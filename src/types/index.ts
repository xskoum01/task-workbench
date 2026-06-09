export type TaskStatus =
  | 'new'
  | 'analyzed'
  | 'in-progress'
  | 'ready-for-review'
  | 'done'
  | 'blocked';

export type TaskWaitingState =
  | 'pricing-approval'
  | 'code-review'
  | 'consultant-testing';

export type TaskAttentionState =
  | 'pr-comments';

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
  // Legacy fields — always populated for backward compat with stored tasks
  summary: string;
  problemPoints?: string[];
  suggestedActions: SuggestedAction[];
  confidence: number;
  nextStep?: string;

  // Bilingual structured fields — populated by the current prompt, absent on old tasks
  summaryCz?: string;
  summaryEn?: string;
  problemPointsCz?: string[];
  problemPointsEn?: string[];
  actionPointsCz?: string[];
  actionPointsEn?: string[];
  nextStepCz?: string;
  nextStepEn?: string;
}

export interface SkeletonPreview {
  fileName: string;
  content: string;
  /** Relative subfolder within pluginFolder (empty string = root). */
  targetPath: string;
}

export type CrmDeveloperWorkKind =
  | 'plugin'
  | 'script'
  | 'ribbon'
  | 'repo-only'
  | 'bugfix'
  | 'review'
  | 'unknown';

export type CrmDeveloperWorkflowStep =
  | 'diagnosis'
  | 'metadata-verification'
  | 'technical-plan'
  | 'code-generation'
  | 'diff-review'
  | 'external-action'
  | 'pull-request'
  | 'done';

