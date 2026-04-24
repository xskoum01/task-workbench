/**
 * ConfirmSetupModal - shown when the user clicks Analyze on a New task.
 *
 * All fields are pre-filled by inferWorkflowSetupDefaults(). If the task
 * already has a confirmed workflowSetup, those values take priority and new
 * inference does not override them.
 *
 * For Update/Fix/Review workflows:
 *   - Script: lists existing .js/.ts files from the customer script folder.
 *   - Plugin: lists existing plugin projects, then .cs files in the chosen project.
 *   Both allow manual path entry as fallback.
 *
 * When effectiveMode = 'general', developer-specific fields are hidden.
 */
import { useState, useEffect } from 'react';
import type { Task, Customer, WorkflowSetup, AiReviewerConfig } from '../types';
import type { DevTarget } from '../lib/resolveTaskDevTarget';
import type { FileEntry } from '../lib/tauriCommands';
import Modal from './Modal';
import { mergeWithDefaults } from '../lib/aiReviewers';
import { inferWorkflowSetupDefaults } from '../lib/inferWorkflowSetup';
import * as tauriApi from '../lib/tauriCommands';

const PLUGIN_EXCLUDED_DIRS = ['bin', 'obj', '.vs', 'packages', '.git', 'node_modules'];

interface ConfirmSetupModalProps {
  task: Task;
  customers: Customer[];
  customer: Customer | undefined;
  devTarget: DevTarget;
  /** Resolved plugin project directory (e.g. <repo>/Plugins). */
  pluginsDir: string | undefined;
  /** Heuristic default script folder for pre-fill. */
  scriptFolder: string | undefined;
  /** AI reviewer configs from settings. */
  reviewerConfigs?: AiReviewerConfig[];
  /**
   * Effective task mode - controls which fields are visible.
   * 'general' hides all developer-specific fields (target kind, plugin, script, reviewer).
   * 'developer' shows the full developer setup.
   */
  effectiveMode: 'developer' | 'general';
  /** Called when the user clicks Confirm & Analyze. */
  onConfirm: (setup: WorkflowSetup) => void;
  onCancel: () => void;
}

