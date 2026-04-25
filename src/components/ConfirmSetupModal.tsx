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

// ---------------------------------------------------------------------------
// Auto-scoring for script file preselection (Update / Fix workflows)
// ---------------------------------------------------------------------------

/** Strips common Czech/Latin diacritics. */
function removeDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Splits a string on whitespace, underscores, hyphens, and camelCase boundaries,
 * returning lower-cased tokens with diacritics removed.
 */
function tokenize(s: string): string[] {
  // Insert space before uppercase sequences so camelCase splits cleanly.
  const expanded = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return removeDiacritics(expanded)
    .toLowerCase()
    .split(/[\s_\-./\\]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 1);
}

/** Generic stop-words that add no signal (very common prefixes, file extensions, etc.). */
const STOP_WORDS = new Set([
  'nvr', 'js', 'ts', 'the', 'and', 'for', 'pro', 'na', 've', 'ze',
  'se', 've', 'do', 'je', 'ale', 'nebo', 'pri', 'jak', 'jako', 'tez',
  'nad', 'pod', 'bez', 'aby', 'jen', 'byt', 'byl', 'bylo', 'byly',
  'tento', 'tato', 'toto', 'tyto', 'tuto', 'neni', 'neni',
]);

/**
 * CRM entity / area synonym map.
 * Each entry: list of text triggers → canonical area key.
 * All strings are already lowercase-and-diacritics-free.
 */
const ENTITY_SYNONYMS: Array<{ triggers: string[]; key: string }> = [
  { triggers: ['ukol', 'ukoly', 'task', 'tasks', 'bulktask', 'bulk', 'ukolu', 'ukolu', 'dokoncit'], key: 'bulktask' },
  { triggers: ['kontakt', 'contact', 'contacts', 'kontaktu', 'kontakty'], key: 'contact' },
  { triggers: ['ucet', 'account', 'accounts', 'firma', 'firmy', 'firmu'], key: 'account' },
  { triggers: ['aktivita', 'activity', 'activities', 'aktivity'], key: 'activity' },
  { triggers: ['interakce', 'interaction', 'interakci'], key: 'interaction' },
  { triggers: ['telefon', 'phone', 'phonenumber', 'telefonni', 'cislo'], key: 'phonenumber' },
  { triggers: ['objednavka', 'order', 'salesorder', 'orders'], key: 'salesorder' },
  { triggers: ['projekt', 'project', 'projects'], key: 'project' },
  { triggers: ['pripad', 'case', 'incident'], key: 'incident' },
  { triggers: ['lead', 'leads'], key: 'lead' },
  { triggers: ['prilezitost', 'opportunity', 'opportunities'], key: 'opportunity' },
];

/** Detects entity area keys present in a token set. */
function detectEntityAreas(tokens: Set<string>): Set<string> {
  const found = new Set<string>();
  for (const { triggers, key } of ENTITY_SYNONYMS) {
    for (const t of triggers) {
      if (tokens.has(t)) { found.add(key); break; }
    }
  }
  return found;
}

/**
 * Detects the file type intent from text tokens.
 *   'events'  = event/workflow/state logic expected
 *   'ribbon'  = ribbon/command-bar logic expected
 *   'neutral' = no strong signal
 */
function detectFileIntent(tokens: Set<string>): 'events' | 'ribbon' | 'neutral' {
  const eventSignals = [
    'workflow', 'stav', 'stavu', 'hodnota', 'hodnotu', 'zmena', 'zmenou',
    'kliknuti', 'nereaguje', 'podminka', 'podminky', 'notifikacni', 'lista',
    'onload', 'onchange', 'onsave', 'onsubmit', 'oncreate', 'ondelete',
    'change', 'load', 'save', 'submit', 'form', 'formular', 'field', 'pole',
    'validace', 'validate', 'validation',
  ];
  const ribbonSignals = [
    'ribbon', 'command', 'commandbar', 'commandbutton', 'ribbonu', 'ribbonova',
  ];
  // "tlačítko" / "button" alone is weak — only ribbon if explicitly in ribbon context.
  const weakRibbonSignals = ['tlacitko', 'button'];

  let evScore = 0;
  let riScore = 0;

  for (const t of tokens) {
    if (eventSignals.includes(t))     evScore += 3;
    if (ribbonSignals.includes(t))    riScore += 5;
    if (weakRibbonSignals.includes(t)) riScore += 1;
  }

  if (riScore >= 5 && riScore > evScore) return 'ribbon';
  if (evScore > 0) return 'events';
  return 'neutral';
}