export interface CrmDeveloperWorkflowApprovalGate {
  approved: boolean;
  approvedAt?: string;
  approvedBy?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface CrmTechnicalImplementationPlan {
  generatedAt: string;
  generatedFromVerificationReportId?: string;
  workKind: CrmDeveloperWorkKind;
  summary: string;
  target?: {
    entityLogicalName?: string;
    message?: string;
    stage?: string;
    mode?: string;
    scriptPath?: string;
    pluginProject?: string;
  };
  implementationSteps: string[];
  dataverseFindings: string[];
  risks: string[];
  testChecklist: string[];
  externalActionPreview?: string[];
}

/**
 * Local-only record that the user manually completed an external action outside the app.
 * Does not represent actual execution — the app never executes anything external.
 */
export interface CrmExternalExecutionTracking {
  completed: boolean;
  completedAt?: string;
  /** Free-text note required before marking completed. */
  notes?: string;
  /** IDs of the proposal entries the user confirmed were done. */
  completedActionIds?: string[];
  invalidatedAt?: string;
  invalidationReason?: string;
}

/** Local-only pull request proposal text. The app does not create the PR. */
export interface CrmPullRequestProposal {
  generatedAt: string;
  title: string;
  body: string;
  checklist: string[];
  warnings: string[];
  relatedArtifactPath?: string;
  sourceSummary?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

/** Local-only record that a pull request was created manually outside the app. */
export interface CrmPullRequestTracking {
  createdManually: boolean;
  createdAt?: string;
  prUrl?: string;
  notes?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface CrmPullRequestReviewComment {
  id?: string;
  author?: string;
  body: string;
  filePath?: string;
  line?: number;
  isResolved?: boolean;
  createdAt?: string;
}

/** Local read-only snapshot of PR review intake. No remote PR state is modified. */
export interface CrmPullRequestReviewIntake {
  fetchedAt: string;
  provider?: 'github' | 'azure-devops' | 'unknown';
  prUrl: string;
  title?: string;
  state?: string;
  author?: string;
  baseBranch?: string;
  headBranch?: string;
  comments?: CrmPullRequestReviewComment[];
  unresolvedCount?: number;
  attentionRequired?: boolean;
  summary?: string;
  warnings?: string[];
  error?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface CrmPullRequestReviewAnalysisComment {
  id?: string;
  author?: string;
  body: string;
  line?: number;
  createdAt?: string;
}

export interface CrmPullRequestReviewGroupedFinding {
  filePath?: string;
  title: string;
  comments: CrmPullRequestReviewAnalysisComment[];
  suggestedAction: string;
  riskLevel: 'low' | 'medium' | 'high';
}

/** Local deterministic plan for addressing fetched PR review comments. */
export interface CrmPullRequestReviewAnalysis {
  generatedAt: string;
  sourceReviewFetchedAt?: string;
  attentionRequired: boolean;
  summary: string;
  groupedFindings: CrmPullRequestReviewGroupedFinding[];
  actionItems: string[];
  testChecklist: string[];
  warnings: string[];
  limitations: string[];
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface CrmPullRequestFixProposedChange {
  filePath?: string;
  title: string;
  description: string;
  addressesCommentIds?: string[];
  confidence: 'low' | 'medium' | 'high';
  riskLevel: 'low' | 'medium' | 'high';
}

/** Local deterministic proposal for fixing PR review feedback. Does not edit files. */
export interface CrmPullRequestFixProposal {
  generatedAt: string;
  sourceAnalysisGeneratedAt?: string;
  summary: string;
  proposedChanges: CrmPullRequestFixProposedChange[];
  implementationOrder: string[];
  testChecklist: string[];
  warnings: string[];
  limitations: string[];
  canGenerateCodeLater: boolean;
  invalidatedAt?: string;
  invalidationReason?: string;
}

/** Local-only record that the user manually pushed/updated PR fixes outside the app. */
export interface CrmPullRequestFixUpdateTracking {
  updatedManually: boolean;
  updatedAt?: string;
  notes?: string;
  commitSha?: string;
  branchName?: string;
  relatedFixProposalGeneratedAt?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface CrmDeveloperWorkflowState {
  detectedWorkKind?: CrmDeveloperWorkKind;
  currentStep?: CrmDeveloperWorkflowStep;
  technicalPlan?: CrmTechnicalImplementationPlan;
  planApproval?: CrmDeveloperWorkflowApprovalGate;
  diffApproval?: CrmDeveloperWorkflowApprovalGate;
  externalActionApproval?: CrmDeveloperWorkflowApprovalGate;
  pullRequestApproval?: CrmDeveloperWorkflowApprovalGate;
  /**
   * User-recorded confirmation that external actions were completed outside the app.
   * Local tracking only — the app never executes external actions.
  */
  externalExecution?: CrmExternalExecutionTracking;
  /** Local deterministic PR proposal. The app never creates branches, commits, or PRs. */
  pullRequestProposal?: CrmPullRequestProposal;
  /** Local record of a PR created manually outside the app. */
  pullRequestTracking?: CrmPullRequestTracking;
  /** Local read-only PR review intake snapshot. The app never updates the remote PR. */
  pullRequestReview?: CrmPullRequestReviewIntake;
  /** Local deterministic plan for addressing fetched PR review comments. */
  pullRequestReviewAnalysis?: CrmPullRequestReviewAnalysis;
  /** Local deterministic proposal for future fix drafting. Does not edit files. */
  pullRequestFixProposal?: CrmPullRequestFixProposal;
  /** Local-only record that the user manually updated the PR outside the app. */
  pullRequestFixUpdateTracking?: CrmPullRequestFixUpdateTracking;
  createdAt?: string;
  updatedAt?: string;
}

// ── Implementation verification types ────────────────────────────────────────

/** Status for optional pre-review verification checks. */
export type ImplCheckStatus =
  | 'not-run'
  | 'passed'
  | 'warnings'
  | 'failed'
  | 'skipped'
  | 'manually-verified';

export type LocalTestImplStatus = 'not-run' | 'passed' | 'failed' | 'not-needed';

/** Single optional verification check record — Dataverse check or AI code review. */
export interface ImplCheckRecord {
  status: ImplCheckStatus;
  runAt?: string;
  skippedAt?: string;
  skippedReason?: string;
  manuallyVerifiedAt?: string;
  summary?: string;
  findings?: string[];
}

/** Local test record inside the implementation verification block. */
export interface ImplLocalTestRecord {
  status: LocalTestImplStatus;
  recordedAt?: string;
  notes?: string;
}

/**
 * Optional Development-phase verification state.
 * All four checks are non-blocking — the task stays in Development regardless.
 * dataverseCheck.status = 'not-run' or undefined means no manual override;
 * the displayed status is derived from task.crmVerificationReports[0].verdict.
 */
export interface ImplementationVerification {
  /** Build / project readiness check result. */
  buildCheck?: ImplCheckRecord;
  /** Manual override for Dataverse check status (skipped / manually-verified). */
  dataverseCheck?: Pick<ImplCheckRecord, 'status' | 'skippedAt' | 'skippedReason' | 'manuallyVerifiedAt'>;
  /** AI internal code review result. */
  aiCodeReview?: ImplCheckRecord;
  /** Local test record. */
  localTest?: ImplLocalTestRecord;
  updatedAt?: string;
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
  /** Budget: number of hours estimated for this task (explicit, user-editable). */
  budget?: number;
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
  /** Passive waiting state: task is waiting on someone else. */
  waitingState?: TaskWaitingState | null;
  /** Active attention state: task needs work from me even if it came from a review loop. */
  attentionState?: TaskAttentionState | null;

