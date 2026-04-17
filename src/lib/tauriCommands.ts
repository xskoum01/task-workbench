/**
 * Typed wrappers around Tauri's invoke() for all persistence and
 * filesystem commands. Maps 1-to-1 with the Rust commands in lib.rs.
 */
import { invoke } from '@tauri-apps/api/core';
import { openUrl as openerOpen } from '@tauri-apps/plugin-opener';
import type { Task, Customer, AppSettings, TaskAnalysis, SkeletonPreview, GitInitStatus, OutlookMessage, TeamsChat, TeamsChatMessage, TeamsFlatMessage, ClassificationResult } from '../types';

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

/** Fetch the 25 most recent Outlook messages. */
export function getOutlookMessages(clientId: string): Promise<OutlookMessage[]> {
  return invoke('get_outlook_messages', { clientId });
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
 */
export function getTeamsRecentMessages(clientId: string): Promise<TeamsFlatMessage[]> {
  return invoke('get_teams_recent_messages', { clientId });
}
