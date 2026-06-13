import { useState, useEffect, useRef, useMemo } from 'react';
import type {
  Task,
  TaskStatus,
  SkeletonPreview,
  WorkflowSetup,
  AiFileReviewResult,
  CrmSkeletonResult,
  CrmVerificationReport,
  CrmPullRequestFixUpdateTracking,
  ImplementationVerification,
} from '../types';
import TaskEmailContent from './TaskEmailContent';
import TaskDevModePanel, { type TaskDevModePanelHandle } from './TaskDevModePanel';
import { useApp } from '../context/AppContext';
import { TypeBadge, SourceBadge, TaskStateBadges } from './StatusBadge';
import SkeletonPreviewModal from './SkeletonPreviewModal';
import {
  analyzeScriptTask,
  buildScriptPlan,
  generateSkeleton,
  buildScriptPreview,
} from '../lib/scriptAssistant';
import TaskForm from './TaskForm';
import CreatePluginProjectModal from './CreatePluginProjectModal';
import ConfirmSetupModal from './ConfirmSetupModal';
import StartDevelopmentModal from './StartDevelopmentModal';
import Icon from './Icon';
import Modal from './Modal';
import AiReviewResultView from './AiReviewResultView';
import CrmSkeletonResultView from './CrmSkeletonResultView';
import CrmVerificationReportView from './CrmVerificationReportView';
import CrmDeveloperWorkflowPanel from './CrmDeveloperWorkflowPanel';
import PrimarchVerificationModal, { type PrimarchVerifyStep } from './PrimarchVerificationModal';
import ImplementationVerificationModal from './ImplementationVerificationModal';
import * as tauriApi from '../lib/tauriCommands';
import { openReviewTarget } from '../lib/openReviewTarget';
import { formatTaskActivityNotes, splitTaskNotes } from '../lib/taskActivityFormatter';
import { WorkflowStepper } from './WorkflowStepper';
import CopyAiWorkflowPromptButton from './CopyAiWorkflowPromptButton';
import { getDeveloperReadiness } from '../lib/developerReadiness';
import GitCommitModal from './GitCommitModal';
import { buildTaskWorkflowPlan } from '../lib/workflowPlan';
import type { TaskWorkflowPlan } from '../lib/workflowPlan';
import {
  buildCrmDeveloperWorkflowStateAfterMetadataVerification,
  buildCrmDeveloperWorkflowStateAfterDiffApproval,
  buildCrmDeveloperWorkflowStateAfterDiffApprovalRevoked,
  buildCrmDeveloperWorkflowStateAfterDraftRegenerated,
  buildCrmDeveloperWorkflowStateAfterExternalActionApproval,
  buildCrmDeveloperWorkflowStateAfterExternalActionApprovalRevoked,
  buildCrmDeveloperWorkflowStateAfterPlanApproval,
  buildCrmDeveloperWorkflowStateAfterPlanApprovalRevoked,
  buildCrmDeveloperWorkflowStateAfterTechnicalPlan,
  buildCrmDeveloperWorkflowStateAfterPlanAndDraft,
  buildCrmDeveloperWorkflowStateSnapshot,
  buildCrmTechnicalImplementationPlan,
  getCrmCodeGenerationReadiness,
  getCrmDiffReviewStatus,
  getCrmExternalActionApprovalStatus,
  getCrmExternalExecutionStatus,
  isMeaningfulCrmVerificationReport,
  isDeveloperWorkflowTask,
  buildCrmExternalExecutionPreview,
  buildCrmDeveloperWorkflowStateAfterExternalExecutionCompleted,
  buildCrmDeveloperWorkflowStateAfterExternalExecutionRevoked,
  buildCrmDeveloperWorkflowStateAfterManualPullRequestTracked,
  buildCrmDeveloperWorkflowStateAfterManualPullRequestTrackingRevoked,
  buildCrmDeveloperWorkflowStateAfterPullRequestProposal,
  buildCrmDeveloperWorkflowStateAfterPullRequestReviewIntake,
  buildCrmDeveloperWorkflowStateAfterPullRequestReviewAnalysis,
  buildCrmDeveloperWorkflowStateAfterPullRequestFixProposal,
  buildCrmDeveloperWorkflowStateAfterManualPullRequestFixUpdated,
  buildCrmDeveloperWorkflowStateAfterManualPullRequestFixUpdateRevoked,
  buildCrmPullRequestProposal,
  buildCrmPullRequestReviewIntake,
  buildCrmPullRequestReviewAnalysis,
  buildCrmPullRequestFixProposal,
  buildCrmDraftContextFromPullRequestFixProposal,
  fetchCrmGitHubPullRequestReviewIntake,
  getCrmPullRequestProposalStatus,
  getCrmPullRequestReviewStatus,
  getCrmPullRequestReviewAnalysisStatus,
  getCrmPullRequestFixProposalStatus,
  getCrmPullRequestFixUpdateStatus,
  getCrmPullRequestTrackingStatus,
  type CrmExternalExecutionPreview,
} from '../lib/crmDeveloperWorkflow';
import CrmExecutionPreviewModal from './CrmExecutionPreviewModal';
import AiKitActionsPanel, { type AiKitActionsPanelHandle } from './AiKitActionsPanel';
import { resolveTaskDevTarget, getPluginsDir } from '../lib/resolveTaskDevTarget';
import {
  detectTaskKindFromTask as detectAiKitTaskKind,
  loadAiKitContext,
  buildDiffReviewInstructions as buildAiKitDiffReviewInstructions,
  type PowerPlatformAiKitContext,
} from '../lib/powerPlatformAiKit';
import TaskModeSwitch from './TaskModeSwitch';
import { getAiKitWorkflowState } from '../lib/aiKitWorkflow';
import { selectImplReviewSource } from '../lib/implReviewSource';
import { mergeWithDefaults, selectReviewer, inferReviewSource } from '../lib/aiReviewers';
import { inferTaskMode } from '../lib/taskMode';
import { BUCKET_META, computePlanning, effectiveBucket } from '../lib/planning';
import { isOverdue, formatRelativeDate } from '../lib/dates';
import { buildScriptScaffold } from '../lib/scriptScaffold';
import { isPathInsideDir } from '../lib/pathUtils';
import {
  scanJavaScriptCrmReferences,
  scanCSharpCrmReferences,
  type CrmReferenceScanResult,
} from '../lib/crmReferenceScanner';

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
}

type AiAction = 'analyze' | 'draft';

type PrimarchAction = 'skeleton' | 'verify';

function withCrmDraftContext(task: Task, context: string | undefined): Task {
  if (!context) return task;
  return {
    ...task,
    originalMessage: `${task.originalMessage}\n\n${context}`,
  };
}

function formatEffort(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours === 1) return '1h';
  return `${hours}h`;
}

function formatCrmVerdict(verdict: string): string {
  return verdict.replace(/_/g, ' ').toUpperCase();
}

function createPrimarchVerifySteps(): PrimarchVerifyStep[] {
  return [
    { id: 'resolve-target-file', label: 'Resolve target file', status: 'pending' },
    { id: 'read-local-code', label: 'Read local code', status: 'pending' },
    { id: 'scan-crm-references', label: 'Scan CRM references', status: 'pending' },
    { id: 'connect-primarch-mcp', label: 'Connect to Primarch MCP', status: 'pending' },
    { id: 'inspect-dataverse', label: 'Inspect targeted Dataverse metadata', status: 'pending' },
    { id: 'build-report', label: 'Build verification report', status: 'pending' },
    { id: 'done', label: 'Done', status: 'pending' },
  ];
}

function setStepStatus(
  steps: PrimarchVerifyStep[],
  stepId: string,
  status: PrimarchVerifyStep['status'],
  detail?: string,
): PrimarchVerifyStep[] {
  return steps.map((step) => (
    step.id === stepId ? { ...step, status, detail } : step
  ));
}

function summarizeVerifications(issues: CrmVerificationReport['issues'], verdict: CrmVerificationReport['verdict']): string {
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const suggestionCount = issues.filter((i) => i.severity === 'suggestion').length;
  switch (verdict) {
    case 'pass':
      return 'This code is consistent with the inspected Dataverse metadata. No missing logical names were found.';
    case 'warnings':
      return 'This code is mostly consistent with Dataverse metadata, but some references could not be fully verified.';
    case 'fail':
      return `This code has Dataverse metadata issues and may not match this environment. ${errorCount} errors and ${warningCount} warnings were found.`;
    case 'not_configured':
      return 'CRM metadata verification is not configured. Enable Primarch MCP in Settings.';
    case 'error':
    default:
      return `Verification could not be completed. ${errorCount} errors, ${warningCount} warnings, ${suggestionCount} suggestions.`;
  }
}

// Bilingual analysis block
// ---------------------------------------------------------------------------

interface AnalysisLangBlockProps {
  lang: 'CZ' | 'EN';
  summary?: string;
  problems?: string[];
  actions?: string[];
  nextStep?: string;
  labelProblem: string;
  labelAction: string;
  labelNext: string;
}

