/**
 * Typed wrappers around Tauri's invoke() for all persistence and
 * filesystem commands. Maps 1-to-1 with the Rust commands in lib.rs.
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  Task,
  Customer,
  AppSettings,
  TaskStorageStatus,
  TaskAnalysis,
  SkeletonPreview,
  GitInitStatus,
  OutlookMessage,
  OutlookFlaggedListResult,
  TeamsChat,
  TeamsChatMessage,
  TeamsFlatMessage,
  ClassificationResult,
  AiFileReviewResult,
  AiStructuredReview,
  CrmRawExtractedReferences,
  CrmSkeletonResult,
  CrmVerificationReport,
  GitCommitPreview,
  GitCommitResult,
  GitPushResult,
} from '../types';
import type { WorkItem, WorkItemActorType } from '../domain/workItem';

export type { ClassificationResult };

// --- Persistence -----------------------------------------------------------

export function loadTasks(): Promise<Task[]> {
  return invoke<Task[]>('load_tasks');
}

export function saveTasks(tasks: Task[]): Promise<void> {
  return invoke('save_tasks', { tasks });
}

export interface WorkItemMigrationReport {
  databasePath: string;
  imported: number;
  skipped: number;
  sourceChecksum?: string;
  alreadyCompleted: boolean;
}

export interface WorkItemChangeRecord {
  sequence: number;
  workItemId: string;
  revision: number;
  changedAt: string;
  action: string;
}

export interface WorkItemListResult {
  apiVersion: string;
  generatedAt: string;
  snapshotRevision: number;
  items: WorkItem[];
  nextCursor: string | null;
}

export interface WorkItemChangesResult {
  apiVersion: string;
  changes: WorkItemChangeRecord[];
  nextCursor: number | null;
}

export interface TaskRecordDetailResult {
  apiVersion: string;
  canonical: WorkItem;
  legacyTask: Task | Record<string, unknown>;
  derived: {
    workflowType: 'developer' | 'general';
    recordStatus: string;
    recordStatusLabel: string;
    recordStatusOptions: Array<{ value: string; label: string }>;
    planningBucket: string | null;
    notesText: string;
    externalLinks: unknown[];
  };
}

export function initializeWorkItemStorage(): Promise<WorkItemMigrationReport> {
  return invoke<WorkItemMigrationReport>('initialize_work_item_storage');
}

export function listWorkItems(includeArchived = false, limit = 200): Promise<WorkItemListResult> {
  return invoke<WorkItemListResult>('list_work_items', { includeArchived, limit });
}

export function getWorkItem(id: string): Promise<WorkItem | null> {
  return invoke<WorkItem | null>('get_work_item', { id });
}

export function getTaskRecord(id: string): Promise<TaskRecordDetailResult> {
  return invoke<TaskRecordDetailResult>('get_task_record', { id });
}

export function createWorkItem(item: WorkItem, idempotencyKey?: string): Promise<WorkItem> {
  return invoke<WorkItem>('create_work_item', { item, idempotencyKey });
}

export function updateWorkItem(
  id: string,
  item: WorkItem,
  expectedRevision: number,
  actorType: WorkItemActorType = 'user',
  actorName?: string,
): Promise<WorkItem> {
  return invoke<WorkItem>('update_work_item', {
    id,
    item,
    expectedRevision,
    actorType,
    actorName,
  });
}

export function listWorkItemChanges(after = 0, limit = 200): Promise<WorkItemChangesResult> {
  return invoke<WorkItemChangesResult>('list_work_item_changes', { after, limit });
}

export function getPlanningToday(timezone?: string): Promise<unknown> {
  return invoke('get_planning_today', { timezone });
}

/** Explicitly clears all tasks. Bypasses the empty-overwrite guard. */
export function clearAllTasks(): Promise<void> {
  return invoke('clear_all_tasks');
}

/** Returns storage diagnostics: task count, backup count, restore-needed signal. */
export function checkTaskStorage(): Promise<TaskStorageStatus> {
  return invoke<TaskStorageStatus>('check_task_storage');
}

/** Restores the most-recent non-empty backup to tasks.json. Returns restored count. */
export function restoreTasksFromLatestBackup(): Promise<number> {
  return invoke<number>('restore_tasks_from_latest_backup');
}

export function loadCustomers(): Promise<Customer[]> {
  return invoke<Customer[]>('load_customers');
}

export function saveCustomers(customers: Customer[]): Promise<void> {
  return invoke('save_customers', { customers });
}

export function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>('load_settings');
}

export function saveSettings(settings: AppSettings): Promise<void> {
  return invoke('save_settings', { settings });
}

// --- Filesystem ------------------------------------------------------------

/** Opens the given path in the OS file explorer. */
export function openPath(path: string): Promise<void> {
  return invoke('open_path', { path });
}

/** Opens the given path in VS Code. Rejects if `code` is not in PATH. */
export function openInVscode(path: string): Promise<void> {
  return invoke('open_in_vscode', { path });
}

