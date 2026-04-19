export type TaskStatus =
  | 'new'
  | 'analyzed'
  | 'in-progress'
  | 'ready-for-review'
  | 'done'
  | 'blocked';

export type TaskSource = 'email' | 'teams' | 'manual';

export type TaskType =
  | 'bug-fix'
  | 'feature'
  | 'review'
  | 'question'
  | 'deployment'
  | 'other';

export interface SuggestedAction {
  id: string;
  label: string;
}

export type WorkItemSource = 'none' | 'helpdesk' | 'azure_devops' | 'other';

export interface TaskAnalysis {
  summary: string;
  suggestedActions: SuggestedAction[];
  confidence: number;
  nextStep?: string;
}

export interface SkeletonPreview {
  fileName: string;
  content: string;
  /** Relative subfolder within pluginFolder (empty string = root). */
  targetPath: string;
}

export interface Task {
  id: string;
  title: string;
  source: TaskSource;
  customerId: string;
  taskType: TaskType;
  status: TaskStatus;
  /** AI classification confidence as a percentage (0–100). */
  confidence: number;
  originalMessage: string;
  receivedAt: string; // ISO date string
  suggestedActions: SuggestedAction[];

  // --- Planning fields (all optional for backwards compatibility) ---
  /** ISO date string for the task's deadline. */
  dueAt?: string;
  /** Rough effort estimate in hours. */
  estimatedEffort?: number;
  /** The bucket the user explicitly chose; overrides the suggestion when set. */
  planningBucket?: PlanningBucket;
  /** Computed recommended bucket (never user-editable directly). */
  suggestedPlanningBucket?: PlanningBucket;
  /** 0–100 priority score computed by rule-based logic. */
  priorityScore?: number;
  /** Short human-readable explanation of the score. */
  priorityReason?: string;
  /** When true, planning bucket will not be overwritten by auto-recompute. */
  isPlanningLocked?: boolean;

  // --- AI-generated content ---
  /** Persisted result from the AI Analyze action. */
  analysisResult?: TaskAnalysis;
  /** Persisted AI-generated reply draft. */
  generatedReply?: string;
  /** Persisted Script Assistant analysis result. */
  scriptAnalysis?: ScriptAnalysis;

  // --- Tracking / delivery metadata ---
  /** Where the work item originates (helpdesk ticket, ADO task, etc.). */
  workItemSource?: WorkItemSource;
  /** URL to the related helpdesk / support ticket. */
  ticketUrl?: string;
  /** URL to the Azure DevOps work item or task. */
  devopsTaskUrl?: string;
  /** Expected budget in hours. */
  budgetHours?: number;
  /** Optional free-text budget context or constraint. */
  budgetNote?: string;

  // --- Import / inbox classification ---
  /** Stable external ID from Outlook/Teams used for deduplication. */
  externalMessageId?: string;
  /** Conversation or thread ID when available (Teams chatId, Outlook conversationId). */
  sourceThreadId?: string;
  /** Direct web link to the source message (webLink from Graph API). */
  sourceUrl?: string;
  /** Display name of the sender/author. */
  senderName?: string;
  /** Email address of the sender. */
  senderEmail?: string;
  /** ISO timestamp of when this item was imported into the app. */
  importedAt?: string;
  /** Short human-readable hint about what kind of item this is (e.g. "PR feedback", "ADO work item", "Meeting invitation"). */
  classificationLabel?: string;
  /**
   * Structured context extracted deterministically from Azure DevOps notification emails.
   * Populated for PR comment and work item emails; undefined for all other sources.
   */
  adoContext?: AdoEmailContext;
  /**
   * Classification pipeline state.
   * - pending:  imported, awaiting classification
   * - analyzed: AI ran, medium confidence — needs user review before becoming a task
   * - rejected: prefilter or AI determined this is not an actionable task
   * - created:  promoted to a real task (or manually created — same as undefined)
   * When undefined the item is treated as a regular task (legacy compat).
   */
  classificationState?: ClassificationState;
}

export type ClassificationState = 'pending' | 'analyzed' | 'rejected' | 'created';

