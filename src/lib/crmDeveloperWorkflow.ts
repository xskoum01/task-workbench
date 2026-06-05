import type {
  CrmDeveloperWorkKind,
  CrmDeveloperWorkflowState,
  CrmPullRequestFixProposal,
  CrmPullRequestFixUpdateTracking,
  CrmPullRequestProposal,
  CrmPullRequestReviewComment,
  CrmPullRequestReviewAnalysis,
  CrmPullRequestReviewIntake,
  CrmTechnicalImplementationPlan,
  CrmVerificationReport,
  Task,
} from '../types';
import { inferTaskMode } from './taskMode';

export type CrmDeveloperDetectionSource =
  | 'confirmed workflowSetup'
  | 'ADO PR context'
  | 'ADO work item context'
  | 'selected artifact path'
  | 'task fields heuristic'
  | 'not detected';

export interface CrmDeveloperWorkKindDetection {
  kind: CrmDeveloperWorkKind;
  source: CrmDeveloperDetectionSource;
  detail: string;
}

export interface CrmDeveloperChecklistItem {
  id: string;
  label: string;
  complete: boolean;
  detail: string;
}

export interface CrmVerificationSummary {
  exists: boolean;
  verdict: CrmVerificationReport['verdict'] | 'none';
  checkpointComplete: boolean;
  summary: string;
  createdAt?: string;
  issueCount?: number;
  inspectedEntityCount?: number;
}

export interface CrmCodeGenerationReadiness {
  ready: boolean;
  reason: string;
  blockers: string[];
  warnings: string[];
}

export interface CrmDiffReviewStatus {
  approved: boolean;
  approvable: boolean;
  hasReviewableChanges: boolean;
  reason: string;
  blockers: string[];
  warnings: string[];
}

export type CrmExternalActionProposalType =
  | 'plugin-registration'
  | 'web-resource-upload'
  | 'ribbon-update'
  | 'publish-customizations'
  | 'pull-request'
  | 'manual-check'
  | 'unknown';

export type CrmExternalActionRiskLevel = 'low' | 'medium' | 'high';

export interface CrmExternalActionProposal {
  id: string;
  type: CrmExternalActionProposalType;
  title: string;
  description: string;
  requiredBeforeExecution: string[];
  riskLevel: CrmExternalActionRiskLevel;
  readyForFutureExecution: boolean;
  blockedReason?: string;
  warnings: string[];
  previewPayload?: Record<string, string | string[] | undefined>;
}

export interface CrmExternalActionApprovalStatus {
  approved: boolean;
  approvable: boolean;
  reason: string;
  blockers: string[];
  warnings: string[];
}