/**
 * Opens a VS Code workspace folder, and optionally also opens a specific file
 * in the same VS Code instance. Runs: code "<workspacePath>" ["<filePath>"]
 */
export function openInVscodeWorkspace(workspacePath: string, filePath?: string): Promise<void> {
  return invoke('open_in_vscode_workspace', { workspacePath, filePath: filePath ?? null });
}

/** Open a file/folder using the OS default application (file association). */
export function openWithShell(path: string): Promise<void> {
  return invoke('open_with_shell', { path });
}

/** Opens an external web URL in Microsoft Edge. */
export function openExternalUrl(url: string): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) {
    return Promise.reject(new Error('No URL provided.'));
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return Promise.reject(new Error('Only http:// and https:// URLs can be opened.'));
  }
  const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return invoke('open_url_in_edge', { url: href });
}

export function isExternalWebUrl(value: string | undefined): boolean {
  return !!value && /^https?:\/\//i.test(value.trim());
}

/**
 * Shows the OS native folder-picker dialog.
 * Resolves to the selected folder path, or null if the user cancelled.
 */
export function pickFolder(): Promise<string | null> {
  return invoke<string | null>('pick_folder');
}

/**
 * Shows the OS native file-picker dialog filtered to the given extensions.
 * Returns the selected file path, or null if the user cancelled.
 * @param filterName  Display name of the filter group, e.g. "ZIP Archives"
 * @param extensions  File extensions without dots, e.g. ["zip"]
 */
export function pickFile(filterName: string, extensions: string[]): Promise<string | null> {
  return invoke<string | null>('pick_file', { filterName, extensions });
}

/**
 * Validates a repository template at the given path.
 * Returns 'not_selected' | 'valid' | 'invalid'.
 */
export function validateTemplate(
  path: string,
  templateType: 'zip' | 'folder',
): Promise<'not_selected' | 'valid' | 'invalid'> {
  return invoke('validate_template', { path, templateType });
}

/**
 * Extracts a ZIP template into targetPath, stripping the top-level folder
 * from the archive if there is one (e.g. _GIT_REPO_TEMPLATE/).
 */
export function createRepositoryFromTemplate(
  templatePath: string,
  targetPath: string,
): Promise<void> {
  return invoke('create_repository_from_template', { templatePath, targetPath });
}

/**
 * Initializes a Git repository in the given directory.
 * Safe to call on an already-initialized directory — returns 'already_exists'.
 * Returns a structured result; never throws on git failures.
 */
export function initializeGitRepository(
  path: string,
  branch: string,
  createInitialCommit: boolean,
): Promise<{ status: GitInitStatus; message: string; initialCommitCreated: boolean }> {
  return invoke('initialize_git_repository', { path, branch, createInitialCommit });
}

/** Returns true if the given filesystem path exists. */
export function checkPathExists(path: string): Promise<boolean> {
  return invoke<boolean>('check_path_exists', { path });
}

/**
 * For each customer, resolves the repository path using:
 *   1. repositoryRootOverride (if set)
 *   2. baseDir + folderName   (if baseDir and folderName are set)
 *   3. repositoryRoot         (fallback)
 * Returns customers with updated repositoryStatus and resolvedRepositoryPath.
 */
export function rescanRepositories(customers: Customer[], baseDir: string): Promise<Customer[]> {
  return invoke<Customer[]>('rescan_repositories', { customers, baseDir });
}

/**
 * Lists immediate subfolder names under the given CRM base directory.
 * Returns an empty array when the directory is empty or not configured.
 * Hidden folders (starting with '.') are excluded.
 */
export function listCrmFolders(baseDir: string): Promise<string[]> {
  return invoke<string[]>('list_crm_folders', { baseDir });
}

// --- AI commands -----------------------------------------------------------

/**
 * Calls Claude to analyse a task. Reads the API key from settings.json in
 * Rust — the key is never exposed to the frontend.
 * Rejects if no API key is configured or the request fails.
 */
export function analyzeTask(task: Task, customer: Customer | null): Promise<TaskAnalysis> {
  return invoke('analyze_task', { task, customer });
}

/** Generates a professional reply draft for the task. Returns plain text. */
export function generateReply(task: Task, customer: Customer | null): Promise<string> {
  return invoke('generate_reply', { task, customer });
}

/** Generates a C# plugin skeleton and returns a SkeletonPreview object. */
export function generateSkeletonPreview(task: Task, customer: Customer | null): Promise<SkeletonPreview> {
  return invoke('generate_skeleton_preview', { task, customer });
}

/** Tests Primarch MCP server connectivity by running initialize + tools/list only. */
export function testPrimarchMcpConnection(settingsOverride?: Partial<AppSettings>): Promise<{ status: string; message: string; toolCount?: number; safeToolCount?: number }> {
  return invoke('test_primarch_mcp_connection', {
    settingsOverride: settingsOverride ?? null,
  });
}