export default function ConfirmSetupModal({
  task,
  customers,
  customer,
  devTarget,
  pluginsDir,
  scriptFolder,
  reviewerConfigs,
  effectiveMode,
  onConfirm,
  onCancel,
}: ConfirmSetupModalProps) {
  // Run inference once on mount - workflowSetup values win over guesses inside the helper.
  const { defaults, hints } = inferWorkflowSetupDefaults({
    task,
    customer,
    customers,
    devTarget,
    pluginsDir,
    scriptFolder,
    reviewerConfigs,
  });

  const isDev = effectiveMode === 'developer';

  const allReviewers = reviewerConfigs
    ? mergeWithDefaults(reviewerConfigs).filter((r) => r.enabled)
    : [];

  /** Returns the first enabled reviewer matching the given target kind. */
  function selectReviewerByKind(kind: 'plugin' | 'script'): string {
    return allReviewers.find((r) => r.appliesTo.devTargetKinds?.includes(kind))?.id ?? '';
  }

  // --- Core form state ---
  const [workIntent, setWorkIntent] = useState<WorkflowSetup['workIntent']>(defaults.workIntent);
  const initDevKind = (defaults.devTargetKind === 'repo' || !defaults.devTargetKind)
    ? 'script' : defaults.devTargetKind;
  const [devKind, setDevKind]         = useState<'plugin' | 'script'>(initDevKind);
  const [customerId, setCustomerId]   = useState<string>(defaults.customerId);
  const [pluginProject, setPluginProject] = useState<string>(defaults.pluginProject);
  // Script folder path — used only for Create workflow.
  const [scriptCreateFolder, setScriptCreateFolder] = useState<string>(defaults.scriptPath);
  const initReviewerId = defaults.reviewerId || selectReviewerByKind(initDevKind);
  const [reviewerId, setReviewerId]   = useState<string>(initReviewerId);
  const [reviewerManuallySet, setReviewerManuallySet] = useState(false);

  // --- File picker state (Update/Fix/Review only) ---
  const initSelectedFile = task.workflowSetup?.artifactPath ?? '';
  const [selectedExistingFile, setSelectedExistingFile] = useState<string>(initSelectedFile);
  const [scriptFiles, setScriptFiles]               = useState<FileEntry[]>([]);
  const [scriptFilesLoading, setScriptFilesLoading] = useState(false);
  const [scriptFilesError, setScriptFilesError]     = useState<string | null>(null);
  const [scriptManualEntry, setScriptManualEntry]   = useState(() => {
    const p = initSelectedFile.toLowerCase();
    return p.endsWith('.js') || p.endsWith('.ts');
  });
  const [pluginProjects, setPluginProjects]               = useState<string[]>([]);
  const [pluginProjectsLoading, setPluginProjectsLoading] = useState(false);
  const [pluginFiles, setPluginFiles]               = useState<FileEntry[]>([]);
  const [pluginFilesLoading, setPluginFilesLoading] = useState(false);
  const [pluginFilesError, setPluginFilesError]     = useState<string | null>(null);
  const [pluginManualEntry, setPluginManualEntry]   = useState(() => {
    const p = initSelectedFile.toLowerCase();
    return p.endsWith('.cs');
  });

  const isEditMode = workIntent !== 'create';

  const selectedCustomer = customers.find((c) => c.id === customerId);
  const repoHint =
    selectedCustomer?.resolvedRepositoryPath ??
    selectedCustomer?.repositoryRoot ??
    selectedCustomer?.folderName ?? '';

  // --- File loading effects ---

  useEffect(() => {
    if (!isDev || devKind !== 'script' || !isEditMode || !scriptFolder) {
      setScriptFiles([]); return;
    }
    setScriptFilesLoading(true);
    setScriptFilesError(null);
    tauriApi.listFilesWithPaths(scriptFolder, ['js', 'ts'], false, [])
      .then((files) => {
        setScriptFiles(files);
        if (files.length === 1 && !selectedExistingFile) setSelectedExistingFile(files[0].path);
      })
      .catch(() => setScriptFilesError('Could not read script folder.'))
      .finally(() => setScriptFilesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devKind, workIntent, scriptFolder]);

  useEffect(() => {
    if (!isDev || devKind !== 'plugin' || !isEditMode || !pluginsDir) {
      setPluginProjects([]); return;
    }
    setPluginProjectsLoading(true);
    tauriApi.listSubfolders(pluginsDir)
      .then(setPluginProjects)
      .catch(() => setPluginProjects([]))
      .finally(() => setPluginProjectsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devKind, workIntent, pluginsDir]);

  useEffect(() => {
    if (!isDev || devKind !== 'plugin' || !isEditMode || !pluginsDir || !pluginProject) {
      setPluginFiles([]); return;
    }
    const dir = `${pluginsDir}/${pluginProject}`;
    setPluginFilesLoading(true);
    setPluginFilesError(null);
    tauriApi.listFilesWithPaths(dir, ['cs'], true, PLUGIN_EXCLUDED_DIRS)
      .then((files) => {
        setPluginFiles(files);
        if (files.length === 1 && !selectedExistingFile) setSelectedExistingFile(files[0].path);
      })
      .catch(() => setPluginFilesError('Could not read plugin project folder.'))
      .finally(() => setPluginFilesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devKind, workIntent, pluginsDir, pluginProject]);

  // --- Handlers ---

  function handleKindChange(kind: 'plugin' | 'script') {
    setDevKind(kind);
    setSelectedExistingFile('');
    if (!reviewerManuallySet) setReviewerId(selectReviewerByKind(kind));
  }

  function handleWorkIntentChange(intent: WorkflowSetup['workIntent']) {
    setWorkIntent(intent);
    setSelectedExistingFile('');
  }

  function handleConfirm() {
    if (!isDev) {
      onConfirm({
        customerId: customerId || undefined,
        workIntent: undefined, devTargetKind: undefined, repositoryRoot: undefined,
        pluginProject: undefined, scriptPath: undefined, reviewerId: undefined,
        artifactPath: undefined, confirmedAt: new Date().toISOString(),
      });
      return;
    }
    const chosenFile = isEditMode ? (selectedExistingFile.trim() || undefined) : undefined;
    const setup: WorkflowSetup = {
      workIntent,
      devTargetKind:  devKind,
      customerId:     customerId || undefined,
      repositoryRoot: repoHint   || undefined,
      pluginProject:  devKind === 'plugin' ? (pluginProject.trim() || undefined) : undefined,
      scriptPath: devKind === 'script'
        ? (isEditMode ? chosenFile : (scriptCreateFolder.trim() || undefined))
        : undefined,
      reviewerId:   reviewerId || undefined,
      // artifactPath is set here for Update/Fix/Review (the chosen existing file).
      // For Create it stays undefined until Apply Draft creates the file.
      artifactPath: chosenFile,
      confirmedAt:  new Date().toISOString(),
    };
    onConfirm(setup);
  }
  // --- Render helpers ---

  function renderScriptField() {
    if (!isDev || devKind !== 'script') return null;
    if (!isEditMode) {
      return (
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Target script folder</label>
          <input
            className="form-input" type="text" value={scriptCreateFolder}
            placeholder="Folder where the new script will be created"
            onChange={(e) => setScriptCreateFolder(e.target.value)}
          />
          {hints.scriptPath && <div className="confirm-setup-inferred">{hints.scriptPath}</div>}
        </div>
      );
    }
    if (scriptFilesLoading) {
      return (
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Existing script file</label>
          <div className="confirm-setup-hint">Scanning script folder...</div>
        </div>
      );
    }
    if (scriptFilesError || scriptFiles.length === 0) {
      return (
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Existing script file</label>
          {scriptFilesError
            ? <div className="confirm-setup-hint confirm-setup-hint--warn">{scriptFilesError}</div>
            : !scriptFolder
              ? <div className="confirm-setup-hint confirm-setup-hint--warn">No script folder configured for this customer.</div>
              : <div className="confirm-setup-hint confirm-setup-hint--warn">No .js / .ts files found in {scriptFolder}.</div>}
          <input
            className="form-input" type="text" value={selectedExistingFile}
            placeholder="Absolute path to existing .js / .ts file"
            onChange={(e) => setSelectedExistingFile(e.target.value)}
          />
        </div>
      );
    }
    if (!scriptManualEntry) {
      return (
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Existing script file</label>
          <select
            className="form-select" value={selectedExistingFile}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__manual__') { setScriptManualEntry(true); setSelectedExistingFile(''); }
              else setSelectedExistingFile(v);
            }}
          >
            <option value="">Select script file...</option>
            {scriptFiles.map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
            <option value="__manual__">Enter path manually...</option>
          </select>
          {scriptFolder && <div className="confirm-setup-hint">From: {scriptFolder}</div>}
        </div>
      );
    }
    return (
      <div className="confirm-setup-row">
        <label className="form-label confirm-setup-label">Existing script file</label>
        <input
          className="form-input" type="text" value={selectedExistingFile}
          placeholder="Absolute path to existing .js / .ts file"
          onChange={(e) => setSelectedExistingFile(e.target.value)}
        />
        <button className="btn btn-secondary btn-xs" type="button" style={{ marginTop: 4 }}
          onClick={() => { setScriptManualEntry(false); setSelectedExistingFile(''); }}>
          Back to list
        </button>
      </div>
    );
  }

  function renderPluginProjectField() {
    if (!isDev || devKind !== 'plugin') return null;
    if (!isEditMode) {
      return (
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">New plugin project</label>
          <input
            className="form-input" type="text" value={pluginProject}
            placeholder="Name for the new plugin project (will be created)"
            onChange={(e) => setPluginProject(e.target.value)}
          />
          {hints.pluginProject && <div className="confirm-setup-inferred">{hints.pluginProject}</div>}
        </div>
      );
    }
    if (pluginProjectsLoading) {
      return (
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Existing plugin project</label>
          <div className="confirm-setup-hint">Scanning plugins folder...</div>
        </div>
      );
    }
    return (
      <div className="confirm-setup-row">
        <label className="form-label confirm-setup-label">Existing plugin project</label>
        {pluginProjects.length > 0
          ? (
            <select className="form-select" value={pluginProject}
              onChange={(e) => { setPluginProject(e.target.value); setSelectedExistingFile(''); }}>
              <option value="">Select plugin project...</option>
              {pluginProjects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          ) : (
            <input
              className="form-input" type="text" value={pluginProject}
              placeholder={pluginsDir ? `Subfolder inside ${pluginsDir}` : 'Plugin project folder name'}
              onChange={(e) => setPluginProject(e.target.value)}
            />
          )}
        {hints.pluginProject && <div className="confirm-setup-inferred">{hints.pluginProject}</div>}
        {pluginsDir && <div className="confirm-setup-hint">Inside: {pluginsDir}</div>}
      </div>
    );
  }

  function renderPluginFileField() {
    if (!isDev || devKind !== 'plugin' || !isEditMode || !pluginProject) return null;
    if (pluginFilesLoading) {
      return (
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Existing plugin file</label>
          <div className="confirm-setup-hint">Scanning project...</div>
        </div>
      );
    }
    if (pluginFilesError || pluginFiles.length === 0) {
      return (
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Existing plugin file</label>
          {pluginFilesError
            ? <div className="confirm-setup-hint confirm-setup-hint--warn">{pluginFilesError}</div>
            : <div className="confirm-setup-hint confirm-setup-hint--warn">No .cs files found in {pluginProject}.</div>}
          <input
            className="form-input" type="text" value={selectedExistingFile}
            placeholder="Absolute path to existing .cs file"
            onChange={(e) => setSelectedExistingFile(e.target.value)}
          />
        </div>
      );
    }
    if (!pluginManualEntry) {
      return (
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Existing plugin file</label>
          <select
            className="form-select" value={selectedExistingFile}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__manual__') { setPluginManualEntry(true); setSelectedExistingFile(''); }
              else setSelectedExistingFile(v);
            }}
          >
            <option value="">Select plugin file...</option>
            {pluginFiles.map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
            <option value="__manual__">Enter path manually...</option>
          </select>
        </div>
      );
    }
    return (
      <div className="confirm-setup-row">
        <label className="form-label confirm-setup-label">Existing plugin file</label>
        <input
          className="form-input" type="text" value={selectedExistingFile}
          placeholder="Absolute path to existing .cs file"
          onChange={(e) => setSelectedExistingFile(e.target.value)}
        />
        <button className="btn btn-secondary btn-xs" type="button" style={{ marginTop: 4 }}
          onClick={() => { setPluginManualEntry(false); setSelectedExistingFile(''); }}>
          Back to list
        </button>
      </div>
    );
  }

  return (
    <Modal
      title={isDev ? 'Confirm task setup' : 'Confirm task'}
      size="md"
      onClose={onCancel}
      footer={
        <div className="confirm-setup-footer">
          <button className="btn btn-secondary btn-sm" onClick={onCancel} type="button">Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={handleConfirm} type="button">Confirm &amp; Analyze</button>
        </div>
      }
    >
      <div className="confirm-setup-body">

        {/* Work intent */}
        {isDev && (
          <div className="confirm-setup-row">
            <label className="form-label confirm-setup-label">Work intent</label>
            <div className="confirm-setup-kind-group">
              {(['update', 'create', 'fix', 'review'] as const).map((intent) => (
                <button key={intent} type="button"
                  className={`btn btn-sm${workIntent === intent ? ' btn-primary' : ' btn-secondary'}`}
                  onClick={() => handleWorkIntentChange(intent)}>
                  {intent.charAt(0).toUpperCase() + intent.slice(1)}
                </button>
              ))}
            </div>
            {hints.workIntent && <div className="confirm-setup-inferred">{hints.workIntent}</div>}
          </div>
        )}

        {/* Target kind */}
        {isDev && (
          <div className="confirm-setup-row">
            <label className="form-label confirm-setup-label">Target kind</label>
            <div className="confirm-setup-kind-group">
              {(['plugin', 'script'] as const).map((kind) => (
                <button key={kind} type="button"
                  className={`btn btn-sm${devKind === kind ? ' btn-primary' : ' btn-secondary'}`}
                  onClick={() => handleKindChange(kind)}>
                  {kind.charAt(0).toUpperCase() + kind.slice(1)}
                </button>
              ))}
            </div>
            {hints.devTargetKind && <div className="confirm-setup-inferred">{hints.devTargetKind}</div>}
          </div>
        )}

        {/* Customer */}
        {customers.length > 1 && (
          <div className="confirm-setup-row">
            <label className="form-label confirm-setup-label">Customer</label>
            <select className="form-select" value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">None</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {isDev && repoHint && <div className="confirm-setup-hint">{repoHint}</div>}
          </div>
        )}

        {renderPluginProjectField()}
        {renderPluginFileField()}
        {renderScriptField()}

        {/* AI reviewer */}
        {isDev && allReviewers.length > 0 && (
          <div className="confirm-setup-row">
            <label className="form-label confirm-setup-label">AI reviewer</label>
            <select className="form-select" value={reviewerId}
              onChange={(e) => { setReviewerId(e.target.value); setReviewerManuallySet(true); }}>
              <option value="">Auto-select</option>
              {allReviewers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            {hints.reviewerId && <div className="confirm-setup-inferred">{hints.reviewerId}</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}