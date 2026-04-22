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
import { useState, useEffect } from 'react';
import type { Task, Customer } from '../types';
import Icon from './Icon';
import * as tauriApi from '../lib/tauriCommands';
import { hintedPluginProject } from '../lib/resolveTaskDevTarget';

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
}

export default function TaskDevModePanel({
  task,
  pluginsDir,
  repoRootForGit,
  defaultMode,
  scriptOpenPath,
  onError,
  autoCollapsed = false,
}: TaskDevModePanelProps) {
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
  const [pluginOpenHint, setPluginOpenHint]               = useState<string | null>(null);

  // --- branch (V2) ---
  const [currentBranch, setBranch]          = useState<string | null>(null);
  const [branches, setBranches]             = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [branchDirty, setBranchDirty]       = useState(false);
  const [branchLoading, setBranchLoading]   = useState(false);
  const [branchSwitching, setBranchSwitching] = useState(false);
  const [branchError, setBranchError]       = useState<string | null>(null);

  // Reset all state when the viewed task changes.
  useEffect(() => {
    setExpanded(!autoCollapsed);
    setDevMode(defaultMode === 'plugin' ? 'plugin' : 'script');
    setSelectedPlugin('');
    setPluginProjects([]);
    setPluginProjectsLoaded(false);
    setPluginOpenHint(null);
    setBranch(null);
    setBranches([]);
    setSelectedBranch('');
    setBranchDirty(false);
    setBranchError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  // Load plugin project subfolders when mode = plugin.
  useEffect(() => {
    if (devMode !== 'plugin' || !pluginsDir || pluginProjectsLoaded) return;
    setPluginProjectsLoading(true);
    tauriApi.listSubfolders(pluginsDir)
      .then((folders) => {
        setPluginProjects(folders);
        const hint = hintedPluginProject(task);
        if (hint && folders.includes(hint)) setSelectedPlugin(hint);
        else if (folders.length === 1) setSelectedPlugin(folders[0]);
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
      setSelectedPlugin('');
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

          {!pluginProjectsLoading && pluginProjectsLoaded && pluginProjects.length === 0 && (
            <div className="detail-devmode-hint">
              No plugin project folders found{pluginsDir ? ` in ${pluginsDir}` : ''}.
            </div>
          )}

          {!pluginProjectsLoading && pluginProjects.length > 0 && (
            <select
              className="form-select"
              value={selectedPlugin}
              onChange={(e) => setSelectedPlugin(e.target.value)}
            >
              <option value="">— select plugin project —</option>
              {pluginProjects.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
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
        </>
      )}
    </div>
  );
}