/** Returns status and published tools for the local task-workbench MCP bridge. */
export function getTaskMcpBridgeStatus(): Promise<{
  active: boolean;
  host: string;
  port: number;
  serverPath: string;
  readOnlyMode: boolean;
  localWriteMode: boolean;
  readOnlyTools: Array<{ name: string; description: string; readOnly: boolean }>;
  localWriteTools: Array<{ name: string; description: string; readOnly: boolean }>;
  lastError?: string;
}> {
  return invoke('get_task_mcp_bridge_status');
}

/** Lists MCP tools and marks each one as read-only safe or blocked. */
export function listPrimarchMcpTools(): Promise<{ tools: Array<{ name: string; description: string; readOnly: boolean }>; message?: string }> {
  return invoke('list_primarch_mcp_tools');
}

/** Generate CRM metadata-based pseudo-code skeleton (read-only metadata calls only). */
export function generateCrmSkeleton(
  task: Task,
  customer: Customer | null,
  workflowSetup?: Task['workflowSetup'],
): Promise<CrmSkeletonResult> {
  return invoke('generate_crm_skeleton', { task, customer, workflowSetup: workflowSetup ?? null });
}

/** Returns true when the repository has at least one commit (HEAD resolves). False for new/empty repos. */
export function gitHasHead(repoPath: string): Promise<boolean> {
  return invoke('git_has_head', { repoPath });
}

// --- Git commit / push commands -------------------------------------------

/** Returns a preview of pending git changes and a suggested commit message. Read-only. */
export function getGitCommitPreview(repoRoot: string, taskJson?: unknown): Promise<GitCommitPreview> {
  return invoke('get_git_commit_preview', { repoRoot, taskJson: taskJson ?? null });
}

/**
 * Stages the listed files and creates a git commit.
 * `forceAddFiles` (optional) force-adds specific `.gitignore`-matched paths — only pass paths
 * the user explicitly approved via the "Force-add" action on a gitignored task file.
 */
export function commitTaskChanges(
  repoRoot: string,
  files: string[],
  message: string,
  forceAddFiles?: string[],
): Promise<GitCommitResult> {
  return invoke('commit_task_changes', { repoRoot, files, message, forceAddFiles: forceAddFiles ?? null });
}

/** Pushes the current branch to origin. Blocks main/master; no force push. */
export function pushTaskBranch(repoRoot: string): Promise<GitPushResult> {
  return invoke('push_task_branch', { repoRoot });
}

/**
 * Stages files, commits, then pushes — single-step wrapper.
 * `forceAddFiles` (optional) — see commitTaskChanges.
 */
export function commitAndPushTaskChanges(
  repoRoot: string,
  files: string[],
  message: string,
  forceAddFiles?: string[],
): Promise<GitPushResult> {
  return invoke('commit_and_push_task_changes', { repoRoot, files, message, forceAddFiles: forceAddFiles ?? null });
}

/**
 * Creates a new local branch and switches to it.
 * Rejects if the branch already exists or the name is unsafe.
 * Never pushes, commits, or merges.
 */
export function createGitBranch(repoRoot: string, branchName: string): Promise<{ ok: boolean; branch: string }> {
  return invoke('create_git_branch', { repoRoot, branchName });
}

/**
 * Creates (from the current HEAD — no fetch, no rebase onto a remote base) or checks out the
 * given branch. Use this for the "AI proposed a name, user approved it" moment — unlike
 * createGitBranch, this never fetches from origin and never rejects because the branch already
 * exists (it checks it out instead). Never force-checks-out: if git refuses because uncommitted
 * changes would be overwritten, that refusal is surfaced as an error verbatim. Never commits
 * or pushes.
 */
export function createOrCheckoutTaskBranch(repoRoot: string, branchName: string): Promise<{
  ok: boolean;
  previousBranch: string;
  currentBranch: string;
  branchCreated: boolean;
  branchCheckedOut: boolean;
}> {
  return invoke('create_or_checkout_task_branch_command', { repoRoot, branchName });
}

/** Scans a C# file for Dataverse logical-name references using the Rust scanner (same as MCP path). */
export function scanCsFileForCrm(
  path: string,
  primaryEntityOverride?: string | null,
): Promise<CrmRawExtractedReferences & { ambiguousAttributes?: string[] }> {
  return invoke('scan_cs_file_for_crm', {
    path,
    primaryEntityOverride: primaryEntityOverride ?? null,
  });
}

/** Verify extracted CRM references against metadata (deterministic verdict). */
export function verifyAgainstCrm(
  task: Task,
  customer: Customer | null,
  scanResult: CrmRawExtractedReferences & { ambiguousAttributes?: string[] },
  filePath?: string,
  primaryEntityOverride?: string,
): Promise<CrmVerificationReport> {
  return invoke('verify_against_crm', {
    task,
    customer,
    scanResult,
    filePath: filePath ?? null,
    primaryEntityOverride: primaryEntityOverride ?? null,
  });
}

/** Writes content to the given absolute path, creating directories as needed. */
export function saveGeneratedFile(path: string, content: string): Promise<void> {
  return invoke('save_generated_file', { path, content });
}

export interface BuildCheckItem {
  id: string;
  result: 'pass' | 'warning' | 'fail' | 'skip';
  label: string;
  detail: string;
}

