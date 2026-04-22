/**
 * Typed wrappers around Tauri's invoke() for all persistence and
 * filesystem commands. Maps 1-to-1 with the Rust commands in lib.rs.
 */
import { invoke } from '@tauri-apps/api/core';
import { openUrl as openerOpen } from '@tauri-apps/plugin-opener';
import type { Task, Customer, AppSettings, TaskAnalysis, SkeletonPreview, GitInitStatus, OutlookMessage, OutlookFlaggedListResult, TeamsChat, TeamsChatMessage, TeamsFlatMessage, ClassificationResult } from '../types';

export type { ClassificationResult };

// --- Persistence -----------------------------------------------------------

export function loadTasks(): Promise<Task[]> {
  return invoke<Task[]>('load_tasks');
}

export function saveTasks(tasks: Task[]): Promise<void> {
  return invoke('save_tasks', { tasks });
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
 * Opens a URL in the system default browser.
 * Uses the Tauri opener plugin — window.open is blocked inside the WebView.
 */
export function openUrl(url: string): Promise<void> {
  return openerOpen(url);
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

/** Writes content to the given absolute path, creating directories as needed. */
export function saveGeneratedFile(path: string, content: string): Promise<void> {
  return invoke('save_generated_file', { path, content });
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

/**
 * Lists immediate subfolder names under `dir` (hidden folders excluded, sorted).
 * Reuses the same Rust command as listCrmFolders.
 * Returns empty array if dir not found or not a directory.
 */
export function listSubfolders(dir: string): Promise<string[]> {
  return invoke<string[]>('list_crm_folders', { baseDir: dir });
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Returns the name of the currently checked-out branch. */
export function getGitBranch(repoPath: string): Promise<string> {
  return invoke<string>('get_git_branch', { repoPath });
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