export interface CrmPullRequestProposalStatus {
  generated: boolean;
  generatable: boolean;
  reason: string;
  blockers: string[];
  warnings: string[];
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface CrmPullRequestTrackingStatus {
  tracked: boolean;
  trackable: boolean;
  requiresExternalExecution: boolean;
  reason: string;
  blockers: string[];
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface CrmPullRequestReviewStatus {
  available: boolean;
  fetchable: boolean;
  reason: string;
  blockers: string[];
  provider: CrmPullRequestReviewIntake['provider'];
  attentionRequired?: boolean;
  unresolvedCount?: number;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface CrmPullRequestReviewAnalysisStatus {
  generated: boolean;
  generatable: boolean;
  reason: string;
  blockers: string[];
  attentionRequired?: boolean;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface CrmPullRequestFixProposalStatus {
  generated: boolean;
  generatable: boolean;
  reason: string;
  blockers: string[];
  canGenerateCodeLater?: boolean;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface CrmDraftContextFromPullRequestFixProposal {
  ready: boolean;
  reason: string;
  blockers: string[];
  warnings: string[];
  summary?: string;
  targetFileHints: string[];
  proposedChanges: Array<{
    filePath?: string;
    title: string;
    description: string;
    addressesCommentIds: string[];
    confidence: 'low' | 'medium' | 'high';
    riskLevel: 'low' | 'medium' | 'high';
  }>;
  implementationOrder: string[];
  risks: string[];
  testChecklist: string[];
  limitations: string[];
  promptContext?: string;
}

export interface CrmPullRequestFixUpdateStatus {
  tracked: boolean;
  trackable: boolean;
  reason: string;
  blockers: string[];
  warnings: string[];
  updatedAt?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface CrmPostFixReviewRefreshStatus {
  visible: boolean;
  refreshed: boolean;
  refreshable: boolean;
  needsAnalysis: boolean;
  reason: string;
  blockers: string[];
  warnings: string[];
  updatedAt?: string;
  refreshedAt?: string;
  latestCommentCount?: number;
}

export interface CrmGitHubPullRequestRef {
  owner: string;
  repo: string;
  prNumber: number;
}

const MEANINGFUL_VERIFICATION_VERDICTS: CrmVerificationReport['verdict'][] = ['pass', 'warnings', 'fail'];

export function isMeaningfulCrmVerificationReport(
  report: CrmVerificationReport | undefined,
): report is CrmVerificationReport {
  return !!report && MEANINGFUL_VERIFICATION_VERDICTS.includes(report.verdict);
}

function taskText(task: Task): string {
  return [
    task.title,
    task.originalMessage,
    task.classificationLabel,
    task.analysisResult?.summary,
    task.analysisResult?.summaryCz,
    task.analysisResult?.summaryEn,
    task.workflowSetup?.scriptPath,
    task.workflowSetup?.artifactPath,
    task.selectedPluginProject,
    task.adoContext?.commentedFile,
    task.adoContext?.reviewComment,
    task.adoContext?.workItemTitle,
    task.adoContext?.workItemDescription,
  ].filter(Boolean).join(' ').toLowerCase();
}

function pathKind(path: string | undefined): CrmDeveloperWorkKind | undefined {
  const lower = path?.toLowerCase() ?? '';
  if (!lower) return undefined;
  if (lower.endsWith('.cs') || lower.includes('/plugins/') || lower.includes('\\plugins\\')) return 'plugin';
  if (lower.endsWith('.js') || lower.endsWith('.ts') || lower.includes('webresource')) return 'script';
  return undefined;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function isIsoAfter(value: string | undefined, compareTo: string | undefined): boolean {
  if (!value || !compareTo) return false;
  const valueTime = Date.parse(value);
  const compareTime = Date.parse(compareTo);
  if (!Number.isFinite(valueTime) || !Number.isFinite(compareTime)) return false;
  return valueTime > compareTime;
}

function inferPluginStage(task: Task): string | undefined {
  const text = taskText(task);
  if (/pre[-\s]?validation/.test(text)) return 'PreValidation';
  if (/pre[-\s]?operation/.test(text)) return 'PreOperation';
  if (/post[-\s]?operation/.test(text)) return 'PostOperation';
  return undefined;
}

function inferPluginMode(task: Task): string | undefined {
  const text = taskText(task);
  if (/\basync|asynchronous\b/.test(text)) return 'Async';
  if (/\bsync|synchronous\b/.test(text)) return 'Sync';
  return undefined;
}

function inferPluginMessage(task: Task, report: CrmVerificationReport | undefined): string | undefined {
  const pluginMessages = report?.rawExtractedReferences?.pluginContext?.messages ?? [];
  const explicit = uniqueStrings(pluginMessages)[0];
  if (explicit) return explicit;

  const text = taskText(task);
  const knownMessages = ['create', 'update', 'delete', 'assign', 'setstate', 'associate', 'disassociate'];
  return knownMessages.find((message) => new RegExp(`\\b${message}\\b`).test(text));
}

function inferTargetEntity(task: Task, report: CrmVerificationReport | undefined): string | undefined {
  return task.workflowSetup?.primaryEntityLogicalName
    ?? task.scriptAnalysis?.entityLogicalName
    ?? report?.rawExtractedReferences?.pluginContext?.primaryEntityName
    ?? report?.inspectedEntities?.[0]
    ?? report?.metadataInspected?.entityLogicalNames?.[0];
}

function buildDataverseFindings(report: CrmVerificationReport | undefined): string[] {
  if (!report) {
    return ['Plan generated without verified Dataverse metadata. Run metadata verification before implementation when possible.'];
  }

  const findings = [
    `Latest metadata verification verdict: ${report.verdict}.`,
    report.summary || report.answer,
  ];

  if (report.verdict === 'fail') {
    findings.push('Plan must account for verification issues before implementation.');
  } else if (report.verdict === 'warnings') {
    findings.push('Review verification warnings before implementation.');
  } else if (!isMeaningfulCrmVerificationReport(report)) {
    findings.push('Latest report does not complete the metadata verification checkpoint.');
  }

  const issueFindings = (report.issues ?? [])
    .slice(0, 5)
    .map((issue) => `${issue.severity.toUpperCase()}: ${issue.title}`);

  return uniqueStrings([...findings, ...issueFindings]);
}

function buildExternalActionPreview(kind: CrmDeveloperWorkKind): string[] {
  if (kind === 'plugin') {
    return ['Plugin step registration may be needed later, but this plan does not register anything.'];
  }
  if (kind === 'script' || kind === 'ribbon') {
    return ['Web resource upload or publishing may be needed later, but this plan does not upload or publish anything.'];
  }
  return ['Pull request or deployment actions may be needed later, but this plan does not create external changes.'];
}

function buildPlanSections(
  task: Task,
  kind: CrmDeveloperWorkKind,
  report: CrmVerificationReport | undefined,
): Pick<CrmTechnicalImplementationPlan, 'implementationSteps' | 'risks' | 'testChecklist'> {
  const entity = inferTargetEntity(task, report) ?? 'target table/entity';
  const scriptPath = task.workflowSetup?.scriptPath ?? task.workflowSetup?.artifactPath ?? 'target web resource';
  const pluginProject = task.workflowSetup?.pluginProject ?? task.selectedPluginProject ?? 'target plugin project';
  const message = inferPluginMessage(task, report) ?? 'target message';
  const stage = inferPluginStage(task) ?? 'target stage';
  const mode = inferPluginMode(task) ?? 'sync/async mode';

  switch (kind) {
    case 'plugin':
      return {
        implementationSteps: [
          `Confirm plugin target: ${entity}, ${message}, ${stage}, ${mode}.`,
          `Locate the correct plugin class/project in ${pluginProject}.`,
          'Define filtering attributes and required pre/post images before writing code.',
          'Implement business logic with null checks, depth/recursion protection, tracing, and minimal column access.',
          'Prepare a diff for review before any registration or deployment step.',
        ],
        risks: [
          'Plugin stage/message/entity may be incomplete if setup or metadata verification is missing.',
          'Filtering attributes or image configuration can cause runtime behavior to differ from local code expectations.',
          'Metadata verification issues must be resolved or explicitly accepted before implementation.',
        ],
        testChecklist: [
          'Build the plugin project locally.',
          'Exercise create/update/delete path matching the configured message.',
          'Verify behavior with missing optional fields and unchanged filtering attributes.',
          'Check trace output and exception handling.',
          'Confirm no plugin step registration is performed until explicitly approved later.',
        ],
      };
    case 'script':
      return {
        implementationSteps: [
          `Confirm target form/table and script path: ${scriptPath}.`,
          'Identify event handlers to add or update, including onLoad/onSave/onChange wiring.',
          'List all fields, tabs, sections, notifications, and Xrm APIs touched by the script.',
          'Design defensive formContext access and avoid assumptions about unavailable controls.',
          'Prepare a diff for review before any web resource upload.',
        ],
        risks: [
          'Form event wiring may be outside the script file and needs explicit review.',
          'Fields or controls may not exist on every form variation.',
          'Metadata verification warnings should be reviewed before implementation.',
        ],
        testChecklist: [
          'Load the target form and verify handler registration.',
          'Test onLoad/onSave/onChange paths relevant to the task.',
          'Verify required notifications, visibility, requirement level, and field values.',
          'Test with empty/null values and read-only forms where relevant.',
          'Confirm no web resource upload is performed until explicitly approved later.',
        ],
      };
    case 'ribbon':
      return {
        implementationSteps: [
          'Confirm command bar area, button/command names, and intended user action.',
          'Identify enable/display rules and any JavaScript action to add or update.',
          'Verify referenced table, form, and web resource names before implementation.',
          'Plan publishing/deployment notes separately from code changes.',
          'Prepare a diff for review before any ribbon publishing or web resource upload.',
        ],
        risks: [
          'Ribbon rules can vary by app, form, table, and selection context.',
          'Publishing changes can affect users broadly and must stay behind a later approval gate.',
          'Metadata verification issues must be accounted for before implementation.',
        ],
        testChecklist: [
          'Verify button visibility in the intended app/form/grid context.',
          'Test enable/display rules for allowed and blocked records.',
          'Test JavaScript action behavior and error handling.',
          'Confirm labels/icons/localization if applicable.',
          'Confirm no publish/upload action is performed until explicitly approved later.',
        ],
      };
    case 'review':
      return {
        implementationSteps: [
          'Collect the PR comment, affected file, and expected behavior.',
          'Map each review comment to a proposed local code change.',
          'Check whether Dataverse metadata findings affect the requested change.',
          'Prepare a minimal fix plan before editing files.',
        ],
        risks: [
          'Review context may be incomplete without the full PR diff.',
          'A requested fix may conflict with existing task setup or metadata verification findings.',
        ],
        testChecklist: [
          'Verify every review comment has a response or proposed change.',
          'Run relevant local tests/build after code is changed in a later PR.',
          'Confirm no PR reply or push is performed until explicitly approved later.',
        ],
      };
    case 'bugfix':
      return {
        implementationSteps: [
          'Reproduce or restate the bug and expected behavior.',
          'Identify the smallest target area likely responsible for the issue.',
          'Use metadata verification findings to avoid fixing against stale logical names.',
          'Prepare a minimal implementation diff plan before editing files.',
        ],
        risks: [
          'Bug reports may omit the exact environment, form, security role, or data shape.',
          'Fixing symptoms without metadata validation may leave Dataverse-specific failures.',
        ],
        testChecklist: [
          'Verify the reported failure path.',
          'Test the corrected path and one nearby regression path.',
          'Run relevant local tests/build after code is changed in a later PR.',
        ],
      };
    case 'repo-only':
    case 'unknown':
    default:
      return {
        implementationSteps: [
          'Clarify the target repository files and intended behavior.',
          'Confirm whether the task is CRM-specific, plugin/script/ribbon, or repo-only.',
          'Use metadata verification if Dataverse logical names are involved.',
          'Prepare a minimal diff plan before editing files.',
        ],
        risks: [
          'Work kind is not specific enough to produce an implementation-ready plan.',
          'Dataverse impact may be hidden until target files are identified.',
        ],
        testChecklist: [
          'Confirm target files and acceptance criteria.',
          'Run relevant local tests/build after code is changed in a later PR.',
          'Confirm no external action is performed until explicitly approved later.',
        ],
      };
  }
}

export function isDeveloperWorkflowTask(task: Task): boolean {
  return inferTaskMode(task).mode === 'developer';
}

export function detectCrmDeveloperWorkKind(task: Task): CrmDeveloperWorkKindDetection {
  const setup = task.workflowSetup;
  if (setup?.devTargetKind === 'plugin') {
    return {
      kind: 'plugin',
      source: 'confirmed workflowSetup',
      detail: setup.pluginProject ? `Confirmed plugin project: ${setup.pluginProject}` : 'Confirmed target kind is plugin.',
    };
  }
  if (setup?.devTargetKind === 'script') {
    const text = taskText(task);
    const isRibbon = /\bribbon\b|command\s*bar|commandbar|enable\s*rule|display\s*rule/.test(text);
    return {
      kind: isRibbon ? 'ribbon' : 'script',
      source: 'confirmed workflowSetup',
      detail: setup.scriptPath ? `Confirmed script path: ${setup.scriptPath}` : 'Confirmed target kind is script.',
    };
  }
  if (setup?.devTargetKind === 'repo') {
    return {
      kind: 'repo-only',
      source: 'confirmed workflowSetup',
      detail: setup.repositoryRoot ? `Confirmed repository: ${setup.repositoryRoot}` : 'Confirmed target kind is repository.',
    };
  }
  if (setup?.workIntent === 'review') {
    return { kind: 'review', source: 'confirmed workflowSetup', detail: 'Confirmed work intent is review.' };
  }
  if (setup?.workIntent === 'fix') {
    return { kind: 'bugfix', source: 'confirmed workflowSetup', detail: 'Confirmed work intent is fix.' };
  }

  if (task.adoContext?.type === 'pr-comment') {
    return {
      kind: 'review',
      source: 'ADO PR context',
      detail: task.adoContext.commentedFile
        ? `PR comment on ${task.adoContext.commentedFile}`
        : 'Azure DevOps PR comment context was detected.',
    };
  }

  const artifactKind = pathKind(setup?.artifactPath) ?? pathKind(setup?.scriptPath);
  if (artifactKind) {
    return {
      kind: artifactKind,
      source: 'selected artifact path',
      detail: setup?.artifactPath ?? setup?.scriptPath ?? 'Selected artifact path indicates the work kind.',
    };
  }
  if (task.selectedPluginProject) {
    return {
      kind: 'plugin',
      source: 'selected artifact path',
      detail: `Selected plugin project: ${task.selectedPluginProject}`,
    };
  }

  const text = taskText(task);
  if (/\bribbon\b|command\s*bar|commandbar|enable\s*rule|display\s*rule/.test(text)) {
    return { kind: 'ribbon', source: 'task fields heuristic', detail: 'Ribbon or command bar keywords were found.' };
  }
  if (/\bplugin\b|\biplugin\b|preoperation|postoperation|iorganizationservice|\.cs\b|\.csproj\b/.test(text)) {
    return { kind: 'plugin', source: 'task fields heuristic', detail: 'Plugin/C# Dataverse keywords were found.' };
  }
  if (/\bscript\b|web\s*resource|webresource|\bonload\b|\bonsave\b|\bonchange\b|\bxrm\.|formcontext|\.js\b|\.ts\b/.test(text)) {
    return { kind: 'script', source: 'task fields heuristic', detail: 'Script/web resource keywords were found.' };
  }
  if (task.taskType === 'review') {
    return { kind: 'review', source: 'task fields heuristic', detail: 'Task type is review.' };
  }
  if (task.taskType === 'bug-fix') {
    return { kind: 'bugfix', source: 'task fields heuristic', detail: 'Task type is bug fix.' };
  }
  if (task.adoContext?.type === 'work-item' || task.devopsTaskUrl) {
    return {
      kind: 'repo-only',
      source: task.adoContext?.type === 'work-item' ? 'ADO work item context' : 'task fields heuristic',
      detail: 'Developer context exists, but no plugin/script/ribbon target was detected.',
    };
  }

  return { kind: 'unknown', source: 'not detected', detail: 'No CRM developer work kind could be inferred yet.' };
}

export function buildCrmDeveloperWorkflowChecklist(task: Task): CrmDeveloperChecklistItem[] {
  const latestVerification = task.crmVerificationReports?.[0];
  const latestReview = task.aiFileReviews?.[0];
  const hasDiffReview = task.aiFileReviews?.some((review) => review.reviewMode === 'change') ?? false;
  const hasArtifact = !!(task.workflowSetup?.artifactPath || task.workflowSetup?.scriptPath);
  const hasTechnicalPlan = !!task.crmDeveloperWorkflow?.technicalPlan;
  const planApproved = !!task.crmDeveloperWorkflow?.planApproval?.approved;
  const diffReviewStatus = getCrmDiffReviewStatus(task);
  const externalActionStatus = getCrmExternalActionApprovalStatus(task);
  const executionStatus = getCrmExternalExecutionStatus(task);
  const prProposalStatus = getCrmPullRequestProposalStatus(task);
  const prTrackingStatus = getCrmPullRequestTrackingStatus(task);
  const prReviewAnalysisStatus = getCrmPullRequestReviewAnalysisStatus(task);
  const prFixProposalStatus = getCrmPullRequestFixProposalStatus(task);
  const fixDraftContext = buildCrmDraftContextFromPullRequestFixProposal(task);
  const codeReadinessStatus = getCrmCodeGenerationReadiness(task);
  const fixUpdateStatus = getCrmPullRequestFixUpdateStatus(task);
  const postFixRefreshStatus = getCrmPostFixReviewRefreshStatus(task);

  return [
    {
      id: 'task-analyzed',
      label: 'Task analyzed',
      complete: !!task.analysisResult || task.status !== 'new',
      detail: task.analysisResult ? 'Analysis result is saved on this task.' : 'No saved analysis result yet.',
    },
    {
      id: 'setup-confirmed',
      label: 'Setup confirmed',
      complete: !!task.workflowSetup?.confirmedAt,
      detail: task.workflowSetup?.confirmedAt ? 'Workflow setup has been confirmed by the user.' : 'Plugin/script/repo setup has not been confirmed.',
    },
    {
      id: 'dataverse-verified',
      label: 'Dataverse metadata verified',
      complete: isMeaningfulCrmVerificationReport(latestVerification),
      detail: latestVerification ? `Latest verdict: ${latestVerification.verdict}.` : 'No CRM verification report is saved.',
    },
    {
      id: 'technical-plan-approved',
      label: 'Technical plan approved',
      complete: planApproved,
      detail: planApproved
        ? 'The draft technical plan has been explicitly approved by the user.'
        : hasTechnicalPlan
          ? 'Draft technical plan exists and is waiting for explicit approval.'
          : 'Generate a draft technical plan before approval.',
    },
    {
      id: 'code-generated',
      label: 'Code generated',
      complete: hasArtifact,
      detail: hasArtifact ? 'A task artifact path is saved.' : 'No generated or selected artifact is saved.',
    },
    {
      id: 'diff-approved',
      label: 'Diff approved',
      complete: diffReviewStatus.approved,
      detail: diffReviewStatus.approved
        ? 'The reviewed diff/code changes have been explicitly approved by the user.'
        : hasDiffReview || latestReview || diffReviewStatus.hasReviewableChanges
          ? 'Reviewable changes exist and are waiting for explicit diff approval.'
          : 'No generated or reviewed code changes are available for diff approval yet.',
    },
    {
      id: 'external-action-approved',
      label: 'External action approved',
      complete: externalActionStatus.approved,
      detail: externalActionStatus.approved
        ? 'The proposed external action plan has been explicitly approved locally.'
        : 'External execution remains a future explicit gate. No external action is approved yet.',
    },
    {
      id: 'external-execution-completed',
      label: 'External execution recorded',
      complete: executionStatus.completed,
      detail: executionStatus.completed
        ? `Manually recorded as completed${executionStatus.completedAt ? ` — ${executionStatus.completedAt}` : ''}.${executionStatus.notes ? ` Note: ${executionStatus.notes}` : ''}`
        : executionStatus.invalidatedAt
          ? `Previous completion invalidated: ${executionStatus.invalidationReason ?? 'upstream change'}.`
          : 'No manual completion recorded yet.',
    },
    {
      id: 'pull-request-proposal-generated',
      label: 'Pull request proposal generated',
      complete: prProposalStatus.generated,
      detail: prProposalStatus.generated
        ? 'A local PR title/body proposal is saved on this task.'
        : prProposalStatus.invalidatedAt
          ? `Previous PR proposal invalidated: ${prProposalStatus.invalidationReason ?? 'upstream change'}.`
          : 'No local PR proposal has been generated yet.',
    },
    {
      id: 'pull-request-manually-tracked',
      label: 'Pull request manually tracked',
      complete: prTrackingStatus.tracked,
      detail: prTrackingStatus.tracked
        ? 'A manually created PR has been recorded locally.'
        : prTrackingStatus.invalidatedAt
          ? `Previous manual PR tracking invalidated: ${prTrackingStatus.invalidationReason ?? 'upstream change'}.`
          : 'No manually created PR is recorded yet.',
    },
    {
      id: 'pull-request-review-analysis-generated',
      label: 'PR review analysis generated',
      complete: prReviewAnalysisStatus.generated,
      detail: prReviewAnalysisStatus.generated
        ? 'A local review fix plan is saved on this task.'
        : prReviewAnalysisStatus.invalidatedAt
          ? `Previous review analysis invalidated: ${prReviewAnalysisStatus.invalidationReason ?? 'upstream change'}.`
          : 'No local PR review analysis has been generated yet.',
    },
    {
      id: 'pull-request-fix-proposal-generated',
      label: 'PR fix proposal generated',
      complete: prFixProposalStatus.generated,
      detail: prFixProposalStatus.generated
        ? 'A local fix draft proposal is saved on this task.'
        : prFixProposalStatus.invalidatedAt
          ? `Previous fix proposal invalidated: ${prFixProposalStatus.invalidationReason ?? 'upstream change'}.`
          : 'No local PR fix proposal has been generated yet.',
    },
    {
      id: 'fix-proposal-ready-for-draft-generation',
      label: 'Fix proposal ready for draft generation',
      complete: fixDraftContext.ready && codeReadinessStatus.ready,
      detail: fixDraftContext.ready && codeReadinessStatus.ready
        ? 'A valid fix proposal can be passed into the existing draft generation flow.'
        : fixDraftContext.blockers[0]
          ?? codeReadinessStatus.blockers[0]
          ?? 'No valid fix proposal is ready for draft generation.',
    },
    {
      id: 'pull-request-fix-update-manually-tracked',
      label: 'PR fix update manually tracked',
      complete: fixUpdateStatus.tracked,
      detail: fixUpdateStatus.tracked
        ? 'A manual PR update after fixing review comments is recorded locally.'
        : fixUpdateStatus.invalidatedAt
          ? `Previous PR fix update tracking invalidated: ${fixUpdateStatus.invalidationReason ?? 'upstream change'}.`
          : 'No manual PR fix update is recorded yet.',
    },
    {
      id: 'pull-request-review-refreshed-after-fix-update',
      label: 'PR review refreshed after fix update',
      complete: postFixRefreshStatus.refreshed,
      detail: postFixRefreshStatus.refreshed
        ? 'A newer read-only PR review snapshot exists after the manual fix update.'
        : postFixRefreshStatus.visible
          ? 'Fetch PR review status again after the manual PR update.'
          : 'No manual PR fix update is recorded yet.',
    },
    {
      id: 'pr-approved',
      label: 'PR approved',
      complete: false,
      detail: 'Remote PR creation and approval are not implemented here.',
    },
  ];
}

export function buildCrmTechnicalImplementationPlan(
  task: Task,
  now: string = new Date().toISOString(),
): CrmTechnicalImplementationPlan {
  const detection = detectCrmDeveloperWorkKind(task);
  const meaningfulReport = isMeaningfulCrmVerificationReport(task.crmVerificationReports?.[0])
    ? task.crmVerificationReports?.[0]
    : undefined;
  const latestReport = task.crmVerificationReports?.[0];
  const targetEntity = inferTargetEntity(task, meaningfulReport ?? latestReport);
  const planSections = buildPlanSections(task, detection.kind, meaningfulReport ?? latestReport);

  return {
    generatedAt: now,
    generatedFromVerificationReportId: meaningfulReport?.id,
    workKind: detection.kind,
    summary: `Draft ${detection.kind} implementation plan for "${task.title}". Review this plan before any code generation or file edits.`,
    target: {
      entityLogicalName: targetEntity,
      message: detection.kind === 'plugin' ? inferPluginMessage(task, meaningfulReport ?? latestReport) : undefined,
      stage: detection.kind === 'plugin' ? inferPluginStage(task) : undefined,
      mode: detection.kind === 'plugin' ? inferPluginMode(task) : undefined,
      scriptPath: task.workflowSetup?.scriptPath ?? task.workflowSetup?.artifactPath,
      pluginProject: task.workflowSetup?.pluginProject ?? task.selectedPluginProject,
    },
    implementationSteps: planSections.implementationSteps,
    dataverseFindings: buildDataverseFindings(latestReport),
    risks: planSections.risks,
    testChecklist: planSections.testChecklist,
    externalActionPreview: buildExternalActionPreview(detection.kind),
  };
}

export function getLatestCrmVerificationSummary(task: Task): CrmVerificationSummary {
  const report = task.crmVerificationReports?.[0];
  if (!report) {
    return {
      exists: false,
      verdict: 'none',
      checkpointComplete: false,
      summary: 'No CRM verification report has been saved for this task.',
    };
  }

  return {
    exists: true,
    verdict: report.verdict,
    checkpointComplete: isMeaningfulCrmVerificationReport(report),
    summary: report.summary || report.answer || 'CRM verification report exists.',
    createdAt: report.createdAt,
    issueCount: report.issues?.length ?? 0,
    inspectedEntityCount: report.inspectedEntities?.length ?? report.metadataInspected?.entityLogicalNames?.length ?? 0,
  };
}

export function getCrmCodeGenerationReadiness(task: Task): CrmCodeGenerationReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!isDeveloperWorkflowTask(task)) {
    return {
      ready: false,
      reason: 'Not a developer workflow task.',
      blockers: ['CRM code generation readiness applies only to developer workflow tasks.'],
      warnings,
    };
  }

  const detection = detectCrmDeveloperWorkKind(task);
  const workflow = task.crmDeveloperWorkflow;
  const technicalPlan = workflow?.technicalPlan;
  const planApproval = workflow?.planApproval;
  const latestVerification = task.crmVerificationReports?.[0];

  if (!technicalPlan) {
    blockers.push('Missing technical implementation plan.');
  }

  if (!planApproval?.approved) {
    blockers.push(planApproval?.invalidatedAt
      ? `Technical plan approval was invalidated: ${planApproval.invalidationReason ?? 'approval is stale'}.`
      : 'Technical implementation plan is not approved.');
  }

  const latestVerificationVerdict = latestVerification?.verdict;
  if (latestVerificationVerdict === 'warnings') {
    warnings.push('Latest Dataverse metadata verification completed with warnings.');
  } else if (latestVerificationVerdict === 'fail') {
    warnings.push('Latest Dataverse metadata verification found issues. Code generation may proceed only with those issues explicitly accounted for.');
  } else if (!latestVerification) {
    warnings.push('No Dataverse metadata verification report is saved for this task.');
  } else if (latestVerificationVerdict !== 'pass') {
    warnings.push(`Latest Dataverse metadata verification is ${latestVerificationVerdict} and does not complete the checkpoint.`);
  }

  if (detection.kind === 'plugin') {
    if (!(task.workflowSetup?.pluginProject ?? task.selectedPluginProject)) {
      blockers.push('Plugin project is not selected.');
    }
  } else if (detection.kind === 'script' || detection.kind === 'ribbon') {
    if (!(task.workflowSetup?.scriptPath ?? task.workflowSetup?.artifactPath)) {
      warnings.push('Target script/web resource path is not confirmed yet.');
    }
  } else if (detection.kind === 'unknown') {
    blockers.push('CRM developer work kind is unknown.');
  }

  const ready = blockers.length === 0;
  const reason = ready
    ? warnings.length > 0
      ? 'Ready with warnings: approved plan exists, but review warnings before code generation.'
      : 'Ready: approved technical plan exists.'
    : blockers[0] ?? 'Not ready.';

  return {
    ready,
    reason,
    blockers,
    warnings,
  };
}

export function hasCrmReviewableGeneratedChanges(task: Task): boolean {
  return !!task.workflowSetup?.artifactPath
    || (task.aiFileReviews?.some((review) => review.reviewMode === 'change' || review.reviewMode === 'file') ?? false);
}

export function getCrmDiffReviewStatus(task: Task): CrmDiffReviewStatus {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const codeReadiness = getCrmCodeGenerationReadiness(task);
  const workflow = task.crmDeveloperWorkflow;
  const diffApproval = workflow?.diffApproval;
  const hasReviewableChanges = hasCrmReviewableGeneratedChanges(task);

  if (!workflow?.technicalPlan) {
    blockers.push('Missing technical implementation plan.');
  }
  if (!workflow?.planApproval?.approved) {
    blockers.push(workflow?.planApproval?.invalidatedAt
      ? `Technical plan approval was invalidated: ${workflow.planApproval.invalidationReason ?? 'approval is stale'}.`
      : 'Technical implementation plan is not approved.');
  }
  if (!codeReadiness.ready) {
    blockers.push(`Code generation readiness is not satisfied: ${codeReadiness.reason}`);
  }
  if (!hasReviewableChanges) {
    blockers.push('No generated artifact or saved code review is available to approve.');
  }

  warnings.push(...codeReadiness.warnings);

  if (diffApproval?.invalidatedAt && !diffApproval.approved) {
    warnings.push(`Previous diff approval was invalidated: ${diffApproval.invalidationReason ?? 'approval is stale'}.`);
  }

  const approvable = blockers.length === 0;
  const approved = !!diffApproval?.approved && approvable;
  const reason = approved
    ? warnings.length > 0
      ? 'Diff approved with warnings.'
      : 'Diff approved.'
    : approvable
      ? warnings.length > 0
        ? 'Reviewable changes can be approved with warnings.'
        : 'Reviewable changes are ready for diff approval.'
      : blockers[0] ?? 'Diff approval is not ready.';

  return {
    approved,
    approvable,
    hasReviewableChanges,
    reason,
    blockers,
    warnings,
  };
}

function buildExternalProposalWarnings(report: CrmVerificationReport | undefined): string[] {
  if (!report) {
    return ['No Dataverse metadata verification report is saved for this task.'];
  }
  const verdict = report.verdict;
  if (verdict === 'warnings') {
    return ['Latest Dataverse metadata verification completed with warnings.'];
  }
  if (verdict === 'fail') {
    return ['Latest Dataverse metadata verification found issues that must be handled before external execution.'];
  }
  if (verdict !== 'pass') {
    return [`Latest Dataverse metadata verification is ${verdict} and does not complete the checkpoint.`];
  }
  return [];
}

function proposal(
  base: Omit<CrmExternalActionProposal, 'requiredBeforeExecution' | 'readyForFutureExecution' | 'blockedReason' | 'warnings'>,
  blockers: string[],
  warnings: string[],
): CrmExternalActionProposal {
  return {
    ...base,
    readyForFutureExecution: blockers.length === 0,
    blockedReason: blockers.length > 0 ? blockers.join(' ') : undefined,
    warnings,
    requiredBeforeExecution: [
      ...blockers,
      'Explicit external action approval gate in a future PR.',
      'Final environment and target confirmation by the user.',
    ],
  };
}

export function buildCrmExternalActionProposals(task: Task): CrmExternalActionProposal[] {
  const detection = detectCrmDeveloperWorkKind(task);
  const workflow = task.crmDeveloperWorkflow;
  const diffStatus = getCrmDiffReviewStatus(task);
  const latestVerification = task.crmVerificationReports?.[0];
  const warnings = buildExternalProposalWarnings(latestVerification);
  const target = workflow?.technicalPlan?.target;
  const artifactPath = task.workflowSetup?.artifactPath ?? task.workflowSetup?.scriptPath;
  const pluginProject = task.workflowSetup?.pluginProject ?? task.selectedPluginProject ?? target?.pluginProject;
  const scriptPath = target?.scriptPath ?? artifactPath;

  const blockers: string[] = [];
  if (!workflow?.technicalPlan) blockers.push('Generate a technical implementation plan first.');
  if (!workflow?.planApproval?.approved) blockers.push('Approve the technical implementation plan first.');
  if (!diffStatus.approved) blockers.push('Approve the reviewed diff/code changes first.');

  const commonPayload = {
    workKind: detection.kind,
    artifactPath,
    verificationVerdict: latestVerification?.verdict,
  };

  switch (detection.kind) {
    case 'plugin':
      return [
        proposal({
          id: 'plugin-registration',
          type: 'plugin-registration',
          title: 'Plugin step registration proposal',
          description: 'Future step may register or update a Dataverse plugin step after explicit approval.',
          riskLevel: 'high',
          previewPayload: {
            ...commonPayload,
            pluginProject,
            entity: target?.entityLogicalName,
            message: target?.message,
            stage: target?.stage,
            mode: target?.mode,
          },
        }, blockers, warnings),
        proposal({
          id: 'publish-customizations',
          type: 'publish-customizations',
          title: 'Publish customizations note',
          description: 'Future Dataverse deployment may require publishing customizations after plugin registration.',
          riskLevel: 'medium',
          previewPayload: commonPayload,
        }, blockers, warnings),
        proposal({
          id: 'pull-request',
          type: 'pull-request',
          title: 'Pull request proposal',
          description: 'Future step may create a pull request for reviewed local repository changes.',
          riskLevel: 'low',
          previewPayload: commonPayload,
        }, blockers, warnings),
      ];
    case 'script':
      return [
        proposal({
          id: 'web-resource-upload',
          type: 'web-resource-upload',
          title: 'Web resource upload proposal',
          description: 'Future step may upload the reviewed script/web resource to Dataverse after explicit approval.',
          riskLevel: 'high',
          previewPayload: {
            ...commonPayload,
            scriptPath,
            entity: target?.entityLogicalName,
          },
        }, blockers, warnings),
        proposal({
          id: 'publish-customizations',
          type: 'publish-customizations',
          title: 'Publish customizations note',
          description: 'Future Dataverse deployment may require publishing customizations after web resource upload.',
          riskLevel: 'medium',
          previewPayload: commonPayload,
        }, blockers, warnings),
        proposal({
          id: 'pull-request',
          type: 'pull-request',
          title: 'Pull request proposal',
          description: 'Future step may create a pull request for reviewed local repository changes.',
          riskLevel: 'low',
          previewPayload: commonPayload,
        }, blockers, warnings),
      ];
    case 'ribbon':
      return [
        proposal({
          id: 'ribbon-update',
          type: 'ribbon-update',
          title: 'Ribbon / command bar update proposal',
          description: 'Future step may apply ribbon or command bar changes after explicit approval.',
          riskLevel: 'high',
          previewPayload: {
            ...commonPayload,
            scriptPath,
            entity: target?.entityLogicalName,
          },
        }, blockers, warnings),
        proposal({
          id: 'publish-customizations',
          type: 'publish-customizations',
          title: 'Publish customizations note',
          description: 'Ribbon or command bar changes usually require publishing customizations.',
          riskLevel: 'high',
          previewPayload: commonPayload,
        }, blockers, warnings),
        proposal({
          id: 'pull-request',
          type: 'pull-request',
          title: 'Pull request proposal',
          description: 'Future step may create a pull request for reviewed local repository changes.',
          riskLevel: 'low',
          previewPayload: commonPayload,
        }, blockers, warnings),
      ];
    case 'review':
    case 'bugfix':
    case 'repo-only':
      return [
        proposal({
          id: 'pull-request',
          type: 'pull-request',
          title: 'Pull request proposal',
          description: 'Future step may create a pull request for the reviewed repository-only change.',
          riskLevel: 'low',
          previewPayload: commonPayload,
        }, blockers, warnings),
        proposal({
          id: 'manual-check',
          type: 'manual-check',
          title: 'Manual delivery checklist',
          description: 'Confirm review comments, tests, and deployment notes before any external handoff.',
          riskLevel: 'low',
          previewPayload: commonPayload,
        }, blockers, warnings),
      ];
    case 'unknown':
    default:
      return [
        proposal({
          id: 'manual-check',
          type: 'manual-check',
          title: 'Manual external action review',
          description: 'Work kind is not clear enough to propose a specific external action.',
          riskLevel: 'medium',
          previewPayload: commonPayload,
        }, [...blockers, 'Clarify the CRM developer work kind first.'], warnings),
      ];
  }
}

export function getCrmExternalActionApprovalStatus(task: Task): CrmExternalActionApprovalStatus {
  const blockers: string[] = [];
  const proposals = buildCrmExternalActionProposals(task);
  const workflow = task.crmDeveloperWorkflow;
  const approval = workflow?.externalActionApproval;

  if (!workflow?.technicalPlan) blockers.push('Generate a technical implementation plan first.');
  if (!workflow?.planApproval?.approved) blockers.push('Approve the technical implementation plan first.');
  if (!workflow?.diffApproval?.approved) blockers.push('Approve the reviewed diff/code changes first.');
  if (proposals.length === 0) blockers.push('No external action proposals are available.');

  const blockedProposals = proposals.filter((proposal) => !proposal.readyForFutureExecution);
  if (blockedProposals.length > 0) {
    blockers.push('Resolve blocked external action proposals first.');
  }

  const warnings = uniqueStrings(proposals.flatMap((proposal) => proposal.warnings));
  if (approval?.invalidatedAt && !approval.approved) {
    warnings.push(`Previous external action approval was invalidated: ${approval.invalidationReason ?? 'approval is stale'}.`);
  }

  const approvable = blockers.length === 0;
  const approved = !!approval?.approved && approvable;
  const reason = approved
    ? warnings.length > 0
      ? 'External action plan approved with warnings.'
      : 'External action plan approved.'
    : approvable
      ? warnings.length > 0
        ? 'External action plan can be approved with warnings for a future execution step.'
        : 'External action plan is ready for local approval.'
      : blockers[0] ?? 'External action approval is not ready.';

  return {
    approved,
    approvable,
    reason,
    blockers,
    warnings,
  };
}

function buildPrWarnings(task: Task): string[] {
  const latestVerification = task.crmVerificationReports?.[0];
  const warnings: string[] = [];
  if (!latestVerification) {
    warnings.push('No Dataverse metadata verification report is saved for this task.');
  } else {
    const verdict = latestVerification.verdict;
    if (verdict === 'warnings') {
      warnings.push('Dataverse metadata verification completed with warnings.');
    } else if (verdict === 'fail') {
      warnings.push('Dataverse metadata verification found issues that should be explained in the PR.');
    } else if (verdict !== 'pass') {
      warnings.push(`Latest Dataverse metadata verification is ${verdict}; treat metadata as unverified.`);
    }
  }

  const externalExecution = getCrmExternalExecutionStatus(task);
  if (getCrmExternalActionApprovalStatus(task).approved && !externalExecution.completed) {
    warnings.push('External actions are approved locally but manual execution completion is not recorded yet.');
  }

  return uniqueStrings(warnings);
}

function changedArtifactHints(task: Task): string[] {
  return uniqueStrings([
    task.workflowSetup?.artifactPath,
    task.workflowSetup?.scriptPath,
    ...(task.aiFileReviews ?? []).map((review) => review.filePath),
  ]).slice(0, 8);
}

function formatPlanList(items: string[] | undefined, fallback: string): string {
  const values = items?.filter(Boolean) ?? [];
  if (values.length === 0) return `- ${fallback}`;
  return values.map((item) => `- ${item}`).join('\n');
}

export function detectCrmPullRequestProvider(prUrl: string | undefined): CrmPullRequestReviewIntake['provider'] {
  const lower = prUrl?.trim().toLowerCase() ?? '';
  if (!lower) return undefined;
  if (lower.includes('github.com') && (lower.includes('/pull/') || lower.includes('/pulls/'))) {
    return 'github';
  }
  if (
    lower.includes('dev.azure.com')
    || lower.includes('visualstudio.com')
    || lower.includes('_git/')
    || lower.includes('/_pullrequest/')
  ) {
    return 'azure-devops';
  }
  return 'unknown';
}

export function parseGitHubPullRequestUrl(prUrl: string | undefined): CrmGitHubPullRequestRef | undefined {
  const raw = prUrl?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== 'github.com') return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 4) return undefined;
    const [owner, repo, pullSegment, numberSegment] = parts;
    if (!owner || !repo || (pullSegment !== 'pull' && pullSegment !== 'pulls')) return undefined;
    const prNumber = Number.parseInt(numberSegment, 10);
    if (!Number.isInteger(prNumber) || prNumber <= 0) return undefined;
    return { owner, repo, prNumber };
  } catch {
    return undefined;
  }
}

export function getCrmPullRequestProposalStatus(task: Task): CrmPullRequestProposalStatus {
  const workflow = task.crmDeveloperWorkflow;
  const proposal = workflow?.pullRequestProposal;
  const diffStatus = getCrmDiffReviewStatus(task);
  const blockers: string[] = [];
  const warnings = buildPrWarnings(task);

  if (!diffStatus.approved) {
    blockers.push(diffStatus.blockers[0] ?? diffStatus.reason ?? 'Approve the reviewed diff/code changes first.');
  }

  const generated = !!proposal && !proposal.invalidatedAt && blockers.length === 0;
  const generatable = blockers.length === 0;
  const reason = generated
    ? 'Local PR proposal is generated.'
    : generatable
      ? 'Ready to generate a local PR proposal.'
      : blockers[0] ?? 'PR proposal is not ready.';

  return {
    generated,
    generatable,
    reason,
    blockers,
    warnings,
    invalidatedAt: proposal?.invalidatedAt,
    invalidationReason: proposal?.invalidationReason,
  };
}

export function getCrmPullRequestTrackingStatus(task: Task): CrmPullRequestTrackingStatus {
  const workflow = task.crmDeveloperWorkflow;
  const tracking = workflow?.pullRequestTracking;
  const proposalStatus = getCrmPullRequestProposalStatus(task);
  const externalExecution = getCrmExternalExecutionStatus(task);
  const externalProposals = buildCrmExternalActionProposals(task);
  const requiresExternalExecution = externalProposals.some((proposal) => (
    proposal.type !== 'pull-request' && proposal.type !== 'manual-check'
  ));
  const blockers: string[] = [];

  if (!proposalStatus.generated) {
    blockers.push(proposalStatus.blockers[0] ?? 'Generate a local PR proposal first.');
  }
  if (requiresExternalExecution && !externalExecution.completed) {
    blockers.push('Record manual external execution completion before tracking the PR.');
  }

  const trackable = blockers.length === 0;
  const tracked = !!tracking?.createdManually && !tracking.invalidatedAt && trackable;
  const reason = tracked
    ? 'Manual PR creation is recorded locally.'
    : trackable
      ? 'Ready to record a PR created manually outside the app.'
      : blockers[0] ?? 'Manual PR tracking is not ready.';

  return {
    tracked,
    trackable,
    requiresExternalExecution,
    reason,
    blockers,
    invalidatedAt: tracking?.invalidatedAt,
    invalidationReason: tracking?.invalidationReason,
  };
}

export function getCrmPullRequestReviewStatus(task: Task): CrmPullRequestReviewStatus {
  const workflow = task.crmDeveloperWorkflow;
  const tracking = workflow?.pullRequestTracking;
  const review = workflow?.pullRequestReview;
  const blockers: string[] = [];
  const provider = detectCrmPullRequestProvider(tracking?.prUrl);

  if (!tracking?.createdManually || tracking.invalidatedAt) {
    blockers.push('Record a manually created pull request before fetching review status.');
  }
  if (!tracking?.prUrl?.trim()) {
    blockers.push('Manual PR tracking needs a PR URL before review intake can run.');
  }

  const fetchable = blockers.length === 0;
  const available = !!review && !review.invalidatedAt && fetchable;
  const reason = available
    ? review.error
      ? 'PR review intake was attempted, but automatic fetch is unavailable.'
      : 'PR review intake snapshot is saved locally.'
    : fetchable
      ? 'Ready to run read-only PR review intake.'
      : blockers[0] ?? 'PR review intake is not ready.';

  return {
    available,
    fetchable,
    reason,
    blockers,
    provider,
    attentionRequired: review?.attentionRequired,
    unresolvedCount: review?.unresolvedCount,
    invalidatedAt: review?.invalidatedAt,
    invalidationReason: review?.invalidationReason,
  };
}

export function buildCrmPullRequestReviewIntake(
  task: Task,
  now: string = new Date().toISOString(),
): CrmPullRequestReviewIntake {
  const prUrl = task.crmDeveloperWorkflow?.pullRequestTracking?.prUrl?.trim() ?? '';
  const provider = detectCrmPullRequestProvider(prUrl) ?? 'unknown';
  const providerLabel = provider === 'azure-devops'
    ? 'Azure DevOps'
    : provider === 'github'
      ? 'GitHub'
      : 'unknown provider';

  const warnings = [
    provider === 'unknown'
      ? 'PR provider could not be detected from the URL.'
      : `${providerLabel} URL detected, but authenticated read-only comment fetching is not configured in this local workflow yet.`,
    'Use the PR URL to inspect reviewer comments manually. No remote PR state was read or changed.',
  ];

  return {
    fetchedAt: now,
    provider,
    prUrl,
    state: 'not_fetched',
    comments: [],
    unresolvedCount: undefined,
    attentionRequired: undefined,
    summary: provider === 'unknown'
      ? 'Manual PR review intake is available only as a local checklist because the provider is unknown.'
      : `Detected ${providerLabel} PR URL. Automatic read-only comment/status fetching is not configured yet, so no remote comments were fetched.`,
    warnings,
    error: 'Automatic read-only PR status/comment fetch is not configured yet.',
  };
}

async function fetchGitHubJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('GitHub PR was not found or requires authentication. Public unauthenticated read-only fetch cannot access it.');
    }
    if (response.status === 403) {
      throw new Error('GitHub read-only fetch was blocked by rate limits or authentication requirements.');
    }
    throw new Error(`GitHub read-only fetch failed with HTTP ${response.status}.`);
  }

  return response.json();
}

