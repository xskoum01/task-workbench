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
import type { Task, Customer, AiReviewerConfig, AiStructuredReview, AiFileReviewResult } from '../types';
import Icon from './Icon';
import Modal from './Modal';
import * as tauriApi from '../lib/tauriCommands';
import { openReviewTarget } from '../lib/openReviewTarget';
import { hintedPluginProject } from '../lib/resolveTaskDevTarget';
import { mergeWithDefaults, selectReviewer } from '../lib/aiReviewers';
import AiReviewResultView from './AiReviewResultView';
import CodeChangeReviewModal from './CodeChangeReviewModal';

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
   * Called when the filesystem refresh detects that a persisted plugin project
   * folder no longer exists on disk. The parent should clear workflowSetup.pluginProject
   * and task.selectedPluginProject, preserving the name as desiredPluginProject.
   */
  onPluginProjectMissing?: (projectName: string) => void;
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
  /**
   * Absolute path of an artifact file created by "Apply Draft" in a Create workflow.
   * When set:
   *   - Script mode: opens this file instead of the generic scriptOpenPath folder.
   *   - Plugin mode: skips .sln/.csproj search and opens this file directly.
   *   - AI Review: uses this path directly; skips inference.
   */
  artifactPath?: string;
  /**
   * Latest persisted AI review for this task.
   * Shown in the modal when no fresh run has been performed in this session.
   */
  initialReview?: AiFileReviewResult;
  /**
   * Called after a successful review so the parent can persist the result to the task.
   * Used when review runs from the panel's own modal (no status advance follows).
   */
  onReviewSaved?: (review: AiFileReviewResult) => void;
  /**
   * Called after a git-diff change review completes successfully inside the diff modal.
   * Carries the review result so the parent can persist it and advance status in one
   * atomic updateTask call (avoids stale-closure overwrite).
   */
  onChangeReviewComplete?: (review: AiFileReviewResult) => void;
}

export interface TaskDevModePanelHandle {
  /**
   * Runs the AI file review using the currently configured file path and reviewer.
   * Returns the review result when the review completes successfully so the caller
   * can persist it and advance status in one atomic update.
   * Returns false on error, missing config, or when a diff modal was opened instead.
   */
  runReview(): Promise<AiFileReviewResult | false>;
  /**
   * Opens the AI review modal with the current file/reviewer prefilled.
   * Does NOT immediately run the review — user presses Run inside the modal.
   */
  openReviewModal(): Promise<void>;
}