  // --- AI-generated content ---
  /** Persisted result from the AI Analyze action. */
  analysisResult?: TaskAnalysis;
  /** Persisted AI-generated reply draft. */
  generatedReply?: string;
  /** Persisted Script Assistant analysis result. */
  scriptAnalysis?: ScriptAnalysis;
  /** Persisted selected plugin project folder name for dev work (shared between InlineTaskPanel and TaskDetail). */
  selectedPluginProject?: string;
  /**
   * Persisted AI code review results, newest first.
   * Capped at 5 entries. Stored without API keys or prompts.
   */
  aiFileReviews?: AiFileReviewResult[];

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

  /** ISO timestamp of when this task was moved to 'done' status. */
  completedAt?: string;

  /** Free-text notes the user can write on this task. */
  notes?: string;

  /**
   * CRM skeleton proposals generated by "Generate CRM Skeleton" action.
   * Newest first. Capped at 5 entries.
   */
  crmSkeletons?: CrmSkeletonResult[];

  /**
   * CRM verification reports generated by "Verify against CRM" action.
   * Newest first. Capped at 5 entries.
   */
  crmVerificationReports?: CrmVerificationReport[];

  /**
   * Minimal persisted state for the guided CRM developer workflow.
   * Local task state only; external approvals/actions are not executed by this field.
   */
  crmDeveloperWorkflow?: CrmDeveloperWorkflowState;

  /**
   * Confirmed workflow setup choices the user verified before analysis.
   * When present, downstream stages (draft, review, dev mode) prefer these values
   * over heuristic guesses. Gaps fall back to the resolver as before.
   */
  workflowSetup?: WorkflowSetup;

  /**
   * Explicit task mode override set by the user.
   * - 'developer': show dev workflow, tools, repo/plugin/script setup.
   * - 'general': simplified analysis-only workflow, no dev tools.
   * - undefined: inferred from heuristics (ADO assignment → developer, etc.).
   */
  taskMode?: 'developer' | 'general';

  /**
   * Sanitized HTML of the original email body with CID inline images resolved to data: URIs.
   * Only populated for email tasks imported via Microsoft Graph (get_outlook_message_full).
   * Used for display only — never fed into AI, prefilter, or text analysis.
   */
  emailBodyHtml?: string;

  // ── Implementation verification (Development-phase optional checks) ──────
  /**
   * Results of the three optional Development-phase verification checks:
   * Dataverse metadata, AI internal code review, and local test record.
   * All checks are optional and non-blocking — the task stays in Development
   * regardless of results. Only explicit user action moves it forward.
   */
  implementationVerification?: ImplementationVerification;