/**
 * Structured context extracted from Azure DevOps notification emails.
 * Only populated for ADO-originated items.
 */
export interface AdoEmailContext {
  type: 'pr-comment' | 'work-item' | 'build' | 'other';
  // --- PR comment fields ---
  prNumber?: number;
  reviewerName?: string;
  commentedFile?: string;
  reviewComment?: string;
  /** Direct Azure DevOps URL for the PR comment thread or review page. */
  prUrl?: string;
  // --- Work item fields ---
  workItemNumber?: number;
  /** Work item type: Task, Bug, Story, Feature, Epic, etc. */
  workItemType?: string;
  workItemTitle?: string;
  workItemState?: string;
  workItemAssignedTo?: string;
  workItemPriority?: string;
  workItemAreaPath?: string;
  workItemIterationPath?: string;
  workItemUrl?: string;
  workItemDescription?: string;
  // --- Shared ---
  /** Project code extracted from CRM_<Name> pattern, e.g. "Navertica" from "CRM_Navertica". */
  crmProjectCode?: string;
}

export interface ClassificationResult {
  isTask: boolean;
  title: string;
  summary: string;
  customerName?: string | null;
  taskType: TaskType;
  estimatedEffort?: number | null;
  dueAt?: string | null;
  confidence: number;
  suggestedReply?: string | null;
}

/** Describes whether the customer's repository folder is reachable on disk. */
export type RepositoryStatus = 'linked' | 'missing' | 'not_created';

export interface Customer {
  id: string;
  name: string;
  shortCode: string;
  /** Display name for the repository (e.g. "contoso-crm"). */
  repositoryName?: string;
  /** Absolute path to the repository root on the local machine. */
  repositoryRoot?: string;
  /**
   * Optional folder name inside the global CRM base directory.
   * If set, the resolved path is `<crmBaseDirectory>/<folderName>`.
   * Takes precedence over `repositoryRoot` when `crmBaseDirectory` is configured.
   */
  folderName?: string;
  /** Explicit override that wins over the base-dir resolution. */
  repositoryRootOverride?: string;
  /** Template key used when creating the repository from a template. */
  templateKey?: string;
  /** Computed detection result — not persisted, refreshed on app load. */
  repositoryStatus?: RepositoryStatus;
  /** Resolved absolute path after applying base-dir + folderName logic. */
  resolvedRepositoryPath?: string;
  /** Path to the plugin project folder (absolute or relative to repositoryRoot). */
  pluginFolder?: string;
  /** Path to scripts / utilities folder. */
  scriptFolder?: string;
  /** .NET namespace prefix used for generated code (e.g. "Contoso.CRM"). */
  namespace?: string;
  notes?: string;
}

/**
 * Overall Microsoft account connection lifecycle.
 *
 * State machine:
 *   disconnected → connecting → connected ⇄ refreshing
 *                            ↘ error → disconnected
 *
 * - disconnected : no account linked (initial / after sign-out)
 * - connecting   : sign-in flow in progress (MSAL popup / redirect)
 * - connected    : signed in, tokens available, services can be used
 * - refreshing   : silently re-acquiring tokens in the background
 * - error        : sign-in or token refresh failed; lastMicrosoftError contains details
 */
export type MicrosoftConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'refreshing'
  | 'error';

/**
 * Per-service connection state for Outlook / Teams.
 * Evolves independently once the account is connected.
 * - not_configured: service has never been activated
 * - configured:     service enabled but no live token (placeholder / future)
 * - connected:      delegated token for this service is valid
 * - error:          service-specific error (e.g. missing scope)
 */
export type M365ConnectionStatus = 'not_configured' | 'configured' | 'connected' | 'error';

/** Options that override the global settings for a single repository creation call. */
export interface CreateRepoOptions {
  /** Override settings.initializeGitOnCreate */
  initializeGit?: boolean;
  /** Override settings.defaultGitBranch */
  gitBranch?: string;
  /** Override settings.createInitialCommit */
  createInitialCommit?: boolean;
}

