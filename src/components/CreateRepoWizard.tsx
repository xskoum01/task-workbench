/**
 * CreateRepoWizard
 *
 * A modal-based workflow for creating a customer repository from the default
 * template. Walks through three phases:
 *   1. preflight — validates prerequisites and lets the user configure options
 *   2. creating  — shows progress while extraction and git init run
 *   3. done      — shows the per-step outcome and post-create actions
 */
import { useState, useEffect, useCallback } from 'react';
import type { Customer, AppSettings, CreateRepoResult, CreateRepoOptions, GitInitStatus } from '../types';
import Modal from './Modal';
import Icon from './Icon';
import { checkPathExists, validateTemplate, openPath, openInVscode } from '../lib/tauriCommands';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WizardPhase = 'preflight' | 'creating' | 'done' | 'error';

interface PreflightState {
  targetPathExists: boolean | null;   // null = still checking
  templateValid:    'valid' | 'invalid' | 'not_selected' | null;
}

interface WizardOptions {
  initializeGit:       boolean;
  gitBranch:           string;
  createInitialCommit: boolean;
  openAfterCreate:     boolean;
  openInVscodeAfter:   boolean;
}

interface Props {
  customer: Customer;
  settings: AppSettings;
  onClose: () => void;
  /** Called to perform actual repo creation — provided by the parent. */
  onCreateRepo: (customer: Customer, options: CreateRepoOptions) => Promise<CreateRepoResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GIT_INIT_LABEL: Record<GitInitStatus, string> = {
  skipped:        'Skipped',
  already_exists: 'Already initialized',
  success:        'Initialized successfully',
  failed:         'Initialization failed',
  git_not_found:  'git not found in PATH',
};

const GIT_INIT_CLASS: Record<GitInitStatus, string> = {
  skipped:        'wizard-result-neutral',
  already_exists: 'wizard-result-ok',
  success:        'wizard-result-ok',
  failed:         'wizard-result-warn',
  git_not_found:  'wizard-result-warn',
};

function PreflightRow({
  label,
  status,
  detail,
}: {
  label: string;
  status: 'ok' | 'warn' | 'error' | 'checking' | 'info';
  detail: string;
}) {
  const icon = status === 'checking' ? '…'
             : status === 'ok'       ? '✓'
             : status === 'warn'     ? '⚠'
             : status === 'error'    ? '✗'
             : '·';

  const cls = status === 'ok'       ? 'preflight-ok'
            : status === 'warn'     ? 'preflight-warn'
            : status === 'error'    ? 'preflight-error'
            : status === 'checking' ? 'preflight-checking'
            : 'preflight-info';

  return (
    <div className="preflight-row">
      <span className={`preflight-icon ${cls}`}>{icon}</span>
      <span className="preflight-label">{label}</span>
      <span className={`preflight-detail ${cls}`}>{detail}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wizard component
// ---------------------------------------------------------------------------

export default function CreateRepoWizard({ customer, settings, onClose, onCreateRepo }: Props) {
  const folderName  = customer.folderName || customer.repositoryName || '';
  const baseDir     = settings.crmBaseDirectory ?? '';
  const targetPath  = folderName ? `${baseDir}/${folderName}` : '';
  const templatePath = settings.repositoryTemplatePath ?? '';
  const templateType = settings.repositoryTemplateType ?? 'none';

  // --- Phase ---
  const [phase, setPhase] = useState<WizardPhase>('preflight');

  // --- Preflight ---
  const [preflight, setPreflight] = useState<PreflightState>({
    targetPathExists: null,
    templateValid:    null,
  });

  // --- User options (pre-filled from settings) ---
  const [opts, setOpts] = useState<WizardOptions>({
    initializeGit:       settings.initializeGitOnCreate ?? true,
    gitBranch:           settings.defaultGitBranch ?? 'main',
    createInitialCommit: settings.createInitialCommit ?? false,
    openAfterCreate:     false,
    openInVscodeAfter:   false,
  });

  // --- Results ---
  const [result, setResult]   = useState<CreateRepoResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Run preflight checks on mount
  useEffect(() => {
    let cancelled = false;

    async function check() {
      // Check target path
      let pathExists = false;
      if (targetPath) {
        try { pathExists = await checkPathExists(targetPath); } catch { /* ignore */ }
      }
      if (!cancelled) {
        setPreflight((p) => ({ ...p, targetPathExists: pathExists }));
      }

      // Validate template
      let validity: PreflightState['templateValid'] = 'not_selected';
      if (templatePath && templateType !== 'none') {
        try {
          validity = await validateTemplate(templatePath, templateType as 'zip' | 'folder');
        } catch { validity = 'invalid'; }
      }
      if (!cancelled) {
        setPreflight((p) => ({ ...p, templateValid: validity }));
      }
    }

    check();
    return () => { cancelled = true; };
  }, [targetPath, templatePath, templateType]);

  // Derived: can we proceed?
  const canCreate =
    !!baseDir &&
    !!folderName &&
    !!targetPath &&
    preflight.templateValid === 'valid' &&
    preflight.targetPathExists === false; // target must NOT already exist

  // --- Handlers ---

  function setOpt<K extends keyof WizardOptions>(key: K, value: WizardOptions[K]) {
    setOpts((prev) => ({ ...prev, [key]: value }));
  }

  const handleCreate = useCallback(async () => {
    setPhase('creating');
    try {
      const repoOptions: CreateRepoOptions = {
        initializeGit:       opts.initializeGit,
        gitBranch:           opts.gitBranch,
        createInitialCommit: opts.createInitialCommit,
      };
      const res = await onCreateRepo(customer, repoOptions);
      setResult(res);
      setPhase('done');

      // Post-create actions
      if (opts.openInVscodeAfter) {
        openInVscode(res.targetPath).catch(console.warn);
      } else if (opts.openAfterCreate) {
        openPath(res.targetPath).catch(console.warn);
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [customer, onCreateRepo, opts]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isChecking = preflight.targetPathExists === null || preflight.templateValid === null;

  const footer = phase === 'preflight' ? (
    <>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button
        className="btn btn-primary"
        onClick={handleCreate}
        disabled={isChecking || !canCreate}
        title={!canCreate && !isChecking ? getBlockReason(preflight, baseDir, folderName) : undefined}
      >
        Create Repository
      </button>
    </>
  ) : phase === 'done' || phase === 'error' ? (
    <button className="btn btn-primary" onClick={onClose}>Close</button>
  ) : null;

  return (
    <Modal
      title={`Create Repository — ${customer.name}`}
      onClose={phase === 'creating' ? () => {} /* block close during creation */ : onClose}
      size="lg"
      footer={footer}
    >
      {/* ----------------------------------------------------------------- */}
      {/* PREFLIGHT phase                                                    */}
      {/* ----------------------------------------------------------------- */}
      {phase === 'preflight' && (
        <div className="wizard-body">

          {/* Target info */}
          <div className="wizard-section">
            <div className="wizard-section-title">Target</div>
            <div className="wizard-info-grid">
              <span className="wizard-info-label">Customer</span>
              <span className="wizard-info-value">{customer.name}</span>
              <span className="wizard-info-label">Folder name</span>
              <span className="wizard-info-value font-mono">
                {folderName || <em className="text-muted">not configured</em>}
              </span>
              <span className="wizard-info-label">Target path</span>
              <span className="wizard-info-value font-mono">
                {targetPath || <em className="text-muted">cannot be resolved</em>}
              </span>
            </div>
          </div>

          {/* Preflight checks */}
          <div className="wizard-section">
            <div className="wizard-section-title">Preflight checks</div>
            <div className="preflight-list">
              <PreflightRow
                label="CRM base directory"
                status={baseDir ? 'ok' : 'error'}
                detail={baseDir || 'Not configured — set in Settings'}
              />
              <PreflightRow
                label="Customer folder name"
                status={folderName ? 'ok' : 'error'}
                detail={folderName || 'Not set — edit the customer'}
              />
              <PreflightRow
                label="Target path"
                status={
                  preflight.targetPathExists === null ? 'checking' :
                  preflight.targetPathExists ? 'error' : 'ok'
                }
                detail={
                  preflight.targetPathExists === null ? 'Checking…' :
                  preflight.targetPathExists
                    ? 'Already exists — creation would overwrite it'
                    : 'Does not exist yet'
                }
              />
              <PreflightRow
                label="Template"
                status={
                  preflight.templateValid === null           ? 'checking' :
                  preflight.templateValid === 'valid'        ? 'ok' :
                  preflight.templateValid === 'not_selected' ? 'error' : 'error'
                }
                detail={
                  preflight.templateValid === null           ? 'Checking…' :
                  preflight.templateValid === 'valid'        ? templatePath :
                  preflight.templateValid === 'not_selected' ? 'No template selected — set in Settings' :
                  'Template is invalid or not found'
                }
              />
            </div>
          </div>

          {/* Options */}
          <div className="wizard-section">
            <div className="wizard-section-title">Options</div>
            <div className="wizard-options">

              {/* Git init */}
              <label className="form-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  checked={opts.initializeGit}
                  onChange={(e) => setOpt('initializeGit', e.target.checked)}
                />
                <span className="form-check-label">Initialize Git repository (<code>git init</code>)</span>
              </label>

              {opts.initializeGit && (
                <div className="wizard-sub-options">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <label className="form-label" style={{ margin: 0, whiteSpace: 'nowrap', minWidth: 90 }}>
                      Default branch
                    </label>
                    <input
                      className="form-input"
                      type="text"
                      value={opts.gitBranch}
                      onChange={(e) => setOpt('gitBranch', e.target.value)}
                      placeholder="main"
                      style={{ maxWidth: 110 }}
                    />
                  </div>

                  <label className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      checked={opts.createInitialCommit}
                      onChange={(e) => setOpt('createInitialCommit', e.target.checked)}
                    />
                    <span className="form-check-label">Create initial commit after git init</span>
                  </label>
                </div>
              )}

              {/* Post-create actions */}
              <label className="form-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  checked={opts.openAfterCreate}
                  onChange={(e) => {
                    setOpt('openAfterCreate', e.target.checked);
                    if (e.target.checked) setOpt('openInVscodeAfter', false);
                  }}
                />
                <span className="form-check-label">Open repository in file explorer after creation</span>
              </label>

              <label className="form-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  checked={opts.openInVscodeAfter}
                  onChange={(e) => {
                    setOpt('openInVscodeAfter', e.target.checked);
                    if (e.target.checked) setOpt('openAfterCreate', false);
                  }}
                />
                <span className="form-check-label">Open in VS Code after creation</span>
              </label>
            </div>
          </div>

          {/* Blocking notice */}
          {!canCreate && !isChecking && (
            <div className="wizard-block-notice">
              <Icon name="plug" size={12} />
              <span>{getBlockReason(preflight, baseDir, folderName)}</span>
            </div>
          )}
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* CREATING phase                                                     */}
      {/* ----------------------------------------------------------------- */}
      {phase === 'creating' && (
        <div className="wizard-body wizard-creating">
          <div className="wizard-spinner" />
          <div className="wizard-creating-label">Creating repository…</div>
          <div className="wizard-creating-path font-mono">{targetPath}</div>
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* DONE phase                                                         */}
      {/* ----------------------------------------------------------------- */}
      {phase === 'done' && result && (
        <div className="wizard-body">
          <div className="wizard-result-header wizard-result-ok">
            <span className="wizard-result-icon">✓</span>
            <span>Repository created successfully</span>
          </div>

          <div className="wizard-section">
            <div className="wizard-section-title">Result</div>
            <div className="wizard-info-grid">
              <span className="wizard-info-label">Location</span>
              <span className="wizard-info-value font-mono">{result.targetPath}</span>
              <span className="wizard-info-label">Git init</span>
              <span className={`wizard-info-value ${GIT_INIT_CLASS[result.gitInit]}`}>
                {GIT_INIT_LABEL[result.gitInit]}
                {result.gitMessage ? ` — ${result.gitMessage}` : ''}
              </span>
              {result.initialCommitCreated && (
                <>
                  <span className="wizard-info-label">Initial commit</span>
                  <span className="wizard-info-value wizard-result-ok">Created</span>
                </>
              )}
            </div>
          </div>

          <div className="wizard-section">
            <div className="wizard-section-title">Open</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => openPath(result.targetPath).catch(console.warn)}
              >
                <Icon name="folder" size={13} /> Open Repository
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => openInVscode(result.targetPath).catch(console.warn)}
              >
                <Icon name="terminal" size={13} /> Open in VS Code
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* ERROR phase                                                        */}
      {/* ----------------------------------------------------------------- */}
      {phase === 'error' && (
        <div className="wizard-body">
          <div className="wizard-result-header wizard-result-error">
            <span className="wizard-result-icon">✗</span>
            <span>Repository creation failed</span>
          </div>
          <div className="wizard-error-detail">{errorMsg}</div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Helper: human-readable reason why "Create Repository" is blocked
// ---------------------------------------------------------------------------

function getBlockReason(
  preflight: PreflightState,
  baseDir: string,
  folderName: string,
): string {
  if (!baseDir)    return 'CRM base directory is not configured.';
  if (!folderName) return 'Customer has no folder name — edit the customer first.';
  if (preflight.targetPathExists)
    return 'The target directory already exists. Remove it first or choose a different folder name.';
  if (preflight.templateValid === 'not_selected')
    return 'No repository template is selected. Configure one in Settings → Repository Workspace.';
  if (preflight.templateValid === 'invalid')
    return 'The selected template is invalid or the file cannot be found.';
  return 'Preflight checks are still running.';
}