export interface BuildReadinessResult {
  status: 'passed' | 'warnings' | 'failed';
  checks: BuildCheckItem[];
  summary: string;
  buildAttempted: boolean;
  buildSucceeded?: boolean;
  buildOutput?: string;
}

/**
 * Checks plugin project build readiness: file-system prerequisites + optional msbuild.
 * `solutionDir` = parent of the .sln (e.g. pluginsDir/ProjectName/).
 * `artifactPath` = absolute path of the generated .cs file.
 */
export function checkPluginBuildReadiness(
  solutionDir: string,
  artifactPath?: string,
): Promise<BuildReadinessResult> {
  return invoke('check_plugin_build_readiness', {
    solutionDir,
    artifactPath: artifactPath ?? null,
  });
}

export interface NugetRestoreResult {
  /** true when Microsoft.Xrm.Sdk.dll exists on disk after restore. */
  success: boolean;
  /** "nuget_exe" | "direct_download" | "direct_download_failed" | "none" */
  method: string;
  message: string;
  dllExists: boolean;
  /** true when a missing Xrm.Sdk Reference was added to the .csproj (custom templates). */
  xrmRefAdded: boolean;
}

/**
 * Restores NuGet packages for a legacy packages.config plugin project.
 * `solutionDir` is the folder containing the .sln file (e.g. pluginsDir/ProjectName/).
 * Strategy: nuget.exe restore → direct NuGet.org download → warning.
 */
export function restoreNugetPackages(solutionDir: string): Promise<NugetRestoreResult> {
  return invoke('restore_nuget_packages', { solutionDir });
}

export interface CsprojUpdateResult {
  /** "added" | "already_present" | "sdk_style" | "no_csproj_found" */
  action: string;
  csprojPath?: string;
  message: string;
}

/**
 * After a .cs file is saved, adds a `<Compile Include="…" />` entry to the
 * legacy .csproj in the same directory.  SDK-style projects are detected and
 * skipped automatically.  Returns a tagged result the caller uses to show
 * appropriate feedback and set the next step.
 */
export function addCompileIncludeToCsproj(csFilePath: string): Promise<CsprojUpdateResult> {
  return invoke('add_compile_include_to_csproj', { csFilePath });
}

/**
 * Reads a source file from disk and runs a configurable AI reviewer against it.
 * The API key stays in Rust — it is never passed from the frontend.
 *
 * @param filePath      Absolute path to the file to review.
 * @param reviewerName  Display name of the reviewer (included in the result header).
 * @param instructions  Full reviewer instructions (system prompt).
 * @param modelOverride Optional model name. Pass '' to use the global AI model.
 * @param temperature   Model temperature (0–2). Pass 0 to use the reviewer default.
 */
export function runAiFileReview(
  filePath: string,
  reviewerName: string,
  instructions: string,
  modelOverride: string,
  temperature: number,
): Promise<AiFileReviewResult> {
  return invoke<{ structured: AiStructuredReview | null; markdown: string | null }>(
    'run_ai_file_review',
    { filePath, reviewerName, instructions, modelOverride, temperature },
  ).then(({ structured, markdown }) => {
    const result: AiFileReviewResult = { reviewerName, filePath };
    if (structured) {
      // Rust already injected reviewerName/filePath/fileName into the object.
      result.structured = structured;
    }
    if (markdown) {
      result.markdown = markdown;
    }
    return result;
  });
}

/**
 * Creates a new plugin project from a local template folder or built-in scaffold.
 * Copies the template (or generates built-in scaffold) into <pluginsDir>/<projectName>,
 * replacing __PROJECT_NAME__ and __NAMESPACE__ placeholders.
 *
 * @param legacyStyle When true and no custom template is configured, generates a legacy
 *   packages.config / Visual Studio style project (key.snk, app.config, AssemblyInfo).
 *   When false (default), generates an SDK-style csproj with PackageReference.
 *
 * Returns the absolute path of the created solution root folder.
 */
export function createPluginProjectFromTemplate(
  templateDir: string,
  pluginsDir: string,
  projectName: string,
  namespace: string,
  createInitialClass: boolean,
  legacyStyle: boolean = false,
): Promise<string> {
  return invoke('create_plugin_project_from_template', {
    templateDir,
    pluginsDir,
    projectName,
    namespace,
    createInitialClass,
    legacyStyle,
  });
}

/**
 * Calls Claude to classify an imported inbox item.
 * Returns a ClassificationResult with isTask, confidence, suggested title, etc.
 * Rejects if no API key is configured or the request fails.
 */
export function classifyInboxItem(item: Task): Promise<ClassificationResult> {
  return invoke('classify_inbox_item', { item });
}

/**
 * Resets local task and customer data by writing empty arrays to disk.
 * Settings and Microsoft tokens are preserved.
 */
export function resetLocalData(): Promise<void> {
  return invoke('reset_local_data');
}

// --- Script Assistant -------------------------------------------------------

/**
 * Reads the full content of a file from the customer repository for inspection.
 * Returns the content as a string, capped at 500 KB.
 * Rejects if the file does not exist.
 */