/**
 * Improved script file scorer.
 * Higher score = better match. Returns 0 when there is no meaningful signal.
 *
 * Scoring tiers:
 *  +30  exact filename stem mention in task text
 *  +15  entity/area canonical key match in file name
 *  +10  file type intent aligns (events ↔ _events, ribbon ↔ _ribbon/Ribbon)
 *   +2  shared meaningful token (after stop-word + short-token filter)
 *   −8  file name contains a *different* entity area than the dominant one detected
 */
function scoreScriptFile(fileName: string, task: Task): { score: number; label: string } {
  const stem = fileName.toLowerCase().replace(/\.(js|ts)$/, '');
  const textRaw = [task.title, task.originalMessage ?? ''].join(' ');

  // Normalised token sets.
  const textTokens = new Set(tokenize(textRaw).filter((t) => !STOP_WORDS.has(t)));
  const stemTokens = new Set(tokenize(stem).filter((t) => !STOP_WORDS.has(t)));

  let score = 0;

  // 1. Exact stem mention.
  const normalText = removeDiacritics(textRaw).toLowerCase();
  if (normalText.includes(stem.replace(/_/g, ''))) score += 30;
  else if (normalText.includes(stem)) score += 30;

  // 2. Entity/area matching.
  const textAreas = detectEntityAreas(textTokens);
  const stemAreas = detectEntityAreas(stemTokens);

  // Boost for every area shared between text and filename.
  for (const area of textAreas) {
    if (stemAreas.has(area)) score += 15;
  }

  // Penalise filename areas that clearly don't match the dominant text area.
  if (textAreas.size > 0) {
    for (const area of stemAreas) {
      if (!textAreas.has(area)) score -= 8;
    }
  }

  // 3. File type intent alignment.
  const intent = detectFileIntent(textTokens);
  const isEventsFile = /events?/i.test(stem);
  const isRibbonFile = /ribbon/i.test(stem);

  if (intent === 'events' && isEventsFile) score += 10;
  if (intent === 'ribbon' && isRibbonFile) score += 10;
  // Slight penalty when intent doesn't match.
  if (intent === 'events' && isRibbonFile && !isEventsFile) score -= 3;
  if (intent === 'ribbon' && isEventsFile && !isRibbonFile) score -= 3;

  // 4. Shared meaningful tokens (after stop-word filter, length >= 3).
  for (const t of textTokens) {
    if (t.length >= 3 && stemTokens.has(t)) score += 2;
  }

  // Build a short label for the UI hint.
  const label = score <= 0 ? '' : `${fileName}`;

  return { score: Math.max(0, score), label };
}

/**
 * Returns the path of the best-matching file when there is sufficient
 * confidence (score >= 8 AND gap over second-best >= 3). Otherwise empty.
 *
 * Also returns a hint for the UI:
 *   'high'   = confident match
 *   'low'    = best >= 8 but gap < 3 (tied candidates)
 *   'none'   = no confident match
 */