function githubCommentBody(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const body = (value as { body?: unknown }).body;
  return typeof body === 'string' && body.trim() ? body : undefined;
}

function mapGitHubIssueComment(value: unknown): CrmPullRequestReviewComment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as {
    id?: unknown;
    user?: { login?: unknown };
    body?: unknown;
    created_at?: unknown;
  };
  const body = githubCommentBody(item);
  if (!body) return undefined;
  return {
    id: typeof item.id === 'number' || typeof item.id === 'string' ? String(item.id) : undefined,
    author: typeof item.user?.login === 'string' ? item.user.login : undefined,
    body,
    createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
  };
}

function mapGitHubReviewComment(value: unknown): CrmPullRequestReviewComment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as {
    id?: unknown;
    user?: { login?: unknown };
    body?: unknown;
    path?: unknown;
    line?: unknown;
    original_line?: unknown;
    created_at?: unknown;
  };
  const body = githubCommentBody(item);
  if (!body) return undefined;
  const line = typeof item.line === 'number'
    ? item.line
    : typeof item.original_line === 'number'
      ? item.original_line
      : undefined;
  return {
    id: typeof item.id === 'number' || typeof item.id === 'string' ? String(item.id) : undefined,
    author: typeof item.user?.login === 'string' ? item.user.login : undefined,
    body,
    filePath: typeof item.path === 'string' ? item.path : undefined,
    line,
    createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
  };
}