export function readFileContent(path: string): Promise<string> {
  return invoke<string>('read_file_content', { path });
}

/**
 * Lists file names (not full paths) in the given directory that match
 * the given extension (e.g. "js"). Returns empty array if dir not found.
 */
export function listDirectoryFiles(dir: string, extension: string): Promise<string[]> {
  return invoke<string[]>('list_directory_files', { dir, extension });
}

export interface FileEntry {
  /** Bare file name, e.g. "CustomerUpdate.js" */
  name: string;
  /** Absolute path with forward slashes, e.g. "C:/CRM/Customer/Scripts/CustomerUpdate.js" */
  path: string;
}

/**
 * Lists files under `dir` whose extension matches any entry in `extensions`.
 * Returns `{ name, path }` objects so callers have both the display name and
 * the absolute path without needing to reconstruct it.
 *
 * @param dir           Root directory to scan.
 * @param extensions    Extensions without dots, e.g. ["js", "ts"].
 * @param recursive     When true, descends into subdirectories.
 * @param excludedDirs  Subdirectory names to skip (case-insensitive), e.g. ["bin", "obj"].
 */
export function listFilesWithPaths(
  dir: string,
  extensions: string[],
  recursive: boolean,
  excludedDirs: string[],
): Promise<FileEntry[]> {
  return invoke<FileEntry[]>('list_files_with_paths', { dir, extensions, recursive, excludedDirs });
}

/**
 * Searches `basePath` recursively for the best candidate file to review.
 * For plugin mode: looks for .cs files (IPlugin preferred).
 * For script mode: looks for .js/.ts files (formContext/Xrm preferred).
 * Returns the absolute file path, or empty string if nothing found.
 */
export function inferReviewFilePath(
  basePath: string,
  mode: 'plugin' | 'script',
  projectName: string,
  /** Optional free-text hint (e.g. task title) used to boost files whose names match. */
  classHint: string = '',
): Promise<string> {
  return invoke<string>('infer_review_file_path', { basePath, mode, projectName, classHint });
}

/**
 * Lists immediate subfolder names under `dir` (hidden folders excluded, sorted).
 * Reuses the same Rust command as listCrmFolders.
 * Returns empty array if dir not found or not a directory.
 */
export function listSubfolders(dir: string): Promise<string[]> {
  return invoke<string[]>('list_crm_folders', { baseDir: dir });
}

/**
 * Given an absolute path to a reviewed file (e.g. a .cs plugin file), resolves
 * the best "open" target for its Visual Studio solution or project.
 *
 * Search order:
 *   1. .sln in the parent directory of the file (project folder)
 *   2. .sln one level above (solution root — most common layout)
 *   3. .csproj in the parent directory of the file
 *   4. the parent directory itself as a fallback folder
 *
 * Returns null when the file does not appear to be a C# plugin file.
 */
export async function resolvePluginOpenTargetFromFile(
  filePath: string,
): Promise<{ path: string; kind: 'sln' | 'csproj' | 'folder' } | null> {
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized.toLowerCase().endsWith('.cs')) return null;

  const parts = normalized.split('/');
  // fileDir: directory containing the .cs file
  const fileDir = parts.slice(0, -1).join('/');
  // solutionRoot: one level above fileDir
  const solutionRoot = parts.slice(0, -2).join('/');

  // 1. .sln inside the project folder (unusual but possible)
  const slnsInFileDir = await listDirectoryFiles(fileDir, 'sln').catch(() => [] as string[]);
  if (slnsInFileDir.length > 0) {
    return { path: `${fileDir}/${slnsInFileDir[0]}`, kind: 'sln' };
  }

  // 2. .sln one level above (solution root — standard VS layout)
  if (solutionRoot) {
    const slnsInRoot = await listDirectoryFiles(solutionRoot, 'sln').catch(() => [] as string[]);
    if (slnsInRoot.length > 0) {
      return { path: `${solutionRoot}/${slnsInRoot[0]}`, kind: 'sln' };
    }
  }

  // 3. .csproj in the project folder
  const csprojs = await listDirectoryFiles(fileDir, 'csproj').catch(() => [] as string[]);
  if (csprojs.length > 0) {
    return { path: `${fileDir}/${csprojs[0]}`, kind: 'csproj' };
  }

  // 4. fall back to the project folder itself
  return { path: fileDir, kind: 'folder' };
}

/**
 * Resolves the primary open target for a selected plugin project folder.
 *
 * Search order:
 *   1. .sln in <pluginsDir>/<selectedPluginProject>, preferring a solution
 *      whose basename matches the selected project folder name.
 *   2. The selected plugin project folder itself.
 *
 * Returns null when the inputs are missing or the selected project folder does
 * not exist.
 */