/** Outcome of a git initialization attempt. */
export type GitInitStatus =
  | 'skipped'        // initializeGitOnCreate is false
  | 'already_exists' // .git was already present — no action taken
  | 'success'        // git init ran successfully
  | 'failed'         // git init ran but returned a non-zero exit code
  | 'git_not_found'; // git binary not found in PATH

/** Structured result returned after creating a customer repository. */
export interface CreateRepoResult {
  /** Absolute path of the newly created (or existing) directory. */
  targetPath: string;
  /** Outcome of the git initialization step. */
  gitInit: GitInitStatus;
  /** Human-readable detail from git, only set on failure or git_not_found. */
  gitMessage?: string;
  /** True when an initial commit was created. */
  initialCommitCreated?: boolean;
}

/** How the default repository template is specified. */
export type RepositoryTemplateType = 'none' | 'zip' | 'folder';

/** Validation state after the user picks a template. */
export type TemplateValidationState = 'not_selected' | 'valid' | 'invalid';

export type AppTemplateType = 'plugin' | 'script';
export type AppTemplateSourceKind = 'zip' | 'folder';

export interface AppTemplate {
  id: string;
  name: string;
  type: AppTemplateType;
  sourceKind: AppTemplateSourceKind;
  sourcePath: string;
  isDefault: boolean;
  description?: string;
}

export interface AppSettings {
  appName: string;
  theme: string;
  defaultTaskConfidence: number;
  aiModel: string;
  aiApiKey: string;
  /** Global base directory where all CRM customer repositories live. */
  crmBaseDirectory?: string;
  /**
   * @deprecated Use repositoryTemplateType + repositoryTemplatePath instead.
   * Kept only for backward compatibility with existing JSON.
   */
  repositoryTemplate?: string;
  /** Whether the default template is a zip archive or a folder. */
  repositoryTemplateType?: RepositoryTemplateType;
  /** Absolute path to the selected zip/folder template. */
  repositoryTemplatePath?: string;
  /** When true, run `git init` after template extraction. */
  initializeGitOnCreate?: boolean;
  /** Branch name to use for `git init -b`. Defaults to "main". */
  defaultGitBranch?: string;
  /** When true and git init succeeds, stage all files and create an initial commit. */
  createInitialCommit?: boolean;
  microsoftTenant: string;
  graphEnabled: boolean;
  /** Microsoft 365 account email used for Outlook / Teams. */
  m365AccountEmail?: string;
  /** Outlook connection status (replaces the old outlookConnected boolean). */
  outlookStatus?: M365ConnectionStatus;
  /** Teams connection status (replaces the old teamsConnected boolean). */
  teamsStatus?: M365ConnectionStatus;
  // Legacy boolean fields kept for backward compatibility with existing JSON
  outlookConnected?: boolean;
  teamsConnected?: boolean;

  /** Azure App Registration Application (client) ID for OAuth2 PKCE sign-in. */
  microsoftClientId?: string;

  // ── Microsoft account connection model ────────────────────────────────────
  // These fields drive the account-level connection UI.
  // They are set by the sign-in/sign-out flow, NOT by the user directly.

  /**
   * Overall Microsoft account connection state.
   * Drives which panel is shown in the M365 Integration settings section.
   */
  microsoftConnectionStatus?: MicrosoftConnectionStatus;

  /** Display name returned by Microsoft identity (e.g. "Jan Novák"). */
  microsoftAccountDisplayName?: string;

  /**
   * Tenant GUID returned by Microsoft identity (preferred over microsoftTenant).
   * microsoftTenant is kept for backward compatibility.
   */
  microsoftTenantId?: string;

  /** Human-readable tenant name (e.g. "Contoso Ltd"). */
  microsoftTenantName?: string;

  /** ISO 8601 timestamp of the last successful Microsoft token refresh. */
  lastMicrosoftSyncAt?: string;

  /** Human-readable error message from the last failed sign-in or refresh. */
  lastMicrosoftError?: string;

  /** Plugin and Script templates managed in Settings → Templates. */
  templates?: AppTemplate[];
}

