/**
 * TaskDevModePanel — shared Script / Plugin dev-mode switcher.
 *
 * Manages its own state for:
 *   - mode toggle (Script | Plugin)
 *   - plugin project listing and selection
 *   - .sln / .csproj hint for the selected project
 *   - git branch display and switching (V2)
 *
 * Used in both TaskDetail and InlineTaskPanel.
 */
import { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import type { Task, Customer, AiReviewerConfig } from '../types';
import Icon from './Icon';
import * as tauriApi from '../lib/tauriCommands';
import { hintedPluginProject } from '../lib/resolveTaskDevTarget';
import { mergeWithDefaults, selectReviewer } from '../lib/aiReviewers';
import MarkdownView from './MarkdownView';

export interface TaskDevModePanelProps {
  task: Task;
  customer: Customer | undefined;
  /** Directory that contains plugin project subfolders (e.g. <repo>/Plugins). */
  pluginsDir: string | undefined;
  /** Repository root used for git operations. */
  repoRootForGit: string | undefined;
  /** Initial mode chosen by the heuristic resolver; user may override. */
  defaultMode: 'plugin' | 'script';
  /** Path opened when the user clicks Open Script in VS Code. */
  scriptOpenPath: string | undefined;
  /** Called when an error should be surfaced to the parent. */
  onError: (msg: string) => void;
  /**
   * When true, the panel starts collapsed and the user must click the header
   * to reveal it. Use this for tasks where dev work was not detected so the
   * panel doesn't clutter non-dev tasks.
   */
  autoCollapsed?: boolean;
  /**
   * Called whenever the selected plugin project changes (including when cleared).
   * Allows parent components to track the selection for Apply Draft targeting.
   */
  onSelectedPluginChange?: (plugin: string) => void;
  /**
   * Persisted selected plugin project for this task (from task model).
   * When set, takes priority over the heuristic auto-selection on mount/reset.
   */
  selectedPluginProject?: string;
  /**
   * When incremented, forces the plugin project list to re-scan.
   * Increment this in the parent after creating a new plugin project.
   */
  pluginRefreshTick?: number;
  /**
   * AI reviewer configurations from settings.
   * When provided, the Run AI Review button is shown after the open button.
   */
  reviewerConfigs?: AiReviewerConfig[];
}

export interface TaskDevModePanelHandle {
  /**
   * Runs the AI file review using the currently configured file path and reviewer.
   * Returns true when the review completes successfully, false on error or missing config.
   */
  runReview(): Promise<boolean>;
}

export default forwardRef<TaskDevModePanelHandle, TaskDevModePanelProps>(function TaskDevModePanel({
  task,
  pluginsDir,
  repoRootForGit,
  defaultMode,
  scriptOpenPath,
  onError,
  autoCollapsed = false,
  onSelectedPluginChange,
  selectedPluginProject: persistedSelectedPlugin,
  pluginRefreshTick = 0,
  reviewerConfigs,
}: TaskDevModePanelProps, ref: React.Ref<TaskDevModePanelHandle>) {
  // --- collapse toggle ---
  const [expanded, setExpanded] = useState(!autoCollapsed);

  // --- mode ---
  const [devMode, setDevMode] = useState<'script' | 'plugin'>(
    defaultMode === 'plugin' ? 'plugin' : 'script',
  );

  // If no explicit git root is provided, infer it as the parent directory of
  // pluginsDir (e.g. "C:/repo/Plugins" → "C:/repo"). This covers customers
  // that have pluginFolder set but no repositoryRoot configured.
  const effectiveRepoRoot: string | undefined = repoRootForGit ?? (() => {
    if (!pluginsDir) return undefined;
    const norm = pluginsDir.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    const slashIdx = norm.lastIndexOf('/');
    return slashIdx > 0 ? norm.slice(0, slashIdx) : undefined;
  })();

  // --- plugin projects ---
  const [pluginProjects, setPluginProjects]               = useState<string[]>([]);
  const [pluginProjectsLoaded, setPluginProjectsLoaded]   = useState(false);
  const [pluginProjectsLoading, setPluginProjectsLoading] = useState(false);
  const [selectedPlugin, setSelectedPlugin]               = useState<string>('');

  // Wrap setSelectedPlugin so the parent is always notified.
  function updateSelectedPlugin(plugin: string) {
    setSelectedPlugin(plugin);
    onSelectedPluginChange?.(plugin);
  }
  const [pluginOpenHint, setPluginOpenHint]               = useState<string | null>(null);
  // ADO-hinted project name that was not found in the folder listing on the current branch.
  const [hintedProjectMissing, setHintedProjectMissing]   = useState<string | null>(null);

  // --- branch (V2) ---
  const [currentBranch, setBranch]          = useState<string | null>(null);
  const [branches, setBranches]             = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [branchDirty, setBranchDirty]       = useState(false);
  const [branchLoading, setBranchLoading]   = useState(false);
  const [branchSwitching, setBranchSwitching] = useState(false);
  const [branchError, setBranchError]       = useState<string | null>(null);

  // --- AI Review state ---
  const [reviewExpanded, setReviewExpanded]     = useState(false);
  const [reviewFilePath, setReviewFilePath]     = useState('');
  const [reviewSelectedId, setReviewSelectedId] = useState('');
  const [reviewRunning, setReviewRunning]       = useState(false);
  const [reviewError, setReviewError]           = useState<string | null>(null);
  const [reviewMarkdown, setReviewMarkdown]     = useState<string | null>(null);
  const [reviewInferring, setReviewInferring]   = useState(false);
  const [reviewInferError, setReviewInferError] = useState<string | null>(null);

  // Reset all state when the viewed task changes.
  useEffect(() => {
    setExpanded(!autoCollapsed);
    setDevMode(defaultMode === 'plugin' ? 'plugin' : 'script');
    updateSelectedPlugin('');
    setPluginProjects([]);
    setPluginProjectsLoaded(false);
    setPluginOpenHint(null);
    setHintedProjectMissing(null);
    setBranch(null);
    setBranches([]);
    setSelectedBranch('');
    setBranchDirty(false);
    setBranchError(null);
    // Reset review state
    setReviewExpanded(false);
    setReviewFilePath('');
    setReviewSelectedId('');
    setReviewMarkdown(null);
    setReviewError(null);
    setReviewInferError(null);
    setReviewInferring(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  // Re-scan plugin projects when the parent signals a refresh (e.g. after creating a new project).
  useEffect(() => {
    if (!pluginRefreshTick) return; // skip initial mount (tick = 0)
    setPluginProjects([]);
    setPluginProjectsLoaded(false);
    updateSelectedPlugin('');
    setPluginOpenHint(null);
    setHintedProjectMissing(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginRefreshTick]);

  // Load plugin project subfolders when mode = plugin.
  useEffect(() => {
    if (devMode !== 'plugin' || !pluginsDir || pluginProjectsLoaded) return;
    setPluginProjectsLoading(true);
    tauriApi.listSubfolders(pluginsDir)
      .then((folders) => {
        setPluginProjects(folders);
        // Selection priority: persisted value → heuristic hint → single folder
        if (persistedSelectedPlugin && folders.includes(persistedSelectedPlugin)) {
          updateSelectedPlugin(persistedSelectedPlugin);
          setHintedProjectMissing(null);
        } else {
          const hint = hintedPluginProject(task);
          if (hint && folders.includes(hint)) {
            updateSelectedPlugin(hint);
            setHintedProjectMissing(null);
          } else if (hint && !folders.includes(hint)) {
            // The ADO context points to a project that is not present on the current branch.
            setHintedProjectMissing(hint);
            if (folders.length === 1) updateSelectedPlugin(folders[0]);
          } else {
            setHintedProjectMissing(null);
            if (folders.length === 1) updateSelectedPlugin(folders[0]);
          }
        }
        setPluginProjectsLoaded(true);
      })
      .catch(() => { setPluginProjects([]); setPluginProjectsLoaded(true); })
      .finally(() => setPluginProjectsLoading(false));
  }, [devMode, pluginsDir, pluginProjectsLoaded, task]);

  // Load branch info when mode = plugin.
  useEffect(() => {
    if (devMode !== 'plugin' || !effectiveRepoRoot || currentBranch !== null) return;
    setBranchLoading(true);
    setBranchError(null);
    Promise.all([
      tauriApi.getGitBranch(effectiveRepoRoot),
      tauriApi.listGitBranches(effectiveRepoRoot),
      tauriApi.gitHasUncommitted(effectiveRepoRoot),
    ])
      .then(([branch, branchList, dirty]) => {
        setBranch(branch);
        setSelectedBranch(branch);
        setBranches(branchList);
        setBranchDirty(dirty);
      })
      .catch((err) => setBranchError(String(err)))
      .finally(() => setBranchLoading(false));
  }, [devMode, effectiveRepoRoot, currentBranch]);

  // Scan selected plugin folder for .sln / .csproj.
  useEffect(() => {
    if (!selectedPlugin || !pluginsDir) { setPluginOpenHint(null); return; }
    const pluginPath = `${pluginsDir}/${selectedPlugin}`;
    tauriApi.listDirectoryFiles(pluginPath, 'sln')
      .then((slns) => {
        if (slns.length > 0) { setPluginOpenHint(`.sln found: ${slns[0]}`); return; }
        return tauriApi.listDirectoryFiles(pluginPath, 'csproj').then((csprojs) => {
          setPluginOpenHint(
            csprojs.length > 0
              ? `.csproj found: ${csprojs[0]}`
              : 'No .sln or .csproj found in this plugin folder.',
          );
        });
      })
      .catch(() => setPluginOpenHint(null));
  }, [selectedPlugin, pluginsDir]);

  // --- handlers ---

  async function handleSwitchBranch() {
    if (!effectiveRepoRoot || !selectedBranch || selectedBranch === currentBranch) return;
    setBranchError(null);
    setBranchSwitching(true);
    try {
      const dirty = await tauriApi.gitHasUncommitted(effectiveRepoRoot);
      if (dirty) {
        setBranchDirty(true);
        setBranchError('Cannot switch branch because the repository has uncommitted changes.');
        return;
      }
      await tauriApi.gitCheckoutBranch(effectiveRepoRoot, selectedBranch);
      const newBranch = await tauriApi.getGitBranch(effectiveRepoRoot);
      setBranch(newBranch);
      setBranchDirty(false);
      setPluginProjectsLoaded(false);
      updateSelectedPlugin('');
      setPluginOpenHint(null);
    } catch (err) {
      setBranchError(String(err));
    } finally {
      setBranchSwitching(false);
    }
  }

  async function handleOpenScript() {
    if (!scriptOpenPath) { onError('No script path configured for this customer.'); return; }
    try { await tauriApi.openInVscode(scriptOpenPath); }
    catch (e) { onError(String(e)); }
  }

  function handleRefreshPlugins() {
    setPluginProjectsLoaded(false);
    setPluginProjects([]);
    updateSelectedPlugin('');
    setPluginOpenHint(null);
  }

  async function handleOpenPlugin() {
    if (!pluginsDir || !selectedPlugin) { onError('Select a plugin project first.'); return; }
    const pluginPath = `${pluginsDir}/${selectedPlugin}`;
    try {
      const slns = await tauriApi.listDirectoryFiles(pluginPath, 'sln');
      if (slns.length > 0) {
        const target = `${pluginPath}/${slns[0]}`;
        console.log('[devTarget] final path=', target, '(from .sln → Visual Studio)');
        // Open .sln with the OS file association — Visual Studio on Windows.
        await tauriApi.openWithShell(target); return;
      }
      const csprojs = await tauriApi.listDirectoryFiles(pluginPath, 'csproj');
      if (csprojs.length > 0) {
        const target = `${pluginPath}/${csprojs[0]}`;
        console.log('[devTarget] final path=', target, '(from .csproj → VS Code)');
        await tauriApi.openInVscode(target); return;
      }
      const exists = await tauriApi.checkPathExists(pluginPath);
      if (!exists) { onError('Plugin not found on the current branch or path.'); return; }
      console.log('[devTarget] final path=', pluginPath, '(folder — no .sln/.csproj)');
      await tauriApi.openInVscode(pluginPath);
    } catch (e) { onError(String(e)); }
  }

  // --- AI Review helpers ---

  /**
   * Returns the list of enabled reviewer configs (merged with defaults).
   * Returns empty array when no reviewer configs are provided.
   */
  const allReviewers = reviewerConfigs ? mergeWithDefaults(reviewerConfigs).filter((r) => r.enabled) : [];

  /**
   * Infers a best default review file path from the current dev mode and selection.
   * Used to pre-fill the path input when the review panel is first opened.
   */
  /**
   * Infers the best concrete file path for AI review.
   * For script mode: returns scriptOpenPath directly (already a file).
   * For plugin mode: calls the Rust backend to find the best .cs file in the plugin folder.
   * Sets reviewInferError when no concrete file is found.
   */
  async function inferReviewPath(): Promise<string> {
    if (devMode === 'script') return scriptOpenPath ?? '';
    if (devMode === 'plugin' && pluginsDir && selectedPlugin) {
      const dirPath = `${pluginsDir}/${selectedPlugin}`;
      setReviewInferring(true);
      setReviewInferError(null);
      try {
        const found = await tauriApi.inferReviewFilePath(dirPath, 'plugin', selectedPlugin);
        if (!found) {
          setReviewInferError(`No .cs file found in ${selectedPlugin}. Open the panel and enter the path manually.`);
          return '';
        }
        return found;
      } catch {
        setReviewInferError('Could not search for files. Enter the path manually.');
        return '';
      } finally {
        setReviewInferring(false);
      }
    }
    return '';
  }

  /**
   * Returns the currently selected reviewer, auto-resolved when reviewSelectedId is blank.
   */
  function getActiveReviewer() {
    if (reviewSelectedId) {
      return allReviewers.find((r) => r.id === reviewSelectedId);
    }
    return selectReviewer(allReviewers, reviewFilePath, devMode);
  }

  async function handleOpenReviewPanel() {
    if (!reviewExpanded) {
      const defaultPath = await inferReviewPath();
      setReviewFilePath((prev) => prev || defaultPath);
    }
    setReviewExpanded((v) => !v);
    setReviewMarkdown(null);
    setReviewError(null);
  }

  async function handleRunReview(): Promise<boolean> {
    const path = reviewFilePath.trim();
    if (!path) { setReviewError('Enter the file path to review.'); return false; }
    const reviewer = getActiveReviewer();
    if (!reviewer) { setReviewError('No matching reviewer. Configure one in Settings → AI Reviewers.'); return false; }
    setReviewRunning(true);
    setReviewError(null);
    setReviewMarkdown(null);
    try {
      const result = await tauriApi.runAiFileReview(
        path,
        reviewer.name,
        reviewer.instructions,
        reviewer.model ?? '',
        reviewer.temperature ?? 0.2,
      );
      setReviewMarkdown(result.markdown);
      return true;
    } catch (err) {
      setReviewError(String(err));
      return false;
    } finally {
      setReviewRunning(false);
    }
  }

  // Imperative handle — lets TaskDetail trigger the review programmatically
  useImperativeHandle(ref, () => ({
    runReview: async () => {
      // Ensure the review panel is visible so the user sees the results
      if (!reviewExpanded) {
        const defaultPath = await inferReviewPath();
        setReviewFilePath((prev) => prev || defaultPath);
        setReviewExpanded(true);
        setReviewMarkdown(null);
        setReviewError(null);
      }
      return handleRunReview();
    },
  }));

  // --- render ---

  return (
    <div className="detail-devmode-block">
      {/* Collapse toggle header — only shown when the panel starts collapsed */}
      {autoCollapsed && (
        <button
          className="detail-devmode-collapse-btn"
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="detail-devmode-collapse-arrow">{expanded ? '▾' : '▸'}</span>
          Dev tools
        </button>
      )}

      {expanded && (
        <>
      {/* Mode toggle */}
      <div className="detail-devmode-toggle">
        <button
          className={`btn btn-sm ${devMode === 'script' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setDevMode('script')}
        >
          Script
        </button>
        <button
          className={`btn btn-sm ${devMode === 'plugin' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setDevMode('plugin')}
        >
          Plugin
        </button>
      </div>

      {devMode === 'plugin' ? (
        <>
          {/* Branch panel */}
          {effectiveRepoRoot && (
            <div className="detail-devmode-branch">
              {branchLoading ? (
                <div className="detail-devmode-branch-current">Branch: <span className="detail-devmode-branch-name">…</span></div>
              ) : branchError ? (
                <div className="detail-devmode-branch-error">{branchError}</div>
              ) : (
                <>
                  <div className="detail-devmode-branch-current">
                    Branch:{' '}
                    <span className="detail-devmode-branch-name">
                      {currentBranch ?? 'unknown'}
                    </span>
                    {branchDirty && (
                      <span className="detail-devmode-branch-dirty" title="Uncommitted changes present">
                        {' '}(dirty)
                      </span>
                    )}
                  </div>

                  {branches.length > 1 && (
                    <div className="detail-devmode-branch-row">
                      <select
                        className="form-select detail-devmode-branch-select"
                        value={selectedBranch}
                        onChange={(e) => setSelectedBranch(e.target.value)}
                        disabled={branchSwitching}
                      >
                        {branches.map((b) => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                      </select>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={handleSwitchBranch}
                        disabled={branchSwitching || !selectedBranch || selectedBranch === currentBranch}
                        title="Switch to selected branch"
                      >
                        {branchSwitching ? <><span className="btn-spinner" /> Switching…</> : 'Switch'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Plugin project listing */}
          {pluginProjectsLoading && (
            <div className="detail-devmode-hint">Loading plugin projects…</div>
          )}

          {!pluginProjectsLoading && pluginProjectsLoaded && hintedProjectMissing && (
            <div className="detail-devmode-hint">
              ADO-hinted project <strong>{hintedProjectMissing}</strong> not found on this branch.
              Switch branches or use Create Plugin Project in the Workflow section.
            </div>
          )}

          {!pluginProjectsLoading && pluginProjectsLoaded && pluginProjects.length === 0 && (
            <div className="detail-devmode-hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>No plugin project folders found{pluginsDir ? ` in ${pluginsDir}` : ''}.</span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleRefreshPlugins}
                title="Refresh plugin project list"
              >
                <Icon name="refresh-cw" size={11} /> Refresh
              </button>
            </div>
          )}

          {!pluginProjectsLoading && pluginProjects.length > 0 && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <select
                className="form-select"
                style={{ flex: 1 }}
                value={selectedPlugin}
                onChange={(e) => updateSelectedPlugin(e.target.value)}
              >
                <option value="">— select plugin project —</option>
                {pluginProjects.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleRefreshPlugins}
                title="Refresh plugin project list"
              >
                <Icon name="refresh-cw" size={11} />
              </button>
            </div>
          )}

          {pluginOpenHint && (
            <div className="detail-devmode-hint">{pluginOpenHint}</div>
          )}

          <button
            className="btn btn-secondary btn-sm btn-full"
            onClick={handleOpenPlugin}
            disabled={
              !selectedPlugin ||
              pluginOpenHint === 'No .sln or .csproj found in this plugin folder.'
            }
          >
            <Icon name="terminal" size={13} />{' '}
            {pluginOpenHint?.startsWith('.sln') ? 'Open Plugin in Visual Studio' : 'Open Plugin in VS Code'}
          </button>
        </>
      ) : (
        <button
          className="btn btn-secondary btn-sm btn-full"
          onClick={handleOpenScript}
          disabled={!scriptOpenPath}
        >
          <Icon name="terminal" size={13} /> Open Script in VS Code
        </button>
      )}

      {/* AI Review panel — shown when reviewer configs are available */}
      {allReviewers.length > 0 && (
        <div className="detail-devmode-review-section">
          <button
            className="btn btn-ghost btn-sm detail-devmode-review-toggle"
            onClick={handleOpenReviewPanel}
            type="button"
          >
            <Icon name="search" size={12} />
            {reviewExpanded ? 'Hide AI Review' : 'Run AI Review'}
          </button>

          {reviewExpanded && (
            <div className="detail-devmode-review-panel">
              {/* File path input */}
              <div className="detail-devmode-review-row">
                <label className="form-label" style={{ marginBottom: 2 }}>File to review</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="C:\path\to\file.cs"
                  value={reviewFilePath}
                  onChange={(e) => {
                    setReviewFilePath(e.target.value);
                    setReviewSelectedId(''); // reset manual override on path change
                    setReviewMarkdown(null);
                    setReviewError(null);
                    setReviewInferError(null);
                  }}
                />
                {reviewInferring && (
                  <div className="detail-devmode-hint" style={{ marginTop: 3 }}>Searching for file…</div>
                )}
                {reviewInferError && !reviewFilePath && (
                  <div className="detail-devmode-hint" style={{ color: 'var(--color-blocked)', marginTop: 3 }}>
                    {reviewInferError}
                  </div>
                )}
              </div>

              {/* Reviewer selector */}
              <div className="detail-devmode-review-row">
                <label className="form-label" style={{ marginBottom: 2 }}>Reviewer</label>
                <select
                  className="form-select"
                  value={reviewSelectedId || (getActiveReviewer()?.id ?? '')}
                  onChange={(e) => setReviewSelectedId(e.target.value)}
                >
                  <option value="">— auto-select by file type —</option>
                  {allReviewers.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
                {!getActiveReviewer() && reviewFilePath && (
                  <div className="detail-devmode-hint" style={{ color: 'var(--color-blocked)', marginTop: 3 }}>
                    No reviewer matches this file type. Configure one in Settings → AI Reviewers.
                  </div>
                )}
              </div>

              {/* Run button */}
              <button
                className="btn btn-primary btn-sm btn-full"
                onClick={handleRunReview}
                disabled={reviewRunning || reviewInferring || !reviewFilePath.trim() || !getActiveReviewer()}
                type="button"
              >
                {reviewRunning
                  ? <><span className="btn-spinner" /> Running review…</>
                  : <><Icon name="search" size={12} /> Run AI Review</>}
              </button>

              {/* Error */}
              {reviewError && (
                <div className="detail-devmode-hint" style={{ color: 'var(--color-blocked)', marginTop: 6 }}>
                  {reviewError}
                </div>
              )}

              {/* Result */}
              {reviewMarkdown && (
                <div className="detail-devmode-review-result">
                  <MarkdownView markdown={reviewMarkdown} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
        </>
      )}
    </div>
  );
});