  // ── MCP local workflow fields ─────────────────────────────────────────────
  /** Local test record written by MCP record_local_test tool. */
  localTestRecord?: { status: string; updatedAt: string; note?: string };
  /** Consultant test record written by MCP record_consultant_testing tool. */
  consultantTestRecord?: { status: string; updatedAt: string; note?: string };
  /** Per-item checklist overrides set by MCP update_task_checklist_item tool. */
  mcpChecklistOverrides?: Record<string, string>;
  /** Recommended next step written by MCP set_task_next_step tool. */
  mcpNextStep?: { action: string; reason: string; updatedAt: string };
  /**
   * True when this task was created by the MCP create_test_task tool.
   * Used by delete_test_task to guard against accidental deletion of real tasks.
   */
  mcpTestTask?: boolean;
}

export type ClassificationState = 'pending' | 'analyzed' | 'rejected' | 'created';

/**
 * User-confirmed setup for a task's development workflow.
 * Saved when the user clicks "Confirm & Analyze" on a New task.
 * Downstream stages prefer these values over heuristic guesses.
 */
export interface WorkflowSetup {
  /** What the developer intends to do. */
  workIntent?: 'create' | 'update' | 'fix' | 'review';
  /** Plugin / Script / Repo target — overrides resolver when set. */
  devTargetKind?: 'plugin' | 'script' | 'repo';
  /** Overrides task.customerId when the user switches customer. */
  customerId?: string;
  /** Absolute path to the repository root the user selected. */
  repositoryRoot?: string;
  /** Plugin project subfolder name within the plugins directory. */
  pluginProject?: string;
  /**
   * The intended plugin project name for a Create+Plugin workflow.
   * Preserved when the project folder is deleted so the Create Plugin Project
   * modal can be prefilled with the previous name after a missing-folder reset.
   */
  desiredPluginProject?: string;
  /** Script file or folder path. */
  scriptPath?: string;
  /** Optional primary Dataverse entity logical name chosen by the user for verification. */
  primaryEntityLogicalName?: string;
  /** ID of the AI reviewer profile to default to. */
  reviewerId?: string;
  /** ISO timestamp of when the user confirmed. */
  confirmedAt?: string;
  /**
   * Absolute path of the file created by "Apply Draft" in a Create workflow.
   * Stored after the draft is written to disk so subsequent Open and AI Review
   * actions can navigate directly to the created artifact.
   */
  artifactPath?: string;
  /**
   * Desired target script file name (just the base name, e.g. "nvr_account_events.js").
   * Set during Confirm Setup for Create+Script workflows so Generate Draft uses the
   * confirmed name instead of re-inferring it from the task text.
   */
  desiredScriptFile?: string;
}

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
  summaryCz?: string | null;
  summaryEn?: string | null;
  problemPointsCz?: string[] | null;
  problemPointsEn?: string[] | null;
  actionPointsCz?: string[] | null;
  actionPointsEn?: string[] | null;
  nextStepCz?: string | null;
  nextStepEn?: string | null;
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
  /** Display name for the repository (e.g. "contoso-crm"). Used for Azure DevOps repo URL construction. */
  repositoryName?: string;
  /** Direct Azure DevOps repository URL (e.g. https://dev.azure.com/org/project/_git/repo). Overrides derived URL. */
  azureDevOpsRepoUrl?: string;
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

/**
 * Structured error codes surfaced by Rust Tauri commands as string prefixes.
 * The Rust command returns `Err("MICROSOFT_RECONNECT_REQUIRED: <detail>")` etc.
 * The frontend parses the prefix via `parseMicrosoftError()` in tauriCommands.ts.
 *
 * - MICROSOFT_RECONNECT_REQUIRED  refresh token expired/invalid — must sign in again
 * - MICROSOFT_NOT_CONNECTED       no token cache at all
 * - MICROSOFT_PERMISSION_MISSING  Graph returned 403 / Authorization_RequestDenied
 * - GRAPH_HTTP_ERROR              other non-2xx Graph response
 * - UNKNOWN_ERROR                 anything else
 */
export type CommandErrorCode =
  | 'MICROSOFT_RECONNECT_REQUIRED'
  | 'MICROSOFT_NOT_CONNECTED'
  | 'MICROSOFT_PERMISSION_MISSING'
  | 'GRAPH_HTTP_ERROR'
  | 'UNKNOWN_ERROR';

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

// ── AI provider types ────────────────────────────────────────────────────────

/** Which AI provider is active. */
export type AiProvider = 'openai' | 'anthropic';

export interface AppSettings {
  appName: string;
  theme: string;
  defaultTaskConfidence: number;
  /** @deprecated Use openaiApiKey + activeAiProvider instead. Kept for backward compatibility. */
  aiModel: string;
  /** @deprecated Use openaiApiKey + activeAiProvider instead. Kept for backward compatibility. */
  aiApiKey: string;