export default forwardRef<TaskDevModePanelHandle, TaskDevModePanelProps>(function TaskDevModePanel({
  task,
  customer,
  pluginsDir,
  repoRootForGit,
  defaultMode,
  scriptOpenPath,
  onError,
  autoCollapsed = false,
  onSelectedPluginChange,
  onPluginProjectMissing,
  selectedPluginProject: persistedSelectedPlugin,
  pluginRefreshTick = 0,
  reviewerConfigs,
  artifactPath,
  initialReview,
  onReviewSaved,
  onChangeReviewComplete,
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
  // Persisted plugin project that was not found on disk after a refresh.
  const [persistedProjectMissing, setPersistedProjectMissing] = useState<string | null>(null);

  // --- branch (V2) ---
  const [currentBranch, setBranch]          = useState<string | null>(null);
  const [branches, setBranches]             = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [branchDirty, setBranchDirty]       = useState(false);
  const [branchLoading, setBranchLoading]   = useState(false);
  const [branchSwitching, setBranchSwitching] = useState(false);
  const [branchError, setBranchError]       = useState<string | null>(null);

  // Diff-based change review (Update / Fix workflows).
  const [diffModalOpen, setDiffModalOpen]     = useState(false);
  const [diffContent, setDiffContent]         = useState('');
  const [diffLoadingGit, setDiffLoadingGit]   = useState(false);

  // Whether this task uses diff-based review (Update or Fix workIntent).
  const workIntent = task.workflowSetup?.workIntent;
  const isDiffWorkflow = workIntent === 'update' || workIntent === 'fix';

  // --- AI Review state ---
  const [reviewModalOpen, setReviewModalOpen]           = useState(false);
  const [reviewFilePath, setReviewFilePath]             = useState('');
  const [reviewPathUserEdited, setReviewPathUserEdited] = useState(false);
  const [reviewSelectedId, setReviewSelectedId]         = useState('');
  const [reviewRunning, setReviewRunning]               = useState(false);
  const [reviewError, setReviewError]                   = useState<string | null>(null);
  const [reviewMarkdown, setReviewMarkdown]             = useState<string | null>(null);
  const [reviewStructured, setReviewStructured]         = useState<AiStructuredReview | null>(null);
  const [reviewInferring, setReviewInferring]           = useState(false);
  const [reviewInferError, setReviewInferError]         = useState<string | null>(null);

  // Reset all state when the viewed task changes.
  useEffect(() => {
    setExpanded(!autoCollapsed);
    setDevMode(defaultMode === 'plugin' ? 'plugin' : 'script');
    updateSelectedPlugin('');
    setPluginProjects([]);
    setPluginProjectsLoaded(false);
    setPluginOpenHint(null);
    setHintedProjectMissing(null);
    setPersistedProjectMissing(null);
    setBranch(null);
    setBranches([]);
    setSelectedBranch('');
    setBranchDirty(false);
    setBranchError(null);
    // Reset review state
    setReviewModalOpen(false);
    setReviewFilePath('');
    setReviewPathUserEdited(false);
    setReviewSelectedId('');
    setReviewMarkdown(null);
    setReviewStructured(null);
    setReviewError(null);
    setReviewInferError(null);
    setReviewInferring(false);
    // Reset diff modal state
    setDiffModalOpen(false);
    setDiffContent('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  // Re-scan plugin projects when the parent signals a refresh (e.g. after creating a new project).
  useEffect(() => {
    if (!pluginRefreshTick) return; // skip initial mount (tick = 0)
    setPluginProjects([]);
    setPluginProjectsLoaded(false);
    // Use setSelectedPlugin (not updateSelectedPlugin) so the parent's persisted project name
    // is NOT cleared via onSelectedPluginChange — we need it intact for post-refresh auto-select.
    setSelectedPlugin('');
    setPluginOpenHint(null);
    setHintedProjectMissing(null);
    setPersistedProjectMissing(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginRefreshTick]);

  // Auto-fill review file path from persisted artifactPath when it becomes available.
  // Only runs when the user has not manually typed a path into the review modal.
  useEffect(() => {
    if (reviewPathUserEdited) return;
    if (artifactPath) {
      setReviewFilePath(artifactPath);
      setReviewError(null);
      setReviewInferError(null);
    }
  }, [artifactPath, reviewPathUserEdited]);

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
          setPersistedProjectMissing(null);
        } else if (persistedSelectedPlugin && !folders.includes(persistedSelectedPlugin)) {
          // The persisted project no longer exists on disk — notify parent to clear it.
          setPersistedProjectMissing(persistedSelectedPlugin);
          onPluginProjectMissing?.(persistedSelectedPlugin);
          // Let heuristic/single-folder fallback take over below.
          const hint = hintedPluginProject(task);
          if (hint && folders.includes(hint)) {
            updateSelectedPlugin(hint);
            setHintedProjectMissing(null);
          } else {
            setHintedProjectMissing(null);
            if (folders.length === 1) updateSelectedPlugin(folders[0]);
          }
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
    // Prefer the specific artifact file (created or selected), fall back to scriptOpenPath.
    const filePath = artifactPath ?? scriptOpenPath;
    if (!filePath) { onError('No script path configured for this customer.'); return; }

    // Determine whether filePath is a concrete file or just a folder.
    const norm = filePath.replace(/\\/g, '/');
    const lower = norm.toLowerCase();
    const isFile = lower.endsWith('.js') || lower.endsWith('.ts')
                || lower.endsWith('.jsx') || lower.endsWith('.tsx');

    try {
      if (isFile) {
        // File: open workspace root + the file so VS Code has full repo context.
        const workspaceRoot =
          customer?.resolvedRepositoryPath ??
          customer?.repositoryRoot ??
          (() => {
            // Climb up from CRM_Code/Scripts/... to CRM_Code
            const crmIdx = norm.toLowerCase().lastIndexOf('/crm_code/');
            if (crmIdx !== -1) return norm.slice(0, crmIdx + '/crm_code'.length);
            // Fall back to parent folder of the file.
            const slash = norm.lastIndexOf('/');
            return slash > 0 ? norm.slice(0, slash) : undefined;
          })();
        if (workspaceRoot) {
          await tauriApi.openInVscodeWorkspace(workspaceRoot, filePath);
        } else {
          await tauriApi.openInVscode(filePath);
        }
      } else {
        // It is already a folder — open it as-is.
        await tauriApi.openInVscode(filePath);
      }
    } catch (e) { onError(String(e)); }
  }

  function handleRefreshPlugins() {
    setPluginProjectsLoaded(false);
    setPluginProjects([]);
    updateSelectedPlugin('');
    setPluginOpenHint(null);
  }

  async function handleOpenPlugin() {
    if (!pluginsDir || !selectedPlugin) { onError('Select a plugin project first.'); return; }
    // Always open the plugin project/solution in Visual Studio — never a raw .cs file.
    // artifactPath is used for AI Review file selection only, not for opening the project.
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
        console.log('[devTarget] final path=', target, '(from .csproj → Visual Studio)');
        await tauriApi.openWithShell(target); return;
      }
      const exists = await tauriApi.checkPathExists(pluginPath);
      if (!exists) { onError('Plugin not found on the current branch or path.'); return; }
      console.log('[devTarget] final path=', pluginPath, '(folder — no .sln/.csproj)');
      await tauriApi.openWithShell(pluginPath);
    } catch (e) { onError(String(e)); }
  }

  // --- AI Review helpers ---

  /**
   * Returns the list of enabled reviewer configs (merged with defaults).
   * Returns empty array when no reviewer configs are provided.
   */
  const allReviewers = reviewerConfigs ? mergeWithDefaults(reviewerConfigs).filter((r) => r.enabled) : [];

  // Effective path for review: user-typed value wins; fall back to persisted artifactPath.
  // Used for validation, disabled checks, and reviewer auto-selection.
  const effectiveReviewFilePath = reviewFilePath.trim() || (artifactPath ?? '');

  /**
   * Infers the best concrete file path for AI review.
   * Never overwrites a path the user has manually edited.
   *
   * Script mode:
   *   - If scriptOpenPath (or artifactPath) ends with .js/.ts/.jsx/.tsx → use it directly.
   *   - Otherwise it is a folder → ask the backend to find the best .js/.ts inside it.
   *   - If nothing found, returns '' and sets reviewInferError so the modal prompts the user.
   *
   * Plugin mode: calls the Rust backend to find the best .cs file in the plugin folder,
   * using the task title as a class-name hint to improve matching.
   */
  async function inferReviewPath(): Promise<string> {
    // Never infer if the user has already typed something manually.
    if (reviewPathUserEdited) return reviewFilePath;
    // A created artifact always wins — no inference needed.
    if (artifactPath) return artifactPath;

    if (devMode === 'script') {
      const base = scriptOpenPath ?? '';
      if (!base) return '';
      // Detect whether base is a concrete script file.
      const lower = base.toLowerCase();
      const isFile = lower.endsWith('.js') || lower.endsWith('.ts')
                  || lower.endsWith('.jsx') || lower.endsWith('.tsx');
      if (isFile) return base;
      // It is a folder — try to find the best script file inside it.
      setReviewInferring(true);
      setReviewInferError(null);
      try {
        const found = await tauriApi.inferReviewFilePath(base, 'script', '', task.title);
        if (!found) {
          setReviewInferError(`No .js/.ts file found in ${base}. Enter the file path manually.`);
          return '';
        }
        return found;
      } catch {
        setReviewInferError('Could not search for script files. Enter the path manually.');
        return '';
      } finally {
        setReviewInferring(false);
      }
    }

    if (devMode === 'plugin' && pluginsDir && selectedPlugin) {
      const dirPath = `${pluginsDir}/${selectedPlugin}`;
      setReviewInferring(true);
      setReviewInferError(null);
      try {
        const found = await tauriApi.inferReviewFilePath(dirPath, 'plugin', selectedPlugin, task.title);
        if (!found) {
          setReviewInferError(`No .cs file found in ${selectedPlugin}. Enter the path manually.`);
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
    return selectReviewer(allReviewers, effectiveReviewFilePath, devMode);
  }

  /** Opens the AI review modal, inferring the file path if not yet set. */
  async function handleOpenReviewModal() {
    const effectivePath = reviewFilePath.trim() || (artifactPath ?? '');
    if (!reviewPathUserEdited && !effectivePath) {
      const defaultPath = await inferReviewPath();
      setReviewFilePath((prev) => prev || defaultPath);
    }
    // If no fresh result for this session, show the latest persisted review.
    if (!reviewStructured && !reviewMarkdown && initialReview) {
      if (initialReview.structured) setReviewStructured(initialReview.structured);
      if (initialReview.markdown)   setReviewMarkdown(initialReview.markdown ?? null);
    }
    setReviewModalOpen(true);
  }

  /**
   * Loads the git diff for the current file/repo and updates `diffContent`.
   * Returns the loaded diff string (empty string when nothing changed or on error).
   *
   * For script workflows, derives the Git repo root by walking up from the
   * selected file when effectiveRepoRoot is missing or not a Git repo.
   */
  async function handleLoadGitDiff(): Promise<string> {
    const filePath = (reviewFilePath.trim() || artifactPath || '').trim() || undefined;
    setDiffLoadingGit(true);
    try {
      // 1. Resolve the Git repo root to use for this diff.
      let repoRoot: string | undefined;

      // Try the pre-configured root first.
      if (effectiveRepoRoot) {
        const hasGit = await tauriApi.checkPathExists(`${effectiveRepoRoot.replace(/[\\/]+$/, '')}/.git`).catch(() => false);
        if (hasGit) repoRoot = effectiveRepoRoot;
      }

      // If the configured root is missing or not a Git repo, walk upward from the file.
      if (!repoRoot && filePath) {
        const norm = filePath.replace(/\\/g, '/');
        const parts = norm.split('/');
        // Walk from the file's directory upward (skip the file name itself).
        for (let i = parts.length - 1; i > 0; i--) {
          const candidate = parts.slice(0, i).join('/');
          if (!candidate) break;
          const hasGit = await tauriApi.checkPathExists(`${candidate}/.git`).catch(() => false);
          if (hasGit) { repoRoot = candidate; break; }
        }
      }

      if (!repoRoot) {
        const hint = filePath
          ? `Git repository was not found for this file. Make sure the file is inside a Git repo.`
          : `No Git repository root configured. Set repositoryRoot on the customer.`;
        setDiffContent(hint);
        return '';
      }

      const diff = await tauriApi.getGitDiff(repoRoot, filePath);
      setDiffContent(diff);
      return diff;
    } catch (e) {
      const msg = String(e);
      setDiffContent(`// Error loading diff:\n// ${msg}`);
      return '';
    } finally {
      setDiffLoadingGit(false);
    }
  }

  /**
   * Runs the AI change review over whatever is currently in `diffContent`.
   * Called from inside CodeChangeReviewModal when the user clicks Run AI Review.
   */
  async function handleRunDiffReview() {
    if (!diffContent.trim()) { setReviewError('Diff je prázdný — vložte kód nebo diff ke kontrole.'); return; }
    const reviewer = getActiveReviewer();
    if (!reviewer) { setReviewError('Žádný recenzent. Nastavte AI Reviewers v Settings.'); return; }
    const path = (reviewFilePath.trim() || artifactPath || '').trim();
    const fileName = path ? path.replace(/\\/g, '/').split('/').pop() ?? path : 'changed file';
    setReviewRunning(true);
    setReviewError(null);
    setReviewMarkdown(null);
    setReviewStructured(null);
    try {
      const result = await tauriApi.runAiChangeReview(
        diffContent,
        task.title,
        fileName,
        reviewer.name,
        reviewer.instructions,
        reviewer.model ?? '',
        reviewer.temperature ?? 0.2,
      );
      if (result.structured) setReviewStructured(result.structured);
      if (result.markdown)   setReviewMarkdown(result.markdown);
      const persisted: AiFileReviewResult = {
        ...result,
        id: crypto.randomUUID(),
        reviewerId:   reviewer.id,
        reviewerName: reviewer.name,
        // Use the full resolved path when available; fall back to base file name.
        filePath:     path || fileName,
        reviewMode:   'change',
        reviewedAt:   new Date().toISOString(),
      };
      // Pass the review to onChangeReviewComplete so the parent can persist it and
      // advance status in a SINGLE updateTask call. Do NOT call onReviewSaved separately
      // here — that would cause two updateTask calls and the second (status) would
      // overwrite aiFileReviews due to stale closure capture.
      setDiffModalOpen(false);
      // Show the review result in the normal review modal.
      setReviewModalOpen(true);
      onChangeReviewComplete?.(persisted);
    } catch (err) {
      setReviewError(String(err));
    } finally {
      setReviewRunning(false);
    }
  }

  async function handleRunReview(calledFromHandle = false): Promise<AiFileReviewResult | false> {
    // Update / Fix workflows: review only the git diff, not the whole file.
    if (isDiffWorkflow) {
      // Ensure review file path is resolved before loading the diff.
      if (!reviewPathUserEdited && !reviewFilePath.trim() && !artifactPath) {
        const defaultPath = await inferReviewPath();
        setReviewFilePath((prev) => prev || defaultPath);
      }
      const diff = await handleLoadGitDiff();
      setDiffContent(diff);
      setDiffModalOpen(true);
      // Return false — status advance + persistence happen via onChangeReviewComplete.
      return false;
    }

    // Create workflows: review the full artifact file (existing behaviour).
    const path = (reviewFilePath.trim() || artifactPath || '').trim();
    if (!path) { setReviewError('Enter the file path to review.'); return false; }
    const reviewer = getActiveReviewer();
    if (!reviewer) { setReviewError('No matching reviewer. Configure one in Settings → AI Reviewers.'); return false; }
    setReviewRunning(true);
    setReviewError(null);
    setReviewMarkdown(null);
    setReviewStructured(null);
    try {
      const result = await tauriApi.runAiFileReview(
        path,
        reviewer.name,
        reviewer.instructions,
        reviewer.model ?? '',
        reviewer.temperature ?? 0.2,
      );
      if (result.structured) setReviewStructured(result.structured);
      if (result.markdown)   setReviewMarkdown(result.markdown);
      const persisted: AiFileReviewResult = {
        ...result,
        id: crypto.randomUUID(),
        reviewerId:   reviewer.id,
        reviewerName: reviewer.name,
        filePath:     path,
        reviewMode:   'file',
        reviewedAt:   new Date().toISOString(),
      };
      if (!calledFromHandle) {
        // Called from the modal Run button directly (e.g. "Spustit znovu") — no status advance
        // will follow, so persist immediately via the callback.
        onReviewSaved?.(persisted);
      }
      // Always return the review so the imperative handle can combine it with status advance.
      return persisted;
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
      if (isDiffWorkflow) {
        // Diff workflow: handleRunReview opens diffModalOpen itself.
        // Returns false — parent waits for onChangeReviewComplete to combine save + status.
        return handleRunReview(true);
      }
      // Full-file workflow: open the review modal so the user sees the results.
      const effectivePath = reviewFilePath.trim() || (artifactPath ?? '');
      if (!reviewPathUserEdited && !effectivePath) {
        const defaultPath = await inferReviewPath();
        setReviewFilePath((prev) => prev || defaultPath);
      }
      setReviewModalOpen(true);
      // Pass calledFromHandle=true so onReviewSaved is NOT called inside handleRunReview.
      // The returned review is used by the parent to combine aiFileReviews + status in one updateTask.
      return handleRunReview(true);
    },
    openReviewModal: async () => {
      await handleOpenReviewModal();
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
                <div
                  className="detail-devmode-branch-error"
                  title={branchError}
                >
                  {/not a git repository/i.test(branchError)
                    ? 'Git repository not detected for this path.'
                    : branchError}
                </div>
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

          {!pluginProjectsLoading && pluginProjectsLoaded && persistedProjectMissing && (
            <div className="detail-devmode-hint" style={{ color: 'var(--color-warning, #d29922)' }}>
              Plugin project <strong>{persistedProjectMissing}</strong> was not found on disk.
              Create it again or select another project.
            </div>
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

          {!pluginProjectsLoading && pluginProjectsLoaded && pluginProjects.length > 0 && !selectedPlugin && (
            <div className="detail-devmode-hint">
              Select a plugin project to open or review code.
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
            {pluginOpenHint?.startsWith('.sln') || pluginOpenHint?.startsWith('.csproj') ? 'Open Plugin in Visual Studio' : 'Open Plugin Folder'}
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

      {/* AI Review — shown when reviewer configs are available */}
      {allReviewers.length > 0 && (
        <button
          className="btn btn-secondary btn-sm btn-full"
          onClick={handleOpenReviewModal}
          disabled={reviewInferring}
          type="button"
        >
          <Icon name="search" size={12} />
          {reviewInferring ? 'Searching file…' : 'Run AI Review'}
        </button>
      )}
        </>
      )}

      {/* AI Review modal — rendered outside the expanded block so it persists if the panel collapses */}
      {reviewModalOpen && (
        <Modal
          title="AI Code Review"
          size="xl"
          onClose={() => setReviewModalOpen(false)}
          footer={
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setReviewModalOpen(false)}
              type="button"
            >
              Close
            </button>
          }
        >
          <div className="ai-review-modal-body">
            <div className="ai-review-modal-fields">
              {/* File path input */}
              <div className="ai-review-modal-row">
                <label className="form-label">File to review</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="C:\path\to\file.cs"
                  value={reviewFilePath}
                  onChange={(e) => {
                    setReviewFilePath(e.target.value);
                    setReviewPathUserEdited(true);
                    setReviewSelectedId('');
                    setReviewMarkdown(null);
                    setReviewStructured(null);
                    setReviewError(null);
                    setReviewInferError(null);
                  }}
                />
                {reviewInferring && (
                  <div className="detail-devmode-hint" style={{ marginTop: 3 }}>Searching for file…</div>
                )}
                {reviewInferError && !effectiveReviewFilePath && (
                  <div className="detail-devmode-hint" style={{ color: 'var(--color-blocked)', marginTop: 3 }}>
                    {reviewInferError}
                  </div>
                )}
              </div>

              {/* Reviewer selector */}
              <div className="ai-review-modal-row">
                <label className="form-label">Reviewer</label>
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
                {!getActiveReviewer() && effectiveReviewFilePath && (
                  <div className="detail-devmode-hint" style={{ color: 'var(--color-blocked)', marginTop: 3 }}>
                    No reviewer matches this file type. Configure one in Settings → AI Reviewers.
                  </div>
                )}
              </div>

              {/* Run button */}
              <button
                className="btn btn-primary btn-sm"
                onClick={() => handleRunReview(false)}
                disabled={reviewRunning || reviewInferring || !effectiveReviewFilePath || !getActiveReviewer()}
                type="button"
              >
                {reviewRunning
                  ? <><span className="btn-spinner" /> Running review…</>
                  : <><Icon name="search" size={12} /> Run AI Review</>}
              </button>

              {/* Error */}
              {reviewError && (
                <div className="detail-devmode-hint" style={{ color: 'var(--color-blocked)' }}>
                  {reviewError}
                </div>
              )}
            </div>

            {/* Structured or markdown result */}
            {(reviewStructured || reviewMarkdown) && (
              <div className="ai-review-modal-result">
                <AiReviewResultView
                  structured={reviewStructured ?? undefined}
                  markdown={reviewMarkdown ?? undefined}
                  onOpenFile={async (fp) => {
                    // Use the shared helper: .cs → open .sln in Visual Studio, .js/.ts → VS Code.
                    const err = await openReviewTarget(fp, devMode === 'plugin' ? 'plugin' : 'script');
                    if (err) setReviewError(err);
                  }}
                  openLabel={devMode === 'plugin' ? 'Otevřít projekt' : 'Otevřít soubor'}
                  openTitle={devMode === 'plugin' ? 'Otevře .sln ve Visual Studiu, pokud existuje.' : 'Otevře soubor ve VS Code.'}
                />
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Diff-based change review modal — shown for Update / Fix workflows */}
      {diffModalOpen && (
        <CodeChangeReviewModal
          diff={diffContent}
          onChange={setDiffContent}
          fileName={
            (reviewFilePath.trim() || artifactPath || '')
              .replace(/\\/g, '/')
              .split('/')
              .pop() ?? ''
          }
          loadingDiff={diffLoadingGit}
          runningReview={reviewRunning}
          onLoadGitDiff={handleLoadGitDiff}
          onRunReview={handleRunDiffReview}
          onClose={() => setDiffModalOpen(false)}
        />
      )}
    </div>
  );
});