function AnalysisLangBlock({
  lang, summary, problems, actions, nextStep,
  labelProblem, labelAction, labelNext,
}: AnalysisLangBlockProps) {
  const isCz       = lang === 'CZ';
  const hasProblems = problems && problems.length > 0;
  const hasActions  = actions  && actions.length  > 0;
  if (!summary && !hasProblems && !hasActions && !nextStep) return null;

  return (
    <div className="analysis-lang-block">
      <div className="analysis-lang-header">
        <span className={`detail-analysis-lang-badge${isCz ? ' detail-analysis-lang-badge--cz' : ''}`}>
          {lang}
        </span>
        {summary && <p className="detail-analysis-summary">{summary}</p>}
      </div>

      {hasProblems && (
        <div className="analysis-subsection">
          <span className="analysis-subsection-label">{labelProblem}</span>
          <ul className="detail-analysis-points">
            {problems!.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      {hasActions && (
        <div className="analysis-subsection">
          <span className="analysis-subsection-label">{labelAction}</span>
          <ul className="detail-analysis-points">
            {actions!.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </div>
      )}

      {nextStep && (
        <div className="detail-analysis-next">
          <span className="detail-analysis-next-label">{labelNext}:</span>
          {nextStep}
        </div>
      )}
    </div>
  );
}

/** Detects whether a TaskAnalysis has real Czech bilingual data (not just legacy English). */
function hasCzBilingualData(ar: NonNullable<Task['analysisResult']>): boolean {
  return !!(
    ar.summaryCz ||
    (ar.problemPointsCz && ar.problemPointsCz.length > 0) ||
    (ar.actionPointsCz  && ar.actionPointsCz.length  > 0) ||
    ar.nextStepCz
  );
}

/** Detects whether a TaskAnalysis has real English bilingual data. */
function hasEnBilingualData(ar: NonNullable<Task['analysisResult']>): boolean {
  return !!(
    ar.summaryEn ||
    (ar.problemPointsEn && ar.problemPointsEn.length > 0) ||
    (ar.actionPointsEn  && ar.actionPointsEn.length  > 0) ||
    ar.nextStepEn
  );
}

/**
 * Renders the AI analysis block in one of three modes:
 *   - Bilingual: CZ block + EN block (when fresh analysis is present)
 *   - Partial:   only the language block that has data
 *   - Legacy:    one English-only block + re-run hint (old stored tasks)
 */
function AnalysisBlock({ result }: { result: NonNullable<Task['analysisResult']> }) {
  const hasCz = hasCzBilingualData(result);
  const hasEn = hasEnBilingualData(result);
  const hasBilingual = hasCz || hasEn;

  if (hasBilingual) {
    return (
      <div className="detail-analysis-block">
        {hasCz && (
          <AnalysisLangBlock
            lang="CZ"
            summary={result.summaryCz}
            problems={result.problemPointsCz}
            actions={result.actionPointsCz}
            nextStep={result.nextStepCz}
            labelProblem="Problém"
            labelAction="Co udělat"
            labelNext="Další krok"
          />
        )}
        {hasCz && hasEn && <div className="detail-analysis-divider" />}
        {hasEn && (
          <AnalysisLangBlock
            lang="EN"
            summary={result.summaryEn}
            problems={result.problemPointsEn}
            actions={result.actionPointsEn}
            nextStep={result.nextStepEn}
            labelProblem="Problem"
            labelAction="What to do"
            labelNext="Next step"
          />
        )}
      </div>
    );
  }

  // Legacy mode — old task with English-only analysis
  return (
    <div className="detail-analysis-block">
      <div className="analysis-legacy-block">
        {result.summary && <p className="detail-analysis-summary">{result.summary}</p>}
        {result.problemPoints && result.problemPoints.length > 0 && (
          <div className="analysis-subsection">
            <span className="analysis-subsection-label">Problem</span>
            <ul className="detail-analysis-points">
              {result.problemPoints.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          </div>
        )}
        {result.nextStep && (
          <div className="detail-analysis-next">
            <span className="detail-analysis-next-label">Next step:</span>
            {result.nextStep}
          </div>
        )}
      </div>
      <p className="analysis-rerun-hint">
        Click Analyze to generate a new analysis.
      </p>
    </div>
  );
}

interface PlanningSectionProps {
  task: Task;
}

function PlanningSection({ task }: PlanningSectionProps) {
  const computed  = computePlanning(task);
  const score     = task.priorityScore  ?? computed.priorityScore;
  const reason    = task.priorityReason ?? computed.priorityReason;
  const bucket    = effectiveBucket(task);
  const suggested = task.suggestedPlanningBucket ?? computed.suggestedPlanningBucket;

  // Whether the user manually overrode the suggestion
  const isManual   = !!task.isPlanningLocked;
  // Whether the manual choice differs from the current suggestion
  const isMismatch = isManual && task.planningBucket && task.planningBucket !== suggested;
  // Overdue check
  const taskOverdue = task.dueAt ? isOverdue(task.dueAt, task.status) : false;

  const scoreClass = score >= 80
    ? 'planning-score--high'
    : score >= 50
      ? 'planning-score--mid'
      : 'planning-score--low';

  return (
    <div className="detail-section detail-planning-section">
      <span className="detail-section-label">Planning</span>

      {/* Due date + effort row */}
      {(task.dueAt || task.estimatedEffort !== undefined) && (
        <div className="detail-planning-meta">
          {task.dueAt && (
            <div className={`detail-planning-meta-item${taskOverdue ? ' detail-planning-meta-item--overdue' : ''}`}>
              <Icon name="due" size={12} className="detail-planning-meta-icon" />
              <span className="detail-planning-meta-label">Due</span>
              <span className="detail-planning-meta-value">
                {formatRelativeDate(task.dueAt, task.status)}
                {taskOverdue && <span className="overdue-badge overdue-badge--inline">overdue</span>}
              </span>
            </div>
          )}
          {task.estimatedEffort !== undefined && (
            <div className="detail-planning-meta-item">
              <Icon name="effort" size={12} className="detail-planning-meta-icon" />
              <span className="detail-planning-meta-label">Effort</span>
              <span className="detail-planning-meta-value">{formatEffort(task.estimatedEffort)}</span>
            </div>
          )}
        </div>
      )}

      {/* Effective bucket + lock / suggestion indicators */}
      <div className="detail-planning-bucket-row">
        <span className={`planning-bucket-pill planning-bucket-pill--${bucket}`}>
          <Icon name={BUCKET_META[bucket].icon} size={11} />
          {BUCKET_META[bucket].label}
        </span>
        {isManual ? (
          <span className="detail-planning-locked" title="Planning manually locked">
            <Icon name="pin" size={11} /> manual
          </span>
        ) : (
          <span className="detail-planning-auto" title="Auto-suggested by rule engine">
            <Icon name="bolt" size={11} /> auto
          </span>
        )}
        {isMismatch && suggested && (
          <span className="detail-planning-suggestion" title="Auto-suggestion differs from manual choice">
            {'->'} suggested: {BUCKET_META[suggested].label}
          </span>
        )}
      </div>

      {/* Priority score */}
      <div className="detail-planning-score-row">
        <span className="detail-planning-score-label">Priority</span>
        <div className="detail-planning-score-bar-wrap">
          <div className={`detail-planning-score-bar ${scoreClass}`} style={{ width: `${score}%` }} />
        </div>
        <span className={`detail-planning-score-num ${scoreClass}`}>{score}</span>
      </div>
      {reason && (
        <span className="detail-planning-reason">{reason}</span>
      )}
    </div>
  );
}

// ¦¦ Workflow summary helpers ¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦¦

type CheckStatus = 'done' | 'partial' | 'pending' | 'active' | 'skip';

interface CheckRow { label: string; status: CheckStatus; }

// Maps checklist row labels to MCP override keys
const CHECKLIST_KEY_MAP: Record<string, string> = {
  'Task analyzed':        'task-analyzed',
  'Setup confirmed':      'setup-confirmed',
  'CRM metadata verified':'crm-metadata-verified',
  'Technical plan':       'technical-plan-ready',
  'Implementation':       'implementation-done',
  'Local test':           'local-test-done',
  'Consultant testing':   'consultant-testing',
  'Pull request':         'pull-request',
  'Code review':          'code-review',
  'Done':                 'done',
};

function buildWorkflowChecklist(task: Task, effectiveMode: string): CheckRow[] {
  const overrides = task.mcpChecklistOverrides ?? {};
  const applyOverride = (label: string, derived: CheckStatus): CheckStatus => {
    const key = CHECKLIST_KEY_MAP[label];
    return key && overrides[key] ? (overrides[key] as CheckStatus) : derived;
  };

  if (effectiveMode !== 'developer') {
    const rows: CheckRow[] = [
      { label: 'Task analyzed', status: (!!task.analysisResult || task.status !== 'new') ? 'done' : 'pending' },
      { label: 'Done',          status: task.status === 'done' ? 'done' : 'pending' },
    ];
    return rows.map((r) => ({ ...r, status: applyOverride(r.label, r.status) }));
  }
  const wf  = task.crmDeveloperWorkflow;
  const ver = task.crmVerificationReports?.[0];
  const verOk            = !!ver && (ver.verdict === 'pass' || ver.verdict === 'warnings');
  const verFail          = ver?.verdict === 'fail';
  const planApproved     = !!(wf?.planApproval?.approved && !wf.planApproval.invalidatedAt);
  const diffApproved     = !!(wf?.diffApproval?.approved && !wf.diffApproval.invalidatedAt);
  const consultantDone   = !!(wf?.externalExecution?.completed && !wf.externalExecution.invalidatedAt)
                         || task.consultantTestRecord?.status === 'confirmed';
  const prTracked        = !!(wf?.pullRequestTracking?.createdManually && !wf.pullRequestTracking.invalidatedAt);
  const reviewDone       = !!(wf?.pullRequestReview && !wf.pullRequestReview.invalidatedAt);
  const reviewNeedsAttention = !!wf?.pullRequestReview?.attentionRequired;
  const isInProgress     = task.status === 'in-progress';
  const isTesting        = task.waitingState === 'consultant-testing';
  const isReview         = task.status === 'ready-for-review';
  const isDone           = task.status === 'done';

  // Local test status from MCP record
  const localTestSt = task.localTestRecord?.status;
  const localTestDerived: CheckStatus =
    localTestSt === 'passed'     ? 'done'    :
    localTestSt === 'failed'     ? 'partial' :
    localTestSt === 'not-needed' ? 'skip'    : 'pending';

  // Consultant test status (also updated via MCP record_consultant_testing)
  const consultantTestNotNeeded = task.consultantTestRecord?.status === 'not-needed';
  const consultantDerived: CheckStatus =
    consultantDone                  ? 'done'   :
    isTesting                       ? 'active' :
    consultantTestNotNeeded         ? 'skip'   : 'skip';

  const rows: CheckRow[] = [
    { label: 'Task analyzed',        status: (!!task.analysisResult || task.status !== 'new') ? 'done' : 'pending' },
    { label: 'Setup confirmed',      status: !!task.workflowSetup?.confirmedAt ? 'done' : 'pending' },
    { label: 'CRM metadata verified',status: verFail ? 'partial' : verOk ? 'done' : 'pending' },
    { label: 'Technical plan',       status: planApproved ? 'done' : wf?.technicalPlan ? 'partial' : 'pending' },
    { label: 'Implementation',       status: diffApproved ? 'done' : (isInProgress && !isTesting) ? 'active' : 'pending' },
    { label: 'Local test',           status: localTestDerived },
    { label: 'Consultant testing',   status: consultantDerived },
    { label: 'Pull request',         status: prTracked ? 'done' : isReview ? 'active' : 'pending' },
    { label: 'Code review',          status: reviewDone ? (reviewNeedsAttention ? 'partial' : 'done') : 'pending' },
    { label: 'Done',                 status: isDone ? 'done' : 'pending' },
  ];
  return rows.map((r) => ({ ...r, status: applyOverride(r.label, r.status) }));
}

function deriveNextStep(task: Task, plan: TaskWorkflowPlan, effectiveMode: string): { action: string; why: string } | null {
  if (task.status === 'done') return null;

  // MCP-provided next step takes priority over the heuristic when present and non-empty.
  const mcp = task.mcpNextStep;
  if (mcp?.action?.trim()) {
    return { action: mcp.action.trim(), why: mcp.reason?.trim() ?? '' };
  }

  if (task.status === 'new') {
    if (plan.isDeveloperAwaitingSetup)
      return { action: 'Confirm developer setup', why: 'Choose plugin or script target before analysis.' };
    return { action: 'Analyze task', why: 'Run AI analysis to understand the assignment.' };
  }

  if (task.status === 'analyzed') {
    if (effectiveMode === 'general')
      return { action: 'Mark as done when ready', why: 'Task analyzed. Continue manually and mark done.' };
    if (plan.isDeveloperAwaitingSetup)
      return { action: 'Confirm developer setup', why: 'Plugin or script target must be confirmed.' };
    const ver = task.crmVerificationReports?.[0];
    if (!ver)
      return { action: 'Verify Dataverse metadata', why: 'CRM metadata not yet verified for this task.' };
    const wf = task.crmDeveloperWorkflow;
    if (!wf?.technicalPlan)
      return { action: 'Generate technical plan', why: 'No technical plan yet. Generate one in the workflow details below.' };
    if (!wf.planApproval?.approved || wf.planApproval.invalidatedAt)
      return { action: 'Approve technical plan', why: 'Technical plan needs approval before development starts.' };
    return { action: 'Start development', why: 'Plan approved. Begin implementation.' };
  }

  if (task.status === 'in-progress') {
    if (task.waitingState === 'consultant-testing')
      return { action: 'Awaiting consultant testing', why: 'Waiting for the tester to verify the change.' };
    const wf = task.crmDeveloperWorkflow;
    if (!wf?.diffApproval?.approved || wf.diffApproval.invalidatedAt)
      return { action: 'Review implementation diff', why: 'Diff review not yet completed in the workflow details.' };
    if (!wf?.pullRequestProposal || wf.pullRequestProposal.invalidatedAt)
      return { action: 'Generate PR proposal', why: 'PR proposal not yet generated.' };
    return { action: 'Mark ready for code review', why: 'Development complete. Create PR and move to review.' };
  }

  if (task.status === 'ready-for-review') {
    if (task.attentionState === 'pr-comments')
      return { action: 'Address PR comments', why: 'Active PR comments need to be resolved.' };
    const wf = task.crmDeveloperWorkflow;
    if (!wf?.pullRequestTracking?.createdManually)
      return { action: 'Track created pull request', why: 'Record the PR URL after creating it manually.' };
    if (wf?.pullRequestReview?.attentionRequired)
      return { action: 'Address review feedback', why: 'PR review has items that require attention.' };
    return { action: 'Mark as done when ready', why: 'Code review in progress. Mark done when approved.' };
  }

  return null;
}

/**
 * Appends a timestamped activity note line to the task's notes string.
 * Format: `[ISO-timestamp] body` — matched by the activity formatter.
 */
function appendActivityNote(existing: string | undefined, body: string): string {
  const line = `[${new Date().toISOString()}] ${body}`;
  return existing?.trim() ? `${existing.trim()}\n${line}` : line;
}

/**
 * Resolves a repo-root candidate to an absolute path.
 *
 * - If the candidate is already absolute (starts with a drive letter, `\\`, or `/`) → returned as-is.
 * - If the candidate looks like a bare folder name (e.g. "VSK-Test") → joined with `crmBase`.
 * - If neither gives an absolute result → returns `undefined` so the caller falls through.
 *
 * This prevents bare folder names stored in customer/task state from being passed directly
 * to Rust git commands, which would fail with "Repository path not found: VSK-Test".
 */
function resolveToAbsRepoPath(
  candidate: string | null | undefined,
  crmBase: string | undefined,
): string | undefined {
  const p = candidate?.trim();
  if (!p) return undefined;
  // Already absolute: Windows "C:\..." / UNC "\\..." or Unix "/"
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) {
    return p;
  }
  // Bare/relative name — resolve against the CRM base directory
  const base = crmBase?.replace(/[\\/]+$/, '').trim();
  if (base) return `${base}/${p}`;
  // No base available — discard rather than pass a relative path to git
  return undefined;
}

/**
 * Derives an Azure DevOps repository URL from a work-item URL by replacing
 * `/_workitems/edit/{id}` with `/_git/{repositoryName}`.
 *
 * Returns `null` when the input is not a valid ADO work-item URL or repositoryName is empty.
 *
 * @example
 * deriveAzureDevOpsRepoUrlFromWorkItemUrl(
 *   "https://dev.azure.com/Ptacek-velkoobchod/CRM/_workitems/edit/10277/",
 *   "CRM_Code"
 * )
 * // → "https://dev.azure.com/Ptacek-velkoobchod/CRM/_git/CRM_Code"
 */
function deriveAzureDevOpsRepoUrlFromWorkItemUrl(
  workItemUrl: string,
  repositoryName: string,
): string | null {
  if (!workItemUrl.startsWith('https://dev.azure.com/')) return null;
  if (!repositoryName.trim()) return null;
  const m = /^(https:\/\/dev\.azure\.com\/[^/]+\/[^/]+)\/_workitems\/edit\//.exec(workItemUrl);
  if (!m) return null;
  return `${m[1]}/_git/${repositoryName.trim()}`;
}

type AzureDevOpsResolution =
  | { kind: 'repo';      url: string }
  | { kind: 'work-item'; url: string }   // fallback — not a repo URL, clearly labelled
  | null;

/**
 * Resolves the best Azure DevOps URL for opening after testing confirmation.
 *
 * Priority:
 *   A. customer.azureDevOpsRepoUrl — explicit repo URL
 *   B. Derived from task.devopsTaskUrl + customer.repositoryName → /_git/{repo}
 *   C. task.devopsTaskUrl itself — work-item fallback (opened if no repo URL)
 */
function buildAzureDevOpsRepoUrl(
  task: { devopsTaskUrl?: string },
  customer: { azureDevOpsRepoUrl?: string; repositoryName?: string } | null,
): AzureDevOpsResolution {
  // A. Explicit repo URL
  const explicit = customer?.azureDevOpsRepoUrl?.trim();
  if (explicit?.startsWith('https://dev.azure.com/')) {
    return { kind: 'repo', url: explicit };
  }
  // B. Derived from work-item URL + repositoryName
  const workItemUrl = task.devopsTaskUrl;
  const repoName = customer?.repositoryName;
  if (workItemUrl && repoName) {
    const derived = deriveAzureDevOpsRepoUrlFromWorkItemUrl(workItemUrl, repoName);
    if (derived) return { kind: 'repo', url: derived };
  }
  // C. Work-item URL fallback
  if (workItemUrl?.startsWith('https://dev.azure.com/')) {
    return { kind: 'work-item', url: workItemUrl };
  }
  return null;
}

export default function TaskDetail({ task, onClose }: TaskDetailProps) {
  const { updateTask, deleteTask, getCustomerById, customers, settings, crmFolders, resolveOrCreateCustomerByFolder } = useApp();
  const customer = getCustomerById(task.customerId);

  // Effective VS Code path: prefer explicit paths, fall back to crmBaseDirectory + folderName.
  const crmFolderPath = (settings?.crmBaseDirectory && customer?.folderName)
    ? `${settings.crmBaseDirectory}/${customer.folderName}`
    : undefined;

  // Smart resolver — picks plugin / script / repo based on task heuristics.
  // When the user has confirmed a setup, devTargetKind overrides the heuristic.
  const heuristicDevTarget = resolveTaskDevTarget(task, customer, crmFolderPath);
  const devTarget = task.workflowSetup?.devTargetKind
    ? { ...heuristicDevTarget, kind: task.workflowSetup.devTargetKind as typeof heuristicDevTarget.kind }
    : heuristicDevTarget;
  const effectiveVscodePath = devTarget.path;

  // Resolved script folder: prefer confirmed scriptPath, then explicit scriptFolder, then fallback.
  // Must be consistent with resolveCustomerScriptFolder in scriptAssistant.ts.
  // When scriptPath is a specific file (ends .js/.ts), extract the parent folder.
  const repoFallback = customer?.resolvedRepositoryPath ?? customer?.repositoryRoot;
  const rawScriptPath = devTarget.kind === 'script' ? task.workflowSetup?.scriptPath : undefined;
  const scriptPathIsFile = !!rawScriptPath && /\.(js|ts)$/i.test(rawScriptPath);
  const scriptPathFolder = scriptPathIsFile
    ? rawScriptPath.replace(/\\/g, '/').replace(/\/[^/]+$/, '')
    : rawScriptPath;
  const effectiveScriptFolder =
    scriptPathFolder ??
    customer?.scriptFolder ??
    (repoFallback ? `${repoFallback}/Scripts` : undefined) ??
    (devTarget.kind !== 'plugin' ? effectiveVscodePath : undefined);

  // Container directory for plugin project subfolders.
  const pluginsDir = getPluginsDir(customer, crmFolderPath);
  // Root used for git operations (branch switching, commit preview).
  //
  // Resolution priority:
  //   A. task.workflowSetup.repositoryRoot  — explicit task config
  //   B. customer.resolvedRepositoryPath    — computed by rescanRepositories (absolute)
  //   C. customer.repositoryRoot            — explicit customer config
  //   D. crmFolderPath                      — settings.crmBaseDirectory + customer.folderName
  //   E. parent(pluginsDir)                 — inferred from plugin folder path
  //
  // All candidates pass through resolveToAbsRepoPath so that bare folder names
  // like "VSK-Test" are resolved against crmBaseDirectory rather than used as-is.
  const crmBase = settings?.crmBaseDirectory;
  const repoRootForGit: string | undefined =
    resolveToAbsRepoPath(task.workflowSetup?.repositoryRoot, crmBase)
    ?? resolveToAbsRepoPath(customer?.resolvedRepositoryPath, crmBase)
    ?? resolveToAbsRepoPath(customer?.repositoryRoot, crmBase)
    ?? crmFolderPath   // already absolute when both crmBaseDirectory and folderName are set
    ?? (() => {
      if (!pluginsDir) return undefined;
      const norm = pluginsDir.replace(/[\\/]+$/, '').replace(/\\/g, '/');
      const idx = norm.lastIndexOf('/');
      return idx > 0 ? norm.slice(0, idx) : undefined;
    })();

  // Inline feedback message (e.g. "Analysis recorded")
  const [feedback, setFeedback] = useState<string | null>(null);
  // Filesystem error message
  const [fsError, setFsError]   = useState<string | null>(null);
  // AI error message
  const [aiError, setAiError]   = useState<string | null>(null);
  // Which AI action is currently running
  const [aiLoading, setAiLoading] = useState<AiAction | null>(null);
  // Which Primarch action is currently running
  const [primarchActionLoading, setPrimarchActionLoading] = useState<PrimarchAction | null>(null);
  const [crmWorkflowSaving, setCrmWorkflowSaving] = useState(false);
  const [crmTechnicalPlanGenerating, setCrmTechnicalPlanGenerating] = useState(false);
  const [crmPlanApprovalSaving, setCrmPlanApprovalSaving] = useState(false);
  const [crmDiffApprovalSaving, setCrmDiffApprovalSaving] = useState(false);
  const [crmExternalActionApprovalSaving, setCrmExternalActionApprovalSaving] = useState(false);
  const [crmExternalExecutionSaving, setCrmExternalExecutionSaving] = useState(false);
  const [crmPullRequestSaving, setCrmPullRequestSaving] = useState(false);
  const [crmPullRequestReviewSaving, setCrmPullRequestReviewSaving] = useState(false);
  const [crmPullRequestReviewAnalysisSaving, setCrmPullRequestReviewAnalysisSaving] = useState(false);
  const [crmPullRequestFixProposalSaving, setCrmPullRequestFixProposalSaving] = useState(false);
  const [crmPullRequestFixUpdateSaving, setCrmPullRequestFixUpdateSaving] = useState(false);
  const [crmExecutionPreview, setCrmExecutionPreview] = useState<CrmExternalExecutionPreview | null>(null);
  // Confirm setup modal (shown for New tasks before Analyze)
  const [showSetupModal, setShowSetupModal] = useState(false);
  // Draft (plugin skeleton or script preview)
  const [showSkeleton, setShowSkeleton]       = useState(false);
  const [skeletonPreview, setSkeletonPreview] = useState<SkeletonPreview | null>(null);
  // Create Plugin Project modal
  const [showCreatePlugin, setShowCreatePlugin] = useState(false);
  // Start Development modal
  const [showStartDevModal, setShowStartDevModal] = useState(false);
  // Testing actions modal
  const [showTestingActionsModal, setShowTestingActionsModal] = useState(false);
  // AI Kit testing gate — warning shown before moving to consultant testing when review is missing/failed.
  const [aiKitTestingGate, setAiKitTestingGate] = useState<{
    severity: 'fail' | 'warn' | 'no-review';
    onConfirm: () => Promise<void>;
  } | null>(null);
  // Git commit modal
  const [showGitCommitModal, setShowGitCommitModal] = useState(false);
  // When true, GitCommitModal was opened from the Testing → Prepare commit guided flow
  const [gitCommitGuidedMode, setGitCommitGuidedMode] = useState(false);
  // Implementation Verification modal
  const [showImplVerifyModal,    setShowImplVerifyModal]    = useState(false);
  const [implVerifyBuildRunning, setImplVerifyBuildRunning] = useState(false);
  const [implVerifyDvRunning,    setImplVerifyDvRunning]    = useState(false);
  const [implVerifyAiRunning,    setImplVerifyAiRunning]    = useState(false);
  // Resolved artifact path shown in the modal (explicit or inferred).
  const [modalArtifactPath,      setModalArtifactPath]      = useState<string | null>(null);
  const [modalArtifactInferred,  setModalArtifactInferred]  = useState(false);
  // Post-save action pending after skeleton preview confirmation (set by guided "Create + Save Draft + Open" flow).
  const [pendingPostSaveAction, setPendingPostSaveAction] = useState<'save-draft-open' | null>(null);
  // True when the guided flow auto-generated a technical plan (not approved) for the current skeleton preview.
  const [skeletonUsedAutoGeneratedPlan, setSkeletonUsedAutoGeneratedPlan] = useState(false);
  // Plugin project folder names loaded when the Create Plugin Project modal opens.
  // Used to improve naming-convention auto-suggestions inside the modal.
  const [pluginProjectsForModal, setPluginProjectsForModal] = useState<string[]>([]);
  // Absolute path of the generated script file — set after generateScriptDraft, cleared on apply.
  const [scriptDraftPath, setScriptDraftPath] = useState<string | null>(null);
  // For script-create tasks: null = unknown/loading, true = exists, false = missing
  const [scriptArtifactExists, setScriptArtifactExists] = useState<boolean | null>(null);
  // True while "Create Script File" scaffold write + task update is in progress
  const [scriptFileCreating, setScriptFileCreating] = useState(false);
  // True while "Create + Implement with AI Kit" validation is running and the panel is being invoked
  const [scriptAndImplementLoading, setScriptAndImplementLoading] = useState(false);
  const devModePanelRef  = useRef<TaskDevModePanelHandle>(null);
  // Refresh counter for the Dev panel — increment after creating a new plugin project.
  const [devPanelRefreshTick, setDevPanelRefreshTick] = useState(0);
  // Edit task form
  const [showEditForm, setShowEditForm] = useState(false);
  // Delete confirmation step
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Notes — local state, saved on blur
  const [notes, setNotes] = useState(task.notes ?? '');
  // Keep notes in sync when task changes (e.g. different task selected)
  useEffect(() => { setNotes(task.notes ?? ''); }, [task.id, task.notes]);
  // Clear script draft path, pending post-save action, plan-warning flag, and impl verify state when switching tasks.
  useEffect(() => {
    setScriptDraftPath(null);
    setPendingPostSaveAction(null);
    setSkeletonUsedAutoGeneratedPlan(false);
    setShowImplVerifyModal(false);
    setImplVerifyBuildRunning(false);
    setImplVerifyDvRunning(false);
    setImplVerifyAiRunning(false);
    setModalArtifactPath(task.workflowSetup?.artifactPath ?? null);
    setModalArtifactInferred(false);
    setScriptArtifactExists(null);
    setScriptFileCreating(false);
    setScriptAndImplementLoading(false);
  }, [task.id]);
  // AI Code Review — which saved review is open in the detail modal (null = closed)
  const [savedReviewModal, setSavedReviewModal] = useState<AiFileReviewResult | null>(null);
  const [showCrmSkeletonModal, setShowCrmSkeletonModal] = useState(false);
  const [showCrmVerificationModal, setShowCrmVerificationModal] = useState(false);
  const [showPrimarchVerifyModal, setShowPrimarchVerifyModal] = useState(false);
  const [showAdvancedWorkflow, setShowAdvancedWorkflow]       = useState(false);
  const [primarchVerifySteps, setPrimarchVerifySteps] = useState<PrimarchVerifyStep[]>(createPrimarchVerifySteps());
  const [primarchVerifyResult, setPrimarchVerifyResult] = useState<CrmVerificationReport | null>(null);
  const [primarchVerifyError, setPrimarchVerifyError] = useState<string | null>(null);
  const [primarchVerifyFilePath, setPrimarchVerifyFilePath] = useState<string>('');
  const [primarchPrimaryEntityOverride, setPrimarchPrimaryEntityOverride] = useState<string>(
    task.workflowSetup?.primaryEntityLogicalName
      ?? task.scriptAnalysis?.entityLogicalName
      ?? '',
  );
  const latestCrmSkeleton = task.crmSkeletons?.[0];
  const latestCrmVerification = task.crmVerificationReports?.[0];
  const isCreateIntent = task.workflowSetup?.workIntent === 'create';
  const isPluginCreate = isCreateIntent && devTarget.kind === 'plugin';
  const primarchActionBusyRef = useRef(false);
  const primarchVerifyIgnoreResultRef = useRef(false);
  const primarchVerifyRunIdRef = useRef(0);
  const aiKitPanelRef = useRef<AiKitActionsPanelHandle>(null);

  useEffect(() => {
    setPrimarchActionLoading(null);
    setShowPrimarchVerifyModal(false);
    setPrimarchVerifySteps(createPrimarchVerifySteps());
    setPrimarchVerifyResult(null);
    setPrimarchVerifyError(null);
    setPrimarchVerifyFilePath('');
    setPrimarchPrimaryEntityOverride(task.workflowSetup?.primaryEntityLogicalName ?? task.scriptAnalysis?.entityLogicalName ?? '');
    primarchActionBusyRef.current = false;
    primarchVerifyIgnoreResultRef.current = false;
    primarchVerifyRunIdRef.current += 1;
  }, [task.id]);

  // Persists a new AI review result on the task (newest first, capped at 5).
  async function handleReviewSaved(review: AiFileReviewResult) {
    const existing = task.aiFileReviews ?? [];
    const updated = [review, ...existing].slice(0, 5);
    await updateTask(task.id, { aiFileReviews: updated });
  }

  async function handleSaveCrmDeveloperWorkflowState() {
    setCrmWorkflowSaving(true);
    try {
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateSnapshot(task),
      });
      setFeedback('CRM workflow diagnosis state saved locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmWorkflowSaving(false);
    }
  }

  async function handleGenerateCrmTechnicalPlan() {
    setCrmTechnicalPlanGenerating(true);
    try {
      const generatedAt = new Date().toISOString();
      const plan = buildCrmTechnicalImplementationPlan(task, generatedAt);
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterTechnicalPlan(task, plan, generatedAt),
      });
      setFeedback('Draft CRM technical implementation plan saved locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmTechnicalPlanGenerating(false);
    }
  }

  async function handleApproveCrmTechnicalPlan() {
    if (!task.crmDeveloperWorkflow?.technicalPlan) {
      setAiError('Generate a CRM technical implementation plan before approving it.');
      return;
    }

    setCrmPlanApprovalSaving(true);
    try {
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterPlanApproval(task),
      });
      setFeedback('CRM technical implementation plan approved locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmPlanApprovalSaving(false);
    }
  }

  async function handleRevokeCrmTechnicalPlanApproval() {
    setCrmPlanApprovalSaving(true);
    try {
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterPlanApprovalRevoked(task),
      });
      setFeedback('CRM technical implementation plan approval revoked locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmPlanApprovalSaving(false);
    }
  }

  async function handleApproveCrmDiffReview() {
    const diffStatus = getCrmDiffReviewStatus(task);
    if (!diffStatus.approvable) {
      setAiError(`CRM diff approval is not ready: ${diffStatus.reason}`);
      return;
    }

    setCrmDiffApprovalSaving(true);
    try {
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterDiffApproval(task),
      });
      setFeedback(diffStatus.warnings.length > 0
        ? 'CRM diff approved locally with warnings.'
        : 'CRM diff approved locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmDiffApprovalSaving(false);
    }
  }

  async function handleRevokeCrmDiffReviewApproval() {
    setCrmDiffApprovalSaving(true);
    try {
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterDiffApprovalRevoked(task),
      });
      setFeedback('CRM diff approval revoked locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmDiffApprovalSaving(false);
    }
  }

  async function handleApproveCrmExternalActionPlan() {
    const externalStatus = getCrmExternalActionApprovalStatus(task);
    if (!externalStatus.approvable) {
      setAiError(`CRM external action approval is not ready: ${externalStatus.reason}`);
      return;
    }

    setCrmExternalActionApprovalSaving(true);
    try {
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterExternalActionApproval(task),
      });
      setFeedback(externalStatus.warnings.length > 0
        ? 'CRM external action plan approved locally with warnings.'
        : 'CRM external action plan approved locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmExternalActionApprovalSaving(false);
    }
  }

  async function handleRevokeCrmExternalActionApproval() {
    setCrmExternalActionApprovalSaving(true);
    try {
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterExternalActionApprovalRevoked(task),
      });
      setFeedback('CRM external action approval revoked locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmExternalActionApprovalSaving(false);
    }
  }

  function handleOpenCrmExecutionPreview() {
    if (!getCrmExternalActionApprovalStatus(task).approved) return;
    setCrmExecutionPreview(buildCrmExternalExecutionPreview(task, new Date().toISOString()));
  }

  async function handleMarkExternalExecutionCompleted(notes: string) {
    const status = getCrmExternalExecutionStatus(task);
    if (!status.completable) {
      setAiError(`Cannot record manual completion: ${status.reason}`);
      return;
    }
    if (!notes.trim()) {
      setAiError('A completion note is required before marking external actions as completed.');
      return;
    }
    setCrmExternalExecutionSaving(true);
    try {
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterExternalExecutionCompleted(
          task,
          notes.trim(),
          new Date().toISOString(),
        ),
      });
      setFeedback('External action completion recorded locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmExternalExecutionSaving(false);
    }
  }

  async function handleRevokeExternalExecution() {
    setCrmExternalExecutionSaving(true);
    try {
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterExternalExecutionRevoked(
          task,
          new Date().toISOString(),
        ),
      });
      setFeedback('External action completion record revoked.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmExternalExecutionSaving(false);
    }
  }

  async function handleGenerateCrmPullRequestProposal() {
    const status = getCrmPullRequestProposalStatus(task);
    if (!status.generatable) {
      setAiError(`CRM pull request proposal is not ready: ${status.reason}`);
      return;
    }

    setCrmPullRequestSaving(true);
    try {
      const generatedAt = new Date().toISOString();
      const proposal = buildCrmPullRequestProposal(task, generatedAt);
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterPullRequestProposal(task, proposal, generatedAt),
      });
      setFeedback(status.warnings.length > 0
        ? 'CRM pull request proposal generated locally with warnings.'
        : 'CRM pull request proposal generated locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmPullRequestSaving(false);
    }
  }

  async function handleMarkCrmPullRequestCreatedManually(prUrl: string, notes: string) {
    const status = getCrmPullRequestTrackingStatus(task);
    if (!status.trackable) {
      setAiError(`Cannot record manual PR tracking: ${status.reason}`);
      return;
    }
    if (!prUrl.trim() && !notes.trim()) {
      setAiError('A PR URL or note is required before recording manual PR tracking.');
      return;
    }

    setCrmPullRequestSaving(true);
    try {
      const now = new Date().toISOString();
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterManualPullRequestTracked(
          task,
          prUrl.trim() || undefined,
          notes.trim() || undefined,
          now,
        ),
      });
      setFeedback('Manual pull request tracking recorded locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmPullRequestSaving(false);
    }
  }

  async function handleRevokeCrmPullRequestTracking() {
    setCrmPullRequestSaving(true);
    try {
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterManualPullRequestTrackingRevoked(
          task,
          new Date().toISOString(),
        ),
      });
      setFeedback('Manual pull request tracking revoked locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmPullRequestSaving(false);
    }
  }

  async function handleFetchCrmPullRequestReviewStatus() {
    const status = getCrmPullRequestReviewStatus(task);
    if (!status.fetchable) {
      setAiError(`Cannot fetch PR review status: ${status.reason}`);
      return;
    }

    setCrmPullRequestReviewSaving(true);
    try {
      const fetchedAt = new Date().toISOString();
      const prUrl = task.crmDeveloperWorkflow?.pullRequestTracking?.prUrl?.trim() ?? '';
      const review = status.provider === 'github'
        ? await fetchCrmGitHubPullRequestReviewIntake(prUrl, fetchedAt)
        : buildCrmPullRequestReviewIntake(task, fetchedAt);
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterPullRequestReviewIntake(task, review, fetchedAt),
      });
      setFeedback(status.provider === 'github'
        ? 'Read-only GitHub PR review snapshot saved locally.'
        : 'Read-only PR review intake saved locally. Automatic provider fetching is not configured yet.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmPullRequestReviewSaving(false);
    }
  }

  async function handleGenerateCrmPullRequestReviewAnalysis() {
    const status = getCrmPullRequestReviewAnalysisStatus(task);
    if (!status.generatable) {
      setAiError(`Cannot generate PR review analysis: ${status.reason}`);
      return;
    }

    setCrmPullRequestReviewAnalysisSaving(true);
    try {
      const generatedAt = new Date().toISOString();
      const analysis = buildCrmPullRequestReviewAnalysis(task, generatedAt);
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterPullRequestReviewAnalysis(
          task,
          analysis,
          generatedAt,
        ),
      });
      setFeedback(analysis.attentionRequired
        ? 'Local PR review fix plan generated. Attention is needed before responding to the PR.'
        : 'Local PR review fix plan generated.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmPullRequestReviewAnalysisSaving(false);
    }
  }

  async function handleGenerateCrmPullRequestFixProposal() {
    const status = getCrmPullRequestFixProposalStatus(task);
    if (!status.generatable) {
      setAiError(`Cannot generate PR fix proposal: ${status.reason}`);
      return;
    }

    setCrmPullRequestFixProposalSaving(true);
    try {
      const generatedAt = new Date().toISOString();
      const proposal = buildCrmPullRequestFixProposal(task, generatedAt);
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterPullRequestFixProposal(
          task,
          proposal,
          generatedAt,
        ),
      });
      setFeedback(proposal.canGenerateCodeLater
        ? 'Local PR fix proposal generated. Future code drafting may be possible after approval in a later step.'
        : 'Local PR fix proposal generated as a manual/conservative plan.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmPullRequestFixProposalSaving(false);
    }
  }

  async function handleMarkCrmPullRequestFixUpdatedManually(notes: string, commitSha: string, branchName: string) {
    const status = getCrmPullRequestFixUpdateStatus(task);
    if (!status.trackable) {
      setAiError(`Cannot record manual PR fix update: ${status.reason}`);
      return;
    }
    if (!notes.trim() && !commitSha.trim()) {
      setAiError('A note or commit SHA is required before recording a manual PR fix update.');
      return;
    }

    setCrmPullRequestFixUpdateSaving(true);
    try {
      const now = new Date().toISOString();
      const tracking: CrmPullRequestFixUpdateTracking = {
        updatedManually: true,
        updatedAt: now,
        notes: notes.trim() || undefined,
        commitSha: commitSha.trim() || undefined,
        branchName: branchName.trim() || undefined,
        relatedFixProposalGeneratedAt: task.crmDeveloperWorkflow?.pullRequestFixProposal?.generatedAt,
      };
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterManualPullRequestFixUpdated(task, tracking, now),
      });
      setFeedback('Manual PR fix update recorded locally. Next recommended step: fetch PR review status again.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmPullRequestFixUpdateSaving(false);
    }
  }

  async function handleRevokeCrmPullRequestFixUpdateTracking() {
    setCrmPullRequestFixUpdateSaving(true);
    try {
      await updateTask(task.id, {
        crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterManualPullRequestFixUpdateRevoked(
          task,
          new Date().toISOString(),
        ),
      });
      setFeedback('Manual PR fix update tracking revoked locally.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setCrmPullRequestFixUpdateSaving(false);
    }
  }

  function handleClosePrimarchVerifyModal() {
    primarchVerifyIgnoreResultRef.current = true;
    setShowPrimarchVerifyModal(false);
  }

  async function handleGenerateCrmSkeleton() {
    if (primarchActionBusyRef.current) {
      return;
    }
    if (effectiveMode !== 'developer') {
      setAiError('CRM skeleton is available only for developer tasks.');
      return;
    }
    if (!settings.crmMetadataEnabled) {
      setAiError('CRM metadata assistant is not enabled. Configure it in Settings › CRM Metadata.');
      return;
    }

    primarchActionBusyRef.current = true;
    setPrimarchActionLoading('skeleton');
    setAiError(null);
    try {
      const result = await tauriApi.generateCrmSkeleton(task, customer ?? null, task.workflowSetup);
      const existing = task.crmSkeletons ?? [];
      const enriched: CrmSkeletonResult = {
        ...result,
        id: result.id ?? `${Date.now()}`,
        createdAt: result.createdAt ?? new Date().toISOString(),
      };
      const updated = [enriched, ...existing].slice(0, 5);
      await updateTask(task.id, { crmSkeletons: updated });
      setFeedback('CRM skeleton generated.');
    } catch (e) {
      setAiError(String(e));
    } finally {
      primarchActionBusyRef.current = false;
      setPrimarchActionLoading(null);
    }
  }

  async function handleVerifyAgainstCrm() {
    if (primarchActionBusyRef.current) {
      return;
    }
    if (effectiveMode !== 'developer') {
      setAiError('CRM verification is available only for developer tasks.');
      return;
    }
    if (
      !settings.crmMetadataEnabled
      || !(settings.primarchMcpCommand ?? '').trim()
      || !(settings.primarchMcpArgs ?? '').trim()
    ) {
      setAiError('CRM metadata assistant is not configured. Open Settings › CRM Metadata, enable assistant, configure MCP command/args, and save settings.');
      return;
    }

    const primaryEntityOverride = primarchPrimaryEntityOverride.trim() || undefined;

    primarchActionBusyRef.current = true;
    primarchVerifyIgnoreResultRef.current = false;
    primarchVerifyRunIdRef.current += 1;
    const runId = primarchVerifyRunIdRef.current;

    setPrimarchActionLoading('verify');
    setPrimarchVerifyError(null);
    setPrimarchVerifyResult(null);
    setPrimarchVerifyFilePath('');
    setPrimarchVerifySteps(createPrimarchVerifySteps());
    setShowPrimarchVerifyModal(true);

    const yieldToUi = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

    window.setTimeout(() => {
      void (async () => {
        let currentFilePath = '';
        let localScan: CrmReferenceScanResult = {
          entities: [],
          attributes: {},
          ambiguousAttributes: [],
          notes: [],
          entityReferences: [],
          attributeReferences: [],
          relationshipReferences: [],
          ambiguousReferences: [],
        };

        try {
          await yieldToUi();
          if (runId !== primarchVerifyRunIdRef.current || primarchVerifyIgnoreResultRef.current) return;

          setPrimarchVerifySteps((prev) => setStepStatus(prev, 'resolve-target-file', 'running'));

          const configuredPath = task.workflowSetup?.artifactPath
            ?? task.workflowSetup?.scriptPath
            ?? '';
          currentFilePath = configuredPath;

          if (!currentFilePath) {
            const basePath =
              task.workflowSetup?.repositoryRoot
              ?? customer?.resolvedRepositoryPath
              ?? customer?.repositoryRoot
              ?? effectiveVscodePath
              ?? '';
            if (basePath) {
              currentFilePath = await tauriApi.inferReviewFilePath(
                basePath,
                devTarget.kind === 'plugin' ? 'plugin' : 'script',
                task.workflowSetup?.pluginProject ?? '',
                task.title,
              ).catch(() => '');
            }
          }

          if (!currentFilePath) {
            throw new Error('No file available for CRM verification. Configure artifact/script path first.');
          }

          setPrimarchVerifyFilePath(currentFilePath);
          setPrimarchVerifySteps((prev) => setStepStatus(prev, 'resolve-target-file', 'done', currentFilePath));

          await yieldToUi();
          if (runId !== primarchVerifyRunIdRef.current || primarchVerifyIgnoreResultRef.current) return;

          setPrimarchVerifySteps((prev) => setStepStatus(prev, 'read-local-code', 'running', 'Reading source file...'));
          const content = await tauriApi.readFileContent(currentFilePath);
          setPrimarchVerifySteps((prev) => setStepStatus(prev, 'read-local-code', 'done', `Read ${content.length.toLocaleString()} characters.`));

          await yieldToUi();
          if (runId !== primarchVerifyRunIdRef.current || primarchVerifyIgnoreResultRef.current) return;

          setPrimarchVerifySteps((prev) => setStepStatus(prev, 'scan-crm-references', 'running', 'Scanning CRM references...'));
          const lower = currentFilePath.toLowerCase();
          const fallbackEntity = task.scriptAnalysis?.entityLogicalName;
          localScan = lower.endsWith('.cs')
            ? scanCSharpCrmReferences(content, primaryEntityOverride)
            : scanJavaScriptCrmReferences(content, fallbackEntity, currentFilePath);
          const localReferenceCount = localScan.entityReferences.length
            + localScan.attributeReferences.length
            + localScan.relationshipReferences.length
            + localScan.ambiguousReferences.length;
          const entitySummary = localScan.entities.length ? localScan.entities.join(', ') : 'no explicit entities';
          const entityAttrSummary = Object.entries(localScan.attributes)
            .filter(([, attrs]) => attrs.length > 0)
            .map(([e, attrs]) => `${e}(${attrs.length})`)
            .join(', ');
          const ambiguousAttrCount = localScan.ambiguousAttributes.length;
          const primaryEntityNote = localScan.notes.find((note) =>
            note.startsWith('Primary form entity:') || note.startsWith('Primary plugin entity:'),
          );
          const primarySource = localScan.pluginContext?.primaryEntitySource
            ?? (primaryEntityNote ? 'inferred' : 'unknown');
          const scanDetail = [
            primaryEntityNote ?? '',
            `Primary entity source: ${primarySource.replace(/_/g, ' ')}.`,
            `Found ${localReferenceCount} references. Entities: ${entitySummary}.`,
            entityAttrSummary ? `Attributes by entity: ${entityAttrSummary}.` : '',
            ambiguousAttrCount > 0 ? `${ambiguousAttrCount} ambiguous attribute(s) could not be bound to a specific entity.` : '',
          ].filter(Boolean).join(' ');
          setPrimarchVerifySteps((prev) => setStepStatus(
            prev,
            'scan-crm-references',
            'done',
            scanDetail,
          ));

          await yieldToUi();
          if (runId !== primarchVerifyRunIdRef.current || primarchVerifyIgnoreResultRef.current) return;

          setPrimarchVerifySteps((prev) => setStepStatus(prev, 'connect-primarch-mcp', 'running', 'Connecting to Primarch MCP...'));
          setPrimarchVerifySteps((prev) => setStepStatus(prev, 'inspect-dataverse', 'running', 'Inspecting targeted Dataverse metadata...'));

          const report = await tauriApi.verifyAgainstCrm(
            task,
            customer ?? null,
            localScan,
            currentFilePath,
            primaryEntityOverride,
          );

          if (runId !== primarchVerifyRunIdRef.current || primarchVerifyIgnoreResultRef.current) return;

          setPrimarchVerifySteps((prev) => setStepStatus(prev, 'connect-primarch-mcp', 'done', report.metadataInspected?.toolsUsed?.length ? 'Primarch MCP connected.' : 'Primarch MCP not configured.'));
          const inspectedEntityDetails = report.metadataInspected?.entityDetails?.length
            ? report.metadataInspected.entityDetails
                .map((detail) => {
                  if (detail.schemaCompleteness === 'complete') {
                    return `Received ${detail.columnCount} columns for ${detail.entityLogicalName} (complete schema)`;
                  }
                  if (detail.schemaCompleteness === 'incomplete') {
                    return `Only ${detail.columnCount} columns returned for ${detail.entityLogicalName}; schema may be incomplete`;
                  }
                  return `${detail.entityLogicalName}: ${detail.columnCount} columns (completeness unknown)`;
                })
                .join('; ')
            : '';
          setPrimarchVerifySteps((prev) => setStepStatus(prev, 'inspect-dataverse', 'done', inspectedEntityDetails
            ? `Requested full schema for ${report.metadataInspected?.entityLogicalNames?.join(', ') ?? 'entities'}. ${inspectedEntityDetails}.`
            : 'No targeted metadata was inspected.'));
          setPrimarchVerifySteps((prev) => setStepStatus(prev, 'build-report', 'running', 'Building verification report...'));

          if (report.verdict === 'not_configured') {
            setPrimarchVerifySteps((prev) => setStepStatus(prev, 'inspect-dataverse', 'failed', 'Dataverse verification was skipped because Primarch MCP is not configured.'));
            setPrimarchVerifySteps((prev) => setStepStatus(prev, 'build-report', 'done', 'Local scan report built (metadata not inspected).'));
            setPrimarchVerifySteps((prev) => setStepStatus(prev, 'done', 'done', 'Local reference scan completed; Dataverse verification skipped.'));
          }

          const enriched: CrmVerificationReport = {
            ...report,
            id: report.id ?? `${Date.now()}`,
            createdAt: report.createdAt ?? new Date().toISOString(),
            filePath: currentFilePath,
            summary: report.summary || summarizeVerifications(report.issues ?? [], report.verdict),
            answer: report.answer ?? report.summary,
            rawExtractedReferences: localScan,
          };

          setPrimarchVerifyResult(enriched);
          if (report.verdict !== 'not_configured') {
            setPrimarchVerifySteps((prev) => setStepStatus(prev, 'build-report', 'done', 'Verification report ready.'));
            setPrimarchVerifySteps((prev) => setStepStatus(prev, 'done', 'done', 'Verification complete.'));
          }

          if (report.verdict !== 'error' && report.verdict !== 'not_configured' && !primarchVerifyIgnoreResultRef.current) {
            const existing = task.crmVerificationReports ?? [];
            const updated = [enriched, ...existing].slice(0, 5);
            const verificationCheckpointComplete = isMeaningfulCrmVerificationReport(enriched);
            const verificationVerdict = formatCrmVerdict(enriched.verdict);
            await updateTask(task.id, {
              crmVerificationReports: updated,
              ...(verificationCheckpointComplete
                ? { crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterMetadataVerification(task, enriched) }
                : {}),
            });
            setFeedback(
              verificationCheckpointComplete
                ? `CRM verification checkpoint complete (${verificationVerdict}).`
                : `CRM verification stored (${verificationVerdict}).`,
            );
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (runId !== primarchVerifyRunIdRef.current) return;

          setPrimarchVerifyError(message);
          const errorReport: CrmVerificationReport = {
            id: `${Date.now()}`,
            createdAt: new Date().toISOString(),
            filePath: currentFilePath || undefined,
            verdict: 'error',
            metadataVerdict: 'unknown',
            runtimeReadiness: 'unknown',
            summary: 'Verification could not be completed. See details below.',
            answer: message,
            issues: [],
            confirmedReferences: [],
            missingReferences: [],
            ambiguousReferences: [],
            runtimeRisks: [],
            pluginChecks: [],
            inspectedEntities: [],
            inspectedAttributesByEntity: {},
            unableToVerifyReasons: [],
            compileReadiness: {
              status: 'not_checked',
              detail: 'Compile readiness was not checked during metadata verification.',
            },
            metadataInspected: {
              entityLogicalNames: [],
              attributeLogicalNames: {},
              toolsUsed: [],
            },
            rawExtractedReferences: localScan,
          };
          setPrimarchVerifyResult(errorReport);
          setPrimarchVerifySteps((prev) => setStepStatus(prev, 'build-report', 'failed', 'Verification could not be completed.'));
          setPrimarchVerifySteps((prev) => setStepStatus(prev, 'done', 'failed', 'Verification could not be completed.'));
        } finally {
          if (runId === primarchVerifyRunIdRef.current) {
            primarchActionBusyRef.current = false;
            setPrimarchActionLoading(null);
          }
        }
      })();
    }, 0);
  }

  // Centralized workflow plan — drives BPF stages, action labels, feature flags.
  // Pass the heuristic devTarget kind so tasks without confirmed setup still work.
  const plan = buildTaskWorkflowPlan(task, heuristicDevTarget.kind);
  const { mode: effectiveMode } = inferTaskMode(task);

  // Developer implementation readiness — used to show blockers and drive prompt content.
  const devReadiness = useMemo(() => getDeveloperReadiness(task, customer), [task, customer]);
  const showDevReadiness = effectiveMode === 'developer'
    && (devTarget.kind === 'plugin' || devTarget.kind === 'script');

  // AI Kit guided workflow state — derived from task notes, reviews, and settings.
  const resolvedArtifactForAiKit = task.workflowSetup?.artifactPath ?? task.workflowSetup?.scriptPath;
  const aiKitWorkflowState = getAiKitWorkflowState(
    task,
    settings?.powerPlatformAiKitPath,
    resolvedArtifactForAiKit,
  );

  // AI Kit actions (implement, review-diff, apply-fixes) are assistant/tool actions only.
  // They must never replace the plan's primary workflow action in the yellow button.
  // The main workflow step is always driven by the plan (verify-implementation for script/plugin).
  const effectiveWorkflowAction = plan.currentAction;

  // Check whether the script artifact file exists on disk for script-create tasks in Development.
  useEffect(() => {
    const path = resolvedArtifactForAiKit?.trim();
    if (!plan.requiresScriptCreate || !path) {
      setScriptArtifactExists(null);
      return;
    }
    let cancelled = false;
    tauriApi.checkPathExists(path).then((exists) => {
      if (!cancelled) setScriptArtifactExists(exists);
    }).catch(() => {
      if (!cancelled) setScriptArtifactExists(null);
    });
    return () => { cancelled = true; };
  }, [plan.requiresScriptCreate, resolvedArtifactForAiKit]);

  async function handleCreateScriptFileInPanel() {
    const rawPath = resolvedArtifactForAiKit?.trim();
    if (!rawPath) {
      setFsError('No script target configured. Use Confirm Setup to select a script file.');
      return;
    }
    const isAbs = /^[a-zA-Z]:[\\/]|^\/|^\\\\/.test(rawPath);
    const artifactPath = isAbs ? rawPath : `${repoRootForGit?.replace(/[\\/]+$/, '') ?? ''}/${rawPath}`;

    setScriptFileCreating(true);
    setFsError(null);
    try {
      const repo = repoRootForGit?.trim();
      if (!repo) throw new Error('Repository root is not configured.');
      if (!isPathInsideDir(artifactPath, repo)) {
        throw new Error(`Target file is outside the repository root.\nFile: ${artifactPath}`);
      }
      const aiKitPath = settings?.powerPlatformAiKitPath?.trim();
      if (aiKitPath && isPathInsideDir(artifactPath, aiKitPath)) {
        throw new Error('Target file must not be inside the AI Kit folder.');
      }
      const parentDir = artifactPath.replace(/\\/g, '/').replace(/\/?[^/]+$/, '');
      if (!parentDir) throw new Error('Cannot determine parent directory.');
      const parentExists = await tauriApi.checkPathExists(parentDir).catch(() => false);
      if (!parentExists) {
        throw new Error(`Target directory does not exist: ${parentDir}`);
      }
      await tauriApi.saveGeneratedFile(artifactPath, buildScriptScaffold());
      const now = new Date().toISOString();
      const note = `[${now}] UI: script-file-created`;
      const existing = task.notes?.trim() ?? '';
      await updateTask(task.id, {
        workflowSetup: { ...task.workflowSetup, scriptPath: artifactPath, artifactPath },
        notes: existing ? `${existing}\n${note}` : note,
      });
      setScriptArtifactExists(true);
    } catch (e) {
      setFsError(String(e));
    } finally {
      setScriptFileCreating(false);
    }
  }

  async function handleCreateScriptAndImplementInPanel() {
    if (scriptAndImplementLoading) return;
    const rawPath = resolvedArtifactForAiKit?.trim();
    if (!rawPath) {
      setFsError('No script target configured. Use Confirm Setup to select a script file.');
      return;
    }
    const isAbs = /^[a-zA-Z]:[\\/]|^\/|^\\\\/.test(rawPath);
    const artifactPath = isAbs ? rawPath : `${repoRootForGit?.replace(/[\\/]+$/, '') ?? ''}/${rawPath}`;

    setScriptAndImplementLoading(true);
    setFsError(null);
    try {
      const repo = repoRootForGit?.trim();
      if (!repo) throw new Error('Repository root is not configured.');
      if (!isPathInsideDir(artifactPath, repo)) {
        throw new Error(`Target file is outside the repository root.`);
      }
      const aiKitPath = settings?.powerPlatformAiKitPath?.trim();
      if (!aiKitPath) throw new Error('AI Kit path is not configured. Go to Settings to configure it.');
      if (isPathInsideDir(artifactPath, aiKitPath)) {
        throw new Error('Target file must not be inside the AI Kit folder.');
      }
      const parentDir = artifactPath.replace(/\\/g, '/').replace(/\/?[^/]+$/, '');
      if (!parentDir) throw new Error('Cannot determine parent directory.');
      const parentExists = await tauriApi.checkPathExists(parentDir).catch(() => false);
      if (!parentExists) {
        throw new Error(`Target directory does not exist: ${parentDir}`);
      }
      // Explicit null check — ref is null if AiKitActionsPanel is not mounted.
      const panel = aiKitPanelRef.current;
      if (!panel) {
        throw new Error('AI Kit panel is not available. This is a bug — please report it.');
      }
      // Start AI Kit implementation. No scaffold is written here.
      // The file is created only after the user clicks Apply in the preview modal.
      // Loading state is cleared by onPreviewReady (success) or onError (failure) callbacks.
      panel.startImplement(artifactPath);
    } catch (e) {
      setFsError(String(e));
      setScriptAndImplementLoading(false);
    }
  }

  async function handleSetMode(mode: 'developer' | 'general') {
    await updateTask(task.id, { taskMode: mode });
  }

  // Selected plugin project: prefer confirmed setup, then persisted task field.
  const selectedPluginProject = task.workflowSetup?.pluginProject ?? task.selectedPluginProject ?? '';
  function handleSelectedPluginChange(plugin: string) {
    updateTask(task.id, { selectedPluginProject: plugin || undefined }).catch(() => {});
  }
  function handleScriptFileSelected(path: string) {
    updateTask(task.id, {
      workflowSetup: { ...task.workflowSetup, scriptPath: path || undefined },
    }).catch(() => {});
  }

  /**
   * Called by TaskDevModePanel when a refresh reveals the persisted plugin project
   * folder no longer exists on disk.
   * Preserves the project name as desiredPluginProject so helper actions can
   * prefill suggestions without turning project creation into a workflow gate.
   */
  async function handlePluginProjectMissing(projectName: string) {
    const currentArtifact = task.workflowSetup?.artifactPath;
    const artifactInsideProject = currentArtifact &&
      (currentArtifact.replace(/\\/g, '/').includes(`/${projectName}/`));
    await updateTask(task.id, {
      selectedPluginProject: undefined,
      workflowSetup: {
        ...task.workflowSetup,
        pluginProject:        undefined,
        desiredPluginProject: task.workflowSetup?.desiredPluginProject ?? projectName,
        artifactPath:         artifactInsideProject ? undefined : currentArtifact,
      },
    });
    setFeedback(`Plugin project '${projectName}' was not found. Create it manually, then refresh projects.`);
  }


  // --- Status change ---

  async function handleStatusChange(status: TaskStatus, extra: Partial<Task> = {}) {
    await updateTask(task.id, {
      waitingState: null,
      attentionState: null,
      ...extra,
      status,
    });
  }

  // --- Completed date edit ---

  const [editingCompletedAt, setEditingCompletedAt] = useState(false);
  useEffect(() => { setEditingCompletedAt(false); }, [task.id]);

  async function handleCompletedAtChange(value: string) {
    // value is YYYY-MM-DD from the date input; convert to ISO with noon UTC to stay on the correct day
    const iso = value ? new Date(`${value}T12:00:00`).toISOString() : undefined;
    await updateTask(task.id, { completedAt: iso });
    setEditingCompletedAt(false);
  }

  // --- Delete ---

  async function handleDelete() {
    await deleteTask(task.id);
    setConfirmDelete(false);
  }

  // --- Notes ---

  const splitNotes = splitTaskNotes(notes);
  const activityItems = formatTaskActivityNotes(splitNotes.activityLines);
  const latestActivity = activityItems[activityItems.length - 1];

  async function handleNotesSave() {
    await updateTask(task.id, { notes });
  }

  // --- Helpers ---

  function formatDate(iso: string | undefined): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  // --- Workflow actions ---

  async function handleAnalyze() {
    await handleAnalyzeWithSetup(undefined);
  }

  /**
   * Runs AI analysis and persists the result in a single updateTask call.
   * When `extraSetup` is provided (e.g. from Confirm Setup), it is merged into
   * the same update so that workflowSetup and status are never split across two
   * updateTask calls (which would lose the setup due to React stale closures).
   */
  async function handleAnalyzeWithSetup(extraSetup: import('../types').WorkflowSetup | undefined) {
    setAiLoading('analyze');
    setAiError(null);
    try {
      const result = await tauriApi.analyzeTask(task, customer ?? null);
      // If setup provides a customer, persist it to task.customerId as well.
      const customerUpdate = extraSetup?.customerId && extraSetup.customerId !== task.customerId
        ? { customerId: extraSetup.customerId }
        : {};
      await updateTask(task.id, {
        ...(extraSetup !== undefined ? { workflowSetup: extraSetup } : {}),
        status:         'analyzed',
        waitingState:   null,
        attentionState: null,
        analysisResult: result,
        confidence:     result.confidence,
        ...customerUpdate,
      });
      setFeedback('AI analysis complete — status set to Analyzed');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiLoading(null);
    }
  }

  async function handleGenerateDraft() {
    let draftTask = task;
    let fixProposalDraftContextApplied = false;

    if (isDeveloperWorkflowTask(task)) {
      const readiness = getCrmCodeGenerationReadiness(task);
      if (!readiness.ready) {
        setAiError(`CRM code generation is not ready: ${readiness.reason}`);
        return;
      }
      if (readiness.warnings.length > 0) {
        setFeedback(`CRM code generation readiness has warnings: ${readiness.warnings.join(' ')}`);
      }

      const fixProposalContext = buildCrmDraftContextFromPullRequestFixProposal(task);
      if (fixProposalContext.ready) {
        draftTask = withCrmDraftContext(task, fixProposalContext.promptContext);
        fixProposalDraftContextApplied = !!fixProposalContext.promptContext;
      }
    }

    if (devTarget.kind === 'plugin') {
      // If a project is selected, verify it still exists before generating.
      if (selectedPluginProject && pluginsDir) {
        const projectPath = `${pluginsDir}/${selectedPluginProject}`;
        const exists = await tauriApi.checkPathExists(projectPath).catch(() => false);
        if (!exists) {
          // Project folder was deleted — clear selection so helper tools can guide recovery.
          await handlePluginProjectMissing(selectedPluginProject);
          setAiError(`Plugin project '${selectedPluginProject}' no longer exists. Create it again first.`);
          return;
        }
      }
      // Plugin: call AI to generate a C# skeleton, then open preview modal.
      setAiLoading('draft');
      setAiError(null);
      try {
        const preview = await tauriApi.generateSkeletonPreview(draftTask, customer ?? null);
        setSkeletonPreview(preview);
        setShowSkeleton(true);
        await updateTask(task.id, {
          crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterDraftRegenerated(task),
        });
        if (fixProposalDraftContextApplied) {
          setFeedback('Draft preview generated using the local PR fix proposal as additional context. Review the diff before approval.');
        }
        // Do not write files, open IDEs, or advance status here; Apply/Start are explicit.
      } catch (e) {
        setAiError(String(e));
      } finally {
        setAiLoading(null);
      }
    } else {
      // Script (Create or Update/Fix): generate via scriptAssistant service directly.
      // No visible Script Assistant panel required — logic runs inline.
      if (!effectiveScriptFolder) {
        setAiError('No script folder configured for this customer.');
        return;
      }
      // For Create + Script: require that Confirm Setup has set a specific target file.
      // workflowSetup.scriptPath will be the full path (e.g. .../Scripts/nvr_account_events.js).
      const confirmedScriptFile = task.workflowSetup?.scriptPath;
      const scriptFileIsConfirmed =
        !!confirmedScriptFile &&
        /\.(js|ts)$/i.test(confirmedScriptFile);
      const isCreateWorkflow = task.workflowSetup?.workIntent === 'create';
      if (isCreateWorkflow && !scriptFileIsConfirmed) {
        setAiError('Confirm target script file first — open Confirm Setup to choose the file name.');
        return;
      }
      setAiLoading('draft');
      setAiError(null);
      try {
        const analysis = analyzeScriptTask(draftTask, customer ?? null);
        const plan_ = await buildScriptPlan(
          analysis,
          effectiveScriptFolder,
          () => tauriApi.listDirectoryFiles(effectiveScriptFolder, 'js'),
          (path: string) => tauriApi.readFileContent(path),
          // For Create workflows pass the confirmed file path so generation targets it.
          scriptFileIsConfirmed ? confirmedScriptFile : undefined,
        );
        const skeleton = generateSkeleton(analysis, plan_);
        const preview = await buildScriptPreview(
          analysis, plan_, skeleton,
          (path: string) => tauriApi.readFileContent(path),
        );
        // Store as SkeletonPreview for the modal, and keep full target path for Apply.
        setSkeletonPreview({ fileName: preview.targetFileName, content: preview.newContent, targetPath: '' });
        setScriptDraftPath(preview.targetFile);
        setShowSkeleton(true);
        await updateTask(task.id, {
          crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterDraftRegenerated(task),
        });
        if (fixProposalDraftContextApplied) {
          setFeedback('Draft preview generated using the local PR fix proposal as additional context. Review the diff before approval.');
        }
        // Status is not changed by generation; Start Development is explicit.
      } catch (e) {
        setAiError(String(e));
      } finally {
        setAiLoading(null);
      }
    }
  }

  /**
   * Completes the script draft apply workflow after the .js file has been written.
   * Persists the artifact path only. State changes and IDE opening stay explicit.
   */
  async function completeScriptDraft(writtenFilePath: string) {
    const now  = new Date().toISOString();
    const note = `[${now}] UI: script-draft-generated`;
    const existing = task.notes ?? '';
    await updateTask(task.id, {
      workflowSetup: {
        ...task.workflowSetup,
        scriptPath:  writtenFilePath,
        artifactPath: writtenFilePath,
      },
      crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterDraftRegenerated(task),
      notes: existing ? `${existing}\n${note}` : note,
    });
    setSkeletonPreview(null);
    setShowSkeleton(false);
    setScriptDraftPath(null);
    setFeedback('Script draft saved. Use Start Development or Open Work when ready.');
  }

  function handleApplyDraft() {
    if (!skeletonPreview) {
      setFeedback('Generate a draft first before applying.');
      return;
    }
    setShowSkeleton(true);
    setFeedback('Review the target path in the preview, then choose Save to File.');
  }

  /**
   * Completes the plugin draft apply workflow after the .cs file has been written.
   * Persists the artifact path and refreshes the dev panel. State changes and
   * opening Visual Studio remain explicit user actions.
   */
  async function completePluginDraft(projectName: string, writtenFilePath: string) {
    // Persist everything in one atomic update so React closures are never stale.
    await updateTask(task.id, {
      selectedPluginProject: projectName,
      workflowSetup: {
        ...task.workflowSetup,
        devTargetKind:        'plugin',
        pluginProject:        projectName,
        desiredPluginProject: undefined,
        artifactPath:         writtenFilePath,
      },
      crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterDraftRegenerated(task),
    });
    // Close the skeleton modal and clear preview state.
    setSkeletonPreview(null);
    setShowSkeleton(false);
    // Refresh the dev panel so the dropdown picks up the project.
    setDevPanelRefreshTick((t) => t + 1);
    setFeedback(`Plugin draft saved: ${projectName}. Use Open Plugin when ready.`);
  }

  // --- Workflow status actions ---

  async function handleMarkDone() {
    await handleStatusChange('done');
    setFeedback('Task marked as Done');
  }

  /**
   * Resolves the best VS Code workspace root for a script task.
   * The workspace root is the repo or CRM folder — not the script file itself.
   * Priority:
   *   1. customer.resolvedRepositoryPath
   *   2. customer.repositoryRoot
   *   3. crmFolderPath (settings.crmBaseDirectory + customer.folderName)
   *   4. Parent of CRM_Code folder (if script lives inside .../CRM_Code/...)
   *   5. Parent folder of the script file itself
   */
  /** Opens the Implementation Verification modal (Development stage primary action for plugins). */
  function handleVerifyImplementation() {
    setShowImplVerifyModal(true);
    // Kick off artifact path resolution as soon as the modal opens so the modal shows
    // the correct path without the user having to run a check first.
    // For script tasks, fall back to scriptPath when artifactPath is not set.
    const explicit = task.workflowSetup?.artifactPath ?? task.workflowSetup?.scriptPath;
    if (explicit) {
      setModalArtifactPath(explicit);
      setModalArtifactInferred(false);
    } else {
      // inferArtifactPath is async — call it and update state when done.
      inferArtifactPath().then((path) => {
        if (path) {
          setModalArtifactPath(path);
          setModalArtifactInferred(true);
          // Persist so subsequent actions find it without repeating inference.
          updateTask(task.id, {
            workflowSetup: { ...task.workflowSetup, artifactPath: path },
          }).catch(() => {});
        } else {
          setModalArtifactPath(null);
          setModalArtifactInferred(false);
        }
      }).catch(() => {});
    }
  }

  /** Opens the Start Development modal instead of immediately moving the task. */
  function handleStartDevelopment() {
    setShowStartDevModal(true);
  }

  /** Called when the user explicitly confirms "Start Development" inside the modal. */
  async function handleStartDevelopmentConfirmed() {
    const note = 'Development started from Start Development modal.';
    const existing = task.notes?.trim() ?? '';
    const combinedNotes = existing
      ? `${existing}\n[${new Date().toISOString()}] ${note}`
      : `[${new Date().toISOString()}] ${note}`;
    await updateTask(task.id, {
      status:       'in-progress',
      waitingState: null,
      attentionState: null,
      notes:        combinedNotes,
    });
    setShowStartDevModal(false);
    setFeedback('Development started');
  }

  /**
   * Guided draft generation used by the Start Development modal for plugin tasks.
   * Bypasses the plan-approval readiness check; auto-generates a draft technical plan if missing.
   * postAction = 'save-draft-open': after the user confirms save in SkeletonPreviewModal,
   *   opens VS, marks task in-progress, appends note, and sets next step.
   */
  async function handleGenerateDraftStartDev(postAction: 'none' | 'save-draft-open'): Promise<void> {
    if (devTarget.kind !== 'plugin') {
      throw new Error('Guided draft generation is only supported for plugin tasks.');
    }
    if (selectedPluginProject && pluginsDir) {
      const projectPath = `${pluginsDir}/${selectedPluginProject}`;
      const exists = await tauriApi.checkPathExists(projectPath).catch(() => false);
      if (!exists) {
        await handlePluginProjectMissing(selectedPluginProject);
        throw new Error(`Plugin project '${selectedPluginProject}' no longer exists. Create it first.`);
      }
    }
    setAiLoading('draft');
    setAiError(null);
    try {
      const now = new Date().toISOString();
      const hasPlan = !!task.crmDeveloperWorkflow?.technicalPlan;
      const plan = hasPlan ? undefined : buildCrmTechnicalImplementationPlan(task, now);
      const preview = await tauriApi.generateSkeletonPreview(task, customer ?? null);
      setSkeletonPreview(preview);
      setSkeletonUsedAutoGeneratedPlan(plan !== undefined); // warn when plan was auto-generated in this run
      setShowSkeleton(true);
      const workflowState = plan
        ? buildCrmDeveloperWorkflowStateAfterPlanAndDraft(task, plan, now)
        : buildCrmDeveloperWorkflowStateAfterDraftRegenerated(task, now);
      await updateTask(task.id, { crmDeveloperWorkflow: workflowState });
      if (postAction === 'save-draft-open') {
        setPendingPostSaveAction('save-draft-open');
      }
    } catch (e) {
      setAiError(String(e));
      throw e;
    } finally {
      setAiLoading(null);
    }
  }

  /** Opens the selected plugin project in Visual Studio — used by StartDevelopmentModal. */
  async function handleOpenPluginForModal() {
    if (!pluginsDir || !selectedPluginProject) {
      throw new Error('No plugin project selected.');
    }
    const target = await tauriApi.resolveSelectedPluginOpenTarget(pluginsDir, selectedPluginProject);
    if (!target) {
      throw new Error(`Plugin project '${selectedPluginProject}' not found.`);
    }
    await tauriApi.openWithShell(target.path);
  }

  /** Updates task.implementationVerification and persists it. */
  async function handleUpdateImplVerification(iv: ImplementationVerification) {
    await updateTask(task.id, { implementationVerification: iv });
  }

  /** Full reset of Dataverse Metadata Check: clears reports, override state, and appends activity note. */
  async function handleResetDvCheck(): Promise<void> {
    const now = new Date().toISOString();
    await updateTask(task.id, {
      crmVerificationReports: [],
      implementationVerification: {
        ...task.implementationVerification,
        dataverseCheck: { status: 'not-run' },
        updatedAt: now,
      },
      notes: appendActivityNote(task.notes, 'UI: dataverse-metadata-check-reset'),
    });
  }

  /** Resets AI Internal Code Review to not-run. Keeps aiFileReviews history intact. */
  async function handleResetAiReview(): Promise<void> {
    const now = new Date().toISOString();
    await updateTask(task.id, {
      implementationVerification: {
        ...task.implementationVerification,
        aiCodeReview: { status: 'not-run' },
        updatedAt: now,
      },
      notes: appendActivityNote(task.notes, 'UI: ai-code-review-reset'),
    });
  }

  /** Marks the task as awaiting consultant testing (status stays in-progress). */
  async function handleMarkWaitingForConsultantTesting() {
    await updateTask(task.id, { waitingState: 'consultant-testing', attentionState: null });
    setShowImplVerifyModal(false);
    setFeedback('Moved to consultant testing');
  }

  /**
   * Gated version of handleMarkWaitingForConsultantTesting.
   * When AI Kit is configured and the latest review is missing, WARN, or FAIL,
   * shows a warning before proceeding.
   */
  async function handleContinueToTestingWithGate() {
    if (aiKitWorkflowState.isConfigured) {
      const v = aiKitWorkflowState.latestReviewVerdict;
      const noReview = !aiKitWorkflowState.latestReviewIsAiKit && aiKitWorkflowState.hasImplementationActivity;
      const severity =
        v === 'needs_changes' ? 'fail' :
        v === 'comment'       ? 'warn' :
        noReview              ? 'no-review' :
        null;
      if (severity) {
        setAiKitTestingGate({ severity, onConfirm: handleMarkWaitingForConsultantTesting });
        return;
      }
    }
    await handleMarkWaitingForConsultantTesting();
  }

  // --- Testing phase actions (from Testing step click) ---

  /** Moves the task back to active development from consultant testing. */
  async function handleTestingBackToDev() {
    const now = new Date().toISOString();
    await updateTask(task.id, {
      waitingState: null,
      attentionState: null,
      mcpNextStep: { action: 'Continue development', reason: 'Moved back to development from consultant testing.', updatedAt: now },
      notes: appendActivityNote(task.notes, 'UI: moved-back-to-development'),
    });
    setShowTestingActionsModal(false);
    setFeedback('Moved back to development.');
  }

  /** Records that consultant testing failed; returns to development for fixes. */
  async function handleTestingFailed() {
    const now = new Date().toISOString();
    await updateTask(task.id, {
      waitingState: null,
      attentionState: null,
      consultantTestRecord: { status: 'failed', updatedAt: now, note: 'Consultant testing failed.' },
      mcpNextStep: { action: 'Fix consultant testing findings', reason: 'Consultant testing failed or returned issues.', updatedAt: now },
      notes: appendActivityNote(task.notes, 'UI: consultant-testing-failed'),
    });
    setShowTestingActionsModal(false);
    setFeedback('Consultant testing failed — back to development.');
  }

  /**
   * Primary guided action: marks consultant testing confirmed, then opens the Git commit modal.
   * Does NOT move to Review yet — that happens only after a successful Commit + Push.
   *
   * If no Git repo is configured, the task is still marked confirmed (back in development)
   * and the user receives feedback asking to configure the repository first.
   */
  async function handleTestingConfirmedPreparePR() {
    const now = new Date().toISOString();
    if (!repoRootForGit) {
      await updateTask(task.id, {
        waitingState: null,
        attentionState: null,
        consultantTestRecord: { status: 'confirmed', updatedAt: now, note: 'Consultant testing confirmed.' },
        mcpNextStep: {
          action: 'Configure repository and prepare commit',
          reason: 'Consultant testing was confirmed, but Git repository was not detected. Configure repository before moving to Code Review.',
          updatedAt: now,
        },
        notes: appendActivityNote(task.notes, 'UI: consultant-testing-confirmed'),
      });
      setShowTestingActionsModal(false);
      setFeedback('Consultant testing confirmed, but Git repository was not detected. Configure repository before moving to Code Review.');
      return;
    }
    // Mark testing confirmed — stays in-progress, NOT moved to Review yet.
    await updateTask(task.id, {
      waitingState: null,
      attentionState: null,
      consultantTestRecord: { status: 'confirmed', updatedAt: now, note: 'Consultant testing confirmed.' },
      mcpNextStep: {
        action: 'Prepare commit and push',
        reason: 'Consultant testing was confirmed. Commit and push are required before code review.',
        updatedAt: now,
      },
      notes: appendActivityNote(task.notes, 'UI: consultant-testing-confirmed'),
    });
    setShowTestingActionsModal(false);
    setGitCommitGuidedMode(true);
    setShowGitCommitModal(true);
  }

  /**
   * Guided mode post-action: called by GitCommitModal after a successful Commit + Push.
   * Moves the task to Review / Waiting for code review and opens Azure DevOps.
   * Receives the pre-built commit note so both notes can be appended in a single updateTask call.
   */
  async function handleGitCommitMoveToReview(
    commitNote: string,
    _hash: string | undefined,
    _branch: string | undefined,
  ) {
    const now = new Date().toISOString();
    const notesWithCommit = appendActivityNote(task.notes, commitNote);
    const notesWithBoth   = appendActivityNote(notesWithCommit, 'UI: testing-confirmed-commit-pushed-moved-to-review');
    await updateTask(task.id, {
      status:         'ready-for-review',
      waitingState:   'code-review',
      attentionState: null,
      mcpNextStep: {
        action:    'Wait for code review',
        reason:    'Changes were committed and pushed. Task moved to code review.',
        updatedAt: now,
      },
      notes: notesWithBoth,
    });
    setShowGitCommitModal(false);
    setGitCommitGuidedMode(false);

    const resolution = buildAzureDevOpsRepoUrl(task, customer ?? null);
    if (resolution?.kind === 'repo') {
      tauriApi.openExternalUrl(resolution.url).then(() => {
        setFeedback('Committed and pushed — task moved to Code Review. Repository opened.');
      }).catch(() => {
        setFeedback('Committed and pushed — task moved to Code Review. Could not open repository.');
      });
    } else if (resolution?.kind === 'work-item') {
      tauriApi.openExternalUrl(resolution.url).then(() => {
        setFeedback('Committed and pushed — task moved to Code Review. Work item opened.');
      }).catch(() => {
        setFeedback('Committed and pushed — task moved to Code Review.');
      });
    } else {
      setFeedback('Committed and pushed — task moved to Code Review. No Azure DevOps URL configured.');
    }
  }

  /**
   * Guided mode post-action: called by GitCommitModal after a commit-only (no push).
   * Stays in Development, updates next step to prompt a push before moving to Review.
   */
  async function handleGitCommitOnlyGuided(commitNote: string, hash: string | undefined) {
    const now = new Date().toISOString();
    await updateTask(task.id, {
      mcpNextStep: {
        action:    'Push branch before moving to Code Review',
        reason:    'Commit created. Push the branch to proceed to code review.',
        updatedAt: now,
      },
      notes: appendActivityNote(task.notes, commitNote),
    });
    setFeedback(`Commit created (${hash ?? '?'}). Push the branch before moving to Code Review.`);
  }

  /**
   * Guided mode post-action: called by GitCommitModal after a push-only operation.
   * Moves the task to Code Review / Waiting for code review and opens Azure DevOps.
   */
  async function handleGitPushOnlyMoveToReview(pushNote: string, branch: string | undefined) {
    const now = new Date().toISOString();
    await updateTask(task.id, {
      status:         'ready-for-review',
      waitingState:   'code-review',
      attentionState: null,
      mcpNextStep: {
        action:    'Wait for code review',
        reason:    'Branch pushed. Task moved to code review.',
        updatedAt: now,
      },
      notes: appendActivityNote(task.notes, pushNote),
    });
    setShowGitCommitModal(false);
    setGitCommitGuidedMode(false);

    const resolution = buildAzureDevOpsRepoUrl(task, customer ?? null);
    if (resolution?.kind === 'repo') {
      tauriApi.openExternalUrl(resolution.url).then(() => {
        setFeedback(`Branch ${branch ?? '?'} pushed — task moved to Code Review. Repository opened.`);
      }).catch(() => {
        setFeedback(`Branch ${branch ?? '?'} pushed — task moved to Code Review. Could not open repository.`);
      });
    } else if (resolution?.kind === 'work-item') {
      tauriApi.openExternalUrl(resolution.url).then(() => {
        setFeedback(`Branch ${branch ?? '?'} pushed — task moved to Code Review. Work item opened.`);
      }).catch(() => {
        setFeedback(`Branch ${branch ?? '?'} pushed — task moved to Code Review.`);
      });
    } else {
      setFeedback(`Branch ${branch ?? '?'} pushed — task moved to Code Review. No Azure DevOps URL configured.`);
    }
  }

  /**
   * Tries to find a single candidate .cs implementation file in the plugin project folder
   * when `task.workflowSetup.artifactPath` is not set (e.g. existing tasks).
   *
   * Returns the absolute path if exactly one candidate is found, or null otherwise.
   * Excludes Properties/AssemblyInfo.cs (in a subdirectory — listDirectoryFiles is
   * shallow, so AssemblyInfo.cs won't appear unless it is in the project root itself).
   */
  async function inferArtifactPath(): Promise<string | null> {
    if (!pluginsDir || !selectedPluginProject) return null;
    // Standard layout: pluginsDir/ProjectName/ProjectName/<ProjectPlugin>.cs
    const projectFolder = `${pluginsDir.replace(/\\/g, '/')}/${selectedPluginProject}/${selectedPluginProject}`;
    try {
      const csFiles = await tauriApi.listDirectoryFiles(projectFolder, 'cs');
      const candidates = csFiles.filter((name) => {
        const lower = name.toLowerCase();
        // Exclude AssemblyInfo.cs (in Properties/ but listDirectoryFiles is shallow)
        // and any obviously generated or property file.
        return !lower.includes('assemblyinfo');
      });
      if (candidates.length === 1) {
        return `${projectFolder}/${candidates[0]}`;
      }
      return null;  // 0 files › nothing to infer; >1 › ambiguous
    } catch {
      return null;
    }
  }

  /** Appends a timestamped git activity note to the task when a commit or push completes. */
  async function handleGitActivityNote(note: string) {
    await updateTask(task.id, { notes: appendActivityNote(task.notes, note) });
  }

  /**
   * Returns `task.workflowSetup.artifactPath` if set, otherwise tries to infer it.
   * When a unique candidate is inferred, auto-persists it to the task so subsequent
   * actions find it without re-running inference.
   */
  async function resolveArtifactPath(): Promise<string | null> {
    // For script tasks, fall back to scriptPath when artifactPath is not set.
    const explicit = task.workflowSetup?.artifactPath ?? task.workflowSetup?.scriptPath;
    if (explicit) return explicit;
    const inferred = await inferArtifactPath();
    if (inferred) {
      await updateTask(task.id, {
        workflowSetup: { ...task.workflowSetup, artifactPath: inferred },
      }).catch(() => {});
    }
    return inferred;
  }

  /**
   * Runs Dataverse metadata verification inline (no Primarch progress modal).
   * Stores the report to task.crmVerificationReports and derives status for the modal.
   */
  async function handleRunDataverseCheckForImpl(): Promise<void> {
    const filePath = (await resolveArtifactPath())
      ?? task.workflowSetup?.scriptPath
      ?? '';
    if (!filePath) {
      setFeedback('No artifact file path found. Save a generated draft first or confirm the plugin setup.');
      return;
    }

    // Preflight: do not call Primarch/Dataverse if CRM metadata assistant is not configured.
    const isCrmConfigured = !!settings?.crmMetadataEnabled
      && !!(settings?.primarchMcpCommand ?? '').trim()
      && !!(settings?.primarchMcpArgs ?? '').trim();
    if (!isCrmConfigured) {
      const now = new Date().toISOString();
      const notConfiguredReport: CrmVerificationReport = {
        id: `dv-not-configured-${Date.now()}`,
        createdAt: now,
        filePath,
        verdict: 'warnings',
        metadataVerdict: 'unknown',
        staticInferenceConfidence: 'unknown',
        runtimeReadiness: 'unknown',
        summary: 'Dataverse metadata assistant is not configured.',
        answer: 'Open Settings → CRM Metadata and configure Primarch MCP command/args.',
        issues: [],
        confirmedReferences: [],
        missingReferences: [],
        ambiguousReferences: [],
        runtimeRisks: [],
        pluginChecks: [],
        inspectedEntities: [],
        inspectedAttributesByEntity: {},
        unableToVerifyReasons: [
          'CRM metadata assistant is not configured. Enable CRM Metadata in Settings and set Primarch MCP command/args.',
        ],
        metadataInspected: { entityLogicalNames: [], attributeLogicalNames: {}, toolsUsed: [] },
      };
      const existing = task.crmVerificationReports ?? [];
      await updateTask(task.id, {
        crmVerificationReports: [notConfiguredReport, ...existing].slice(0, 5),
      });
      setFeedback('Dataverse metadata assistant is not configured. Configure Settings → CRM Metadata / Primarch MCP.');
      return;
    }

    setImplVerifyDvRunning(true);
    try {
      const override = (
        task.workflowSetup?.primaryEntityLogicalName
        ?? task.scriptAnalysis?.entityLogicalName
        ?? primarchPrimaryEntityOverride
        ?? ''
      ) || undefined;

      let localScan: CrmReferenceScanResult;
      if (filePath.toLowerCase().endsWith('.cs')) {
        // Use Rust scanner for C# — same backend path as MCP run_dataverse_check_for_task.
        const rustScan = await tauriApi.scanCsFileForCrm(filePath, override ?? null);
        localScan = rustScan as CrmReferenceScanResult;
        console.debug('[DV check] artifactPath:', filePath);
        console.debug('[DV check] primaryEntity:', (rustScan as { pluginContext?: { primaryEntityName?: string } }).pluginContext?.primaryEntityName);
        console.debug('[DV check] entities extracted:', rustScan.entities);
        console.debug('[DV check] attributes by entity:', rustScan.attributes);
        console.debug('[DV check] raw scan (full):', rustScan);
      } else {
        const content = await tauriApi.readFileContent(filePath);
        localScan = scanJavaScriptCrmReferences(content, undefined, filePath);
        console.debug('[DV check] artifactPath:', filePath);
        console.debug('[DV check] JS scan entities:', localScan.entities);
      }

      console.debug('[DV check] payload to verifyAgainstCrm:', localScan);
      const report = await tauriApi.verifyAgainstCrm(task, customer ?? null, localScan, filePath, override);
      console.debug('[DV check] verdict:', report.verdict);
      console.debug('[DV check] confirmed:', report.confirmedReferences);
      console.debug('[DV check] missing:', report.missingReferences);
      console.debug('[DV check] ambiguous:', report.ambiguousReferences);

      const now     = new Date().toISOString();
      const enriched = {
        ...report,
        id:        report.id ?? String(Date.now()),
        createdAt: report.createdAt ?? now,
        filePath,
        summary:   report.summary || summarizeVerifications(report.issues ?? [], report.verdict),
        answer:    report.answer ?? report.summary,
        rawExtractedReferences: localScan,
      };
      const existing = task.crmVerificationReports ?? [];
      const updated  = [enriched, ...existing].slice(0, 5);
      await updateTask(task.id, {
        crmVerificationReports: updated,
        ...(isMeaningfulCrmVerificationReport(enriched)
          ? { crmDeveloperWorkflow: buildCrmDeveloperWorkflowStateAfterMetadataVerification(task, enriched) }
          : {}),
      });
      setFeedback(`Dataverse check: ${formatCrmVerdict(report.verdict)}.`);
    } catch (e) {
      setFeedback(`Dataverse check failed: ${String(e)}`);
    } finally {
      setImplVerifyDvRunning(false);
    }
  }

  /**
   * Runs the build / project readiness check and saves the result to
   * task.implementationVerification.buildCheck.
   */
  async function handleRunBuildCheckForImpl(): Promise<void> {
    const targetKind = task.workflowSetup?.devTargetKind ?? 'plugin';

    if (targetKind === 'script') {
      const artifactPath = await resolveArtifactPath();
      if (!artifactPath) {
        setFeedback('No script file path found. Save a generated draft first.');
        return;
      }
      setImplVerifyBuildRunning(true);
      try {
        const content = await tauriApi.readFileContent(artifactPath);
        const lineCount = content.split('\n').length;
        const fileName = artifactPath.replace(/\\/g, '/').split('/').pop() ?? artifactPath;
        const now = new Date().toISOString();
        await updateTask(task.id, {
          implementationVerification: {
            ...task.implementationVerification,
            buildCheck: {
              status: 'passed',
              runAt: now,
              summary: `Script file found: ${fileName} (${lineCount} lines).`,
              findings: [
                `pass|Script file exists|${fileName}`,
                `pass|File readable|${lineCount} lines`,
              ],
            },
            updatedAt: now,
          },
        });
        setFeedback('Script file check: passed.');
      } catch (e) {
        setFeedback(`Script file check failed: ${String(e)}`);
        const now = new Date().toISOString();
        await updateTask(task.id, {
          implementationVerification: {
            ...task.implementationVerification,
            buildCheck: { status: 'failed', runAt: now, summary: `File check failed: ${String(e)}` },
            updatedAt: now,
          },
        }).catch(() => {});
      } finally {
        setImplVerifyBuildRunning(false);
      }
      return;
    }

    if (!pluginsDir || !selectedPluginProject) {
      setFeedback('No plugin project selected.');
      return;
    }
    const solutionDir   = `${pluginsDir}/${selectedPluginProject}`;
    const artifactPath  = await resolveArtifactPath();
    setImplVerifyBuildRunning(true);
    try {
      const result = await tauriApi.checkPluginBuildReadiness(solutionDir, artifactPath ?? undefined);
      // Encode each BuildCheckItem as a pipe-delimited string so it fits in ImplCheckRecord.findings.
      const findings = result.checks.map((c) => `${c.result}|${c.label}|${c.detail}`);
      const now = new Date().toISOString();
      await updateTask(task.id, {
        implementationVerification: {
          ...task.implementationVerification,
          buildCheck: {
            status:   result.status === 'passed' ? 'passed' : result.status === 'warnings' ? 'warnings' : 'failed',
            runAt:    now,
            summary:  result.summary,
            findings,
          },
          updatedAt: now,
        },
      });
      setFeedback(`Build check: ${result.status}.`);
    } catch (e) {
      setFeedback(`Build check failed: ${String(e)}`);
      const now = new Date().toISOString();
      await updateTask(task.id, {
        implementationVerification: {
          ...task.implementationVerification,
          buildCheck: { status: 'failed', runAt: now, summary: `Check failed: ${String(e)}` },
          updatedAt: now,
        },
      }).catch(() => {});
    } finally {
      setImplVerifyBuildRunning(false);
    }
  }

  /** Shared: resolves git/file review contexts for both AI review buttons. */
  async function resolveImplReviewContexts(artifactPath: string | null) {
    const repoCandidates = [
      task.workflowSetup?.repositoryRoot,
      customer?.resolvedRepositoryPath,
      customer?.repositoryRoot,
      pluginsDir,
    ].filter((p): p is string => !!p);

    let repoRootForArtifact: string | undefined;
    if (artifactPath) {
      for (const candidate of repoCandidates) {
        const hasGit = await tauriApi.checkPathExists(
          `${candidate.replace(/[\\/]+$/, '')}/.git`
        ).catch(() => false);
        if (hasGit) { repoRootForArtifact = candidate; break; }
      }
      if (!repoRootForArtifact) {
        const norm  = artifactPath.replace(/\\/g, '/');
        const parts = norm.split('/');
        for (let i = parts.length - 1; i > 0; i--) {
          const candidate = parts.slice(0, i).join('/');
          if (!candidate) break;
          const hasGit = await tauriApi.checkPathExists(`${candidate}/.git`).catch(() => false);
          if (hasGit) { repoRootForArtifact = candidate; break; }
        }
      }
    }

    let fileGitCtx: tauriApi.GitFileReviewContext | null = null;
    if (artifactPath && repoRootForArtifact) {
      try {
        fileGitCtx = await tauriApi.collectGitFileReviewContext(repoRootForArtifact, artifactPath);
      } catch { /* not a git repo or command failed */ }
    }

    let fileContent: string | null = null;
    if (artifactPath && !fileGitCtx?.diff.trim()) {
      try { fileContent = await tauriApi.readFileContent(artifactPath); } catch { /* ignore */ }
    }

    let branchGitCtx: tauriApi.GitReviewContext | null = null;
    if (!artifactPath) {
      for (const candidate of repoCandidates) {
        try {
          const ctx = await tauriApi.collectGitReviewContext(candidate);
          if (ctx.diff.trim() || (ctx.changedFiles ?? []).length > 0) {
            branchGitCtx = ctx;
            break;
          }
        } catch { /* not a git repo — try next */ }
      }
    }

    return selectImplReviewSource(artifactPath, fileGitCtx, fileContent, branchGitCtx);
  }

  /** Shared: flattens structured AI review result into a string array for findings storage. */
  function flattenImplReviewFindings(result: AiFileReviewResult): string[] {
    if (!result.structured) {
      return result.markdown ? [result.markdown.slice(0, 400)] : [];
    }
    return [
      ...(result.structured.comments ?? []).map((c) => {
        const loc       = c.lineStart ? ` (ř.${c.lineStart})` : '';
        const firstLine = (c.problem ?? '').split('\n')
          .find((l) => l.trim().startsWith('-'))?.replace(/^-\s*/, '') ?? c.problem ?? '';
        return `[${c.severity}] ${c.title}${loc}: ${firstLine}`.slice(0, 200);
      }),
      ...(result.structured.generalSuggestions ?? []).map((s) => String(s).slice(0, 200)),
    ];
  }

  /**
   * Runs AI internal code review using ONLY local read-only sources.
   *
   * Source priority:
   *   1. Local branch diff — collect_git_review_context (read-only git commands only)
   *   2. Single .cs file   — local file read via runAiFileReview
   *
   * GitHub connectors, GitHub API, PR reads/writes, and any remote write action
   * are explicitly NOT used and must never be added to this function.
   * Only task.implementationVerification.aiCodeReview is updated locally.
   */
  async function handleRunAiCodeReviewForImpl(): Promise<void> {
    setImplVerifyAiRunning(true);
    try {
      const setup    = task.workflowSetup;
      // Resolve artifact path FIRST — drives mode selection.
      const artifactPath = await resolveArtifactPath();
      const isScript = !!artifactPath && /\.[jt]s$/i.test(artifactPath);
      const techPlan = task.crmDeveloperWorkflow?.technicalPlan;
      const dvReport = task.crmVerificationReports?.[0];
      const buildChk = task.implementationVerification?.buildCheck;

      // AI Kit context (optional, falls back to built-in rules)
      let aiKitCtx: PowerPlatformAiKitContext | null = null;
      const aiKitPath = settings?.powerPlatformAiKitPath?.trim();
      if (aiKitPath) {
        try {
          const taskKind = detectAiKitTaskKind(task);
          aiKitCtx = await loadAiKitContext(aiKitPath, taskKind, true, true);
        } catch { /* AI Kit not configured or invalid */ }
      }

      // Shared context builder (used in all review modes)
      function buildInstructions(reviewMode: string, gitInfo?: string): string {
        const ctx: string[] = [];
        ctx.push('You are an expert Dynamics 365 / Power Platform CRM developer and code reviewer.');
        ctx.push(`Review mode: ${reviewMode}.`);
        ctx.push(
          'This is a READ-ONLY code review. ' +
          'You MUST NOT use, invoke, or suggest any of the following GitHub / repository write actions: ' +
          'create_branch, create_commit, create_file, update_file, delete_file, ' +
          'create_pull_request, update_pull_request, add_review_to_pr, add_comment_to_issue, ' +
          'request_pull_request_reviewers, mark_pull_request_ready_for_review, ' +
          'merge_pull_request, update_ref, or any other write action. ' +
          'Only report findings as text. Do not modify code, files, Git state, Dataverse, or any external system.',
        );
        ctx.push('Respond in Czech as required by the output format.');
        if (gitInfo) ctx.push(gitInfo);
        ctx.push('');

        ctx.push('=== ÚKOL ===');
        ctx.push(`Název: ${task.title}`);
        if (task.originalMessage) ctx.push(`Původní požadavek: ${task.originalMessage.slice(0, 600)}`);
        const analysisText = task.analysisResult?.summaryEn || task.analysisResult?.summary;
        if (analysisText) ctx.push(`Analýza: ${analysisText.slice(0, 400)}`);
        ctx.push('');

        ctx.push('=== SETUP PROJEKTU ===');
        const proj = setup?.pluginProject || selectedPluginProject;
        if (proj)                             ctx.push(`Plugin projekt (namespace): ${proj}`);
        if (setup?.primaryEntityLogicalName)  ctx.push(`Primární entita: ${setup.primaryEntityLogicalName}`);
        if (customer?.name)                   ctx.push(`Zákazník: ${customer.name}`);
        if (setup?.workIntent)                ctx.push(`Záměr práce: ${setup.workIntent}`);
        if (techPlan?.target?.message)        ctx.push(`Očekávaná zpráva (MessageName): ${techPlan.target.message}`);
        if (techPlan?.target?.stage)          ctx.push(`Fáze (Stage): ${techPlan.target.stage}`);
        if (techPlan?.target?.mode)           ctx.push(`Mód (Sync/Async): ${techPlan.target.mode}`);
        ctx.push('');

        if (techPlan) {
          ctx.push('=== TECHNICKÝ PLÁN ===');
          if (techPlan.summary) ctx.push(techPlan.summary.slice(0, 500));
          const implSteps = techPlan.implementationSteps ?? [];
          if (implSteps.length) {
            ctx.push('Kroky implementace:');
            implSteps.slice(0, 6).forEach((s) => ctx.push(`- ${s}`));
          }
          const risks = techPlan.risks ?? [];
          if (risks.length) {
            ctx.push('Rizika:');
            risks.slice(0, 3).forEach((r) => ctx.push(`- ${r}`));
          }
          ctx.push('');
        }

        if (buildChk) {
          ctx.push('=== VÝSLEDEK BUILD CHECKU ===');
          ctx.push(`Stav: ${buildChk.status}${buildChk.summary ? ` — ${buildChk.summary}` : ''}`);
          const bldIssues = (buildChk.findings ?? [])
            .map((f) => { const [r, l, d] = f.split('|'); return { r, l, d }; })
            .filter((f) => f.r && f.r !== 'pass' && f.r !== 'skip');
          if (bldIssues.length > 0) {
            ctx.push('Problémy:');
            bldIssues.slice(0, 8).forEach((f) =>
              ctx.push(`- [${f.r}] ${f.l ?? ''}${f.d ? `: ${f.d}` : ''}`)
            );
          }
          ctx.push('');
        }

        if (dvReport) {
          ctx.push('=== VÝSLEDEK DATAVERSE CHECKU ===');
          ctx.push(`Verdikt: ${dvReport.verdict}`);
          if (dvReport.summary) ctx.push(dvReport.summary.slice(0, 400));
          if (dvReport.inspectedEntities?.length) {
            ctx.push(`Ověřené entity: ${dvReport.inspectedEntities.join(', ')}`);
          }
          const missing = (dvReport.missingReferences ?? [])
            .map((r) => `${r.kind}: ${r.displayName}${r.entityLogicalName ? ` (${r.entityLogicalName})` : ''}`)
            .slice(0, 8);
          if (missing.length > 0) {
            ctx.push('Chybějící reference v Dataverse:');
            missing.forEach((m) => ctx.push(`- ${m}`));
          }
          (dvReport.issues ?? []).slice(0, 5).forEach((i) =>
            ctx.push(`- [${i.severity}] ${i.title}`)
          );
          (dvReport.pluginChecks ?? []).filter((c) => c.status !== 'confirmed').slice(0, 4).forEach((c) =>
            ctx.push(`- [${c.status}] ${c.title}: ${c.detail}`)
          );
          ctx.push('');
        }

        return ctx.join('\n');
      }

      // ── Resolve git/file contexts and select review source ───────────────
      const source = await resolveImplReviewContexts(artifactPath);

      // ── Rules strings (reused across file-diff and file-content modes) ────
      const scriptDiffRules = [
        '',
        '=== PRAVIDLA REVIEW (DIFF — JAVASCRIPT/TYPESCRIPT) ===',
        'Zkontroluj scope diffu:',
        '- Jen očekávané soubory byly změněny',
        '- Žádné nesouvisející soubory',
        '- Žádné .github/copilot-instructions.md přidány',
        '',
        'Zkontroluj script správnost:',
        '- Funkce odpovídá Dataverse WebAPI konvencím (pokud relevantní)',
        '- Logické názvy jsou konstanty nebo správně zapsané literály',
        '- Žádné hardcoded OrgUrl, credentials nebo secrety',
        '- Error handling přítomen kde je nutný',
        '- Žádné zbytečné console.log v produkčním kódu',
        '',
        'Zkontroluj business alignment:',
        '- Diff implementuje úkol a nic navíc',
        '- Chování odpovídá původnímu požadavku a technickému plánu',
      ].join('\n');

      const pluginDiffRules = [
        '',
        '=== PRAVIDLA REVIEW (DIFF) ===',
        'Zkontroluj scope diffu:',
        '- Jen očekávané soubory byly změněny',
        '- Žádné nesouvisející soubory',
        '- Žádné .github/copilot-instructions.md přidány',
        '- Žádné .vs/, bin/, obj/, packages/ soubory v commitu',
        '- Generovaný .cs soubor je zahrnut v .csproj jako Compile Include',
        '',
        'Zkontroluj plugin správnost:',
        '- IPlugin implementace, Execute metoda',
        '- Přístup k Target, MessageName/Stage/Entity assumptions',
        '- PreOperation Create: Target atributy přímo, ne service.Update(target)',
        '- Tracing, exception handling, konstanty pro logické názvy',
        '- Namespace odpovídá projektu',
        '',
        'Zkontroluj Dataverse správnost:',
        '- Logické názvy v diffu odpovídají ověřeným názvům z Dataverse checku',
        '- Žádné neověřené logické názvy',
        '',
        'Zkontroluj business alignment:',
        '- Diff implementuje úkol a nic navíc',
        '- Chování odpovídá původnímu požadavku a technickému plánu',
      ].join('\n');

      const scriptFileRules = [
        '',
        '=== PRAVIDLA REVIEW (SOUBOR — JAVASCRIPT/TYPESCRIPT) ===',
        'Zkontroluj script strukturu:',
        '1. Funkce odpovídá Dataverse WebAPI konvencím (pokud relevantní)',
        '2. Logické názvy jsou konstanty nebo správně zapsané literály',
        '3. Žádné hardcoded OrgUrl, credentials nebo secrety',
        '4. Error handling přítomen kde je nutný',
        '5. Žádné zbytečné console.log v produkčním kódu',
        '6. Implementace odpovídá popisu úkolu',
      ].join('\n');

      const pluginFileRules = [
        '',
        '=== PRAVIDLA REVIEW (SOUBOR) ===',
        'Zkontroluj plugin strukturu:',
        '1. IPlugin, Execute(IServiceProvider), ITracingService, IPluginExecutionContext, Target null check',
        '2. MessageName/PrimaryEntityName/Stage ověřeny nebo dokumentovány',
        '3. PreOperation Create: Target přímo, ne service.Update(target)',
        '4. Logické názvy = konstanty/readonly, ne inline literály',
        '5. Namespace odpovídá projektu',
        '6. Tracing, exception handling, žádné TODO-only',
        '7. Depth/recursion guard kde potřeba',
        '8. Implementace odpovídá popisu úkolu',
      ].join('\n');

      // ── Mode: file-diff — artifact has changed lines ──────────────────────
      if (source.mode === 'file-diff') {
        const fileLabel = source.fileRelPath
          ?? artifactPath!.replace(/\\/g, '/').split('/').pop()
          ?? 'file';
        const branchLabel = source.currentBranch && source.baseBranch
          ? ` (${source.currentBranch} › ${source.baseBranch})`
          : '';
        const modeLabel = `Selected file diff${branchLabel}: ${fileLabel}`;

        const gitInfo = [
          '=== GIT CONTEXT (file-specific) ===',
          source.currentBranch
            ? `Větev: ${source.currentBranch}${source.baseBranch ? ` › base: ${source.baseBranch}` : ''}`
            : '',
          `Soubor: ${fileLabel}`,
          source.hasCommitted ? 'Zahrnuje: odevzdané změny větve' : '',
          source.hasStaged    ? 'Zahrnuje: staged změny' : '',
          source.hasUnstaged  ? 'Zahrnuje: unstaged změny' : '',
        ].filter(Boolean).join('\n');

        const reviewerName = aiKitCtx
          ? (isScript ? 'Script AI Kit Review' : 'Plugin AI Kit Review')
          : (isScript ? 'Script Internal Check' : 'Plugin Internal Check');
        const aiKitPrefix = aiKitCtx ? buildAiKitDiffReviewInstructions(aiKitCtx) + '\n\n' : '';
        const instructions = aiKitPrefix
          + buildInstructions(modeLabel, gitInfo)
          + (isScript ? scriptDiffRules : pluginDiffRules);

        const result = await tauriApi.runAiChangeReview(
          source.diff!,
          task.title,
          fileLabel,
          reviewerName,
          instructions,
          '',
          0.2,
        );

        const verdict    = result.structured?.verdict;
        const implStatus = verdict === 'pass' ? 'passed' : verdict === 'needs_changes' ? 'failed' : 'warnings';

        const metaFindings: string[] = [
          `Review source: Selected file diff (${fileLabel})`,
          ...(branchLabel ? [`[info] Branch:${branchLabel}`] : []),
          ...(source.hasCommitted ? ['[info] Committed branch changes included'] : []),
          ...(source.hasStaged    ? ['[info] Staged changes included'] : []),
          ...(source.hasUnstaged  ? ['[info] Unstaged changes included'] : []),
        ];
        const findings = [...metaFindings, ...flattenImplReviewFindings(result)];

        const now = new Date().toISOString();
        const existing = task.aiFileReviews ?? [];
        const reviewEntry: AiFileReviewResult = {
          ...result,
          id:           `impl-review-${now}`,
          reviewerName,
          filePath:     source.fileRelPath ?? fileLabel,
          reviewMode:   'change',
          reviewSource: 'ai-kit',
        };
        await updateTask(task.id, {
          aiFileReviews: [reviewEntry, ...existing].slice(0, 5),
          implementationVerification: {
            ...task.implementationVerification,
            aiCodeReview: {
              status:   implStatus,
              reviewId: reviewEntry.id,
              runAt:    now,
              summary:  result.structured?.summary ?? fileLabel,
              findings,
            },
            updatedAt: now,
          },
        });
        setFeedback(`AI code review (file diff): ${implStatus}.`);

      // ── Mode: file-content — new/untracked/unchanged file ─────────────────
      } else if (source.mode === 'file-content') {
        const fileLabel = source.fileRelPath
          ?? artifactPath!.replace(/\\/g, '/').split('/').pop()
          ?? 'file';
        const modeLabel = source.isUntracked
          ? `New file review (untracked): ${fileLabel}`
          : `File content review: ${fileLabel}`;

        const reviewerName = aiKitCtx
          ? (isScript ? 'Script AI Kit Review' : 'Plugin AI Kit Review')
          : (isScript ? 'Script Internal Check' : 'Plugin Internal Check');
        const aiKitPrefix = aiKitCtx ? buildAiKitDiffReviewInstructions(aiKitCtx) + '\n\n' : '';
        const instructions = aiKitPrefix
          + buildInstructions(modeLabel)
          + (isScript ? scriptFileRules : pluginFileRules);

        const result = await tauriApi.runAiFileReview(
          artifactPath!,
          reviewerName,
          instructions,
          '',
          0.2,
        );

        const verdict    = result.structured?.verdict;
        const implStatus = verdict === 'pass' ? 'passed' : verdict === 'needs_changes' ? 'failed' : 'warnings';

        const sourceLabel = source.isUntracked
          ? `Selected file content (new/untracked): ${fileLabel}`
          : `Selected file content: ${fileLabel}`;
        const metaFindings = [`Review source: ${sourceLabel}`];
        const findings = [...metaFindings, ...flattenImplReviewFindings(result)];

        const now = new Date().toISOString();
        const existing = task.aiFileReviews ?? [];
        const reviewEntry: AiFileReviewResult = {
          ...result,
          id:           `impl-review-${now}`,
          reviewerName,
          filePath:     source.fileRelPath ?? fileLabel,
          reviewMode:   'file',
          reviewSource: 'ai-kit',
        };
        await updateTask(task.id, {
          aiFileReviews: [reviewEntry, ...existing].slice(0, 5),
          implementationVerification: {
            ...task.implementationVerification,
            aiCodeReview: {
              status:   implStatus,
              reviewId: reviewEntry.id,
              runAt:    now,
              summary:  result.structured?.summary ?? '',
              findings,
            },
            updatedAt: now,
          },
        });
        setFeedback(`AI code review (file): ${implStatus}.`);

      // ── Mode: branch-diff — no artifact, fallback to whole branch ─────────
      } else if (source.mode === 'branch-diff') {
        const bCtx = source.branchContext!;
        const branchFrom = bCtx.currentBranch || 'unknown';
        const branchTo   = bCtx.baseBranch    || 'unknown';
        const modeLabel  = `Branch diff (no selected artifact): ${branchFrom} › ${branchTo}`;
        const _changedFiles  = bCtx.changedFiles    ?? [];
        const _noiseFiles    = bCtx.noiseFiles      ?? [];
        const _flaggedPaths  = bCtx.flaggedPaths    ?? [];
        const _untrackedIncl = bCtx.untrackedIncluded ?? [];
        const _untrackedSkip = bCtx.untrackedSkipped  ?? [];

        const gitInfo = [
          '=== GIT CONTEXT (full branch) ===',
          `Větev: ${branchFrom} › base: ${branchTo}`,
          `Změněné soubory (${_changedFiles.length}): ${_changedFiles.slice(0, 10).join(', ')}`,
          bCtx.hasCommitted  ? 'Zahrnuje: odevzdané změny větve' : '',
          bCtx.hasStaged     ? 'Zahrnuje: staged změny' : '',
          bCtx.hasUnstaged   ? 'Zahrnuje: unstaged změny' : '',
          _noiseFiles.length > 0    ? `POZOR — noise soubory v diff: ${_noiseFiles.slice(0, 5).join(', ')}` : '',
          _flaggedPaths.length > 0  ? `UPOZORNĚNÍ — přidány podezřelé soubory: ${_flaggedPaths.join(', ')}` : '',
        ].filter(Boolean).join('\n');

        const reviewerName = aiKitCtx
          ? (isScript ? 'Script AI Kit Review' : 'Plugin AI Kit Review')
          : (isScript ? 'Script Internal Check' : 'Plugin Internal Check');
        const aiKitPrefix = aiKitCtx ? buildAiKitDiffReviewInstructions(aiKitCtx) + '\n\n' : '';
        const instructions = aiKitPrefix
          + buildInstructions(modeLabel, gitInfo)
          + (isScript ? scriptDiffRules : pluginDiffRules);
        const fileName = `local changes (${branchFrom} › ${branchTo})`;

        const result = await tauriApi.runAiChangeReview(
          bCtx.diff,
          `${task.title}. ${bCtx.summary}`,
          fileName,
          reviewerName,
          instructions,
          '',
          0.2,
        );

        const verdict    = result.structured?.verdict;
        const implStatus = verdict === 'pass' ? 'passed' : verdict === 'needs_changes' ? 'failed' : 'warnings';

        const metaFindings: string[] = [
          `Review source: Branch diff (${branchFrom} › ${branchTo})`,
          `[info] Changed files (${_changedFiles.length}): ${_changedFiles.slice(0, 6).join(', ')}${_changedFiles.length > 6 ? '…' : ''}`,
          ...(bCtx.hasStaged    ? ['[info] Staged changes included'] : []),
          ...(bCtx.hasUnstaged  ? ['[info] Unstaged changes included'] : []),
          ...(_untrackedIncl.length > 0 ? [`[info] Untracked files included (${_untrackedIncl.length}): ${_untrackedIncl.join(', ')}`] : []),
          ...(_untrackedSkip.length > 0 ? [`[info] Untracked files skipped: ${_untrackedSkip.slice(0, 3).join(', ')}`] : []),
          ...(_noiseFiles.length   > 0  ? [`[warning] Noise files in diff: ${_noiseFiles.slice(0, 3).join(', ')}`] : []),
          ...(_flaggedPaths.length > 0  ? [`[warning] Flagged paths added: ${_flaggedPaths.join(', ')}`] : []),
        ];
        const findings = [...metaFindings, ...flattenImplReviewFindings(result)];

        const now = new Date().toISOString();
        const existing = task.aiFileReviews ?? [];
        const reviewEntry: AiFileReviewResult = {
          ...result,
          id:           `impl-review-${now}`,
          reviewerName,
          filePath:     fileName,
          reviewMode:   'change',
          reviewSource: 'ai-kit',
        };
        await updateTask(task.id, {
          aiFileReviews: [reviewEntry, ...existing].slice(0, 5),
          implementationVerification: {
            ...task.implementationVerification,
            aiCodeReview: {
              status:   implStatus,
              reviewId: reviewEntry.id,
              runAt:    now,
              summary:  result.structured?.summary ?? bCtx.summary,
              findings,
            },
            updatedAt: now,
          },
        });
        setFeedback(`AI code review (branch diff): ${implStatus}.`);

      } else {
        setFeedback('No artifact file and no git repository found. Save a draft or configure the artifact path first.');
      }
    } catch (e) {
      setFeedback(`AI code review failed: ${String(e)}`);
      const now = new Date().toISOString();
      await updateTask(task.id, {
        implementationVerification: {
          ...task.implementationVerification,
          aiCodeReview: { status: 'failed', runAt: now, summary: `Review failed: ${String(e)}` },
          updatedAt: now,
        },
      }).catch(() => {});
    } finally {
      setImplVerifyAiRunning(false);
    }
  }

  /**
   * Runs Implementation Verification AI review using the configured Settings reviewer profile.
   * Does NOT load AI Kit context. Uses reviewer.instructions, model, temperature from Settings.
   */
  async function handleRunSettingsReviewerForImpl(): Promise<void> {
    setImplVerifyAiRunning(true);
    try {
      const artifactPath = await resolveArtifactPath();
      const isScript     = !!artifactPath && /\.[jt]s$/i.test(artifactPath);
      const devMode: 'plugin' | 'script' = isScript ? 'script' : 'plugin';

      const allReviewers = mergeWithDefaults(settings?.aiReviewers);
      const reviewer     = selectReviewer(allReviewers, artifactPath ?? '', devMode);

      if (!reviewer) {
        const ext = artifactPath && artifactPath.lastIndexOf('.') >= 0
          ? artifactPath.slice(artifactPath.lastIndexOf('.'))
          : '';
        setFeedback(
          `No enabled Settings reviewer matches this file type${ext ? ` (${ext})` : ''}. Configure Settings → AI Reviewers.`
        );
        return;
      }

      const source      = await resolveImplReviewContexts(artifactPath);
      const reviewerName = reviewer.name;
      const instructions = reviewer.instructions;
      const model        = reviewer.model ?? '';
      const temperature  = reviewer.temperature ?? 0.2;

      // ── Mode: file-diff ──────────────────────────────────────────────────
      if (source.mode === 'file-diff') {
        const fileLabel = source.fileRelPath
          ?? artifactPath!.replace(/\\/g, '/').split('/').pop()
          ?? 'file';

        const result = await tauriApi.runAiChangeReview(
          source.diff!,
          task.title,
          fileLabel,
          reviewerName,
          instructions,
          model,
          temperature,
        );

        const verdict    = result.structured?.verdict;
        const implStatus = verdict === 'pass' ? 'passed' : verdict === 'needs_changes' ? 'failed' : 'warnings';

        const branchLabel = source.currentBranch && source.baseBranch
          ? ` (${source.currentBranch} › ${source.baseBranch})` : '';
        const metaFindings: string[] = [
          `Review source: Selected file diff (${fileLabel})`,
          ...(branchLabel ? [`[info] Branch:${branchLabel}`] : []),
          ...(source.hasCommitted ? ['[info] Committed branch changes included'] : []),
          ...(source.hasStaged    ? ['[info] Staged changes included'] : []),
          ...(source.hasUnstaged  ? ['[info] Unstaged changes included'] : []),
        ];
        const findings = [...metaFindings, ...flattenImplReviewFindings(result)];

        const now = new Date().toISOString();
        const existing = task.aiFileReviews ?? [];
        const reviewEntry: AiFileReviewResult = {
          ...result,
          id:         `impl-review-${now}`,
          reviewerName,
          filePath:   source.fileRelPath ?? fileLabel,
          reviewMode: 'change',
          reviewSource: 'settings',
        };
        await updateTask(task.id, {
          aiFileReviews: [reviewEntry, ...existing].slice(0, 5),
          implementationVerification: {
            ...task.implementationVerification,
            aiCodeReview: {
              status:   implStatus,
              reviewId: reviewEntry.id,
              runAt:    now,
              summary:  result.structured?.summary ?? fileLabel,
              findings,
            },
            updatedAt: now,
          },
        });
        setFeedback(`Settings reviewer (file diff): ${implStatus}.`);

      // ── Mode: file-content ───────────────────────────────────────────────
      } else if (source.mode === 'file-content') {
        const fileLabel  = source.fileRelPath
          ?? artifactPath!.replace(/\\/g, '/').split('/').pop()
          ?? 'file';

        const result = await tauriApi.runAiFileReview(
          artifactPath!,
          reviewerName,
          instructions,
          model,
          temperature,
        );

        const verdict    = result.structured?.verdict;
        const implStatus = verdict === 'pass' ? 'passed' : verdict === 'needs_changes' ? 'failed' : 'warnings';

        const sourceLabel = source.isUntracked
          ? `Selected file content (new/untracked): ${fileLabel}`
          : `Selected file content: ${fileLabel}`;
        const findings = [`Review source: ${sourceLabel}`, ...flattenImplReviewFindings(result)];

        const now = new Date().toISOString();
        const existing = task.aiFileReviews ?? [];
        const reviewEntry: AiFileReviewResult = {
          ...result,
          id:         `impl-review-${now}`,
          reviewerName,
          filePath:   source.fileRelPath ?? fileLabel,
          reviewMode: 'file',
          reviewSource: 'settings',
        };
        await updateTask(task.id, {
          aiFileReviews: [reviewEntry, ...existing].slice(0, 5),
          implementationVerification: {
            ...task.implementationVerification,
            aiCodeReview: {
              status:   implStatus,
              reviewId: reviewEntry.id,
              runAt:    now,
              summary:  result.structured?.summary ?? '',
              findings,
            },
            updatedAt: now,
          },
        });
        setFeedback(`Settings reviewer (file): ${implStatus}.`);

      // ── Mode: branch-diff ────────────────────────────────────────────────
      } else if (source.mode === 'branch-diff') {
        const bCtx       = source.branchContext!;
        const branchFrom = bCtx.currentBranch || 'unknown';
        const branchTo   = bCtx.baseBranch    || 'unknown';
        const fileName   = `local changes (${branchFrom} › ${branchTo})`;

        const result = await tauriApi.runAiChangeReview(
          bCtx.diff,
          `${task.title}. ${bCtx.summary}`,
          fileName,
          reviewerName,
          instructions,
          model,
          temperature,
        );

        const verdict    = result.structured?.verdict;
        const implStatus = verdict === 'pass' ? 'passed' : verdict === 'needs_changes' ? 'failed' : 'warnings';

        const _changedFiles  = bCtx.changedFiles    ?? [];
        const _noiseFiles    = bCtx.noiseFiles      ?? [];
        const _flaggedPaths  = bCtx.flaggedPaths    ?? [];
        const _untrackedIncl = bCtx.untrackedIncluded ?? [];
        const _untrackedSkip = bCtx.untrackedSkipped  ?? [];
        const metaFindings: string[] = [
          `Review source: Branch diff (${branchFrom} › ${branchTo})`,
          `[info] Changed files (${_changedFiles.length}): ${_changedFiles.slice(0, 6).join(', ')}${_changedFiles.length > 6 ? '…' : ''}`,
          ...(bCtx.hasStaged    ? ['[info] Staged changes included'] : []),
          ...(bCtx.hasUnstaged  ? ['[info] Unstaged changes included'] : []),
          ...(_untrackedIncl.length > 0 ? [`[info] Untracked files included (${_untrackedIncl.length}): ${_untrackedIncl.join(', ')}`] : []),
          ...(_untrackedSkip.length > 0 ? [`[info] Untracked files skipped: ${_untrackedSkip.slice(0, 3).join(', ')}`] : []),
          ...(_noiseFiles.length   > 0  ? [`[warning] Noise files in diff: ${_noiseFiles.slice(0, 3).join(', ')}`] : []),
          ...(_flaggedPaths.length > 0  ? [`[warning] Flagged paths added: ${_flaggedPaths.join(', ')}`] : []),
        ];
        const findings = [...metaFindings, ...flattenImplReviewFindings(result)];

        const now = new Date().toISOString();
        const existing = task.aiFileReviews ?? [];
        const reviewEntry: AiFileReviewResult = {
          ...result,
          id:         `impl-review-${now}`,
          reviewerName,
          filePath:   fileName,
          reviewMode: 'change',
          reviewSource: 'settings',
        };
        await updateTask(task.id, {
          aiFileReviews: [reviewEntry, ...existing].slice(0, 5),
          implementationVerification: {
            ...task.implementationVerification,
            aiCodeReview: {
              status:   implStatus,
              reviewId: reviewEntry.id,
              runAt:    now,
              summary:  result.structured?.summary ?? bCtx.summary,
              findings,
            },
            updatedAt: now,
          },
        });
        setFeedback(`Settings reviewer (branch diff): ${implStatus}.`);

      } else {
        setFeedback('No artifact file and no git repository found. Save a draft or configure the artifact path first.');
      }
    } catch (e) {
      setFeedback(`Settings reviewer failed: ${String(e)}`);
      const now = new Date().toISOString();
      await updateTask(task.id, {
        implementationVerification: {
          ...task.implementationVerification,
          aiCodeReview: { status: 'failed', runAt: now, summary: `Review failed: ${String(e)}` },
          updatedAt: now,
        },
      }).catch(() => {});
    } finally {
      setImplVerifyAiRunning(false);
    }
  }

  async function handleMarkWaitingForReview() {
    await handleStatusChange('ready-for-review', { waitingState: 'code-review' });
    setFeedback('Marked as Waiting for code review');
  }

  async function handleMarkPrComments() {
    await handleStatusChange('in-progress', { attentionState: 'pr-comments', planningBucket: 'now', isPlanningLocked: false });
    setFeedback('Marked as PR comments — back to Development');
  }

  /**
   * Single dispatcher for all stage-advancing actions.
   * Called by the BPF stepper and by right-panel buttons.
   * Uses the centralized workflow plan so the action matches the stage.
   */
  function runCurrentStageAction() {
    switch (effectiveWorkflowAction) {
      case 'analyze':
        // For developer workflows (any non-general workflowKind) with status 'new':
        // always show the setup modal so the user can re-confirm the target before analyzing.
        // This handles the case where status was reset to 'new' after a previous confirm.
        // For general tasks, or developer tasks past 'new' (e.g. re-analyze on 'analyzed'):
        // show the modal only if setup was never confirmed; otherwise analyze directly.
        if (plan.workflowKind !== 'general' && task.status === 'new') {
          setShowSetupModal(true);
        } else if (!task.workflowSetup?.confirmedAt) {
          setShowSetupModal(true);
        } else {
          handleAnalyze();
        }
        break;
      case 'confirm-setup':           setShowSetupModal(true);  break;
      case 'start-development':       handleStartDevelopment(); break;
      case 'implement-with-ai-kit':   aiKitPanelRef.current?.startImplement(); break;
      case 'review-diff-with-ai-kit': aiKitPanelRef.current?.startReviewDiff(); break;
      case 'apply-ai-review-fixes':   aiKitPanelRef.current?.startApplyFixes(); break;
      case 'verify-implementation':   handleVerifyImplementation(); break;
      case 'mark-waiting-review':     handleMarkWaitingForReview(); break;
      case 'mark-done':               handleMarkDone();          break;
      default: break;
    }
  }

  /** Called when the user clicks Confirm only (no AI analysis) in the setup modal. */
  async function handleConfirmSetupOnly(setup: WorkflowSetup) {
    setShowSetupModal(false);
    // Persist the setup as-is without running analysis.
    // Preserve existing artifact when it is still compatible with the new setup.
    let artifactPath: string | undefined = setup.artifactPath;
    if (artifactPath === undefined) {
      const existingArtifact = task.workflowSetup?.artifactPath;
      if (existingArtifact) {
        const lower = existingArtifact.toLowerCase();
        const matchesScript = lower.endsWith('.js') || lower.endsWith('.ts');
        const matchesPlugin = lower.endsWith('.cs');
        const extensionMismatch =
          (setup.devTargetKind === 'script' && !matchesScript) ||
          (setup.devTargetKind === 'plugin' && !matchesPlugin);
        if (!extensionMismatch) artifactPath = existingArtifact;
      }
    }
    // Also persist setup.customerId › task.customerId so the task header reflects the correct customer.
    const customerUpdate = setup.customerId && setup.customerId !== task.customerId
      ? { customerId: setup.customerId }
      : {};
    await updateTask(task.id, {
      workflowSetup: { ...setup, artifactPath },
      status: 'analyzed',
      waitingState: null,
      attentionState: null,
      ...customerUpdate,
    });
    setFeedback('Setup confirmed — status set to Analyzed');
  }

  /** Called when the user clicks Confirm & Analyze in the setup modal. */
  async function handleConfirmSetup(setup: WorkflowSetup) {
    setShowSetupModal(false);

    // When the modal provides an artifactPath (Update/Fix/Review — user chose an existing
    // file), that selection wins unconditionally over any stale existing artifact.
    // For Create workflows the modal sends artifactPath=undefined and we fall back to
    // preserving the previously created file if the setup is still compatible.
    let artifactPath: string | undefined = setup.artifactPath;

    if (artifactPath === undefined) {
      const existingArtifact = task.workflowSetup?.artifactPath;
      if (existingArtifact) {
        const newKind    = setup.devTargetKind;
        const newIntent  = setup.workIntent;
        const prevIntent = task.workflowSetup?.workIntent;

        const lower = existingArtifact.toLowerCase();
        const matchesScript = lower.endsWith('.js') || lower.endsWith('.ts');
        const matchesPlugin = lower.endsWith('.cs');
        const isNowCreate   = newIntent === 'create';
        const intentChanged = newIntent !== prevIntent;

        const extensionMismatch =
          (newKind === 'script' && !matchesScript) ||
          (newKind === 'plugin' && !matchesPlugin);

        const kindChanged = newKind !== task.workflowSetup?.devTargetKind;

        // Keep existing artifact only when kind/extension still match and we are
        // staying in Create intent (the artifact was produced by Apply Draft).
        if (!kindChanged && !extensionMismatch && !(intentChanged && !isNowCreate)) {
          artifactPath = existingArtifact;
        }
      }
    }

    const mergedSetup: WorkflowSetup = { ...setup, artifactPath };
    // Persist the confirmed setup AND analysis result in one atomic updateTask call.
    await handleAnalyzeWithSetup(mergedSetup);
  }

  // --- URL actions ---

  async function handleOpenUrl(url: string | undefined) {
    if (!url) return;
    setFsError(null);
    try {
      await tauriApi.openExternalUrl(url);
    } catch (err) {
      setFsError(String(err));
    }
  }

  // --- Filesystem actions ---

  async function handleOpenPath(path: string | undefined, label: string) {
    if (!path) {
      setFsError(`No ${label} configured for this customer.`);
      return;
    }
    try {
      await tauriApi.openPath(path);
    } catch (e) {
      setFsError(String(e));
    }
  }

  async function handleOpenRepository(path: string | undefined) {
    if (!path) {
      setFsError('No repository root configured for this customer.');
      return;
    }
    if (tauriApi.isExternalWebUrl(path)) {
      await handleOpenUrl(path);
      return;
    }
    await handleOpenPath(path, 'repository root');
  }

  // Determine which filesystem buttons are relevant
  const hasRepo    = !!customer?.repositoryRoot;
  const hasPlugin  = !!customer?.pluginFolder;
  const hasScript  = !!customer?.scriptFolder;
  // Show VS Code button whenever any path is resolvable (including CRM folder)
  const hasVscodePath = !!effectiveVscodePath;
  const primarchMetadataConfigured = !!settings.crmMetadataEnabled
    && !!(settings.primarchMcpCommand ?? '').trim()
    && !!(settings.primarchMcpArgs ?? '').trim();
  const workflowMetadataVerificationDisabled = !!primarchActionLoading || !primarchMetadataConfigured;
  const workflowMetadataVerificationDisabledReason = !primarchMetadataConfigured
    ? 'Configure and save CRM metadata assistant settings before verification.'
    : primarchActionLoading
      ? 'Another Primarch action is already running.'
      : undefined;

  return (
    <>
      <aside className="detail-panel">

        {/* ---- Header ---- */}
        <div className="detail-panel-header">
          <button
            className="detail-panel-back"
            onClick={onClose}
            title="Back to list"
          >
            <Icon name="arrow-left" size={14} /> Back
          </button>

          <div className="detail-panel-header-content">
            <div className="detail-panel-title-row">
              <div className="detail-panel-title">{task.title}</div>
              <CopyAiWorkflowPromptButton task={task} customer={customer} variant="detail" onSuccess={setFeedback} />
            </div>
            <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
              <TypeBadge type={task.taskType} />
              <TaskStateBadges task={task} />
              {task.analysisResult && (
                <span className="detail-ai-badge">AI</span>
              )}
            </div>
          </div>

          <button
            className="detail-panel-edit"
            onClick={() => setShowEditForm(true)}
            title="Edit task"
          >
            <Icon name="pencil" size={14} />
          </button>
          {confirmDelete ? (
            <>
              <button
                className="btn btn-danger btn-sm"
                onClick={handleDelete}
                title="Confirm delete"
              >
                Delete
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmDelete(false)}
                title="Cancel delete"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="detail-panel-delete"
              onClick={() => setConfirmDelete(true)}
              title="Delete task"
            >
              <Icon name="trash-2" size={14} />
            </button>
          )}
        </div>

        {/* ---- Workflow BPF strip (always visible, never scrolls) ---- */}
        <WorkflowStepper
          displayPhase={plan.displayPhase}
          stages={plan.stages}
          onRunCurrentAction={runCurrentStageAction}
          isRunning={!!aiLoading}
          onTestingAction={() => setShowTestingActionsModal(true)}
          actionLabelOverride={undefined}
        />

        {/* ---- Two-column inner layout ---- */}
        <div className="detail-panel-inner">

        {/* ---- Body ---- */}
        <div className="detail-panel-body">

          {/* Meta grid */}
          <div className="detail-meta-grid">
            <div className="detail-section">
              <span className="detail-section-label">Source</span>
              <SourceBadge source={task.source} />
            </div>

            <div className="detail-section">
              <span className="detail-section-label">Received</span>
              <span className="detail-section-value">
                {formatDate(task.receivedAt)}
              </span>
            </div>

            {task.status === 'done' && (
              <div className="detail-section">
                <span className="detail-section-label">Completed</span>
                {editingCompletedAt ? (
                  <input
                    type="date"
                    className="detail-completed-date-input"
                    defaultValue={task.completedAt ? new Date(task.completedAt).toISOString().slice(0, 10) : ''}
                    autoFocus
                    onBlur={(e) => handleCompletedAtChange(e.target.value)}
                    onChange={(e) => { if (e.target.value) handleCompletedAtChange(e.target.value); }}
                  />
                ) : (
                  <span
                    className="detail-section-value detail-completed-date-value"
                    title="Click to edit completion date"
                    onClick={() => setEditingCompletedAt(true)}
                  >
                    {task.completedAt
                      ? new Date(task.completedAt).toLocaleDateString()
                      : <span className="detail-completed-date-empty">not set — click to set</span>}
                    <Icon name="pencil" size={11} className="detail-completed-date-edit-icon" />
                  </span>
                )}
              </div>
            )}

            <div className="detail-section">
              <span className="detail-section-label">Customer</span>
              {customer ? (
                <span className="detail-section-value">{customer.name}</span>
              ) : (
                <div className="detail-customer-unresolved">
                  <span className="detail-customer-missing">No customer assigned</span>
                  {(customers.length > 0 || crmFolders.length > 0) && (
                    <select
                      className="detail-customer-select"
                      value=""
                      title="Assign customer"
                      onChange={async (e) => {
                        const val = e.target.value;
                        if (!val) return;
                        let customerId: string;
                        if (val.startsWith('crm:')) {
                          customerId = await resolveOrCreateCustomerByFolder(val.slice(4));
                        } else {
                          customerId = val;
                        }
                        await updateTask(task.id, { customerId });
                      }}
                    >
                      <option value="" disabled>Assign customer…</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                      {crmFolders
                        .filter((f) => !customers.some((c) => c.folderName?.toLowerCase() === f.toLowerCase()))
                        .map((f) => (
                          <option key={`crm:${f}`} value={`crm:${f}`}>{f}</option>
                        ))}
                    </select>
                  )}
                </div>
              )}
            </div>

            <div className="detail-section">
              <span className="detail-section-label">Task Type</span>
              <TypeBadge type={task.taskType} />
            </div>
          </div>

          {/* Customer repository info */}
          {customer && (hasRepo || hasPlugin || hasScript || customer.namespace) && (
            <div className="detail-section">
              <span className="detail-section-label">Repository</span>
              <div className="detail-repo-block">
                {customer.repositoryName && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">Name</span>
                    <span className="detail-repo-value">{customer.repositoryName}</span>
                  </div>
                )}
                {customer.namespace && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">NS</span>
                    <span className="detail-repo-value">{customer.namespace}</span>
                  </div>
                )}
                {customer.repositoryRoot && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">Root</span>
                    <span className="detail-repo-value">{customer.repositoryRoot}</span>
                  </div>
                )}
                {customer.pluginFolder && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">Plugin</span>
                    <span className="detail-repo-value">{customer.pluginFolder}</span>
                  </div>
                )}
                {customer.scriptFolder && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">Scripts</span>
                    <span className="detail-repo-value">{customer.scriptFolder}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Original message */}
          <div className="detail-section">
            <span className="detail-section-label">Original Message</span>
            {task.originalMessage ? (
              task.source === 'email' ? (
                <TaskEmailContent task={task} />
              ) : (
                <div className="detail-message">
                  <div className="email-body" style={{ padding: 'var(--gap-md) var(--gap-lg)' }}>
                    {task.originalMessage}
                  </div>
                </div>
              )
            ) : (
              <span className="detail-empty-inline">No message provided</span>
            )}
          </div>

          {/* Notes */}
          <div className="detail-section">
            <span className="detail-section-label">Notes</span>
            {splitNotes.manualNotes.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {splitNotes.manualNotes.map((note, index) => (
                  <div key={`${index}-${note}`} style={{ border: '1px solid var(--border-subtle)', borderRadius: 4, background: 'var(--bg-overlay)', padding: '7px 9px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                    {note}
                  </div>
                ))}
              </div>
            ) : (
              <span className="detail-empty-inline">No manual notes.</span>
            )}
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)' }}>Raw notes editor</summary>
              <textarea
                className="detail-notes-textarea"
                value={notes}
                placeholder="Write notes, context, or reminders..."
                onChange={(e) => setNotes(e.target.value)}
                onBlur={handleNotesSave}
                style={{ marginTop: 6 }}
              />
            </details>
          </div>

          {activityItems.length > 0 && (
            <div className="detail-section">
              <details>
                <summary style={{ cursor: 'pointer' }}>
                  <span className="detail-section-label" style={{ display: 'inline' }}>Activity Log ({activityItems.length})</span>
                  {latestActivity && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                      {[latestActivity.timestampLabel, latestActivity.message].filter(Boolean).join(' | ')}
                    </span>
                  )}
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  {activityItems.map((item) => (
                    <div key={item.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 4, background: 'var(--bg-overlay)', padding: '7px 9px' }}>
                      {(item.timestampLabel || item.source) && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>
                          {[item.timestampLabel, item.source].filter(Boolean).join(' | ')}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>{item.message}</div>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}

          {/* Azure DevOps context — shown for ADO-sourced tasks with parsed metadata */}
          {task.adoContext && task.adoContext.type !== 'other' && (
            <div className="detail-section detail-ado-section">
              <span className="detail-section-label">
                {task.adoContext.type === 'pr-comment' ? 'PR Review Context' : 'Work Item Context'}
              </span>
              <div className="detail-ado-block">
                {/* PR comment fields */}
                {task.adoContext.type === 'pr-comment' && (
                  <>
                    {task.adoContext.prNumber && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">PR</span>
                        <span className="detail-ado-value">#{task.adoContext.prNumber}</span>
                      </div>
                    )}
                    {task.adoContext.reviewerName && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Reviewer</span>
                        <span className="detail-ado-value">{task.adoContext.reviewerName}</span>
                      </div>
                    )}
                    {task.adoContext.commentedFile && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">File</span>
                        <span className="detail-ado-value detail-ado-value--code">{task.adoContext.commentedFile}</span>
                      </div>
                    )}
                    {task.adoContext.reviewComment && (
                      <div className="detail-ado-comment">
                        <span className="detail-ado-comment-label">Comment:</span>
                        <div className="detail-ado-comment-body">{task.adoContext.reviewComment}</div>
                      </div>
                    )}
                  </>
                )}
                {/* Work item fields */}
                {task.adoContext.type === 'work-item' && (
                  <>
                    {task.adoContext.workItemNumber && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">{task.adoContext.workItemType ?? 'Item'}</span>
                        <span className="detail-ado-value">#{task.adoContext.workItemNumber}</span>
                      </div>
                    )}
                    {task.adoContext.workItemState && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">State</span>
                        <span className="detail-ado-value">{task.adoContext.workItemState}</span>
                      </div>
                    )}
                    {task.adoContext.workItemAssignedTo && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Assigned</span>
                        <span className="detail-ado-value">{task.adoContext.workItemAssignedTo}</span>
                      </div>
                    )}
                    {task.adoContext.workItemPriority && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Priority</span>
                        <span className="detail-ado-value">{task.adoContext.workItemPriority}</span>
                      </div>
                    )}
                    {task.adoContext.workItemAreaPath && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Area</span>
                        <span className="detail-ado-value">{task.adoContext.workItemAreaPath}</span>
                      </div>
                    )}
                    {task.adoContext.workItemIterationPath && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Iteration</span>
                        <span className="detail-ado-value">{task.adoContext.workItemIterationPath}</span>
                      </div>
                    )}
                    {task.adoContext.workItemDescription && (
                      <div className="detail-ado-comment">
                        <span className="detail-ado-comment-label">Description:</span>
                        <div className="detail-ado-comment-body">{task.adoContext.workItemDescription}</div>
                      </div>
                    )}
                    {task.adoContext.workItemUrl && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">DevOps</span>
                        <button
                          className="detail-tracking-link"
                          onClick={() => handleOpenUrl(task.adoContext!.workItemUrl)}
                        >
                          Open in Azure DevOps (external)
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* AI Analysis result */}
          {task.analysisResult && (
            <div className="detail-section">
              <span className="detail-section-label detail-ai-label">AI analýza / analysis</span>
              <AnalysisBlock result={task.analysisResult} />
            </div>
          )}

          {/* WORKFLOW CHECKLIST — compact progress snapshot */}
          {effectiveMode === 'developer' && (
            <div className="detail-section">
              <span className="detail-section-label">Workflow progress</span>
              <div className="td-checklist">
                {buildWorkflowChecklist(task, effectiveMode).map((row) => (
                  <div key={row.label} className={`td-checklist-row td-checklist-row--${row.status}`}>
                    <span className="td-checklist-icon">
                      {row.status === 'done'    ? '?'
                     : row.status === 'active'  ? '?'
                     : row.status === 'partial' ? '!'
                     : row.status === 'skip'    ? '–'
                     :                            '·'}
                    </span>
                    <span className="td-checklist-label">{row.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* IMPLEMENTATION READINESS */}
          {showDevReadiness && (
            <div className="detail-section">
              <span className="detail-section-label">Implementation readiness</span>
              {devReadiness.isReady ? (
                <div style={{ fontSize: 12, color: '#3fb950', paddingTop: 2 }}>
                  Ready for code generation
                  {devReadiness.warnings.length > 0 && (
                    <span style={{ color: '#d29922' }}> — review warnings</span>
                  )}
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4 }}>
                    {devReadiness.blockers.length} issue{devReadiness.blockers.length !== 1 ? 's' : ''} blocking implementation
                  </div>
                  <ul style={{ margin: 0, padding: '0 0 0 14px' }}>
                    {devReadiness.blockers.map((b: string, i: number) => (
                      <li key={i} style={{ fontSize: 11, color: '#f85149', marginBottom: 2 }}>{b}</li>
                    ))}
                  </ul>
                  <div style={{ fontSize: 11, color: '#8b949e', marginTop: 6 }}>
                    Next: {devReadiness.recommendedNextStep}
                  </div>
                </div>
              )}
              {devReadiness.warnings.length > 0 && (
                <ul style={{ margin: '6px 0 0 0', padding: '0 0 0 14px' }}>
                  {devReadiness.warnings.map((w: string, i: number) => (
                    <li key={i} style={{ fontSize: 11, color: '#d29922', marginBottom: 2 }}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* CRM DEVELOPER WORKFLOW — collapsed by default to reduce clutter */}
          {effectiveMode === 'developer' && (
            <div className="detail-section">
              <button
                className="td-advanced-btn"
                onClick={() => setShowAdvancedWorkflow((v) => !v)}
              >
                {showAdvancedWorkflow ? '^ Hide advanced workflow details' : 'ˇ Advanced workflow details'}
              </button>
              {showAdvancedWorkflow && (
              <CrmDeveloperWorkflowPanel
                key={task.id}
                task={task}
                onSaveDiagnosisState={handleSaveCrmDeveloperWorkflowState}
                onVerifyMetadata={handleVerifyAgainstCrm}
                onGenerateTechnicalPlan={handleGenerateCrmTechnicalPlan}
                onApproveTechnicalPlan={handleApproveCrmTechnicalPlan}
                onRevokeTechnicalPlanApproval={handleRevokeCrmTechnicalPlanApproval}
                onApproveDiffReview={handleApproveCrmDiffReview}
                onRevokeDiffReviewApproval={handleRevokeCrmDiffReviewApproval}
                onApproveExternalActionPlan={handleApproveCrmExternalActionPlan}
                onRevokeExternalActionApproval={handleRevokeCrmExternalActionApproval}
                onOpenExecutionPreview={handleOpenCrmExecutionPreview}
                onMarkExternalExecutionCompleted={handleMarkExternalExecutionCompleted}
                onRevokeExternalExecution={handleRevokeExternalExecution}
                onGeneratePullRequestProposal={handleGenerateCrmPullRequestProposal}
                onMarkPullRequestCreatedManually={handleMarkCrmPullRequestCreatedManually}
                onRevokePullRequestTracking={handleRevokeCrmPullRequestTracking}
                onFetchPullRequestReviewStatus={handleFetchCrmPullRequestReviewStatus}
                onGeneratePullRequestReviewAnalysis={handleGenerateCrmPullRequestReviewAnalysis}
                onGeneratePullRequestFixProposal={handleGenerateCrmPullRequestFixProposal}
                onUseFixProposalForDraftGeneration={handleGenerateDraft}
                onMarkPullRequestFixUpdatedManually={handleMarkCrmPullRequestFixUpdatedManually}
                onRevokePullRequestFixUpdateTracking={handleRevokeCrmPullRequestFixUpdateTracking}
                savingState={crmWorkflowSaving}
                verifyingMetadata={primarchActionLoading === 'verify'}
                generatingTechnicalPlan={crmTechnicalPlanGenerating}
                savingPlanApproval={crmPlanApprovalSaving}
                savingDiffApproval={crmDiffApprovalSaving}
                savingExternalActionApproval={crmExternalActionApprovalSaving}
                savingExternalExecution={crmExternalExecutionSaving}
                savingPullRequest={crmPullRequestSaving}
                savingPullRequestReview={crmPullRequestReviewSaving}
                savingPullRequestReviewAnalysis={crmPullRequestReviewAnalysisSaving}
                savingPullRequestFixProposal={crmPullRequestFixProposalSaving}
                savingPullRequestFixUpdate={crmPullRequestFixUpdateSaving}
                generatingDraftFromFixProposal={aiLoading === 'draft'}
                metadataVerificationDisabled={workflowMetadataVerificationDisabled}
                metadataVerificationDisabledReason={workflowMetadataVerificationDisabledReason}
              />
              )}
            </div>
          )}

          {/* CRM Skeleton — compact card for latest generated metadata-based skeleton */}
          {latestCrmSkeleton && (
            <div className="detail-section">
              <span className="detail-section-label detail-ai-label">CRM Skeleton</span>
              <div style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 4,
                background: 'var(--bg-overlay)',
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {latestCrmSkeleton.summary || 'CRM skeleton generated'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Mode: {latestCrmSkeleton.mode} · Entities inspected: {(latestCrmSkeleton.metadataInspected?.entityLogicalNames ?? []).length}
                </div>
                <pre className="detail-code-block" style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto', margin: 0 }}>
                  {latestCrmSkeleton.pseudoCode || ''}
                </pre>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => setShowCrmSkeletonModal(true)}>
                    <Icon name="search" size={11} /> Open skeleton
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* CRM Verification — compact card for latest deterministic report */}
          {latestCrmVerification && (
            <div className="detail-section">
              <span className="detail-section-label detail-ai-label">CRM Verification</span>
              <div style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 4,
                background: 'var(--bg-overlay)',
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                    Verdict: {formatCrmVerdict(latestCrmVerification.verdict)}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Errors: {(latestCrmVerification.issues ?? []).filter(i => i.severity === 'error').length}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Warnings: {(latestCrmVerification.issues ?? []).filter(i => i.severity === 'warning').length}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Suggestions: {(latestCrmVerification.issues ?? []).filter(i => i.severity === 'suggestion').length}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {latestCrmVerification.summary || '—'}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => setShowCrmVerificationModal(true)}>
                    <Icon name="search" size={11} /> Open report
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* AI Code Review — one compact card per saved review entry */}
          {(task.aiFileReviews ?? []).length > 0 && (
            <div className="detail-section">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span className="detail-section-label detail-ai-label" style={{ marginBottom: 0 }}>
                  AI recenze kódu
                </span>
                {effectiveMode === 'developer' && plan.requiresDevTools && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => devModePanelRef.current?.openReviewModal()}
                    type="button"
                    title="Open the review panel to run a fresh review"
                  >
                    <Icon name="refresh-cw" size={11} /> Spustit znovu
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(task.aiFileReviews ?? []).map((review, idx) => {
                  const src = inferReviewSource(review);
                  const VERDICT_COLOR: Record<string, string> = {
                    pass: '#3fb950', comment: '#388bfd', needs_changes: '#d29922',
                  };
                  const VERDICT_LABEL: Record<string, string> = {
                    pass: 'Bez zásadních připomínek',
                    comment: 'Komentář',
                    needs_changes: 'Vyžaduje úpravy',
                  };
                  const v = review.structured?.verdict;
                  return (
                    <div key={review.id ?? idx} style={{
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 4,
                      background: 'var(--bg-overlay)',
                      padding: '8px 10px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 5,
                    }}>
                      {/* Top row: file name + source badge + verdict */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {review.structured?.fileName ??
                            review.filePath.replace(/\\/g, '/').split('/').pop() ?? review.filePath}
                        </span>
                        {src !== 'legacy' && (
                          <span style={{
                            fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
                            letterSpacing: '0.04em', border: '1px solid var(--border-subtle)',
                            color: src === 'ai-kit' ? 'var(--accent-fg, #388bfd)' : 'var(--text-muted)',
                            background: 'var(--bg-surface)',
                          }}>
                            {src === 'ai-kit' ? 'AI Kit' : 'Settings'}
                          </span>
                        )}
                        {v && (
                          <span style={{
                            fontSize: 10, fontWeight: 600, padding: '1px 6px',
                            borderRadius: 3, letterSpacing: '0.04em',
                            color: VERDICT_COLOR[v],
                            border: `1px solid ${VERDICT_COLOR[v]}`,
                            background: `color-mix(in srgb, ${VERDICT_COLOR[v]} 12%, var(--bg-surface))`,
                          }}>{VERDICT_LABEL[v]}</span>
                        )}
                      </div>
                      {/* Meta row */}
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        {review.reviewMode && (
                          <span style={{
                            fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
                            letterSpacing: '0.04em', border: '1px solid var(--border-subtle)',
                            color: 'var(--text-muted)', background: 'var(--bg-surface)',
                          }}>
                            {review.reviewMode === 'file' ? 'File review' : 'Change review'}
                          </span>
                        )}
                        <span>Recenzent: {review.reviewerName}</span>
                        {review.structured?.comments?.length != null && (
                          <span>{review.structured.comments.length} komentářů</span>
                        )}
                        {review.reviewedAt && (
                          <span>{formatRelativeDate(review.reviewedAt)}</span>
                        )}
                      </div>
                      {/* Summary preview */}
                      {review.structured?.summary && (
                        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-secondary)',
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                          overflow: 'hidden' }}>
                          {review.structured.summary}
                        </p>
                      )}
                      {/* Actions */}
                      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => setSavedReviewModal(review)}
                          type="button"
                        >
                          <Icon name="search" size={11} /> Otevřít recenzi
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Legacy suggested steps — hidden when bilingual action bullets cover them */}
          {!(task.analysisResult?.actionPointsCz?.length) && !(task.analysisResult?.actionPointsEn?.length) &&
           (task.analysisResult?.suggestedActions ?? task.suggestedActions).length > 0 && (
            <div className="detail-section">
              <span className="detail-section-label">
                {task.analysisResult ? 'Navrhované kroky' : 'Suggested Steps'}
              </span>
              <div className="detail-suggestions">
                {(task.analysisResult?.suggestedActions ?? task.suggestedActions).map((sa, i) => (
                  <div key={sa.id} className="detail-suggestion-item">
                    <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>{i + 1}.</span>
                    {sa.label}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tracking section — only rendered when at least one field is set */}
          {(task.ticketUrl || task.devopsTaskUrl || task.sourceUrl || task.budgetHours !== undefined || task.budgetNote) && (
            <div className="detail-section">
              <span className="detail-section-label">Tracking</span>
              <div className="detail-tracking-block">
                {task.ticketUrl && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">Ticket</span>
                    <button
                      className="detail-tracking-link"
                      onClick={() => handleOpenUrl(task.ticketUrl)}
                      title={task.ticketUrl}
                    >
                      Open Ticket (external)
                    </button>
                  </div>
                )}
                {task.devopsTaskUrl && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">DevOps</span>
                    <button
                      className="detail-tracking-link"
                      onClick={() => handleOpenUrl(task.devopsTaskUrl)}
                      title={task.devopsTaskUrl}
                    >
                      Open DevOps Task (external)
                    </button>
                  </div>
                )}
                {task.sourceUrl && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">Source</span>
                    <button
                      className="detail-tracking-link"
                      onClick={() => handleOpenUrl(task.sourceUrl)}
                      title={task.sourceUrl}
                    >
                      Open Source Message ?
                    </button>
                  </div>
                )}
                {task.budgetHours !== undefined && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">Budget</span>
                    <span className="detail-tracking-value">
                      {task.budgetHours}h
                    </span>
                  </div>
                )}
                {task.budgetNote && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">Note</span>
                    <span className="detail-tracking-value detail-tracking-note">
                      {task.budgetNote}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Planning section */}
          {task.status !== 'done' && (
            <PlanningSection task={task} />
          )}

        </div>

        {/* ---- Action footer ---- */}
        <div className="detail-action-groups">

          {/* MODE SWITCH — top of the action panel for immediate visibility */}
          <div className="detail-action-group">
            <div className="detail-action-group-label">Mode</div>
            <TaskModeSwitch task={task} onSetMode={handleSetMode} />
          </div>

          {/* NEXT STEP — single recommended action */}
          {(() => {
            const step = deriveNextStep(task, plan, effectiveMode);
            if (!step) return null;
            return (
              <div className="td-next-step">
                <div className="td-next-step-action">{step.action}</div>
                {step.why && <div className="td-next-step-why">{step.why}</div>}
              </div>
            );
          })()}

          {/* Inline feedback message */}
          {feedback && (
            <div className="detail-feedback-ok">
              <Icon name="check" size={12} /> {feedback}
            </div>
          )}

          {/* AI error message */}
          {aiError && (
            <div className="detail-fs-error">! {aiError}</div>
          )}

          {/* WORKFLOW — primary action driven by process flow + AI Kit recommendation */}
          {task.status !== 'done' && (
            <div className="detail-action-group">
              <div className="detail-action-group-label">Workflow</div>
              <div className="detail-action-grid">
                {effectiveWorkflowAction !== 'none' && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={runCurrentStageAction}
                    disabled={!!aiLoading}
                    title={
                      plan.isDeveloperAwaitingSetup && effectiveWorkflowAction === 'analyze'
                        ? 'Confirm developer setup before analysis'
                        : `Run: ${plan.currentActionLabel}`
                    }
                  >
                    {aiLoading === 'analyze'
                      ? <><span className="btn-spinner" /> Analysing…</>
                      : <>
                          <Icon name={
                            effectiveWorkflowAction === 'analyze' ? 'search'
                            : effectiveWorkflowAction === 'confirm-setup' ? 'settings'
                            : effectiveWorkflowAction === 'start-development' ? 'play'
                            : effectiveWorkflowAction === 'implement-with-ai-kit' ? 'layers'
                            : effectiveWorkflowAction === 'review-diff-with-ai-kit' ? 'search'
                            : effectiveWorkflowAction === 'apply-ai-review-fixes' ? 'check'
                            : effectiveWorkflowAction === 'verify-implementation' ? 'check'
                            : effectiveWorkflowAction === 'mark-waiting-review' ? 'pause'
                            : 'check'
                          } size={13} />
                          {' '}{plan.currentActionLabel}
                        </>
                    }
                  </button>
                )}
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleMarkDone}
                  disabled={!!aiLoading}
                  title="Mark task as done"
                >
                  <Icon name="check" size={13} /> Done
                </button>
              </div>
            </div>
          )}


          {/* BRANCH + TARGET FILE — branch selector, plugin/script target, open buttons */}
          {(resolvedArtifactForAiKit || repoRootForGit || hasRepo || (effectiveMode === 'developer' && plan.requiresDevTools && (hasRepo || hasVscodePath))) && (
            <div className="detail-action-group">
              <div className="detail-action-group-label">
                {plan.targetKind === 'plugin' ? 'Plugin file' : plan.targetKind === 'script' ? 'Script file' : 'Branch + Target file'}
              </div>

              {/* Script file create actions — shown for Script Create tasks when artifact doesn't exist */}
              {plan.requiresScriptCreate && task.status === 'in-progress' && (
                scriptArtifactExists === false ? (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ color: 'var(--color-warning, #d29922)', fontSize: 11, marginBottom: 6 }}>
                      Script file does not exist yet. Create it to start working.
                    </div>
                    {resolvedArtifactForAiKit && (
                      <div style={{ fontSize: 10, color: 'var(--color-text-muted, #888)', marginBottom: 6 }}>
                        {resolvedArtifactForAiKit.replace(/\\/g, '/').split('/').slice(-2).join('/')}
                      </div>
                    )}
                    <div className="detail-action-grid">
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={handleCreateScriptFileInPanel}
                        disabled={scriptFileCreating}
                        title="Create minimal script file at the configured artifact path"
                      >
                        {scriptFileCreating
                          ? 'Creating…'
                          : <><Icon name="file-text" size={13} /> Create Script File</>}
                      </button>
                      {settings?.powerPlatformAiKitPath && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={handleCreateScriptAndImplementInPanel}
                          disabled={scriptFileCreating || scriptAndImplementLoading}
                          title="Validate path and open AI Kit implementation preview (no scaffold until Apply)"
                        >
                          {scriptAndImplementLoading
                            ? <><span className="btn-spinner" /> Starting…</>
                            : <><Icon name="layers" size={13} /> Create + Implement with AI Kit</>}
                        </button>
                      )}
                    </div>
                  </div>
                ) : scriptArtifactExists === null ? (
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted, #888)', marginBottom: 6 }}>
                    Checking script file…
                  </div>
                ) : null
              )}

              {/* Dev setup controls: branch selector + plugin/script target selector + open buttons */}
              {effectiveMode === 'developer' && (hasRepo || hasVscodePath) && plan.requiresDevTools && (
                <TaskDevModePanel
                  ref={devModePanelRef}
                  task={task}
                  customer={customer}
                  pluginsDir={pluginsDir}
                  repoRootForGit={repoRootForGit}
                  defaultMode={devTarget.kind === 'plugin' ? 'plugin' : 'script'}
                  scriptOpenPath={
                    (plan.requiresScriptCreate && scriptArtifactExists === false)
                      ? undefined
                      : task.workflowSetup?.scriptPath ?? customer?.scriptFolder ?? effectiveVscodePath
                  }
                  onError={setFsError}
                  autoCollapsed={false}
                  hideModeToggle
                  hideAiReview
                  selectedPluginProject={selectedPluginProject}
                  onSelectedPluginChange={handleSelectedPluginChange}
                  onPluginProjectMissing={handlePluginProjectMissing}
                  onScriptFileSelected={handleScriptFileSelected}
                  pluginRefreshTick={devPanelRefreshTick}
                  reviewerConfigs={plan.requiresAiFileReview ? settings.aiReviewers : undefined}
                  artifactPath={task.workflowSetup?.artifactPath}
                  initialReview={task.aiFileReviews?.[0]}
                  onReviewSaved={handleReviewSaved}
                  onChangeReviewComplete={async (review) => {
                    const existing = task.aiFileReviews ?? [];
                    await updateTask(task.id, {
                      aiFileReviews: [review, ...existing].slice(0, 5),
                    });
                    setFeedback('AI review complete');
                  }}
                />
              )}

              {/* Open Repository for non-dev or generic tasks */}
              {!(effectiveMode === 'developer' && plan.requiresDevTools) && (hasRepo || repoRootForGit) && (
                <div className="detail-action-grid">
                  <button
                    className="btn btn-secondary btn-sm btn-full"
                    onClick={() => handleOpenRepository(repoRootForGit ?? customer?.repositoryRoot)}
                  >
                    <Icon name="folder" size={13} /> Open Repository
                  </button>
                </div>
              )}
            </div>
          )}

          {/* AZURE DEVOPS — shown for ADO PR comment/review tasks with an extracted deep link */}
          {(() => {
            const adoUrl =
              task.adoContext?.type === 'pr-comment'
                ? (task.adoContext.prUrl ?? task.adoContext.workItemUrl ?? null)
                : task.adoContext?.type === 'work-item'
                  ? (task.adoContext.workItemUrl ?? null)
                  : null;
            if (!adoUrl) return null;
            return (
              <div className="detail-action-group">
                <div className="detail-action-group-label">Azure DevOps</div>
                <button
                  className="btn btn-secondary btn-sm btn-full"
                  onClick={() => handleOpenUrl(adoUrl)}
                  title={adoUrl}
                >
                  <Icon name="external-link" size={13} /> Open in DevOps
                </button>
              </div>
            );
          })()}

          {/* ASSISTANT TOOLS — collapsed by default, same <details>/<summary> pattern as Raw notes / Activity log */}
          {effectiveMode === 'developer' && plan.requiresDevTools && (
            <div className="detail-action-group">
              <details>
                <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
                  <span className="detail-action-group-label" style={{ display: 'inline' }}>Assistant Tools</span>
                </summary>

                {/* Phase Actions — secondary workflow transitions */}
                {task.status !== 'done' && (
                  <div style={{ marginTop: 8 }}>
                    <div className="detail-action-group-label">Phase Actions</div>
                    <div className="detail-action-grid">
                      {task.status !== 'new' && effectiveWorkflowAction !== 'analyze' && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={handleAnalyze}
                          disabled={!!aiLoading}
                          title="Run AI analysis again"
                        >
                          {aiLoading === 'analyze'
                            ? <><span className="btn-spinner" /> Analysing…</>
                            : <><Icon name="search" size={13} /> Re-analyze</>}
                        </button>
                      )}
                      {effectiveMode === 'developer' && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => setShowSetupModal(true)}
                          disabled={!!aiLoading}
                          title="Review or adjust workflow setup"
                        >
                          <Icon name="settings" size={13} /> Confirm Setup
                        </button>
                      )}
                      {task.status === 'analyzed' && plan.workflowKind !== 'general' && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={handleStartDevelopment}
                          disabled={!!aiLoading}
                          title="Move the task into Development without opening external tools"
                        >
                          <Icon name="play" size={13} /> Start Development
                        </button>
                      )}
                      {task.status === 'in-progress' && (plan.targetKind === 'plugin' || plan.targetKind === 'script') && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={handleVerifyImplementation}
                          disabled={!!aiLoading}
                          title="Open implementation verification checks before code review"
                        >
                          <Icon name="check" size={13} /> Verify Implementation
                        </button>
                      )}
                      {task.status === 'in-progress' && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={handleMarkWaitingForReview}
                          disabled={!!aiLoading}
                          title="Mark this task as waiting for code review"
                        >
                          <Icon name="pause" size={13} /> Waiting for Code Review
                        </button>
                      )}
                      {task.waitingState === 'consultant-testing' && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleStatusChange('in-progress')}
                          disabled={!!aiLoading}
                          title="Move this task back to active development"
                        >
                          <Icon name="play" size={13} /> Back to Development
                        </button>
                      )}
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={handleMarkPrComments}
                        disabled={!!aiLoading}
                        title="Mark review comments as active work"
                      >
                        <Icon name="message-square" size={13} /> PR Comments
                      </button>
                      {repoRootForGit && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => setShowGitCommitModal(true)}
                          title="Stage files, review changes, and commit / push to the repository"
                        >
                          <Icon name="layers" size={13} /> Prepare Commit
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* AI Code Tools: draft generation and review */}
                <div style={{ marginTop: 8 }}>
                  <div className="detail-action-group-label">AI Code Tools</div>
                  <div className="detail-action-grid">
                    <button
                      className={`btn btn-sm ${plan.draftIsPrimaryAction ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={handleGenerateDraft}
                      disabled={!!aiLoading}
                      title={devTarget.kind === 'plugin'
                        ? 'Generate C# plugin class draft and open a preview'
                        : plan.draftIsPrimaryAction
                          ? 'Generate a script draft and open a preview'
                          : 'Generate a patch suggestion and open a preview'}
                    >
                      {aiLoading === 'draft'
                        ? <><span className="btn-spinner" /> Generating…</>
                        : <><Icon name="layers" size={13} /> {plan.draftIsPrimaryAction ? 'Generate Draft' : 'Patch Suggestion'}</>}
                    </button>
                    {skeletonPreview && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={handleApplyDraft}
                        disabled={!!aiLoading}
                        title="Open the draft preview where Save to File is explicit"
                      >
                        <Icon name="check" size={13} /> Preview / Apply Draft
                      </button>
                    )}
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => devModePanelRef.current?.openReviewModal()}
                      disabled={!!aiLoading}
                      title="Open AI review tools without changing workflow state"
                    >
                      <Icon name="search" size={13} /> Run AI Review
                    </button>
                  </div>
                </div>

                {/* Primarch — CRM metadata tools */}
                <div style={{ marginTop: 8 }}>
                  <div className="detail-action-group-label">Primarch</div>
                  <div style={{ marginBottom: 8 }}>
                    <label className="form-label" htmlFor="primarch-primary-entity-override">Primary entity override (optional)</label>
                    <input
                      id="primarch-primary-entity-override"
                      className="form-input"
                      type="text"
                      placeholder="account, contact, nvr_accountcompanyrelation"
                      value={primarchPrimaryEntityOverride}
                      onChange={(e) => setPrimarchPrimaryEntityOverride(e.target.value)}
                    />
                    <div className="settings-field-hint" style={{ marginTop: 4 }}>
                      Used only for this task verification run unless you explicitly save it in task setup.
                    </div>
                  </div>
                  <div className="detail-action-grid">
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={handleGenerateCrmSkeleton}
                      disabled={!!primarchActionLoading}
                      title="Generate metadata-based CRM pseudo-code skeleton (read-only)"
                    >
                      {primarchActionLoading === 'skeleton'
                        ? <><span className="btn-spinner" /> Generating…</>
                        : <><Icon name="layers" size={13} /> Generate CRM Skeleton</>}
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={handleVerifyAgainstCrm}
                      disabled={!!primarchActionLoading || !settings.crmMetadataEnabled || !(settings.primarchMcpCommand ?? '').trim() || !(settings.primarchMcpArgs ?? '').trim()}
                      title={(!settings.crmMetadataEnabled || !(settings.primarchMcpCommand ?? '').trim() || !(settings.primarchMcpArgs ?? '').trim())
                        ? 'Configure and save CRM metadata assistant settings first.'
                        : 'Verify current artifact references against CRM metadata (read-only)'}
                    >
                      {primarchActionLoading === 'verify'
                        ? <><span className="btn-spinner" /> Verifying…</>
                        : <><Icon name="check" size={13} /> Verify against CRM</>}
                    </button>
                  </div>
                </div>

                {/* AI Kit Actions */}
                <div style={{ marginTop: 8 }}>
                  <div className="detail-action-group-label">AI Kit Actions</div>
                  {aiKitWorkflowState.isConfigured && task.status === 'in-progress' && (
                    <div style={{
                      fontSize: 11.5,
                      color: aiKitWorkflowState.latestReviewVerdict === 'needs_changes'
                        ? 'var(--color-blocked, #e05555)'
                        : aiKitWorkflowState.latestReviewVerdict === 'comment'
                        ? 'var(--color-warning, #d29922)'
                        : aiKitWorkflowState.latestReviewVerdict === 'pass'
                        ? 'var(--color-done, #3fb950)'
                        : 'var(--text-muted)',
                      marginBottom: 6,
                      lineHeight: 1.4,
                    }}>
                      {aiKitWorkflowState.statusText}
                    </div>
                  )}

                  {/* Non-blocking advisory when AI Kit review found issues */}
                  {aiKitWorkflowState.isConfigured && task.status === 'in-progress'
                    && (aiKitWorkflowState.latestReviewVerdict === 'needs_changes'
                        || aiKitWorkflowState.latestReviewVerdict === 'comment') && (
                    <div style={{
                      marginBottom: 8,
                      padding: '7px 9px',
                      background: 'var(--bg-secondary)',
                      borderRadius: 4,
                      border: '1px solid var(--border-subtle)',
                      fontSize: 11.5,
                    }}>
                      <div style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>
                        AI Kit review found issues. Apply fixes before verification (recommended).
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => aiKitPanelRef.current?.startApplyFixes()}
                        >
                          <Icon name="check" size={12} /> Apply AI Review Fixes
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => aiKitPanelRef.current?.startReviewDiff()}
                        >
                          <Icon name="search" size={12} /> Review Diff Again
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={handleVerifyImplementation}
                          title="Skip AI fixes and proceed directly to implementation verification"
                        >
                          Verify Anyway
                        </button>
                      </div>
                    </div>
                  )}

                  <AiKitActionsPanel
                    ref={aiKitPanelRef}
                    task={task}
                    customer={customer}
                    aiKitPath={settings?.powerPlatformAiKitPath}
                    crmBaseDirectory={settings?.crmBaseDirectory}
                    repoRootForGit={repoRootForGit}
                    onTaskUpdate={async (updates) => {
                      await updateTask(task.id, updates);
                    }}
                    onPreviewReady={() => setScriptAndImplementLoading(false)}
                    onError={(msg) => { setFsError(msg); setScriptAndImplementLoading(false); }}
                  />
                </div>

                {/* Plugin Project Helper */}
                {isPluginCreate && pluginsDir && (
                  <div style={{ marginTop: 8 }}>
                    <div className="detail-action-group-label">Plugin Project Helper</div>
                    {!selectedPluginProject && (
                      <div className="detail-devmode-hint" style={{ color: 'var(--color-warning, #d29922)', marginBottom: 6 }}>
                        Plugin project was not found. Create it manually or use the helper below.
                      </div>
                    )}
                    <div className="detail-action-grid">
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={async () => {
                          const folders = await tauriApi.listSubfolders(pluginsDir).catch(() => [] as string[]);
                          setPluginProjectsForModal(folders);
                          setShowCreatePlugin(true);
                        }}
                      >
                        <Icon name="folder" size={13} /> Create Plugin Project
                      </button>
                    </div>
                  </div>
                )}

                {/* Filesystem: script folder and dev setup prompt */}
                {(hasScript || plan.isDeveloperAwaitingSetup) && (
                  <div style={{ marginTop: 8 }}>
                    <div className="detail-action-group-label">Filesystem</div>
                    {hasScript && (
                      <button
                        className="btn btn-secondary btn-sm btn-full"
                        onClick={() => handleOpenPath(customer?.scriptFolder, 'script folder')}
                      >
                        <Icon name="file-text" size={13} /> Open Script Folder
                      </button>
                    )}
                    {plan.isDeveloperAwaitingSetup && (
                      <div className="detail-dev-setup-prompt">
                        <span className="detail-dev-setup-text">Choose Plugin or Script target to enable developer tools.</span>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => setShowSetupModal(true)}
                        >
                          Confirm developer setup
                        </button>
                      </div>
                    )}
                  </div>
                )}

              </details>
            </div>
          )}

          {/* Filesystem errors from any action */}
          {fsError && (
            <div className="detail-fs-error">! {fsError}</div>
          )}

        </div>
        </div>{/* end detail-panel-inner */}
      </aside>

      {/* Skeleton preview modal — used for both plugin (.cs) and script (.js) drafts */}
      {showSkeleton && skeletonPreview && (
        devTarget.kind === 'plugin' ? (
          <SkeletonPreviewModal
            preview={skeletonPreview}
            customer={customer}
            resolvedPluginBase={
              (pluginsDir && selectedPluginProject)
                ? `${pluginsDir}/${selectedPluginProject}`
                : undefined
            }
            unapprovedPlanWarning={
              skeletonUsedAutoGeneratedPlan
                ? 'Technical plan was generated automatically and has not been approved. Saving this draft means you accept this generated implementation direction.'
                : undefined
            }
            onClose={() => { setShowSkeleton(false); setPendingPostSaveAction(null); setSkeletonUsedAutoGeneratedPlan(false); }}
            onSaved={async (filePath) => {
              // 1. Persist artifact metadata and close modal state.
              const project = selectedPluginProject;
              if (project) {
                await completePluginDraft(project, filePath);
              }

              // 2. Add the file to the legacy .csproj (if this is a legacy project).
              //    SDK-style projects auto-include .cs files and need no change.
              let csprojOk = false; // true › file is in project (added, sdk, or already there)
              let csprojFeedback = `Plugin draft saved: ${project}.`;
              try {
                const result = await tauriApi.addCompileIncludeToCsproj(filePath);
                switch (result.action) {
                  case 'added':
                    csprojOk = true;
                    csprojFeedback = 'Draft saved and added to the project file.';
                    break;
                  case 'sdk_style':
                    csprojOk = true;
                    csprojFeedback = 'Draft saved. SDK-style project auto-includes .cs files.';
                    break;
                  case 'already_present':
                    csprojOk = true;
                    csprojFeedback = 'Plugin draft saved. File is already referenced in the project.';
                    break;
                  default:
                    // no_csproj_found — keep default message; may be a custom template layout
                    break;
                }
              } catch {
                csprojFeedback = 'Draft was saved, but it could not be added to the .csproj. Use Show All Files › Include In Project in Visual Studio.';
              }

              // 3. Post-save guided action ("Create + Save Draft + Open").
              //    pendingPostSaveAction is read from the closure (captured at last render);
              //    it is still 'save-draft-open' here even though onClose already called
              //    setPendingPostSaveAction(null), because React state updates are async.
              if (pendingPostSaveAction === 'save-draft-open') {
                setPendingPostSaveAction(null);

                // 3a. Restore NuGet packages (nuget.exe › direct download fallback).
                //     Solution dir = pluginsDir/projectName (parent of the .sln file).
                let nugetOk = false;
                let nugetMsg = '';
                if (pluginsDir && project) {
                  const solutionDir = `${pluginsDir}/${project}`;
                  try {
                    const nugetResult = await tauriApi.restoreNugetPackages(solutionDir);
                    nugetOk  = nugetResult.dllExists;
                    nugetMsg = nugetResult.message;
                  } catch (e) {
                    nugetMsg = `NuGet restore failed: ${String(e)}`;
                  }
                }

                // 3b. Open Visual Studio.
                let vsOpened = false;
                try {
                  await handleOpenPluginForModal();
                  vsOpened = true;
                } catch { /* VS open failed — surfaced via feedback and adjusted next step below */ }

                const noteText = 'Plugin project created and draft generated from Start Development workflow.';
                const existing = task.notes?.trim() ?? '';
                const combinedNotes = existing
                  ? `${existing}\n[${new Date().toISOString()}] ${noteText}`
                  : `[${new Date().toISOString()}] ${noteText}`;

                // Next step encodes all failure dimensions: .csproj, NuGet, VS open.
                const nextStepParts: string[] = [];
                if (!nugetOk)   nextStepParts.push('restore NuGet packages');
                if (!csprojOk)  nextStepParts.push('include generated .cs file in project');
                if (!vsOpened)  nextStepParts.push('open plugin project manually');
                const baseStep   = nextStepParts.length === 0
                  ? 'Build and test plugin'
                  : `${nextStepParts.join(', then ')}, then build and test plugin`;
                const nextStepAction = vsOpened
                  ? baseStep
                  : `Open plugin project manually and ${baseStep.replace('open plugin project manually, then ', '').toLowerCase()}`;

                const nextStepReason = [
                  'Draft generated and saved from Start Development workflow.',
                  !nugetOk  ? (nugetMsg || 'NuGet packages not restored.') : '',
                  !csprojOk ? 'The .cs file could not be added to the .csproj automatically.' : '',
                  !vsOpened ? 'Visual Studio could not be opened automatically.' : '',
                ].filter(Boolean).join(' ');

                // Include workflowSetup.artifactPath explicitly to prevent the stale-closure
                // race: updateTask uses the tasks closure from the last render, which does not
                // yet reflect the workflowSetup.artifactPath set by completePluginDraft above.
                await updateTask(task.id, {
                  status:         'in-progress',
                  waitingState:   null,
                  attentionState: null,
                  notes:          combinedNotes,
                  workflowSetup: {
                    ...task.workflowSetup,
                    devTargetKind: 'plugin',
                    pluginProject: project || task.workflowSetup?.pluginProject,
                    artifactPath:  filePath,
                  },
                  mcpNextStep: {
                    action:    nextStepAction,
                    reason:    nextStepReason,
                    updatedAt: new Date().toISOString(),
                  },
                });

                // Feedback for the guided flow.
                const feedbackParts: string[] = [];
                if (csprojOk)       feedbackParts.push('Draft saved and added to project.');
                else                feedbackParts.push('Draft saved.');
                if (nugetOk)        feedbackParts.push('NuGet packages restored.');
                else                feedbackParts.push('NuGet packages not restored — use Restore NuGet Packages in Visual Studio.');
                if (vsOpened)       feedbackParts.push('Visual Studio opened.');
                else                feedbackParts.push('Visual Studio could not be opened.');
                setFeedback(feedbackParts.join(' '));
              } else {
                // Non-guided flow: show the .csproj result as feedback.
                setFeedback(csprojFeedback);
              }
            }}
          />
        ) : (
          // Script draft preview modal — overrideSavePath directs save to the script folder.
          <SkeletonPreviewModal
            preview={skeletonPreview}
            customer={customer}
            overrideSavePath={scriptDraftPath ?? undefined}
            modalTitle={`Draft: ${skeletonPreview.fileName}`}
            onClose={() => { setShowSkeleton(false); setScriptDraftPath(null); }}
            onSaved={(filePath) => {
              // The modal already wrote the file; persist artifact metadata only.
              completeScriptDraft(filePath);
            }}
          />
        )
      )}

      {/* Confirm Setup modal — shown when user clicks Analyze on a New task */}
      {showSetupModal && (
        <ConfirmSetupModal
          task={task}
          customers={customers}
          customer={customer}
          devTarget={heuristicDevTarget}
          pluginsDir={pluginsDir}
          scriptFolder={effectiveScriptFolder}
          reviewerConfigs={settings.aiReviewers}
          effectiveMode={effectiveMode}
          crmBaseDirectory={settings?.crmBaseDirectory}
          onConfirm={handleConfirmSetup}
          onConfirmOnly={handleConfirmSetupOnly}
          onCancel={() => setShowSetupModal(false)}
        />
      )}

      {/* Start Development modal */}
      {showStartDevModal && (
        <StartDevelopmentModal
          task={task}
          customer={customer}
          plan={plan}
          pluginsDir={pluginsDir}
          selectedPluginProject={selectedPluginProject}
          repoRoot={customer?.resolvedRepositoryPath ?? customer?.repositoryRoot}
          effectiveRepoRoot={repoRootForGit}
          scriptOpenPath={task.workflowSetup?.scriptPath ?? customer?.scriptFolder ?? effectiveVscodePath}
          templateDir={settings.pluginTemplateFolder ?? ''}
          verificationVerdict={task.crmVerificationReports?.[0]?.verdict ?? 'none'}
          onOpenPlugin={handleOpenPluginForModal}
          onGenerateDraft={handleGenerateDraft}
          onGenerateDraftGuided={() => handleGenerateDraftStartDev('none')}
          onGenerateDraftAndOpen={() => handleGenerateDraftStartDev('save-draft-open')}
          onCreatePlugin={async () => {
            setShowStartDevModal(false);
            const folders = await tauriApi.listSubfolders(pluginsDir ?? '').catch(() => [] as string[]);
            setPluginProjectsForModal(folders);
            setShowCreatePlugin(true);
          }}
          onProjectCreated={(projectName) => {
            // Update task state after direct (no-form) project creation from the modal.
            updateTask(task.id, {
              selectedPluginProject: projectName,
              workflowSetup: {
                ...task.workflowSetup,
                pluginProject:        projectName,
                desiredPluginProject: undefined,
              },
            }).catch(() => {});
            setDevPanelRefreshTick((t) => t + 1);
            setFeedback(`Plugin project created: ${projectName}`);
          }}
          onStartDevelopment={handleStartDevelopmentConfirmed}
          onClose={() => setShowStartDevModal(false)}
          aiKitPath={settings?.powerPlatformAiKitPath}
          crmBaseDirectory={settings?.crmBaseDirectory}
          onImplementWithAiKit={async (createdArtifactPath?: string) => {
            setShowStartDevModal(false);

            if (createdArtifactPath) {
              // Create-flow: the modal already generated and saved the skeleton file.
              // Persist artifactPath now (before startImplement reads it) and also
              // add the file to the .csproj when applicable.
              try {
                await updateTask(task.id, {
                  workflowSetup: {
                    ...task.workflowSetup,
                    artifactPath: createdArtifactPath,
                  },
                });
                await tauriApi.addCompileIncludeToCsproj(createdArtifactPath).catch(() => {});
              } catch {
                // Non-fatal — startImplement receives the path directly so it will
                // still work even if the task-save partially failed.
              }
              // Start development if needed, then implement using the explicit path.
              if (task.status !== 'in-progress') {
                handleStartDevelopmentConfirmed().then(() => {
                  aiKitPanelRef.current?.startImplement(createdArtifactPath);
                }).catch(() => {});
              } else {
                aiKitPanelRef.current?.startImplement(createdArtifactPath);
              }
            } else {
              // Existing flow: artifactPath already in task.workflowSetup.
              if (task.status !== 'in-progress') {
                handleStartDevelopmentConfirmed().then(() => {
                  aiKitPanelRef.current?.startImplement();
                }).catch(() => {});
              } else {
                aiKitPanelRef.current?.startImplement();
              }
            }
          }}
          onScriptFileCreated={async (createdPath) => {
            // Record file creation activity and persist the artifact path.
            // Development start remains an explicit user action ("Start Development" button).
            const now = new Date().toISOString();
            const note = `[${now}] UI: script-file-created`;
            const existing = task.notes?.trim() ?? '';
            await updateTask(task.id, {
              workflowSetup: {
                ...task.workflowSetup,
                scriptPath:   createdPath,
                artifactPath: createdPath,
              },
              notes: existing ? `${existing}\n${note}` : note,
            });
          }}
        />
      )}

      {/* AI Kit testing gate — warning before moving to consultant testing */}
      {aiKitTestingGate && (
        <Modal
          title="AI Kit Review Warning"
          onClose={() => setAiKitTestingGate(null)}
        >
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            {aiKitTestingGate.severity === 'fail' && (
              <p style={{ color: 'var(--color-blocked, #e05555)', margin: '0 0 12px 0' }}>
                The latest AI Kit review returned <strong>FAIL</strong> — there are blocking issues
                that should be fixed before sending to consultant testing.
                Apply AI Review Fixes or resolve the issues manually first.
              </p>
            )}
            {aiKitTestingGate.severity === 'warn' && (
              <p style={{ color: 'var(--color-warning, #d29922)', margin: '0 0 12px 0' }}>
                The latest AI Kit review returned <strong>WARN</strong> — there are warnings
                that should be addressed. You may continue to testing, but consider applying fixes first.
              </p>
            )}
            {aiKitTestingGate.severity === 'no-review' && (
              <p style={{ color: 'var(--color-warning, #d29922)', margin: '0 0 12px 0' }}>
                No AI Kit diff review has been run for the current changes.
                Consider running "Review Diff with AI Kit" before sending to testing.
              </p>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              {aiKitTestingGate.severity === 'fail' ? (
                <button
                  className="btn btn-danger btn-sm"
                  onClick={async () => { await aiKitTestingGate.onConfirm(); setAiKitTestingGate(null); }}
                >
                  Override — Continue to Testing
                </button>
              ) : (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={async () => { await aiKitTestingGate.onConfirm(); setAiKitTestingGate(null); }}
                >
                  Continue to Testing
                </button>
              )}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setAiKitTestingGate(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Git commit modal */}
      {showGitCommitModal && repoRootForGit && (
        <GitCommitModal
          task={task}
          customer={customer ?? null}
          repoRoot={repoRootForGit}
          postCommitPushAction={gitCommitGuidedMode ? 'move-to-review-and-open-ado' : undefined}
          onPostCommitPushSuccess={gitCommitGuidedMode ? handleGitCommitMoveToReview : undefined}
          onCommitOnlySuccess={gitCommitGuidedMode ? handleGitCommitOnlyGuided : undefined}
          onPushOnlySuccess={gitCommitGuidedMode ? handleGitPushOnlyMoveToReview : undefined}
          onClose={() => { setShowGitCommitModal(false); setGitCommitGuidedMode(false); }}
          onActivityNote={(note) => void handleGitActivityNote(note)}
        />
      )}

      {/* Testing actions modal */}
      {showTestingActionsModal && (
        <div className="modal-overlay" onClick={() => setShowTestingActionsModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="testing-modal-title">
            <div className="modal-header">
              <h3 className="modal-title" id="testing-modal-title">Testing actions</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowTestingActionsModal(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-sm)' }}>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-muted)' }}>
                Testing in progress — waiting for consultant testing.
              </p>
              {/* Azure DevOps URL hint — shows customer name and what is/isn't configured */}
              {(() => {
                const resolution  = buildAzureDevOpsRepoUrl(task, customer ?? null);
                const workItemUrl = task.devopsTaskUrl;
                const custName    = customer?.name ?? 'unknown customer';
                const repoName    = customer?.repositoryName;
                const repoUrl     = customer?.azureDevOpsRepoUrl;

                if (resolution?.kind === 'repo') {
                  return (
                    <p style={{ margin: 0, fontSize: 12, wordBreak: 'break-all', color: 'var(--color-text-muted)' }}>
                      Repository: <span style={{ color: 'var(--color-accent)' }}>{resolution.url}</span>
                    </p>
                  );
                }
                if (resolution?.kind === 'work-item') {
                  return (
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <p style={{ margin: 0 }}>
                        Repository URL not configured for <strong>{custName}</strong>.
                        {!repoName && <span> Set <code style={{ fontSize: 11 }}>repositoryName</code> for {custName}.</span>}
                      </p>
                      <p style={{ margin: 0 }}>Fallback: Azure DevOps work item will be opened.</p>
                      <p style={{ margin: 0, wordBreak: 'break-all', opacity: 0.75 }}>Work item: {resolution.url}</p>
                    </div>
                  );
                }
                return (
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <p style={{ margin: 0 }}>
                      Repository URL not configured for <strong>{custName}</strong>.
                    </p>
                    <p style={{ margin: 0, opacity: 0.8 }}>
                      repositoryName: <span style={{ fontStyle: repoName ? 'normal' : 'italic' }}>{repoName ?? '(not set)'}</span>
                      {' · '}
                      azureDevOpsRepoUrl: <span style={{ fontStyle: repoUrl ? 'normal' : 'italic' }}>{repoUrl ?? '(not set)'}</span>
                    </p>
                    <p style={{ margin: 0 }}>
                      Configure <code style={{ fontSize: 11 }}>repositoryName</code> or <code style={{ fontSize: 11 }}>azureDevOpsRepoUrl</code> for {custName} in workspace settings.
                    </p>
                    {workItemUrl && (
                      <p style={{ margin: 0, wordBreak: 'break-all', opacity: 0.75 }}>Work item: {workItemUrl}</p>
                    )}
                  </div>
                );
              })()}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleTestingBackToDev}
                >
                  Back to Development
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleTestingFailed}
                >
                  Testing failed
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleTestingConfirmedPreparePR()}
                  title={repoRootForGit
                    ? 'Marks testing confirmed and opens commit dialog — Commit + Push will move to Code Review and open Azure DevOps'
                    : 'Marks testing confirmed — Git repository not configured, configure it before moving to Code Review'}
                >
                  Testing confirmed → Prepare commit / PR
                </button>
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowTestingActionsModal(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Implementation Verification modal */}
      {showImplVerifyModal && (
        <ImplementationVerificationModal
          task={task}
          customer={customer}
          selectedPluginProject={selectedPluginProject}
          targetKind={task.workflowSetup?.devTargetKind ?? 'plugin'}
          resolvedArtifactPath={modalArtifactPath ?? task.workflowSetup?.artifactPath ?? task.workflowSetup?.scriptPath ?? null}
          artifactInferred={modalArtifactInferred && !task.workflowSetup?.artifactPath && !task.workflowSetup?.scriptPath}
          buildCheckRunning={implVerifyBuildRunning}
          dataverseCheckRunning={implVerifyDvRunning}
          aiCodeReviewRunning={implVerifyAiRunning}
          onRunBuildCheck={handleRunBuildCheckForImpl}
          onRunDataverseCheck={handleRunDataverseCheckForImpl}
          onRunAiCodeReview={handleRunAiCodeReviewForImpl}
          onRunSettingsReviewer={handleRunSettingsReviewerForImpl}
          onUpdate={handleUpdateImplVerification}
          onContinueToTesting={handleContinueToTestingWithGate}
          onProceedToReview={async () => {
            await handleMarkWaitingForReview();
            setShowImplVerifyModal(false);
          }}
          onUpdateNextStepAndClose={async (nextStep) => {
            await updateTask(task.id, {
              mcpNextStep: {
                action: nextStep,
                reason: 'Updated from Implementation Verification.',
                updatedAt: new Date().toISOString(),
              },
            });
            setFeedback(`Next step set: "${nextStep}"`);
            setShowImplVerifyModal(false);
          }}
          onOpenAiReview={() => {
            const reviewId = task.implementationVerification?.aiCodeReview?.reviewId;
            const target = reviewId
              ? task.aiFileReviews?.find((r) => r.id === reviewId)
              : task.aiFileReviews?.[0];
            if (target) setSavedReviewModal(target);
          }}
          onOpenDvReview={latestCrmVerification ? () => setShowCrmVerificationModal(true) : undefined}
          onResetDvCheck={handleResetDvCheck}
          onResetAiReview={handleResetAiReview}
          onClose={() => setShowImplVerifyModal(false)}
        />
      )}

      {/* Create Plugin Project modal */}
      {showCreatePlugin && customer && pluginsDir && (
        <CreatePluginProjectModal
          task={task}
          customer={customer}
          pluginsDir={pluginsDir}
          existingPluginProjects={pluginProjectsForModal}
          onCreated={(path) => {
            setShowCreatePlugin(false);
            const projectName = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
            if (projectName) {
              // Persist both the task-level field and workflowSetup.pluginProject so the
              // derived selectedPluginProject and the Dev panel both pick it up after refresh.
              // Clear desiredPluginProject — the project now exists, the desired name fulfilled.
              updateTask(task.id, {
                selectedPluginProject: projectName,
                workflowSetup: {
                  ...task.workflowSetup,
                  pluginProject:        projectName,
                  desiredPluginProject: undefined,
                },
              }).catch(() => {});
            }
            setDevPanelRefreshTick((t) => t + 1);
            setFeedback(`Plugin project created: ${projectName || path}`);
          }}
          onClose={() => setShowCreatePlugin(false)}
        />
      )}

      {/* Edit task form */}
      {showEditForm && (
        <TaskForm
          initialTask={task}
          onClose={() => setShowEditForm(false)}
        />
      )}

      {/* AI Code Review — full PR-style view of the selected saved review */}
      {savedReviewModal && (() => {
        // Determine whether this is a plugin review.
        // The reviewed file extension is the primary signal — it is stored on the
        // review result itself and cannot lie. devTargetKind is used only as a
        // tiebreaker when the extension is ambiguous (e.g. .ts could be either).
        const reviewFilePath = savedReviewModal.filePath ?? savedReviewModal.structured?.filePath ?? '';
        const lowerReviewPath = reviewFilePath.toLowerCase();
        const reviewKind: 'plugin' | 'script' = (() => {
          // Extension wins for unambiguous types.
          if (lowerReviewPath.endsWith('.cs')) return 'plugin';
          if (lowerReviewPath.endsWith('.js')) return 'script';
          // For .ts files, use devTargetKind as tiebreaker (plugins don't normally use .ts).
          const devKind = task.workflowSetup?.devTargetKind;
          if (devKind === 'plugin') return 'plugin';
          return 'script';
        })();

        const isPlugin = reviewKind === 'plugin';

        async function handleReviewOpen(fp: string) {
          const err = await openReviewTarget(fp, reviewKind);
          if (err) setFsError(err);
        }

        return (
          <Modal
            title="AI recenze kódu"
            size="xl"
            onClose={() => setSavedReviewModal(null)}
            footer={
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setSavedReviewModal(null)}
                type="button"
              >
                Zavřít
              </button>
            }
          >
            <div className="ai-review-modal-body">
              <div className="ai-review-modal-result">
                <AiReviewResultView
                  structured={savedReviewModal.structured}
                  markdown={savedReviewModal.markdown}
                  onOpenFile={handleReviewOpen}
                  openLabel={isPlugin ? 'Otevřít projekt' : 'Otevřít soubor'}
                  openTitle={isPlugin ? 'Otevře .sln ve Visual Studiu, pokud existuje.' : 'Otevře soubor ve VS Code.'}
                />
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* Live Primarch verification modal */}
      {showPrimarchVerifyModal && (
        <PrimarchVerificationModal
          filePath={primarchVerifyFilePath}
          steps={primarchVerifySteps}
          running={primarchActionLoading === 'verify'}
          result={primarchVerifyResult}
          error={primarchVerifyError}
          primaryEntityOverride={primarchPrimaryEntityOverride.trim() || undefined}
          crmMetadataEnabled={!!settings.crmMetadataEnabled}
          mcpCommandConfigured={!!(settings.primarchMcpCommand ?? '').trim()}
          mcpArgsConfigured={!!(settings.primarchMcpArgs ?? '').trim()}
          onClose={handleClosePrimarchVerifyModal}
        />
      )}

      {/* CRM Skeleton modal */}
      {showCrmSkeletonModal && latestCrmSkeleton && (
        <Modal
          title="CRM Skeleton"
          size="xl"
          onClose={() => setShowCrmSkeletonModal(false)}
          footer={
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowCrmSkeletonModal(false)}
              type="button"
            >
              Close
            </button>
          }
        >
          <CrmSkeletonResultView result={latestCrmSkeleton} />
        </Modal>
      )}

      {/* CRM Verification modal */}
      {showCrmVerificationModal && latestCrmVerification && (
        <Modal
          title="CRM Verification Report"
          size="xl"
          onClose={() => setShowCrmVerificationModal(false)}
          footer={
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowCrmVerificationModal(false)}
              type="button"
            >
              Close
            </button>
          }
        >
          <CrmVerificationReportView report={latestCrmVerification} />
        </Modal>
      )}

      {crmExecutionPreview && (
        <CrmExecutionPreviewModal
          preview={crmExecutionPreview}
          onClose={() => setCrmExecutionPreview(null)}
        />
      )}
    </>
  );
}