export async function resolveSelectedPluginOpenTarget(
  pluginsDir: string | undefined,
  selectedPluginProject: string | undefined,
): Promise<{ path: string; kind: 'sln' | 'folder' } | null> {
  const projectName = selectedPluginProject?.trim();
  if (!pluginsDir || !projectName) return null;

  const pluginPath = `${pluginsDir.replace(/[\\/]+$/, '').replace(/\\/g, '/')}/${projectName}`;
  const exists = await checkPathExists(pluginPath).catch(() => false);
  if (!exists) return null;

  const slns = await listDirectoryFiles(pluginPath, 'sln').catch(() => [] as string[]);
  if (slns.length > 0) {
    const sorted = [...slns].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const projectKey = projectName.toLowerCase();
    const matching =
      sorted.find((file) => file.replace(/\.sln$/i, '').toLowerCase() === projectKey) ??
      sorted.find((file) => file.toLowerCase().startsWith(projectKey));
    const chosen = matching ?? sorted[0];
    return { path: `${pluginPath}/${chosen}`, kind: 'sln' };
  }

  return { path: pluginPath, kind: 'folder' };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export interface GitReviewContext {
  repoRoot: string;
  currentBranch: string;
  baseBranch: string;
  /** All changed files (committed branch diff + working-tree status). */
  changedFiles: string[];
  /** Combined diff: branch diff + staged + unstaged, capped to safe sizes. */
  diff: string;
  hasStaged: boolean;
  hasUnstaged: boolean;
  hasCommitted: boolean;
  /** True when at least one relevant untracked file was read and added to `diff`. */
  hasUntracked: boolean;
  /** Relative paths of untracked files whose content was included in `diff`. */
  untrackedIncluded: string[];
  /** Relative paths of untracked files that were skipped (with reason). */
  untrackedSkipped: string[];
  /** Files that are repository noise (bin/, obj/, packages/, .vs/, *.user, *.suo). */
  noiseFiles: string[];
  /** Paths that should be explicitly flagged (.github/copilot-instructions etc.). */
  flaggedPaths: string[];
  summary: string;
}

/**
 * Collects read-only Git diff context for AI code review.
 *
 * Runs only: rev-parse, branch --show-current, diff (readonly variants), status --short.
 * Never runs add, commit, push, checkout, merge, rebase, or any write command.
 *
 * `repoRoot` can be any path inside the repository — the command resolves the
 * actual git root automatically via `git rev-parse --show-toplevel`.
 */
export function collectGitReviewContext(
  repoRoot: string,
  baseBranch?: string,
): Promise<GitReviewContext> {
  return invoke('collect_git_review_context', {
    repoRoot,
    baseBranch: baseBranch ?? null,
  });
}

/**
 * File-specific git review context. Unlike `GitReviewContext` (full branch diff),
 * this contains only changes to a single file — avoiding unrelated files being sent to AI.
 */
export interface GitFileReviewContext {
  repoRoot: string;
  currentBranch: string;
  baseBranch: string;
  /** Repo-relative file path, e.g. "Scripts/nvr_account_events.js". */
  fileRelPath: string;
  /** Combined diff for this file: committed branch changes + staged + unstaged. */
  diff: string;
  hasCommitted: boolean;
  hasStaged: boolean;
  hasUnstaged: boolean;
  /** True when the file is not tracked by git (new/never staged). */
  isUntracked: boolean;
}

/**
 * Collects a read-only, file-specific git diff context.
 *
 * Runs only safe read-only git commands for the selected file:
 *   git diff <base>...HEAD -- <file>    (committed branch changes)
 *   git diff --cached -- <file>         (staged)
 *   git diff -- <file>                  (unstaged)
 *   git ls-files --error-unmatch <file> (check if tracked)
 *
 * Never runs write commands.
 */
export function collectGitFileReviewContext(
  repoRoot: string,
  filePath: string,
): Promise<GitFileReviewContext> {
  return invoke('collect_git_file_review_context', { repoRoot, filePath });
}

/** Returns the name of the currently checked-out branch. */
export function getGitBranch(repoPath: string): Promise<string> {
  return invoke<string>('get_git_branch', { repoPath });
}

/**
 * Returns the current branch name by reading `.git/HEAD` directly — no git
 * process is spawned so this is instantaneous. Use this for the initial panel
 * load where latency is visible to the user. Falls back to an abbreviated SHA
 * in detached-HEAD state.
 */
export function getGitBranchQuick(repoPath: string): Promise<string> {
  return invoke<string>('get_git_branch_quick', { repoPath });
}

/** Returns sorted list of local branch names. */
export function listGitBranches(repoPath: string): Promise<string[]> {
  return invoke<string[]>('list_git_branches', { repoPath });
}

/** Returns true when the repo has uncommitted changes (including untracked files). */
export function gitHasUncommitted(repoPath: string): Promise<boolean> {
  return invoke<boolean>('git_has_uncommitted', { repoPath });
}

/** Checks out the given branch. Rejects with an error message on failure. */
export function gitCheckoutBranch(repoPath: string, branch: string): Promise<void> {
  return invoke('git_checkout_branch', { repoPath, branch });
}

/**
 * Returns the Git diff for `repoPath`, optionally scoped to a single `filePath`.
 *
 * Combines unstaged and staged changes so the caller always gets all pending
 * modifications regardless of staging state. Returns an empty string when
 * there are no pending changes — this is not an error.
 *
 * Rejects when:
 * - `repoPath` does not exist.
 * - `repoPath` is not a Git repository.
 * - `git` is not installed / not on PATH.
 */
export function getGitDiff(repoPath: string, filePath?: string): Promise<string> {
  return invoke<string>('get_git_diff', { repoPath, filePath: filePath ?? null });
}

/**
 * Runs an AI review against a Git diff instead of a full source file.
 *
 * The AI is instructed to comment only on changed lines ('+'/'-') and to avoid
 * speculating about code not visible in the diff. The result has the same
 * `{ structured, markdown }` shape as `runAiFileReview`.
 */
export function runAiChangeReview(
  diff: string,
  taskContext: string,
  fileName: string,
  reviewerName: string,
  instructions: string,
  modelOverride: string,
  temperature: number,
): Promise<AiFileReviewResult> {
  return invoke<{ structured: AiStructuredReview | null; markdown: string | null }>(
    'run_ai_change_review',
    { diff, taskContext, fileName, reviewerName, instructions, modelOverride, temperature },
  ).then(({ structured, markdown }) => {
    const result: AiFileReviewResult = { reviewerName, filePath: fileName };
    if (structured) result.structured = structured;
    if (markdown) result.markdown = markdown;
    return result;
  });
}

// ---------------------------------------------------------------------------
// Power Platform AI Kit commands
// ---------------------------------------------------------------------------

export interface AiKitImplementationResult {
  /** True when the model returned valid JSON. */
  ok: boolean;
  /** Parsed result when ok=true. */
  result?: {
    proposedContent: string;
    summary: string;
    changedSections?: string[];
    risks?: string[];
    testScenarios?: string[];
    /** Set when the model asked for clarification instead of implementing. */
    clarificationNeeded?: string;
    /** Fix-mode: issues addressed. */
    fixedIssues?: string[];
    /** Fix-mode: issues skipped with reason. */
    skippedIssues?: string[];
  };
  /** Raw model text when JSON parsing failed (ok=false). */
  rawText?: string;
}

/**
 * Runs AI Kit implementation against the provided artifact content.
 *
 * The artifact file is NOT read or written by this command.
 * The frontend reads the current file content, passes it in, and writes
 * the proposed content after user confirmation.
 *
 * @param artifactContent  Current content of the target file.
 * @param taskContext      Structured task context string.
 * @param instructions     Full system instructions (assembled from AI Kit rules).
 * @param modelOverride    Optional model name. Pass '' to use global model.
 * @param temperature      Sampling temperature (0.0 = use default).
 */
export function runAiKitImplementation(
  artifactContent: string,
  taskContext: string,
  instructions: string,
  modelOverride: string,
  temperature: number,
): Promise<AiKitImplementationResult> {
  return invoke<AiKitImplementationResult>('run_ai_kit_implementation', {
    artifactContent,
    taskContext,
    instructions,
    modelOverride,
    temperature,
  });
}

// ---------------------------------------------------------------------------
// Microsoft 365 — OAuth2 PKCE sign-in and Microsoft Graph API
//
// All token handling lives in Rust (lib.rs). The frontend only sees account
// metadata. Scopes requested: openid profile email offline_access
//   User.Read  Mail.Read  Chat.Read
// ---------------------------------------------------------------------------

export interface MicrosoftAccountInfo {
  /** UPN / login email returned by Microsoft identity. */
  email: string;
  /** Display name from the Microsoft account. */
  displayName: string;
  /** Tenant GUID. */
  tenantId: string;
  /** Human-readable tenant name — not always returned by the Graph /me endpoint. */
  tenantName?: string;
  /** ISO 8601 timestamp when the tokens were last refreshed. */
  lastSyncAt: string;
}

/**
 * Opens the system browser to the tenant-specific Microsoft OAuth2 PKCE sign-in
 * page, waits for the redirect on localhost:3049, exchanges the code, and returns
 * the connected account metadata. All token storage stays in Rust.
 *
 * @param tenantId  Azure Directory (tenant) ID — required for single-tenant apps.
 */
export function connectMicrosoftAccount(clientId: string, tenantId: string): Promise<MicrosoftAccountInfo> {
  return invoke('connect_microsoft_account', { clientId, tenantId });
}

/** Silently re-acquires Microsoft tokens using the cached refresh token. */
export function refreshMicrosoftConnection(clientId: string): Promise<MicrosoftAccountInfo> {
  return invoke('refresh_microsoft_connection', { clientId });
}

/** Signs out and clears the token cache. */
export function disconnectMicrosoftAccount(): Promise<void> {
  return invoke('disconnect_microsoft_account');
}

/**
 * Returns a simple string state: 'connected' | 'needs_refresh' | 'disconnected'.
 * Does not trigger any UI interaction.
 */
export function getMicrosoftConnectionState(): Promise<string> {
  return invoke('get_microsoft_connection_state');
}

/** @deprecated Use getOutlookFlaggedList + getOutlookMessageFull instead. */
export function getOutlookMessages(clientId: string): Promise<OutlookMessage[]> {
  return invoke('get_outlook_messages', { clientId });
}

/**
 * Lightweight flagged-email list for the Outlook import panel.
 * Returns only display fields (no body) so the panel loads quickly.
 * Paginates up to 300 flagged emails, sorts newest-first locally, returns top 50.
 * Full body is fetched lazily via getOutlookMessageFull when the user clicks Import.
 *
 * @param daysBack  Only return emails from the last N days (server-side cutoff).
 *                  Pass 0 to fetch all flagged emails regardless of age.
 */
export function getOutlookFlaggedList(clientId: string, daysBack: number): Promise<OutlookFlaggedListResult> {
  return invoke('get_outlook_flagged_list', { clientId, daysBack });
}

/**
 * Fetch one Outlook message by id with full body, HTML stripping, and ADO link extraction.
 * Call this lazily when the user clicks Import — not during panel load.
 */
export function getOutlookMessageFull(clientId: string, messageId: string): Promise<OutlookMessage> {
  return invoke('get_outlook_message_full', { clientId, messageId });
}

/** Fetch the 20 most recent Teams chats. */
export function getTeamsChats(clientId: string): Promise<TeamsChat[]> {
  return invoke('get_teams_chats', { clientId });
}

/** Fetch the 30 most recent messages in a Teams chat. */
export function getTeamsChatMessages(clientId: string, chatId: string): Promise<TeamsChatMessage[]> {
  return invoke('get_teams_chat_messages', { clientId, chatId });
}

/**
 * Fetch the latest 10 Teams messages across the user's recent chats.
 * Each item embeds its parent chat context (chatId, chatTopic, chatMembersSummary).
 * This is the message-centric view used by the Teams import panel.
 *
 * NOTE: This uses recent chat messages, NOT saved/bookmarked messages.
 * Microsoft Graph does not expose a stable user-level "saved for later" endpoint
 * for Teams chats as of 2025 (the Teams in-app Save feature has no Graph API surface).
 * If Graph ever exposes GET /me/teams/savedMessages or similar, replace this call
 * and the Rust `get_teams_recent_messages` command with a saved-messages fetch.
 */
export function getTeamsRecentMessages(clientId: string): Promise<TeamsFlatMessage[]> {
  return invoke('get_teams_recent_messages', { clientId });
}

/** Fetch today's messages from the user's configured Teams intake chat. */
export function getTeamsIntakeMessages(clientId: string, chatId: string): Promise<TeamsFlatMessage[]> {
  return invoke('get_teams_intake_messages', { clientId, chatId });
}

/**
 * Fetch today's messages from the signed-in user's self-chat (Teams intake inbox).
 *
 * Self-chat = the oneOnOne chat where the user is the only participant.
 * Today filter = messages sent on the current UTC date.
 *
 * Send or forward a message to yourself in Teams to queue it as a task candidate.
 * This is the Teams equivalent of flagging an email in Outlook.
 */
export function getTeamsSelfChatMessages(clientId: string): Promise<TeamsFlatMessage[]> {
  return invoke('get_teams_self_chat_messages', { clientId });
}

// ---------------------------------------------------------------------------
// Microsoft error code helpers
// ---------------------------------------------------------------------------

/**
 * Parse the structured error code from a Tauri command error string.
 * The Rust backend returns errors prefixed with `MICROSOFT_RECONNECT_REQUIRED: `,
 * `MICROSOFT_NOT_CONNECTED: `, etc. so the frontend can route them correctly.
 */
export function parseMicrosoftError(err: unknown): {
  code: import('../types').CommandErrorCode;
  detail: string;
} {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (msg.startsWith('MICROSOFT_RECONNECT_REQUIRED:')) {
    return { code: 'MICROSOFT_RECONNECT_REQUIRED', detail: msg.replace(/^MICROSOFT_RECONNECT_REQUIRED:\s*/, '') };
  }
  if (msg.startsWith('MICROSOFT_NOT_CONNECTED:')) {
    return { code: 'MICROSOFT_NOT_CONNECTED', detail: msg.replace(/^MICROSOFT_NOT_CONNECTED:\s*/, '') };
  }
  // Map well-known unstructured error strings from Graph error handling.
  if (
    msg.includes('HTTP 403') ||
    msg.includes('Authorization_RequestDenied') ||
    msg.includes('AccessDenied') ||
    msg.includes('Mail.Read permission may be missing')
  ) {
    return { code: 'MICROSOFT_PERMISSION_MISSING', detail: msg };
  }
  if (msg.includes('HTTP ') || msg.includes('Graph request failed')) {
    return { code: 'GRAPH_HTTP_ERROR', detail: msg };
  }
  return { code: 'UNKNOWN_ERROR', detail: msg };
}

/** Returns true when the error requires the user to reconnect Microsoft. */
export function isMicrosoftReconnectRequired(err: unknown): boolean {
  const { code } = parseMicrosoftError(err);
  return code === 'MICROSOFT_RECONNECT_REQUIRED' || code === 'MICROSOFT_NOT_CONNECTED';
}