function isCrmPullRequestReviewComment(
  comment: CrmPullRequestReviewComment | undefined,
): comment is CrmPullRequestReviewComment {
  return comment != null;
}

export async function fetchCrmGitHubPullRequestReviewIntake(
  prUrl: string,
  now: string = new Date().toISOString(),
): Promise<CrmPullRequestReviewIntake> {
  const parsed = parseGitHubPullRequestUrl(prUrl);
  if (!parsed) {
    return {
      fetchedAt: now,
      provider: 'github',
      prUrl,
      state: 'not_fetched',
      comments: [],
      unresolvedCount: undefined,
      attentionRequired: undefined,
      summary: 'GitHub PR URL could not be parsed.',
      warnings: ['Expected GitHub PR URL format: https://github.com/owner/repo/pull/123.'],
      error: 'Malformed GitHub PR URL. Expected https://github.com/owner/repo/pull/123.',
    };
  }

  const apiBase = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const warnings = [
    'GitHub data was fetched with read-only GET requests only. The app did not update the PR.',
    'GitHub REST comments do not reliably expose thread resolution state here; unresolved count is not inferred.',
  ];

  try {
    const [pullRaw, issueCommentsRaw, reviewCommentsRaw] = await Promise.all([
      fetchGitHubJson(`${apiBase}/pulls/${parsed.prNumber}`),
      fetchGitHubJson(`${apiBase}/issues/${parsed.prNumber}/comments?per_page=100`),
      fetchGitHubJson(`${apiBase}/pulls/${parsed.prNumber}/comments?per_page=100`),
    ]);

    const pull = pullRaw as {
      title?: unknown;
      state?: unknown;
      draft?: unknown;
      merged_at?: unknown;
      user?: { login?: unknown };
      base?: { ref?: unknown };
      head?: { ref?: unknown };
    };
    const issueComments = Array.isArray(issueCommentsRaw)
      ? issueCommentsRaw.map(mapGitHubIssueComment).filter(isCrmPullRequestReviewComment)
      : [];
    const reviewComments = Array.isArray(reviewCommentsRaw)
      ? reviewCommentsRaw.map(mapGitHubReviewComment).filter(isCrmPullRequestReviewComment)
      : [];
    const comments = [...issueComments, ...reviewComments];
    const stateParts = [
      typeof pull.state === 'string' ? pull.state : undefined,
      pull.draft === true ? 'draft' : undefined,
      typeof pull.merged_at === 'string' ? 'merged' : undefined,
    ].filter(Boolean);

    return {
      fetchedAt: now,
      provider: 'github',
      prUrl,
      title: typeof pull.title === 'string' ? pull.title : undefined,
      state: stateParts.join(' / ') || undefined,
      author: typeof pull.user?.login === 'string' ? pull.user.login : undefined,
      baseBranch: typeof pull.base?.ref === 'string' ? pull.base.ref : undefined,
      headBranch: typeof pull.head?.ref === 'string' ? pull.head.ref : undefined,
      comments,
      unresolvedCount: undefined,
      attentionRequired: comments.length > 0 ? undefined : false,
      summary: comments.length > 0
        ? `Fetched GitHub PR metadata and ${comments.length} comment(s). Review unresolved status manually in GitHub.`
        : 'Fetched GitHub PR metadata. No issue or review comments were returned by the read-only API calls.',
      warnings,
    };
  } catch (error) {
    return {
      fetchedAt: now,
      provider: 'github',
      prUrl,
      state: 'not_fetched',
      comments: [],
      unresolvedCount: undefined,
      attentionRequired: undefined,
      summary: 'GitHub read-only PR fetch could not complete.',
      warnings,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function riskLevelFromComments(comments: CrmPullRequestReviewComment[]): 'low' | 'medium' | 'high' {
  const text = comments.map((comment) => comment.body).join(' ').toLowerCase();
  if (/\b(security|secret|credential|token|crash|data loss|breaking|blocker|must fix|production)\b/.test(text)) {
    return 'high';
  }
  if (/\b(bug|incorrect|regression|fail|missing|null|exception|performance|required)\b/.test(text)) {
    return 'medium';
  }
  return 'low';
}

function suggestedActionForGroup(filePath: string | undefined, comments: CrmPullRequestReviewComment[]): string {
  const target = filePath ?? 'the reviewed change';
  const text = comments.map((comment) => comment.body).join(' ').toLowerCase();
  if (/\btest|coverage|spec\b/.test(text)) {
    return `Review the requested test coverage for ${target} and update the test plan before changing code.`;
  }
  if (/\bnaming|format|style|lint\b/.test(text)) {
    return `Review style/naming feedback for ${target} and prepare a minimal follow-up change if needed.`;
  }
  if (/\bnull|undefined|exception|crash\b/.test(text)) {
    return `Review runtime-safety feedback for ${target}, especially null/exception paths.`;
  }
  if (/\bsecurity|secret|credential|token\b/.test(text)) {
    return `Review security-sensitive feedback for ${target} before any further implementation.`;
  }
  return `Review the comments for ${target} and prepare a focused fix proposal before editing files.`;
}

export function getCrmPullRequestReviewAnalysisStatus(task: Task): CrmPullRequestReviewAnalysisStatus {
  const workflow = task.crmDeveloperWorkflow;
  const review = workflow?.pullRequestReview;
  const analysis = workflow?.pullRequestReviewAnalysis;
  const blockers: string[] = [];

  if (!review || review.invalidatedAt) {
    blockers.push('Fetch or save a PR review intake snapshot before generating analysis.');
  }

  const generatable = blockers.length === 0;
  const generated = !!analysis && !analysis.invalidatedAt && generatable;
  const reason = generated
    ? 'Local PR review fix plan is generated.'
    : generatable
      ? 'Ready to generate a local PR review fix plan.'
      : blockers[0] ?? 'PR review analysis is not ready.';

  return {
    generated,
    generatable,
    reason,
    blockers,
    attentionRequired: analysis?.attentionRequired,
    invalidatedAt: analysis?.invalidatedAt,
    invalidationReason: analysis?.invalidationReason,
  };
}

export function buildCrmPullRequestReviewAnalysis(
  task: Task,
  now: string = new Date().toISOString(),
): CrmPullRequestReviewAnalysis {
  const workflow = task.crmDeveloperWorkflow;
  const review = workflow?.pullRequestReview;
  const comments = (review?.comments ?? []).filter((comment) => comment.body.trim().length > 0);
  const commentsByPath = new Map<string, CrmPullRequestReviewComment[]>();

  for (const comment of comments) {
    const key = comment.filePath?.trim() || 'General PR comments';
    commentsByPath.set(key, [...(commentsByPath.get(key) ?? []), comment]);
  }

  const groupedFindings = [...commentsByPath.entries()].map(([key, group]) => {
    const filePath = key === 'General PR comments' ? undefined : key;
    return {
      filePath,
      title: filePath ? `Review comments for ${filePath}` : 'General PR review comments',
      comments: group.map((comment) => ({
        id: comment.id,
        author: comment.author,
        body: comment.body,
        line: comment.line,
        createdAt: comment.createdAt,
      })),
      suggestedAction: suggestedActionForGroup(filePath, group),
      riskLevel: riskLevelFromComments(group),
    };
  });

  const artifactHints = changedArtifactHints(task);
  const warnings = uniqueStrings([
    ...(review?.warnings ?? []),
    review?.error ? `Latest PR review intake has an error: ${review.error}` : undefined,
    review?.unresolvedCount == null ? 'Unresolved/resolved thread state is not known from the stored PR review intake.' : undefined,
  ]);
  const limitations = uniqueStrings([
    'This analysis is deterministic and local; it does not read repository files or call AI.',
    'It does not edit files, push commits, reply to comments, resolve threads, or update the pull request.',
    review?.provider === 'github'
      ? 'GitHub REST review comments may not include reliable thread resolution state.'
      : 'Provider-specific comment fetching is not available for this review snapshot.',
  ]);
  const actionItems = groupedFindings.length > 0
    ? groupedFindings.map((finding) => finding.suggestedAction)
    : review?.error
      ? ['Open the PR manually and inspect reviewer feedback because automatic intake did not fetch comments.']
      : ['No review comments were found in the stored snapshot. Verify manually in the PR before marking the review loop complete.'];
  const testChecklist = uniqueStrings([
    ...(workflow?.technicalPlan?.testChecklist ?? []),
    'Re-run focused checks for every file/comment group after preparing fixes.',
    artifactHints.length > 0 ? `Verify changed artifact(s): ${artifactHints.join(', ')}.` : undefined,
    'Do not reply to or resolve PR comments until fixes are reviewed and approved in a later step.',
  ]);
  const attentionRequired = comments.length > 0 || !!review?.error || review?.attentionRequired === true;
  const summary = comments.length > 0
    ? `Found ${comments.length} PR review comment(s) across ${groupedFindings.length} group(s). Prepare fixes locally before any PR interaction.`
    : review?.error
      ? 'PR review intake did not fetch comments. Manual PR review is required.'
      : 'No review comments found in the fetched snapshot.';

  return {
    generatedAt: now,
    sourceReviewFetchedAt: review?.fetchedAt,
    attentionRequired,
    summary,
    groupedFindings,
    actionItems,
    testChecklist,
    warnings,
    limitations,
  };
}

function proposalConfidence(filePath: string | undefined, commentIds: string[]): 'low' | 'medium' | 'high' {
  if (filePath && commentIds.length > 0) return 'high';
  if (filePath || commentIds.length > 0) return 'medium';
  return 'low';
}

export function getCrmPullRequestFixProposalStatus(task: Task): CrmPullRequestFixProposalStatus {
  const workflow = task.crmDeveloperWorkflow;
  const analysis = workflow?.pullRequestReviewAnalysis;
  const proposal = workflow?.pullRequestFixProposal;
  const blockers: string[] = [];

  if (!analysis || analysis.invalidatedAt) {
    blockers.push('Generate a non-invalidated PR review analysis before creating a fix proposal.');
  }

  const generatable = blockers.length === 0;
  const generated = !!proposal && !proposal.invalidatedAt && generatable;
  const reason = generated
    ? 'Local PR fix proposal is generated.'
    : generatable
      ? 'Ready to generate a local fix draft proposal.'
      : blockers[0] ?? 'PR fix proposal is not ready.';

  return {
    generated,
    generatable,
    reason,
    blockers,
    canGenerateCodeLater: proposal?.canGenerateCodeLater,
    invalidatedAt: proposal?.invalidatedAt,
    invalidationReason: proposal?.invalidationReason,
  };
}

export function buildCrmPullRequestFixProposal(
  task: Task,
  now: string = new Date().toISOString(),
): CrmPullRequestFixProposal {
  const workflow = task.crmDeveloperWorkflow;
  const analysis = workflow?.pullRequestReviewAnalysis;
  const review = workflow?.pullRequestReview;
  const artifactHints = changedArtifactHints(task);
  const findings = analysis?.groupedFindings ?? [];
  const proposedChanges = findings.map((finding) => {
    const commentIds = finding.comments
      .map((comment) => comment.id)
      .filter((id): id is string => !!id);
    const target = finding.filePath ?? 'manual review area';
    return {
      filePath: finding.filePath,
      title: finding.filePath ? `Prepare fix for ${finding.filePath}` : 'Prepare manual review fix',
      description: `${finding.suggestedAction} Do not claim exact edits until the target file content is inspected in a later step. Target: ${target}.`,
      addressesCommentIds: commentIds.length > 0 ? commentIds : undefined,
      confidence: proposalConfidence(finding.filePath, commentIds),
      riskLevel: finding.riskLevel,
    };
  });

  const noReviewComments = findings.length === 0 && !(review?.comments ?? []).some((comment) => comment.body.trim());
  const manualOnly = !!review?.error || !!analysis?.warnings.some((warning) => /not configured|did not fetch|manual/i.test(warning));
  const canGenerateCodeLater = proposedChanges.length > 0
    && proposedChanges.every((change) => !!change.filePath)
    && !proposedChanges.some((change) => change.riskLevel === 'high')
    && !manualOnly;
  const implementationOrder = proposedChanges.length > 0
    ? proposedChanges.map((change, index) => `${index + 1}. ${change.title}`)
    : noReviewComments
      ? ['No review-comment-driven code changes are proposed from the stored snapshot. Manually confirm the PR still has no actionable comments.']
      : (analysis?.actionItems ?? ['Review the PR manually before drafting any fix.']);
  const warnings = uniqueStrings([
    ...(analysis?.warnings ?? []),
    manualOnly ? 'Automatic intake was incomplete; this proposal should be treated as a manual checklist.' : undefined,
    noReviewComments ? 'No PR review comments were available in the stored snapshot.' : undefined,
    proposedChanges.some((change) => !change.filePath)
      ? 'Some proposed changes are not tied to a specific file path.'
      : undefined,
    artifactHints.length > 0 ? `Changed artifact hint(s): ${artifactHints.join(', ')}.` : undefined,
  ]);
  const limitations = uniqueStrings([
    ...(analysis?.limitations ?? []),
    'This proposal is local and deterministic; it does not read repository files or inspect current file content.',
    'It does not generate code, create a diff, apply patches, commit, push, reply to comments, resolve threads, or update the PR.',
    'Exact code edits must be reviewed in a later explicit step.',
  ]);
  const testChecklist = uniqueStrings([
    ...(analysis?.testChecklist ?? []),
    ...(workflow?.technicalPlan?.testChecklist ?? []),
    proposedChanges.length > 0
      ? 'After any future fix draft, verify each proposed change maps back to the referenced PR comment.'
      : undefined,
  ]);
  const summary = proposedChanges.length > 0
    ? `Prepared ${proposedChanges.length} local fix proposal item(s) from the PR review analysis.`
    : noReviewComments
      ? 'No code changes are proposed from review comments because the stored snapshot has no comments.'
      : 'Prepared a manual fix checklist because automatic review intake or analysis is incomplete.';

  return {
    generatedAt: now,
    sourceAnalysisGeneratedAt: analysis?.generatedAt,
    summary,
    proposedChanges,
    implementationOrder,
    testChecklist,
    warnings,
    limitations,
    canGenerateCodeLater,
  };
}

export function buildCrmDraftContextFromPullRequestFixProposal(
  task: Task,
): CrmDraftContextFromPullRequestFixProposal {
  const proposal = task.crmDeveloperWorkflow?.pullRequestFixProposal;
  const blockers: string[] = [];

  if (!proposal || proposal.invalidatedAt) {
    blockers.push('Generate a non-invalidated PR fix proposal before using it for draft generation.');
  }
  if (proposal && !proposal.invalidatedAt && !proposal.canGenerateCodeLater) {
    blockers.push('The current fix proposal is marked manual/conservative and is not ready for future code drafting.');
  }

  const targetFileHints = uniqueStrings([
    ...(proposal?.proposedChanges.map((change) => change.filePath).filter((path): path is string => !!path) ?? []),
    ...changedArtifactHints(task),
  ]);
  const proposedChanges = proposal?.proposedChanges.map((change) => ({
    filePath: change.filePath,
    title: change.title,
    description: change.description,
    addressesCommentIds: change.addressesCommentIds ?? [],
    confidence: change.confidence,
    riskLevel: change.riskLevel,
  })) ?? [];
  const risks = uniqueStrings(proposedChanges.map((change) => `${change.title}: ${change.riskLevel} risk, ${change.confidence} confidence.`));
  const warnings = uniqueStrings(proposal?.warnings ?? []);
  const limitations = uniqueStrings([
    ...(proposal?.limitations ?? []),
    'This context is passed into the existing draft flow only; it does not edit files by itself.',
    'Diff review and approval remain required after any generated draft preview.',
    'PR comments are not replied to or resolved by this context.',
  ]);
  const ready = blockers.length === 0;
  const promptContext = ready && proposal
    ? [
        'CRM PR FIX PROPOSAL CONTEXT',
        `Summary: ${proposal.summary}`,
        targetFileHints.length > 0 ? `Target file hints: ${targetFileHints.join(', ')}` : 'Target file hints: none',
        'Proposed changes:',
        ...proposedChanges.map((change, index) => [
          `${index + 1}. ${change.title}`,
          `   File: ${change.filePath ?? 'not identified'}`,
          `   Description: ${change.description}`,
          `   Comment IDs: ${change.addressesCommentIds.length > 0 ? change.addressesCommentIds.join(', ') : 'none'}`,
          `   Risk/confidence: ${change.riskLevel} risk, ${change.confidence} confidence`,
        ].join('\n')),
        proposal.implementationOrder.length > 0
          ? `Implementation order:\n${proposal.implementationOrder.map((item) => `- ${item}`).join('\n')}`
          : 'Implementation order: none',
        proposal.testChecklist.length > 0
          ? `Test checklist:\n${proposal.testChecklist.map((item) => `- ${item}`).join('\n')}`
          : 'Test checklist: none',
        warnings.length > 0 ? `Warnings:\n${warnings.map((item) => `- ${item}`).join('\n')}` : 'Warnings: none',
        limitations.length > 0 ? `Limitations:\n${limitations.map((item) => `- ${item}`).join('\n')}` : 'Limitations: none',
        'Do not claim comments are resolved. Do not update the PR. Generate only a draft/preview in the existing flow.',
      ].join('\n')
    : undefined;

  return {
    ready,
    reason: ready
      ? 'Valid PR fix proposal can be passed into the existing draft generation flow.'
      : blockers[0] ?? 'Fix proposal context is not ready.',
    blockers,
    warnings,
    summary: proposal && !proposal.invalidatedAt ? proposal.summary : undefined,
    targetFileHints,
    proposedChanges,
    implementationOrder: proposal?.implementationOrder ?? [],
    risks,
    testChecklist: proposal?.testChecklist ?? [],
    limitations,
    promptContext,
  };
}

export function getCrmPullRequestFixUpdateStatus(task: Task): CrmPullRequestFixUpdateStatus {
  const workflow = task.crmDeveloperWorkflow;
  const proposal = workflow?.pullRequestFixProposal;
  const tracking = workflow?.pullRequestFixUpdateTracking;
  const diffStatus = getCrmDiffReviewStatus(task);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!proposal || proposal.invalidatedAt) {
    blockers.push('Generate a non-invalidated PR fix proposal first.');
  } else if (!proposal.canGenerateCodeLater) {
    blockers.push('The current fix proposal is manual/conservative and is not ready for code drafting.');
  }

  if (!hasCrmReviewableGeneratedChanges(task)) {
    blockers.push('No reviewable generated artifact or saved file review is available yet.');
  }

  if (!diffStatus.approved) {
    blockers.push(diffStatus.reason || 'Approve the reviewed diff before recording a manual PR update.');
  }

  warnings.push(...diffStatus.warnings);
  if (tracking?.invalidatedAt && !tracking.updatedManually) {
    warnings.push(`Previous manual PR update tracking was invalidated: ${tracking.invalidationReason ?? 'upstream change'}.`);
  }

  const trackable = blockers.length === 0;
  const tracked = !!tracking?.updatedManually && !tracking.invalidatedAt;
  const reason = tracked
    ? 'Manual PR fix update is recorded locally.'
    : trackable
      ? 'Ready to record that the PR was manually updated outside the app.'
      : blockers[0] ?? 'Manual PR fix update tracking is not ready.';

  return {
    tracked,
    trackable,
    reason,
    blockers,
    warnings,
    updatedAt: tracking?.updatedAt,
    invalidatedAt: tracking?.invalidatedAt,
    invalidationReason: tracking?.invalidationReason,
  };
}

export function getCrmPostFixReviewRefreshStatus(task: Task): CrmPostFixReviewRefreshStatus {
  const workflow = task.crmDeveloperWorkflow;
  const fixUpdate = workflow?.pullRequestFixUpdateTracking;
  const latestReview = workflow?.pullRequestReview;
  const prTracking = workflow?.pullRequestTracking;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const visible = !!fixUpdate?.updatedManually && !fixUpdate.invalidatedAt;

  if (!visible) {
    blockers.push('Record a manual PR fix update before refreshing review status.');
  }
  if (!prTracking?.createdManually || prTracking.invalidatedAt) {
    blockers.push('Manual PR tracking with a PR URL is required before refreshing review status.');
  } else if (!prTracking.prUrl?.trim()) {
    blockers.push('Manual PR tracking has no PR URL.');
  }

  if (latestReview?.invalidatedAt) {
    warnings.push(`Previous PR review snapshot was invalidated: ${latestReview.invalidationReason ?? 'upstream change'}.`);
  }

  const refreshed = visible && isIsoAfter(latestReview?.fetchedAt, fixUpdate?.updatedAt) && !latestReview?.invalidatedAt;
  const commentCount = latestReview?.comments?.filter((comment) => comment.body.trim().length > 0).length;
  const needsAnalysis = refreshed && (commentCount ?? 0) > 0;
  const refreshable = blockers.length === 0;
  const reason = refreshed
    ? (needsAnalysis
        ? 'Review status was refreshed after the manual PR update. Analyze the latest review comments again.'
        : 'Review status was refreshed after the manual PR update. No comments were found in the latest snapshot.')
    : refreshable
      ? 'Manual PR update is recorded. Fetch PR review status again to check whether comments remain.'
      : blockers[0] ?? 'Post-fix review refresh is not ready.';

  return {
    visible,
    refreshed,
    refreshable,
    needsAnalysis,
    reason,
    blockers,
    warnings,
    updatedAt: fixUpdate?.updatedAt,
    refreshedAt: refreshed ? latestReview?.fetchedAt : undefined,
    latestCommentCount: refreshed ? commentCount : undefined,
  };
}

export function buildCrmPullRequestProposal(
  task: Task,
  now: string = new Date().toISOString(),
): CrmPullRequestProposal {
  const detection = detectCrmDeveloperWorkKind(task);
  const workflow = task.crmDeveloperWorkflow;
  const plan = workflow?.technicalPlan;
  const latestVerification = task.crmVerificationReports?.[0];
  const artifactHints = changedArtifactHints(task);
  const sourceSummary = plan?.summary
    ?? task.analysisResult?.summary
    ?? task.originalMessage.slice(0, 240);
  const warnings = buildPrWarnings(task);
  const titlePrefix = detection.kind === 'unknown' ? 'CRM' : `CRM ${detection.kind}`;
  const title = `${titlePrefix}: ${task.title}`.slice(0, 180);
  const implementationSummary = [
    sourceSummary,
    workflow?.diffApproval?.approvedAt ? `Diff approval recorded at ${workflow.diffApproval.approvedAt}.` : undefined,
    plan?.target?.entityLogicalName ? `Target table/entity: ${plan.target.entityLogicalName}.` : undefined,
    plan?.target?.scriptPath ? `Script/web resource path: ${plan.target.scriptPath}.` : undefined,
    plan?.target?.pluginProject ? `Plugin project: ${plan.target.pluginProject}.` : undefined,
  ].filter(Boolean).join('\n');
  const dataverseNotes = [
    latestVerification ? `Latest metadata verification verdict: ${latestVerification.verdict}.` : 'No metadata verification report is saved.',
    latestVerification?.summary,
    ...(plan?.dataverseFindings ?? []),
  ].filter(Boolean);
  const deploymentNotes = [
    ...(plan?.externalActionPreview ?? []),
    workflow?.externalExecution?.completed
      ? `Manual external execution recorded: ${workflow.externalExecution.notes ?? 'completed outside the app'}.`
      : 'External execution is not performed by this app.',
  ];
  const checklist = uniqueStrings([
    ...(plan?.testChecklist ?? []),
    'Review generated diff before merge.',
    'Confirm no secrets or environment-specific values are included.',
    'Confirm Dataverse deployment notes are understood before release.',
  ]);

  const body = [
    '## Summary',
    implementationSummary || `CRM developer task for ${task.title}.`,
    '',
    '## Implementation Plan',
    formatPlanList(plan?.implementationSteps, 'Review the saved CRM technical plan before merging.'),
    '',
    '## Changed Artifacts',
    formatPlanList(artifactHints, 'No changed artifact path is saved on the task.'),
    '',
    '## Testing Checklist',
    formatPlanList(checklist, 'Run focused manual testing for the affected CRM behavior.'),
    '',
    '## Dataverse / Deployment Notes',
    formatPlanList(uniqueStrings([...dataverseNotes, ...deploymentNotes]), 'No Dataverse deployment notes are available.'),
    '',
    '## Known Warnings',
    formatPlanList(warnings, 'No known warnings recorded by the local workflow.'),
    '',
    '_Generated locally by task-workbench. The app did not create a branch, commit, or pull request._',
  ].join('\n');

  return {
    generatedAt: now,
    title,
    body,
    checklist,
    warnings,
    relatedArtifactPath: artifactHints[0],
    sourceSummary,
  };
}

function invalidateExternalExecution(
  snapshot: CrmDeveloperWorkflowState,
  reason: string,
  now: string,
): CrmDeveloperWorkflowState['externalExecution'] {
  const existing = snapshot.externalExecution;
  if (!existing?.completed) return existing;
  return {
    ...existing,
    completed: false,
    invalidatedAt: now,
    invalidationReason: reason,
  };
}

function invalidatePullRequestProposal(
  snapshot: CrmDeveloperWorkflowState,
  reason: string,
  now: string,
): CrmDeveloperWorkflowState['pullRequestProposal'] {
  const existing = snapshot.pullRequestProposal;
  if (!existing || existing.invalidatedAt) return existing;
  return {
    ...existing,
    invalidatedAt: now,
    invalidationReason: reason,
  };
}

function invalidatePullRequestTracking(
  snapshot: CrmDeveloperWorkflowState,
  reason: string,
  now: string,
): CrmDeveloperWorkflowState['pullRequestTracking'] {
  const existing = snapshot.pullRequestTracking;
  if (!existing?.createdManually && !existing) return existing;
  return {
    ...existing,
    createdManually: false,
    invalidatedAt: now,
    invalidationReason: reason,
  };
}

function invalidatePullRequestReview(
  snapshot: CrmDeveloperWorkflowState,
  reason: string,
  now: string,
): CrmDeveloperWorkflowState['pullRequestReview'] {
  const existing = snapshot.pullRequestReview;
  if (!existing || existing.invalidatedAt) return existing;
  return {
    ...existing,
    invalidatedAt: now,
    invalidationReason: reason,
  };
}

function invalidatePullRequestReviewAnalysis(
  snapshot: CrmDeveloperWorkflowState,
  reason: string,
  now: string,
): CrmDeveloperWorkflowState['pullRequestReviewAnalysis'] {
  const existing = snapshot.pullRequestReviewAnalysis;
  if (!existing || existing.invalidatedAt) return existing;
  return {
    ...existing,
    invalidatedAt: now,
    invalidationReason: reason,
  };
}

function invalidatePullRequestFixProposal(
  snapshot: CrmDeveloperWorkflowState,
  reason: string,
  now: string,
): CrmDeveloperWorkflowState['pullRequestFixProposal'] {
  const existing = snapshot.pullRequestFixProposal;
  if (!existing || existing.invalidatedAt) return existing;
  return {
    ...existing,
    invalidatedAt: now,
    invalidationReason: reason,
  };
}

function invalidatePullRequestFixUpdateTracking(
  snapshot: CrmDeveloperWorkflowState,
  reason: string,
  now: string,
): CrmDeveloperWorkflowState['pullRequestFixUpdateTracking'] {
  const existing = snapshot.pullRequestFixUpdateTracking;
  if (!existing || existing.invalidatedAt) return existing;
  return {
    ...existing,
    updatedManually: false,
    invalidatedAt: now,
    invalidationReason: reason,
  };
}

function invalidateDiffApproval(
  snapshot: CrmDeveloperWorkflowState,
  reason: string,
  now: string,
): CrmDeveloperWorkflowState['diffApproval'] {
  const existing = snapshot.diffApproval;
  if (!existing?.approved) return existing;
  return {
    approved: false,
    approvedAt: existing.approvedAt,
    approvedBy: existing.approvedBy,
    invalidatedAt: now,
    invalidationReason: reason,
  };
}

function invalidateExternalActionApproval(
  snapshot: CrmDeveloperWorkflowState,
  reason: string,
  now: string,
): CrmDeveloperWorkflowState['externalActionApproval'] {
  const existing = snapshot.externalActionApproval;
  if (!existing?.approved) return existing;
  return {
    approved: false,
    approvedAt: existing.approvedAt,
    approvedBy: existing.approvedBy,
    invalidatedAt: now,
    invalidationReason: reason,
  };
}

export function buildCrmDeveloperWorkflowStateSnapshot(
  task: Task,
  now: string = new Date().toISOString(),
): CrmDeveloperWorkflowState {
  const existing = task.crmDeveloperWorkflow;
  const detection = detectCrmDeveloperWorkKind(task);

  return {
    ...existing,
    detectedWorkKind: detection.kind,
    currentStep: existing?.currentStep ?? 'diagnosis',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterMetadataVerification(
  task: Task,
  report: CrmVerificationReport,
  now: string = new Date().toISOString(),
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: isMeaningfulCrmVerificationReport(report)
      ? 'technical-plan'
      : snapshot.currentStep ?? 'metadata-verification',
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterTechnicalPlan(
  task: Task,
  plan: CrmTechnicalImplementationPlan,
  now: string = new Date().toISOString(),
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  const existingApproval = snapshot.planApproval;
  return {
    ...snapshot,
    detectedWorkKind: plan.workKind,
    currentStep: 'technical-plan',
    technicalPlan: plan,
    planApproval: existingApproval?.approved
      ? {
          approved: false,
          approvedAt: existingApproval.approvedAt,
          approvedBy: existingApproval.approvedBy,
          invalidatedAt: now,
          invalidationReason: 'technical plan regenerated',
        }
      : existingApproval,
    diffApproval: invalidateDiffApproval(snapshot, 'technical plan regenerated', now),
    externalActionApproval: invalidateExternalActionApproval(snapshot, 'technical plan regenerated', now),
    externalExecution: invalidateExternalExecution(snapshot, 'technical plan regenerated', now),
    pullRequestProposal: invalidatePullRequestProposal(snapshot, 'technical plan regenerated', now),
    pullRequestTracking: invalidatePullRequestTracking(snapshot, 'technical plan regenerated', now),
    pullRequestReview: invalidatePullRequestReview(snapshot, 'technical plan regenerated', now),
    pullRequestReviewAnalysis: invalidatePullRequestReviewAnalysis(snapshot, 'technical plan regenerated', now),
    pullRequestFixProposal: invalidatePullRequestFixProposal(snapshot, 'technical plan regenerated', now),
    pullRequestFixUpdateTracking: invalidatePullRequestFixUpdateTracking(snapshot, 'technical plan regenerated', now),
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterPlanApproval(
  task: Task,
  now: string = new Date().toISOString(),
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'technical-plan',
    planApproval: {
      approved: true,
      approvedAt: now,
    },
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterPlanApprovalRevoked(
  task: Task,
  now: string = new Date().toISOString(),
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'technical-plan',
    planApproval: {
      ...snapshot.planApproval,
      approved: false,
      invalidatedAt: now,
      invalidationReason: 'user revoked approval',
    },
    diffApproval: invalidateDiffApproval(snapshot, 'technical plan approval revoked', now),
    externalActionApproval: invalidateExternalActionApproval(snapshot, 'technical plan approval revoked', now),
    externalExecution: invalidateExternalExecution(snapshot, 'technical plan approval revoked', now),
    pullRequestProposal: invalidatePullRequestProposal(snapshot, 'technical plan approval revoked', now),
    pullRequestTracking: invalidatePullRequestTracking(snapshot, 'technical plan approval revoked', now),
    pullRequestReview: invalidatePullRequestReview(snapshot, 'technical plan approval revoked', now),
    pullRequestReviewAnalysis: invalidatePullRequestReviewAnalysis(snapshot, 'technical plan approval revoked', now),
    pullRequestFixProposal: invalidatePullRequestFixProposal(snapshot, 'technical plan approval revoked', now),
    pullRequestFixUpdateTracking: invalidatePullRequestFixUpdateTracking(snapshot, 'technical plan approval revoked', now),
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterDraftRegenerated(
  task: Task,
  now: string = new Date().toISOString(),
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'diff-review',
    diffApproval: invalidateDiffApproval(snapshot, 'draft regenerated', now),
    externalActionApproval: invalidateExternalActionApproval(snapshot, 'draft regenerated', now),
    externalExecution: invalidateExternalExecution(snapshot, 'draft regenerated', now),
    pullRequestProposal: invalidatePullRequestProposal(snapshot, 'draft regenerated', now),
    pullRequestTracking: invalidatePullRequestTracking(snapshot, 'draft regenerated', now),
    pullRequestReview: invalidatePullRequestReview(snapshot, 'draft regenerated', now),
    pullRequestReviewAnalysis: invalidatePullRequestReviewAnalysis(snapshot, 'draft regenerated', now),
    pullRequestFixProposal: invalidatePullRequestFixProposal(snapshot, 'draft regenerated', now),
    pullRequestFixUpdateTracking: invalidatePullRequestFixUpdateTracking(snapshot, 'draft regenerated', now),
    updatedAt: now,
  };
}

/**
 * Combined state builder used by the Start Development guided flow.
 * Generates a new technical plan and immediately marks the draft as regenerated
 * in a single atomic state, avoiding stale-closure problems from two separate updateTask calls.
 */
export function buildCrmDeveloperWorkflowStateAfterPlanAndDraft(
  task: Task,
  plan: CrmTechnicalImplementationPlan,
  now: string = new Date().toISOString(),
): CrmDeveloperWorkflowState {
  const withPlan = buildCrmDeveloperWorkflowStateAfterTechnicalPlan(task, plan, now);
  return {
    ...withPlan,
    currentStep: 'diff-review',
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterDiffApproval(
  task: Task,
  now: string = new Date().toISOString(),
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'diff-review',
    diffApproval: {
      approved: true,
      approvedAt: now,
    },
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterDiffApprovalRevoked(
  task: Task,
  now: string = new Date().toISOString(),
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'diff-review',
    diffApproval: {
      ...snapshot.diffApproval,
      approved: false,
      invalidatedAt: now,
      invalidationReason: 'user revoked diff approval',
    },
    externalActionApproval: invalidateExternalActionApproval(snapshot, 'diff approval revoked', now),
    externalExecution: invalidateExternalExecution(snapshot, 'diff approval revoked', now),
    pullRequestProposal: invalidatePullRequestProposal(snapshot, 'diff approval revoked', now),
    pullRequestTracking: invalidatePullRequestTracking(snapshot, 'diff approval revoked', now),
    pullRequestReview: invalidatePullRequestReview(snapshot, 'diff approval revoked', now),
    pullRequestReviewAnalysis: invalidatePullRequestReviewAnalysis(snapshot, 'diff approval revoked', now),
    pullRequestFixProposal: invalidatePullRequestFixProposal(snapshot, 'diff approval revoked', now),
    pullRequestFixUpdateTracking: invalidatePullRequestFixUpdateTracking(snapshot, 'diff approval revoked', now),
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterExternalActionApproval(
  task: Task,
  now: string = new Date().toISOString(),
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'external-action',
    externalActionApproval: {
      approved: true,
      approvedAt: now,
    },
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterExternalActionApprovalRevoked(
  task: Task,
  now: string = new Date().toISOString(),
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'external-action',
    externalActionApproval: {
      ...snapshot.externalActionApproval,
      approved: false,
      invalidatedAt: now,
      invalidationReason: 'user revoked external action approval',
    },
    externalExecution: invalidateExternalExecution(snapshot, 'external action approval revoked', now),
    pullRequestProposal: invalidatePullRequestProposal(snapshot, 'external action approval revoked', now),
    pullRequestTracking: invalidatePullRequestTracking(snapshot, 'external action approval revoked', now),
    pullRequestReview: invalidatePullRequestReview(snapshot, 'external action approval revoked', now),
    pullRequestReviewAnalysis: invalidatePullRequestReviewAnalysis(snapshot, 'external action approval revoked', now),
    pullRequestFixProposal: invalidatePullRequestFixProposal(snapshot, 'external action approval revoked', now),
    pullRequestFixUpdateTracking: invalidatePullRequestFixUpdateTracking(snapshot, 'external action approval revoked', now),
    updatedAt: now,
  };
}

export interface CrmExternalExecutionPreviewEntry {
  proposalId: string;
  proposalType: CrmExternalActionProposalType;
  title: string;
  description: string;
  riskLevel: CrmExternalActionRiskLevel;
  readyForFutureExecution: boolean;
  blockedReason?: string;
  warnings: string[];
  previewPayload?: Record<string, string | string[] | undefined>;
  requiredBeforeExecution: string[];
}

export interface CrmExternalExecutionPreview {
  generatedAt: string;
  taskId: string;
  taskTitle: string;
  workKind: CrmDeveloperWorkKind;
  entries: CrmExternalExecutionPreviewEntry[];
  planApprovedAt?: string;
  diffApprovedAt?: string;
  externalActionApprovedAt?: string;
  verificationVerdict?: string;
  verificationWarnings: string[];
  globalBlockers: string[];
  globalWarnings: string[];
  isFullyApprovable: boolean;
}

// Read-only preview builder. Derives execution preview from local task state only.
// Does not execute anything. No external calls, no Dataverse writes, no commits.
export function buildCrmExternalExecutionPreview(
  task: Task,
  now: string,
): CrmExternalExecutionPreview {
  const detection = detectCrmDeveloperWorkKind(task);
  const workflow = task.crmDeveloperWorkflow;
  const proposals = buildCrmExternalActionProposals(task);
  const externalApproval = getCrmExternalActionApprovalStatus(task);
  const latestVerification = task.crmVerificationReports?.[0];

  const verificationWarnings: string[] = [];
  if (latestVerification?.verdict === 'warnings') {
    verificationWarnings.push('Metadata verification completed with warnings. Review before any future execution.');
  } else if (latestVerification?.verdict === 'fail') {
    verificationWarnings.push('Metadata verification found issues. Resolve or accept them before any future execution.');
  } else if (!latestVerification) {
    verificationWarnings.push('No metadata verification report is saved for this task.');
  }

  const entries: CrmExternalExecutionPreviewEntry[] = proposals.map((p) => ({
    proposalId: p.id,
    proposalType: p.type,
    title: p.title,
    description: p.description,
    riskLevel: p.riskLevel,
    readyForFutureExecution: p.readyForFutureExecution,
    blockedReason: p.blockedReason,
    warnings: p.warnings,
    previewPayload: p.previewPayload,
    requiredBeforeExecution: p.requiredBeforeExecution,
  }));

  return {
    generatedAt: now,
    taskId: task.id,
    taskTitle: task.title,
    workKind: detection.kind,
    entries,
    planApprovedAt: workflow?.planApproval?.approved ? workflow.planApproval.approvedAt : undefined,
    diffApprovedAt: workflow?.diffApproval?.approved ? workflow.diffApproval.approvedAt : undefined,
    externalActionApprovedAt: workflow?.externalActionApproval?.approved
      ? workflow.externalActionApproval.approvedAt
      : undefined,
    verificationVerdict: latestVerification?.verdict,
    verificationWarnings,
    globalBlockers: externalApproval.blockers,
    globalWarnings: uniqueStrings([...externalApproval.warnings, ...verificationWarnings]),
    isFullyApprovable: externalApproval.approvable,
  };
}

// ── Manual external execution tracking ───────────────────────────────────────

export interface CrmExternalExecutionStatus {
  completed: boolean;
  completable: boolean;
  reason: string;
  blockers: string[];
  completedAt?: string;
  notes?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export function getCrmExternalExecutionStatus(task: Task): CrmExternalExecutionStatus {
  const workflow = task.crmDeveloperWorkflow;
  const tracking = workflow?.externalExecution;
  const externalApproval = getCrmExternalActionApprovalStatus(task);
  const blockers: string[] = [];

  if (!externalApproval.approved) {
    blockers.push(externalApproval.blockers.length > 0
      ? externalApproval.blockers[0]
      : 'External action approval is required before marking manual completion.');
  }

  const completable = blockers.length === 0;
  const completed = !!tracking?.completed && completable;

  const reason = completed
    ? `Manually marked as completed${tracking?.completedAt ? ` at ${tracking.completedAt}` : ''}.`
    : completable
      ? 'Ready to record manual external action completion.'
      : blockers[0] ?? 'Not ready for manual completion tracking.';

  return {
    completed,
    completable,
    reason,
    blockers,
    completedAt: tracking?.completedAt,
    notes: tracking?.notes,
    invalidatedAt: tracking?.invalidatedAt,
    invalidationReason: tracking?.invalidationReason,
  };
}

export function buildCrmDeveloperWorkflowStateAfterExternalExecutionCompleted(
  task: Task,
  notes: string,
  now: string,
  completedActionIds?: string[],
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'done',
    externalExecution: {
      completed: true,
      completedAt: now,
      notes: notes.trim(),
      completedActionIds,
    },
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterExternalExecutionRevoked(
  task: Task,
  now: string,
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'external-action',
    externalExecution: {
      ...snapshot.externalExecution,
      completed: false,
      invalidatedAt: now,
      invalidationReason: 'user revoked manual completion',
    },
    pullRequestProposal: invalidatePullRequestProposal(snapshot, 'external execution tracking revoked', now),
    pullRequestTracking: invalidatePullRequestTracking(snapshot, 'external execution tracking revoked', now),
    pullRequestReview: invalidatePullRequestReview(snapshot, 'external execution tracking revoked', now),
    pullRequestReviewAnalysis: invalidatePullRequestReviewAnalysis(snapshot, 'external execution tracking revoked', now),
    pullRequestFixProposal: invalidatePullRequestFixProposal(snapshot, 'external execution tracking revoked', now),
    pullRequestFixUpdateTracking: invalidatePullRequestFixUpdateTracking(snapshot, 'external execution tracking revoked', now),
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterPullRequestProposal(
  task: Task,
  proposal: CrmPullRequestProposal,
  now: string,
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'pull-request',
    pullRequestProposal: proposal,
    pullRequestTracking: invalidatePullRequestTracking(snapshot, 'pull request proposal regenerated', now),
    pullRequestReview: invalidatePullRequestReview(snapshot, 'pull request proposal regenerated', now),
    pullRequestReviewAnalysis: invalidatePullRequestReviewAnalysis(snapshot, 'pull request proposal regenerated', now),
    pullRequestFixProposal: invalidatePullRequestFixProposal(snapshot, 'pull request proposal regenerated', now),
    pullRequestFixUpdateTracking: invalidatePullRequestFixUpdateTracking(snapshot, 'pull request proposal regenerated', now),
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterManualPullRequestTracked(
  task: Task,
  prUrl: string | undefined,
  notes: string | undefined,
  now: string,
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'pull-request',
    pullRequestTracking: {
      createdManually: true,
      createdAt: now,
      prUrl: prUrl?.trim() || undefined,
      notes: notes?.trim() || undefined,
    },
    pullRequestReview: invalidatePullRequestReview(snapshot, 'manual PR tracking updated', now),
    pullRequestReviewAnalysis: invalidatePullRequestReviewAnalysis(snapshot, 'manual PR tracking updated', now),
    pullRequestFixProposal: invalidatePullRequestFixProposal(snapshot, 'manual PR tracking updated', now),
    pullRequestFixUpdateTracking: invalidatePullRequestFixUpdateTracking(snapshot, 'manual PR tracking updated', now),
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterManualPullRequestTrackingRevoked(
  task: Task,
  now: string,
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'pull-request',
    pullRequestTracking: {
      ...snapshot.pullRequestTracking,
      createdManually: false,
      invalidatedAt: now,
      invalidationReason: 'user revoked manual PR tracking',
    },
    pullRequestReview: invalidatePullRequestReview(snapshot, 'manual PR tracking revoked', now),
    pullRequestReviewAnalysis: invalidatePullRequestReviewAnalysis(snapshot, 'manual PR tracking revoked', now),
    pullRequestFixProposal: invalidatePullRequestFixProposal(snapshot, 'manual PR tracking revoked', now),
    pullRequestFixUpdateTracking: invalidatePullRequestFixUpdateTracking(snapshot, 'manual PR tracking revoked', now),
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterPullRequestReviewIntake(
  task: Task,
  review: CrmPullRequestReviewIntake,
  now: string,
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'pull-request',
    pullRequestReview: review,
    pullRequestReviewAnalysis: invalidatePullRequestReviewAnalysis(snapshot, 'pull request review intake refreshed', now),
    pullRequestFixProposal: invalidatePullRequestFixProposal(snapshot, 'pull request review intake refreshed', now),
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterPullRequestReviewAnalysis(
  task: Task,
  analysis: CrmPullRequestReviewAnalysis,
  now: string,
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'pull-request',
    pullRequestReviewAnalysis: analysis,
    pullRequestFixProposal: invalidatePullRequestFixProposal(snapshot, 'pull request review analysis regenerated', now),
    pullRequestFixUpdateTracking: invalidatePullRequestFixUpdateTracking(snapshot, 'pull request review analysis regenerated', now),
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterPullRequestFixProposal(
  task: Task,
  proposal: CrmPullRequestFixProposal,
  now: string,
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'pull-request',
    pullRequestFixProposal: proposal,
    pullRequestFixUpdateTracking: invalidatePullRequestFixUpdateTracking(snapshot, 'pull request fix proposal regenerated', now),
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterManualPullRequestFixUpdated(
  task: Task,
  tracking: CrmPullRequestFixUpdateTracking,
  now: string,
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'pull-request',
    pullRequestFixUpdateTracking: tracking,
    updatedAt: now,
  };
}

export function buildCrmDeveloperWorkflowStateAfterManualPullRequestFixUpdateRevoked(
  task: Task,
  now: string,
): CrmDeveloperWorkflowState {
  const snapshot = buildCrmDeveloperWorkflowStateSnapshot(task, now);
  return {
    ...snapshot,
    currentStep: 'pull-request',
    pullRequestFixUpdateTracking: {
      ...snapshot.pullRequestFixUpdateTracking,
      updatedManually: false,
      invalidatedAt: now,
      invalidationReason: 'user revoked manual PR fix update tracking',
    },
    updatedAt: now,
  };
}