/** Which planning time-box a task belongs to. */
export type PlanningBucket =
  | 'now'
  | 'today'
  | 'tomorrow'
  | 'this_week'
  | 'later';

// ── Script Assistant types ────────────────────────────────────────────────────

export type ScriptTriggerType = 'onLoad' | 'onSave' | 'onChange' | 'ribbon' | 'helper_only';

export type ScriptOperationType =
  | 'helper_plus_hook'
  | 'new_onchange_handler'
  | 'extend_existing_helper'
  | 'new_file_scaffold';

/** Structured result of script analysis (inferred from task text). */
export interface ScriptAnalysis {
  artifactType: 'script';
  entityLogicalName: string;
  triggerType: ScriptTriggerType;
  triggerField?: string;
  /** Preliminary operation type — refined to a definitive value in ScriptPlan. */
  operationType: ScriptOperationType;
  candidateFunctionName: string;
  shouldReuseExistingHandler: boolean;
  shouldCreateNewHandler: boolean;
  shouldCreateHelper: boolean;
  confidence: number;
  summary: string;
}

/** Result of inspecting an existing JS file in the customer repo. */
export interface ScriptFileInspection {
  filePath: string;
  fileName: string;
  exists: boolean;
  /** All detected function names (handlers + helpers). */
  handlers: string[];
  helpers: string[];
  hasOnLoad: boolean;
  hasOnSave: boolean;
  hasOnChange: boolean;
  /** Fields that already have a dedicated onChange handler. */
  onChangeFields: string[];
  /** Exact name of the best existing handler to hook into, if found. */
  existingHandlerName?: string;
}

/** Resolved plan: which file, what will be done. */
export interface ScriptPlan {
  targetFile: string;
  targetFileName: string;
  resolvedBy: 'canonical' | 'activity_shared' | 'content_match' | 'none';
  fileExists: boolean;
  entity: string;
  triggerType: ScriptTriggerType;
  triggerField?: string;
  operationType: ScriptOperationType;
  reuseExistingHandler: boolean;
  /** Name of the handler to hook into (when reuseExistingHandler is true). */
  existingHandlerName?: string;
  createNewHelper: boolean;
  createNewHandler: boolean;
  /** True when a helper with a similar name already exists. */
  similarHelperFound: boolean;
  /** High-level recommended action in one sentence. */
  recommendedAction: string;
  inspection?: ScriptFileInspection;
}

/** One distinct code section in the skeleton output. */
export interface SkeletonSection {
  label: string;
  description: string;
  code: string;
}

/** Generated skeleton proposal — broken into distinct, copyable sections. */
export interface ScriptSkeleton {
  targetFile: string;
  targetFileName: string;
  operationType: ScriptOperationType;
  sections: SkeletonSection[];
}

export type NavPage = 'inbox' | 'tasks' | 'customers' | 'settings';

// ── Microsoft import types ────────────────────────────────────────────────────

export interface OutlookMessage {
  id: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  receivedAt: string;
  bodyPreview: string;
  /** Full message body stripped of HTML tags. Available when Graph fetches body field. */
  bodyFull?: string;
  webLink: string;
}

export interface TeamsChat {
  id: string;
  topic: string;
  chatType: string; // 'group' | 'oneOnOne' | 'meeting'
  membersSummary: string;
  lastMessagePreview: string;
  lastUpdatedAt: string;
}

export interface TeamsChatMessage {
  id: string;
  senderName: string;
  senderEmail: string;
  sentAt: string;
  /** HTML stripped to plain text. */
  content: string;
}

/**
 * A single Teams chat message with its parent chat context embedded.
 * Returned by get_teams_recent_messages — used for the flat message-centric
 * import view that shows the latest messages across all recent chats.
 */
export interface TeamsFlatMessage {
  // Message fields
  id: string;
  senderName: string;
  senderEmail: string;
  sentAt: string;
  /** HTML stripped to plain text. */
  content: string;
  // Chat context embedded so the UI can show which chat this came from
  chatId: string;
  chatTopic: string;
  chatType: string;
  chatMembersSummary: string;
}