  // ── AI provider config ────────────────────────────────────────────────────
  /** Active AI provider. Defaults to 'openai' when absent. */
  activeAiProvider?: AiProvider;
  /** OpenAI API key. Falls back to legacy aiApiKey when empty. */
  openaiApiKey?: string;
  /** OpenAI model name. Falls back to legacy aiModel when empty. */
  openaiModel?: string;
  /** Anthropic API key. */
  anthropicApiKey?: string;
  /** Anthropic model name (e.g. claude-sonnet-4-5). */
  anthropicModel?: string;
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

  /** Daily notes keyed by YYYY-MM-DD local date string. */
  weeklyNotes?: Record<string, string>;

  /**
   * Teams chat used as the task intake inbox.
   * Populated by the Teams Intake setting in Settings.
   * The Teams import panel reads only from this chat (today's messages).
   * Configure by pasting a Teams chat link or a raw chat ID.
   */
  teamsIntakeChatId?: string;

  /**
   * Absolute path to the local plugin project template folder.
   * Used by "Create Plugin Project" to copy a skeleton into <repo>/Plugins/<Name>.
   * Template files may contain __PROJECT_NAME__ and __NAMESPACE__ placeholders.
   */
  pluginTemplateFolder?: string;

  /**
   * Configurable AI reviewer profiles.
   * Each reviewer defines its instructions, file-type targeting, and optional model override.
   */
  aiReviewers?: AiReviewerConfig[];