function autoSelectScriptFile(
  files: FileEntry[],
  task: Task,
): { path: string; confidence: 'high' | 'low' | 'none' } {
  const MIN_SCORE = 8;
  const MIN_GAP   = 3;

  const scored = files
    .map((f) => ({ path: f.path, ...scoreScriptFile(f.name, task) }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0 || scored[0].score < MIN_SCORE) {
    // Single-file shortcut — obvious choice regardless of score.
    if (files.length === 1) return { path: files[0].path, confidence: 'low' };
    return { path: '', confidence: 'none' };
  }

  const best       = scored[0];
  const secondBest = scored[1]?.score ?? 0;
  const gap        = best.score - secondBest;

  if (gap >= MIN_GAP) return { path: best.path, confidence: 'high' };
  // Close race — still pick the best but mark as low confidence.
  return { path: best.path, confidence: 'low' };
}

interface ConfirmSetupModalProps {
  task: Task;
  customers: Customer[];
  customer: Customer | undefined;
  devTarget: DevTarget;
  /** Resolved plugin project directory (e.g. <repo>/Plugins). */
  pluginsDir: string | undefined;
  /** Heuristic default script folder for pre-fill (used as final fallback). */
  scriptFolder: string | undefined;
  /** AI reviewer configs from settings. */
  reviewerConfigs?: AiReviewerConfig[];
  /**
   * Effective task mode - controls which fields are visible.
   * 'general' hides all developer-specific fields (target kind, plugin, script, reviewer).
   * 'developer' shows the full developer setup.
   */
  effectiveMode: 'developer' | 'general';
  /** CRM base directory from app settings — used to probe candidate script folders. */
  crmBaseDirectory?: string;
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
  crmBaseDirectory,
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
  // When scriptPath is a file path (ends .js/.ts), extract the parent folder.
  const initScriptFolder = (() => {
    const sp = defaults.scriptPath;
    if (sp && /\.(js|ts)$/i.test(sp)) {
      return sp.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
    }
    return sp;
  })();
  const [scriptCreateFolder] = useState<string>(initScriptFolder ?? '');
  const initReviewerId = defaults.reviewerId || selectReviewerByKind(initDevKind);
  const [reviewerId, setReviewerId]   = useState<string>(initReviewerId);
  const [reviewerManuallySet, setReviewerManuallySet] = useState(false);

  // --- File picker state (Update/Fix/Review only) ---
  const initSelectedFile = task.workflowSetup?.artifactPath ?? '';
  const [selectedExistingFile, setSelectedExistingFile] = useState<string>(initSelectedFile);
  // 'auto-high' / 'auto-low' = preselected by scoring with high/low confidence
  // 'manual' = changed by user, 'none' = not set
  const [scriptSelectionSource, setScriptSelectionSource] = useState<'auto-high' | 'auto-low' | 'manual' | 'none'>(
    initSelectedFile ? 'manual' : 'none',
  );
  // The actual resolved script folder (probed for existence, may differ from the prop).
  const [resolvedScriptFolder, setResolvedScriptFolder] = useState<string | undefined>(scriptFolder);
  const [scriptFolderResolving, setScriptFolderResolving] = useState(false);
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

  // --- Create + Script file name state ---
  // File name (base name only) for the new script file in Create + Script workflow.
  const [createScriptFileName, setCreateScriptFileName] = useState<string>(
    defaults.desiredScriptFile ?? task.workflowSetup?.desiredScriptFile ?? 'nvr_account_events.js',
  );
  const [createScriptFileSource] = useState<string>(hints.desiredScriptFileSource ?? '');
  // Existing files in the script folder — used for "extend existing" option in Create + Script.
  const [createScriptFiles, setCreateScriptFiles] = useState<FileEntry[]>([]);
  const [createScriptFilesLoading, setCreateScriptFilesLoading] = useState(false);
  // 'new' = user wants to create a new file; 'existing' = extend existing file
  const [createScriptMode, setCreateScriptMode] = useState<'new' | 'existing'>('new');

  // --- Resolve the best existing script folder from a priority-ordered candidate list ---
  useEffect(() => {
    if (!isDev || devKind !== 'script' || !isEditMode) {
      setResolvedScriptFolder(scriptFolder);
      return;
    }
    const cust = selectedCustomer;
    const candidates: string[] = [];

    // 1. Explicit scriptFolder set by user on the customer record (highest trust).
    if (cust?.scriptFolder) candidates.push(cust.scriptFolder);

    // 2-5. Repo-relative paths: CRM_Code/Scripts first, then plain Scripts.
    const repos = [
      cust?.resolvedRepositoryPath,
      cust?.repositoryRoot,
    ].filter((r): r is string => !!r);
    for (const r of repos) candidates.push(`${r}/CRM_Code/Scripts`);
    for (const r of repos) candidates.push(`${r}/Scripts`);

    // 6-7. Derived from crmBaseDirectory + folderName.
    if (crmBaseDirectory && cust?.folderName) {
      candidates.push(`${crmBaseDirectory}/${cust.folderName}/CRM_Code/Scripts`);
      candidates.push(`${crmBaseDirectory}/${cust.folderName}/Scripts`);
    }

    // 8. Fallback: the pre-resolved scriptFolder prop (may duplicate earlier entries).
    if (scriptFolder && !candidates.includes(scriptFolder)) {
      candidates.push(scriptFolder);
    }

    if (candidates.length === 0) {
      setResolvedScriptFolder(undefined);
      return;
    }

    setScriptFolderResolving(true);
    let cancelled = false;
    (async () => {
      for (const c of candidates) {
        if (cancelled) return;
        try {
          const exists = await tauriApi.checkPathExists(c);
          if (exists && !cancelled) {
            setResolvedScriptFolder(c);
            return;
          }
        } catch { /* skip non-existent or inaccessible */ }
      }
      // No candidate exists — fall back to first so user can see what was tried.
      if (!cancelled) setResolvedScriptFolder(candidates[0]);
    })().finally(() => { if (!cancelled) setScriptFolderResolving(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDev, devKind, workIntent, customerId, crmBaseDirectory, scriptFolder]);

  // --- File loading effects ---

  useEffect(() => {
    if (!isDev || devKind !== 'script' || !isEditMode || !resolvedScriptFolder || scriptFolderResolving) {
      setScriptFiles([]); return;
    }
    setScriptFilesLoading(true);
    setScriptFilesError(null);
    tauriApi.listFilesWithPaths(resolvedScriptFolder, ['js', 'ts'], false, ['node_modules', 'bin', 'obj', 'dist', 'build'])
      .then((files) => {
        setScriptFiles(files);
        // Only auto-select when no file is already chosen (e.g. from a previous confirmation).
        if (!initSelectedFile) {
          const { path: autoPath, confidence } = autoSelectScriptFile(files, task);
          if (autoPath) {
            setSelectedExistingFile(autoPath);
            setScriptSelectionSource(confidence === 'high' ? 'auto-high' : 'auto-low');
          }
        }
      })
      .catch(() => setScriptFilesError('Could not read script folder.'))
      .finally(() => setScriptFilesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devKind, workIntent, resolvedScriptFolder, scriptFolderResolving]);

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

  // Load existing script files for Create + Script (to allow "extend existing" option).
  useEffect(() => {
    if (!isDev || devKind !== 'script' || isEditMode || !scriptCreateFolder) {
      setCreateScriptFiles([]); return;
    }
    setCreateScriptFilesLoading(true);
    tauriApi.listFilesWithPaths(scriptCreateFolder, ['js', 'ts'], false, ['node_modules', 'bin', 'obj', 'dist', 'build'])
      .then(setCreateScriptFiles)
      .catch(() => setCreateScriptFiles([]))
      .finally(() => setCreateScriptFilesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDev, devKind, workIntent, scriptCreateFolder]);

  // --- Handlers ---

  function handleKindChange(kind: 'plugin' | 'script') {
    setDevKind(kind);
    setSelectedExistingFile('');
    if (!reviewerManuallySet) setReviewerId(selectReviewerByKind(kind));
  }

  function handleWorkIntentChange(intent: WorkflowSetup['workIntent']) {
    setWorkIntent(intent);
    setSelectedExistingFile('');
    setScriptSelectionSource('none');
  }

  // Validation error derived from current field state.
  const confirmError: string | null = (() => {
    if (!isDev) return null;
    if (isEditMode && devKind === 'script') {
      const file = selectedExistingFile.trim();
      if (!file || (!file.toLowerCase().endsWith('.js') && !file.toLowerCase().endsWith('.ts'))) {
        return 'Select the existing script file that will be updated.';
      }
    }
    if (!isEditMode && devKind === 'script') {
      const folder = scriptCreateFolder.trim();
      if (!folder) return 'Target Scripts folder is not resolved. Configure a script folder for this customer.';
      const rawName = createScriptFileName.trim();
      const baseName = rawName ? (rawName.replace(/\\/g, '/').split('/').pop() ?? rawName) : '';
      if (!baseName) return 'Confirm target script file name first.';
      if (!baseName.toLowerCase().endsWith('.js') && !baseName.toLowerCase().endsWith('.ts')) {
        return 'Confirm target script file name first — file must end with .js or .ts.';
      }
    }
    return null;
  })();

  function handleConfirm() {
    if (confirmError) return;
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

    // For Create + Script: build full absolute path from folder + file name.
    let createScriptPath: string | undefined;
    let desiredScriptFile: string | undefined;
    if (!isEditMode && devKind === 'script') {
      const folder = scriptCreateFolder.trim();
      // When "extend existing" mode, createScriptFileName may be a full path already.
      const rawName = createScriptFileName.trim();
      const baseName = rawName
        ? (rawName.replace(/\\/g, '/').split('/').pop() ?? rawName)
        : '';
      if (folder && baseName) {
        createScriptPath = `${folder.replace(/[/\\]+$/, '')}/${baseName}`;
      } else if (folder) {
        createScriptPath = folder;
      }
      if (baseName) desiredScriptFile = baseName;
    }

    const setup: WorkflowSetup = {
      workIntent,
      devTargetKind:  devKind,
      customerId:     customerId || undefined,
      repositoryRoot: repoHint   || undefined,
      pluginProject:  devKind === 'plugin' ? (pluginProject.trim() || undefined) : undefined,
      scriptPath: devKind === 'script'
        ? (isEditMode ? chosenFile : createScriptPath)
        : undefined,
      desiredScriptFile: devKind === 'script' && !isEditMode ? desiredScriptFile : undefined,
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
      // Create + Script: show target file picker with entity-based suggestion.
      return (
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Target script file</label>
          {/* Toggle: new file vs. extend existing */}
          <div className="confirm-setup-kind-group" style={{ marginBottom: 6 }}>
            <button type="button"
              className={`btn btn-sm${createScriptMode === 'new' ? ' btn-primary' : ' btn-secondary'}`}
              onClick={() => setCreateScriptMode('new')}>
              New file
            </button>
            <button type="button"
              className={`btn btn-sm${createScriptMode === 'existing' ? ' btn-primary' : ' btn-secondary'}`}
              onClick={() => setCreateScriptMode('existing')}>
              Extend existing
            </button>
          </div>

          {createScriptMode === 'new' ? (
            <>
              <input
                className="form-input" type="text" value={createScriptFileName}
                placeholder="e.g. nvr_account_events.js"
                onChange={(e) => setCreateScriptFileName(e.target.value)}
              />
              {createScriptFileSource && (
                <div className="confirm-setup-inferred">{createScriptFileSource}</div>
              )}
            </>
          ) : (
            createScriptFilesLoading ? (
              <div className="confirm-setup-hint">Scanning script folder…</div>
            ) : createScriptFiles.length > 0 ? (
              <select
                className="form-select"
                value={createScriptFileName}
                onChange={(e) => setCreateScriptFileName(e.target.value.replace(/\\/g, '/').split('/').pop() ?? e.target.value)}
              >
                <option value="">Select script file to extend…</option>
                {createScriptFiles.map((f) => (
                  <option key={f.path} value={f.path}>{f.name}</option>
                ))}
              </select>
            ) : (
              <div className="confirm-setup-hint confirm-setup-hint--warn">No script files found — switch to New file.</div>
            )
          )}

          {scriptCreateFolder && (
            <div className="confirm-setup-hint">
              Scripts folder: {scriptCreateFolder}
            </div>
          )}
          {!scriptCreateFolder && hints.scriptPath && (
            <div className="confirm-setup-inferred">{hints.scriptPath}</div>
          )}
        </div>
      );
    }
    if (scriptFolderResolving || scriptFilesLoading) {
      return (
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Existing script file</label>
          <div className="confirm-setup-hint">{scriptFolderResolving ? 'Locating script folder…' : 'Scanning script folder…'}</div>
        </div>
      );
    }
    if (scriptFilesError || scriptFiles.length === 0) {
      return (
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Existing script file</label>
          {scriptFilesError
            ? <div className="confirm-setup-hint confirm-setup-hint--warn">{scriptFilesError}</div>
            : !resolvedScriptFolder
              ? <div className="confirm-setup-hint confirm-setup-hint--warn">No script folder configured for this customer.</div>
              : <div className="confirm-setup-hint confirm-setup-hint--warn">No .js / .ts files found in {resolvedScriptFolder}.</div>}
          <input
            className="form-input" type="text" value={selectedExistingFile}
            placeholder="Absolute path to existing .js / .ts file"
            onChange={(e) => { setSelectedExistingFile(e.target.value); setScriptSelectionSource('manual'); }}
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
              if (v === '__manual__') { setScriptManualEntry(true); setSelectedExistingFile(''); setScriptSelectionSource('manual'); }
              else { setSelectedExistingFile(v); setScriptSelectionSource('manual'); }
            }}
          >
            <option value="">Select script file…</option>
            {scriptFiles.map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
            <option value="__manual__">Enter path manually…</option>
          </select>
          {resolvedScriptFolder && <div className="confirm-setup-hint">From: {resolvedScriptFolder}</div>}
          {scriptSelectionSource === 'auto-high' && selectedExistingFile && (
            <div className="confirm-setup-hint confirm-setup-hint--success">
              Auto-selected from task text — {selectedExistingFile.replace(/\\/g, '/').split('/').pop()}
            </div>
          )}
          {scriptSelectionSource === 'auto-low' && selectedExistingFile && (
            <div className="confirm-setup-hint confirm-setup-hint--warn">
              Low confidence auto-selection — verify or pick another file
            </div>
          )}
          {scriptSelectionSource === 'manual' && selectedExistingFile && (
            <div className="confirm-setup-hint">Selected manually</div>
          )}
          {selectedExistingFile && (
            <div className="confirm-setup-hint">Changes will be reviewed from Git diff for this file.</div>
          )}
        </div>
      );
    }
    return (
      <div className="confirm-setup-row">
        <label className="form-label confirm-setup-label">Existing script file</label>
        <input
          className="form-input" type="text" value={selectedExistingFile}
          placeholder="Absolute path to existing .js / .ts file"
          onChange={(e) => { setSelectedExistingFile(e.target.value); setScriptSelectionSource('manual'); }}
        />
        {selectedExistingFile && (
          <div className="confirm-setup-hint">Changes will be reviewed from Git diff for this file.</div>
        )}
        <button className="btn btn-secondary btn-xs" type="button" style={{ marginTop: 4 }}
          onClick={() => { setScriptManualEntry(false); setSelectedExistingFile(''); setScriptSelectionSource('none'); }}>
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
          {confirmError && (
            <span className="confirm-setup-validation-error">{confirmError}</span>
          )}
          <button className="btn btn-secondary btn-sm" onClick={onCancel} type="button">Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleConfirm}
            disabled={!!confirmError}
            title={confirmError ?? undefined}
            type="button"
          >Confirm &amp; Analyze</button>
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