  // ── CRM Metadata / Primarch MCP ───────────────────────────────────────────
  /** When true, CRM metadata assistant buttons are enabled. */
  crmMetadataEnabled?: boolean;
  /** Shell command to start the Primarch MCP server (e.g. "node"). */
  primarchMcpCommand?: string;
  /** Space-separated arguments to pass to the MCP command. */
  primarchMcpArgs?: string;
  /** Working directory for the MCP server process. */
  primarchMcpWorkingDirectory?: string;
  /** Always true for now — read-only mode is enforced, not optional. */
  primarchMcpReadOnly?: boolean;
  /** Last known MCP connection status. */
  primarchMcpLastStatus?: 'not_configured' | 'connected' | 'error';
  /** Last MCP connection error message (redacted of secrets). */
  primarchMcpLastError?: string;
}

// ── AI Reviewer types ─────────────────────────────────────────────────────────

/**
 * Targeting rules that determine when a reviewer auto-applies.
 * A reviewer matches when at least one of its fileExtensions matches the file
 * being reviewed AND (optionally) one of its devTargetKinds matches the current dev mode.
 */
export interface AiReviewerAppliesTo {
  fileExtensions: string[];
  keywords?: string[];
  devTargetKinds?: ('plugin' | 'script')[];
}

/**
 * Configuration for a single AI reviewer profile.
 * Stored in settings.json under aiReviewers[].
 */
export interface AiReviewerConfig {
  id: string;
  name: string;
  description: string;
  /** Full system instructions sent to the AI as the reviewer context. */
  instructions: string;
  /** Short prompts the user can pick instead of writing a custom prompt. */
  quickPrompts: string[];
  enabled: boolean;
  /** Optional model override — uses the global AI model when absent. */
  model?: string;
  temperature?: number;
  appliesTo: AiReviewerAppliesTo;
}

/** A single inline comment in a structured AI code review. */
export interface AiReviewComment {
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  /** 1-based line number where the comment starts (omitted when uncertain). */
  lineStart?: number;
  /** 1-based line number where the comment ends (omitted when uncertain). */
  lineEnd?: number;
  title: string;
  problem: string;
  recommendation: string;
  /** Small excerpt from the reviewed file for context. */
  codeSnippet?: string;
  /** Suggested replacement code, if applicable. */
  suggestedCode?: string;
}

/**
 * Structured AI code review response.
 * The AI is asked to return this exact shape as JSON.
 */
export interface AiStructuredReview {
  reviewerName: string;
  filePath: string;
  fileName: string;
  verdict: 'pass' | 'needs_changes' | 'comment';
  summary: string;
  comments: AiReviewComment[];
  generalSuggestions: string[];
}

/**
 * Result returned by the run_ai_file_review Tauri command.
 * `structured` is present when the model returned valid JSON.
 * `markdown` is a fallback when JSON parsing failed.
 */
export interface AiFileReviewResult {
  /** Unique identifier for this review entry. */
  id?: string;
  /** ID of the reviewer config that ran this review. */
  reviewerId?: string;
  reviewerName: string;
  filePath: string;
  /** ISO timestamp of when the review was run. */
  reviewedAt?: string;
  /**
   * 'file'   — full-file review (Create workflow; Apply Draft + Run AI Review).
   * 'change' — git-diff review (Update / Fix workflow).
   */
  reviewMode?: 'file' | 'change';
  /** Parsed structured review. Present when JSON parsing succeeded. */
  structured?: AiStructuredReview;
  /** Raw markdown fallback. Present when JSON parsing failed. */
  markdown?: string;
}

/** Which planning time-box a task belongs to. */
export type PlanningBucket =
  | 'now'
  | 'today'
  | 'tomorrow'
  | 'this_week'
  | 'later'
  | 'queue'
  | 'waiting';

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

// ── Script Assistant V2 types ─────────────────────────────────────────────────

/**
 * Deterministic preview of the exact file change that will be written.
 * Generated from analysis + plan + skeleton without any AI call.
 */
export interface ScriptPreview {
  targetFile: string;
  targetFileName: string;
  /** True when the target file already exists on disk. */
  fileExists: boolean;
  operationType: ScriptOperationType;
  /** Current file content, or empty string for a new file. */
  originalContent: string;
  /** Full content that will be written to disk on Apply. */
  newContent: string;
  /** Short human-readable description of the change. */
  changeSummary: string;
  /** True when newContent equals originalContent — no write needed. */
  isNoop: boolean;
}

/** Result returned after successfully applying a preview to the repository. */
export interface ScriptApplyResult {
  targetFile: string;
  targetFileName: string;
  /** True when the file was newly created (did not exist before). */
  created: boolean;
  /** True when an existing file was updated. */
  updated: boolean;
  /** Number of bytes written. */
  bytesWritten: number;
}

// ── CRM Metadata types ───────────────────────────────────────────────────────

/** A single validation issue found during CRM verification. */
export interface CrmMetadataIssue {
  severity: 'error' | 'warning' | 'suggestion';
  category?: 'missing' | 'ambiguous' | 'plugin' | 'runtime' | 'not_verified';
  /** Short machine-readable code, e.g. "UNKNOWN_ENTITY". */
  code: string;
  title: string;
  detail: string;
  entityLogicalName?: string;
  attributeLogicalName?: string;
  relatedEntityLogicalName?: string;
  sourceReason?: string;
  /** Nearest correct logical name when a typo/alias was detected. */
  suggestedLogicalName?: string;
}

export type CrmMetadataVerdict = 'pass' | 'warnings' | 'fail' | 'unknown';

export type CrmRuntimeReadiness = 'not_checked' | 'low_risk' | 'risks_found' | 'unknown';

export type CrmCompileReadinessStatus =
  | 'not_checked'
  | 'could_not_find_project'
  | 'project_found_build_not_run'
  | 'build_check_available';

export interface CrmReferenceFinding {
  kind: 'entity' | 'attribute' | 'relationship' | 'option_value' | 'lookup_target' | 'plugin' | 'runtime';
  displayName: string;
  entityLogicalName?: string;
  attributeLogicalName?: string;
  relatedEntityLogicalName?: string;
  sourceReason: string;
  detail?: string;
}

export interface CrmPluginCheck {
  status: 'confirmed' | 'warning' | 'not_verified';
  title: string;
  detail: string;
  entityLogicalName?: string;
  attributeLogicalName?: string;
  sourceReason?: string;
}

export interface CrmCompileReadiness {
  status: CrmCompileReadinessStatus;
  detail: string;
}

export interface CrmDetectedEntityReference {
  logicalName: string;
  sourceReason: string;
  contextType: string;
  variableName?: string;
}

export interface CrmDetectedAttributeReference {
  logicalName: string;
  entityLogicalName?: string;
  sourceReason: string;
  contextType: string;
  variableName?: string;
  relatedEntityLogicalName?: string;
  optionValues?: number[];
}

export interface CrmDetectedRelationshipReference {
  sourceEntityLogicalName?: string;
  sourceAttributeLogicalName: string;
  targetEntityLogicalName?: string;
  targetAttributeLogicalName: string;
  sourceReason: string;
  contextType: string;
  variableName?: string;
}

export interface CrmAmbiguousReference {
  kind: 'entity' | 'attribute' | 'relationship' | 'plugin';
  logicalName: string;
  sourceReason: string;
  detail: string;
  entityLogicalName?: string;
  relatedEntityLogicalName?: string;
}

export interface CrmPluginScanInfo {
  primaryEntityName?: string;
  primaryEntitySource?: 'manual_override' | 'inferred' | 'unknown' | string;
  messages: string[];
  /** Stage integer (10=PreValidation, 20=PreOperation, 40=PostOperation). */
  stage?: number;
  stageName?: string;
  /** Mode integer (0=Synchronous, 1=Asynchronous). */
  mode?: number;
  modeName?: string;
  filteringAttributes: string[];
  usesPreEntityImages: boolean;
  usesPostEntityImages: boolean;
  imageAttributes: Record<string, string[]>;
  targetAttributes: string[];
  notes: string[];
}

export interface CrmScanLookupAssignment {
  entityLogicalName?: string;
  attributeLogicalName: string;
  targetEntityLogicalName?: string;
  sourceReason: string;
}

export interface CrmScanOptionSetAssignment {
  entityLogicalName?: string;
  attributeLogicalName: string;
  value: number;
  sourceReason: string;
}

export interface CrmScanFieldAccess {
  entityLogicalName?: string;
  attributeLogicalName: string;
  access: 'read' | 'write';
  sourceReason: string;
}

export interface CrmInspectedEntityDetail {
  entityLogicalName: string;
  columnCount: number;
  schemaCompleteness: 'complete' | 'incomplete' | 'unknown';
  toolUsed: string;
  paging?: string;
  note?: string;
}

export interface CrmRawExtractedReferences {
  entities: string[];
  attributes: Record<string, string[]>;
  entityReferences: CrmDetectedEntityReference[];
  attributeReferences: CrmDetectedAttributeReference[];
  relationshipReferences: CrmDetectedRelationshipReference[];
  ambiguousReferences: CrmAmbiguousReference[];
  notes: string[];
  pluginContext?: CrmPluginScanInfo;
  lookupAssignments?: CrmScanLookupAssignment[];
  optionSetAssignments?: CrmScanOptionSetAssignment[];
  fieldAccesses?: CrmScanFieldAccess[];
}

/** Summary of which Dataverse metadata was inspected during a CRM operation. */
export interface CrmMetadataInspection {
  entityLogicalNames: string[];
  attributeLogicalNames: Record<string, string[]>;
  entityDetails?: CrmInspectedEntityDetail[];
  formNames?: string[];
  solutionNames?: string[];
  /** Names of the MCP tools that were called. */
  toolsUsed: string[];
}

/** Result of the "Generate CRM Skeleton" action. */
export interface CrmSkeletonResult {
  id?: string;
  createdAt?: string;
  mode: 'script' | 'plugin';
  summary: string;
  pseudoCode: string;
  logicalNamesUsed: string[];
  metadataInspected: CrmMetadataInspection;
}

/** Result of the "Verify against CRM" action. */
export interface CrmVerificationReport {
  id?: string;
  createdAt?: string;
  filePath?: string;
  verdict: 'pass' | 'warnings' | 'fail' | 'unknown' | 'not_configured' | 'error';
  metadataVerdict: CrmMetadataVerdict;
  staticInferenceConfidence?: 'high' | 'medium' | 'low' | 'inferred' | 'unknown';
  runtimeReadiness: CrmRuntimeReadiness;
  summary: string;
  answer?: string;
  issues: CrmMetadataIssue[];
  confirmedReferences: CrmReferenceFinding[];
  missingReferences: CrmReferenceFinding[];
  ambiguousReferences: CrmReferenceFinding[];
  runtimeRisks: CrmReferenceFinding[];
  pluginChecks: CrmPluginCheck[];
  inspectedEntities: string[];
  inspectedAttributesByEntity: Record<string, string[]>;
  unableToVerifyReasons: string[];
  compileReadiness?: CrmCompileReadiness;
  metadataInspected: CrmMetadataInspection;
  rawExtractedReferences?: CrmRawExtractedReferences;
}

export type NavPage = 'inbox' | 'tasks' | 'week-log' | 'customers' | 'settings';

// --- Git commit preview types -----------------------------------------------

export interface GitChangedFile {
  path: string;
  status: 'staged' | 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
}

export interface GitCommitPreview {
  ok: boolean;
  repoRoot: string;
  branch: string;
  remote?: string;
  remoteUrl?: string;
  changedFiles: GitChangedFile[];
  ignoredFiles: GitChangedFile[];
  warnings: string[];
  suggestedCommitMessage: string;
  /** Remote default branch detected by the backend (e.g. "origin/main"). */
  baseBranch?: string;
  /** True when current HEAD shares a merge base with baseBranch. */
  hasMergeBase?: boolean;
  /** True when the branch can produce a normal PR (not main/master, has merge base, has remote). */
  canCreatePullRequest?: boolean;
  /** True when an upstream tracking branch is configured for the current branch. */
  hasUpstream?: boolean;
  /** The configured upstream ref, e.g. "origin/main" or "origin/VSM/10277". */
  upstreamBranch?: string;
  /** True when the upstream ref matches origin/<currentBranch>. */
  upstreamMatchesCurrentBranch?: boolean;
}

export interface GitCommitResult {
  ok: boolean;
  commitHash?: string;
  summary?: string;
}

export interface GitPushResult {
  ok: boolean;
  /** Present when this result comes from commit_and_push_task_changes. */
  commitHash?: string;
  branch?: string;
  remote?: string;
  summary?: string;
}

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
  /** Raw HTML body with CID inline images resolved to data: URIs. Only present on full-fetch (getOutlookMessageFull). */
  bodyHtml?: string;
  webLink: string;
  /**
   * True when the email has been flagged by the user in Outlook.
   * Populated from the Graph API `flag.flagStatus` field.
   * The backend filters server-side with `$filter=flag/flagStatus eq 'flagged'`,
   * so this will always be true for messages returned by `get_outlook_messages`.
   */
  isFlagged?: boolean;
}

/** Result shape returned by getOutlookFlaggedList. */
export interface OutlookFlaggedListResult {
  /** Newest SHOW_LIMIT (50) flagged emails, sorted by receivedAt desc. */
  messages: OutlookMessage[];
  /** Total flagged emails fetched via pagination before trimming. */
  fetchedCount: number;
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
  // Forwarded-message metadata — mirrored from TeamsFlatMessage.
  isForwarded?: boolean;
  originalSenderName?: string;
  originalSenderEmail?: string;
  originalSentAt?: string;
  originalContent?: string;
  // Teams message link metadata.
  hasLinkedTeamsMessage?: boolean;
  linkedMessageUrl?: string;
  linkedMessageType?: 'chat' | 'channel' | 'unknown';
  linkedMessageResolved?: boolean;
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
  // Forwarded-message metadata (populated by Rust before strip_html).
  // Present only when the Teams message is a forwarded card.
  isForwarded?: boolean;
  originalSenderName?: string;
  originalSenderEmail?: string;
  originalSentAt?: string;
  originalContent?: string;
  // Teams message link metadata.
  hasLinkedTeamsMessage?: boolean;
  linkedMessageUrl?: string;
  linkedMessageType?: 'chat' | 'channel' | 'unknown';
  linkedMessageResolved?: boolean;
}
