import { useState } from 'react';
import type { Task } from '../types';
import {
  buildCrmExternalActionProposals,
  buildCrmDeveloperWorkflowChecklist,
  buildCrmDraftContextFromPullRequestFixProposal,
  detectCrmDeveloperWorkKind,
  getCrmCodeGenerationReadiness,
  getCrmDiffReviewStatus,
  getCrmExternalActionApprovalStatus,
  getCrmExternalExecutionStatus,
  getLatestCrmVerificationSummary,
  getCrmPullRequestProposalStatus,
  getCrmPullRequestFixProposalStatus,
  getCrmPullRequestReviewAnalysisStatus,
  getCrmPullRequestReviewStatus,
  getCrmPullRequestFixUpdateStatus,
  getCrmPostFixReviewRefreshStatus,
  getCrmPullRequestTrackingStatus,
} from '../lib/crmDeveloperWorkflow';
import Icon from './Icon';

interface CrmDeveloperWorkflowPanelProps {
  task: Task;
  onSaveDiagnosisState?: () => Promise<void> | void;
  onVerifyMetadata?: () => Promise<void> | void;
  onGenerateTechnicalPlan?: () => Promise<void> | void;
  onApproveTechnicalPlan?: () => Promise<void> | void;
  onRevokeTechnicalPlanApproval?: () => Promise<void> | void;
  onApproveDiffReview?: () => Promise<void> | void;
  onRevokeDiffReviewApproval?: () => Promise<void> | void;
  onApproveExternalActionPlan?: () => Promise<void> | void;
  onRevokeExternalActionApproval?: () => Promise<void> | void;
  onOpenExecutionPreview?: () => void;
  onMarkExternalExecutionCompleted?: (notes: string) => Promise<void> | void;
  onRevokeExternalExecution?: () => Promise<void> | void;
  onGeneratePullRequestProposal?: () => Promise<void> | void;
  onMarkPullRequestCreatedManually?: (prUrl: string, notes: string) => Promise<void> | void;
  onRevokePullRequestTracking?: () => Promise<void> | void;
  onFetchPullRequestReviewStatus?: () => Promise<void> | void;
  onGeneratePullRequestReviewAnalysis?: () => Promise<void> | void;
  onGeneratePullRequestFixProposal?: () => Promise<void> | void;
  onUseFixProposalForDraftGeneration?: () => Promise<void> | void;
  onMarkPullRequestFixUpdatedManually?: (notes: string, commitSha: string, branchName: string) => Promise<void> | void;
  onRevokePullRequestFixUpdateTracking?: () => Promise<void> | void;
  savingState?: boolean;
  verifyingMetadata?: boolean;
  generatingTechnicalPlan?: boolean;
  savingPlanApproval?: boolean;
  savingDiffApproval?: boolean;
  savingExternalActionApproval?: boolean;
  savingExternalExecution?: boolean;
  savingPullRequest?: boolean;
  savingPullRequestReview?: boolean;
  savingPullRequestReviewAnalysis?: boolean;
  savingPullRequestFixProposal?: boolean;
  savingPullRequestFixUpdate?: boolean;
  generatingDraftFromFixProposal?: boolean;
  metadataVerificationDisabled?: boolean;
  metadataVerificationDisabledReason?: string;
}

const KIND_LABELS: Record<ReturnType<typeof detectCrmDeveloperWorkKind>['kind'], string> = {
  plugin: 'Plugin',
  script: 'Script',
  ribbon: 'Ribbon / command bar',
  'repo-only': 'Repo-only',
  bugfix: 'Bugfix',
  review: 'Review',
  unknown: 'Unknown',
};

function formatVerdict(verdict: string): string {
  return verdict.replace(/_/g, ' ').toUpperCase();
}

function formatDate(value: string | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

function checkpointLabel(verdict: string): string {
  switch (verdict) {
    case 'pass': return 'verified';
    case 'warnings': return 'verified with warnings';
    case 'fail': return 'verified with issues';
    default: return '';
  }
}

function PlanList({ title, items }: { title: string; items: string[] | undefined }) {
  if (!items?.length) return null;
  return (
    <div className="crm-workflow-plan-block">
      <div className="crm-workflow-muted-label">{title}</div>
      <ul className="crm-workflow-plan-list">
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function formatProposalType(type: string): string {
  return type.replace(/-/g, ' ');
}

function ProposalPayload({ payload }: { payload: Record<string, string | string[] | undefined> | undefined }) {
  const entries = Object.entries(payload ?? {}).filter(([, value]) => (
    Array.isArray(value) ? value.length > 0 : !!value
  ));
  if (entries.length === 0) return null;

  return (
    <div className="crm-workflow-proposal-payload">
      {entries.map(([key, value]) => (
        <span key={key}>
          {key}: {Array.isArray(value) ? value.join(', ') : value}
        </span>
      ))}
    </div>
  );
}

function CrmWorkflowChecklist({
  items,
}: {
  items: ReturnType<typeof buildCrmDeveloperWorkflowChecklist>;
}) {
  return (
    <div className="crm-workflow-checklist" aria-label="CRM developer workflow checklist">
      {items.map((item) => (
        <div
          key={item.id}
          className={`crm-workflow-checklist-item${item.complete ? ' crm-workflow-checklist-item--complete' : ''}`}
        >
          <span className="crm-workflow-check-icon" aria-hidden="true">
            {item.complete ? <Icon name="check" size={12} /> : '-'}
          </span>
          <div className="crm-workflow-check-copy">
            <div className="crm-workflow-check-label">{item.label}</div>
            <div className="crm-workflow-check-detail">{item.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CrmDeveloperWorkflowPanel({
  task,
  onSaveDiagnosisState,
  onVerifyMetadata,
  onGenerateTechnicalPlan,
  onApproveTechnicalPlan,
  onRevokeTechnicalPlanApproval,
  onApproveDiffReview,
  onRevokeDiffReviewApproval,
  onApproveExternalActionPlan,
  onRevokeExternalActionApproval,
  onOpenExecutionPreview,
  onMarkExternalExecutionCompleted,
  onRevokeExternalExecution,
  onGeneratePullRequestProposal,
  onMarkPullRequestCreatedManually,
  onRevokePullRequestTracking,
  onFetchPullRequestReviewStatus,
  onGeneratePullRequestReviewAnalysis,
  onGeneratePullRequestFixProposal,
  onUseFixProposalForDraftGeneration,
  onMarkPullRequestFixUpdatedManually,
  onRevokePullRequestFixUpdateTracking,
  savingState = false,
  verifyingMetadata = false,
  generatingTechnicalPlan = false,
  savingPlanApproval = false,
  savingDiffApproval = false,
  savingExternalActionApproval = false,
  savingExternalExecution = false,
  savingPullRequest = false,
  savingPullRequestReview = false,
  savingPullRequestReviewAnalysis = false,
  savingPullRequestFixProposal = false,
  savingPullRequestFixUpdate = false,
  generatingDraftFromFixProposal = false,
  metadataVerificationDisabled = false,
  metadataVerificationDisabledReason,
}: CrmDeveloperWorkflowPanelProps) {
  const [executionNote, setExecutionNote] = useState('');
  const [manualPrUrl, setManualPrUrl] = useState(task.crmDeveloperWorkflow?.pullRequestTracking?.prUrl ?? '');
  const [manualPrNotes, setManualPrNotes] = useState(task.crmDeveloperWorkflow?.pullRequestTracking?.notes ?? '');
  const [manualFixUpdateNotes, setManualFixUpdateNotes] = useState(task.crmDeveloperWorkflow?.pullRequestFixUpdateTracking?.notes ?? '');
  const [manualFixUpdateCommitSha, setManualFixUpdateCommitSha] = useState(task.crmDeveloperWorkflow?.pullRequestFixUpdateTracking?.commitSha ?? '');
  const [manualFixUpdateBranch, setManualFixUpdateBranch] = useState(task.crmDeveloperWorkflow?.pullRequestFixUpdateTracking?.branchName ?? '');
  const detection = detectCrmDeveloperWorkKind(task);
  const checklist = buildCrmDeveloperWorkflowChecklist(task);
  const verification = getLatestCrmVerificationSummary(task);
  const persistedState = task.crmDeveloperWorkflow;
  const technicalPlan = persistedState?.technicalPlan;
  const planApproval = persistedState?.planApproval;
  const planApproved = !!planApproval?.approved;
  const codeReadiness = getCrmCodeGenerationReadiness(task);
  const diffReview = getCrmDiffReviewStatus(task);
  const externalProposals = buildCrmExternalActionProposals(task);
  const externalApproval = getCrmExternalActionApprovalStatus(task);
  const executionStatus = getCrmExternalExecutionStatus(task);
  const prProposalStatus = getCrmPullRequestProposalStatus(task);
  const prTrackingStatus = getCrmPullRequestTrackingStatus(task);
  const prReviewStatus = getCrmPullRequestReviewStatus(task);
  const prReviewAnalysisStatus = getCrmPullRequestReviewAnalysisStatus(task);
  const prFixProposalStatus = getCrmPullRequestFixProposalStatus(task);
  const fixDraftContext = buildCrmDraftContextFromPullRequestFixProposal(task);
  const fixProposalDraftReady = fixDraftContext.ready && codeReadiness.ready;
  const fixUpdateStatus = getCrmPullRequestFixUpdateStatus(task);
  const postFixRefreshStatus = getCrmPostFixReviewRefreshStatus(task);
  const diffApproval = persistedState?.diffApproval;
  const externalApprovalGate = persistedState?.externalActionApproval;
  const executionTracking = persistedState?.externalExecution;
  const prProposal = persistedState?.pullRequestProposal;
  const prTracking = persistedState?.pullRequestTracking;
  const prReview = persistedState?.pullRequestReview;
  const prReviewAnalysis = persistedState?.pullRequestReviewAnalysis;
  const prFixProposal = persistedState?.pullRequestFixProposal;
  const fixUpdateTracking = persistedState?.pullRequestFixUpdateTracking;
  const codeReadinessStatus = codeReadiness.ready
    ? codeReadiness.warnings.length > 0
      ? 'READY WITH WARNINGS'
      : 'READY'
    : 'NOT READY';

  return (
    <div className="crm-workflow-panel">
      <div className="crm-workflow-header">
        <div>
          <div className="crm-workflow-title">CRM Developer Workflow</div>
          <div className="crm-workflow-subtitle">
            Read-only diagnosis. Later workflow gates are shown as a preview only.
          </div>
        </div>
        <span className={`crm-workflow-kind crm-workflow-kind--${detection.kind}`}>
          {KIND_LABELS[detection.kind]}
        </span>
      </div>

      <div className="crm-workflow-detection">
        <div className="crm-workflow-detection-row">
          <span className="crm-workflow-muted-label">Detection source</span>
          <span>{detection.source}</span>
        </div>
        <div className="crm-workflow-detection-row">
          <span className="crm-workflow-muted-label">Reason</span>
          <span>{detection.detail}</span>
        </div>
        <div className="crm-workflow-detection-row">
          <span className="crm-workflow-muted-label">Persisted state</span>
          <span>
            {persistedState
              ? `${persistedState.detectedWorkKind ?? 'unknown'} / ${persistedState.currentStep ?? 'diagnosis'}`
              : 'Not saved yet'}
          </span>
          {persistedState?.updatedAt && (
            <span className="crm-workflow-state-updated">
              updated {formatDate(persistedState.updatedAt)}
            </span>
          )}
        </div>
        {onSaveDiagnosisState && (
          <button
            className="btn btn-secondary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onSaveDiagnosisState(); }}
            disabled={savingState}
            title="Save the current diagnosis to this local task only"
          >
            {savingState
              ? <><span className="btn-spinner" /> Saving...</>
              : <><Icon name="check" size={12} /> Save diagnosis state</>}
          </button>
        )}
      </div>

      <CrmWorkflowChecklist items={checklist} />

      <div className="crm-workflow-verification">
        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">Latest CRM verification</span>
          <span className={`crm-workflow-verdict crm-workflow-verdict--${verification.verdict}`}>
            {verification.exists ? formatVerdict(verification.verdict) : 'NO REPORT'}
          </span>
          {verification.checkpointComplete && (
            <span className={`crm-workflow-checkpoint-state crm-workflow-checkpoint-state--${verification.verdict}`}>
              {checkpointLabel(verification.verdict)}
            </span>
          )}
        </div>
        <div className="crm-workflow-verification-summary">{verification.summary}</div>
        {verification.verdict === 'fail' && (
          <div className="crm-workflow-verification-summary">
            Verification completed, but metadata issues were found. Resolve or explicitly account for them before implementation.
          </div>
        )}
        {verification.verdict === 'warnings' && (
          <div className="crm-workflow-verification-summary">
            Verification completed with warnings. Review unresolved references before implementation.
          </div>
        )}
        {!verification.exists && (
          <div className="crm-workflow-verification-summary">
            Not verified yet. Run read-only metadata verification before creating a technical plan.
          </div>
        )}
        {verification.exists && !verification.checkpointComplete && (
          <div className="crm-workflow-verification-summary">
            This report does not complete the checkpoint. Resolve configuration/errors or verify again.
          </div>
        )}
        {verification.exists && (
          <div className="crm-workflow-verification-meta">
            {verification.createdAt && <span>{formatDate(verification.createdAt)}</span>}
            <span>{verification.issueCount ?? 0} issues</span>
            <span>{verification.inspectedEntityCount ?? 0} entities inspected</span>
          </div>
        )}
        {onVerifyMetadata && (
          <button
            className="btn btn-secondary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onVerifyMetadata(); }}
            disabled={verifyingMetadata || metadataVerificationDisabled}
            title={metadataVerificationDisabled ? metadataVerificationDisabledReason : 'Run existing read-only Primarch metadata verification'}
          >
            {verifyingMetadata
              ? <><span className="btn-spinner" /> Verifying...</>
              : <><Icon name="search" size={12} /> Verify Dataverse metadata</>}
          </button>
        )}
        {metadataVerificationDisabled && metadataVerificationDisabledReason && (
          <div className="crm-workflow-verification-summary">{metadataVerificationDisabledReason}</div>
        )}
      </div>

      <div className="crm-workflow-plan">
        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">Technical implementation plan</span>
          <span className={`crm-workflow-verdict ${technicalPlan ? 'crm-workflow-verdict--pass' : ''}`}>
            {technicalPlan ? 'DRAFT SAVED' : 'NO PLAN'}
          </span>
          {planApproved && (
            <span className="crm-workflow-checkpoint-state">
              approved
            </span>
          )}
        </div>
        {!technicalPlan && (
          <div className="crm-workflow-verification-summary">
            No draft technical plan is saved yet. Generate a local planning draft before any future code generation step.
          </div>
        )}
        {verification.verdict === 'fail' && (
          <div className="crm-workflow-verification-summary">
            Plan must account for verification issues.
          </div>
        )}
        {!verification.exists && (
          <div className="crm-workflow-verification-summary">
            Plan will be generated without verified Dataverse metadata.
          </div>
        )}
        {verification.verdict === 'warnings' && (
          <div className="crm-workflow-verification-summary">
            Plan should account for metadata verification warnings.
          </div>
        )}
        {technicalPlan && (
          <div className="crm-workflow-plan-content">
            <div className="crm-workflow-verification-meta">
              <span>Generated {formatDate(technicalPlan.generatedAt)}</span>
              <span>Work kind: {KIND_LABELS[technicalPlan.workKind]}</span>
              {technicalPlan.generatedFromVerificationReportId && <span>Based on latest meaningful verification</span>}
            </div>
            <div className={`crm-workflow-approval-state${planApproved ? ' crm-workflow-approval-state--approved' : ''}`}>
              {planApproved
                ? `Technical plan approved${planApproval?.approvedAt ? ` ${formatDate(planApproval.approvedAt)}` : ''}.`
                : 'Technical plan is not approved yet.'}
              {!planApproved && planApproval?.invalidatedAt && (
                <span>
                  Previous approval invalidated {formatDate(planApproval.invalidatedAt)}
                  {planApproval.invalidationReason ? `: ${planApproval.invalidationReason}.` : '.'}
                </span>
              )}
            </div>
            {planApproved && verification.verdict === 'fail' && (
              <div className="crm-workflow-verification-summary">
                Plan approved with known verification issues.
              </div>
            )}
            <div className="crm-workflow-plan-summary">{technicalPlan.summary}</div>
            {technicalPlan.target && (
              <div className="crm-workflow-plan-target">
                {technicalPlan.target.entityLogicalName && <span>Entity: {technicalPlan.target.entityLogicalName}</span>}
                {technicalPlan.target.message && <span>Message: {technicalPlan.target.message}</span>}
                {technicalPlan.target.stage && <span>Stage: {technicalPlan.target.stage}</span>}
                {technicalPlan.target.mode && <span>Mode: {technicalPlan.target.mode}</span>}
                {technicalPlan.target.pluginProject && <span>Plugin: {technicalPlan.target.pluginProject}</span>}
                {technicalPlan.target.scriptPath && <span>Script: {technicalPlan.target.scriptPath}</span>}
              </div>
            )}
            <PlanList title="Implementation steps" items={technicalPlan.implementationSteps} />
            <PlanList title="Dataverse findings" items={technicalPlan.dataverseFindings} />
            <PlanList title="Risks" items={technicalPlan.risks} />
            <PlanList title="Test checklist" items={technicalPlan.testChecklist} />
            <PlanList title="External action preview" items={technicalPlan.externalActionPreview} />
            <div className="crm-workflow-verification-summary">
              Draft only. Technical plan approval does not generate code or touch external systems.
            </div>
            {!planApproved && (
              <div className="crm-workflow-verification-summary">
                Approving this plan only records local approval for a future code-generation step.
              </div>
            )}
            {!verification.exists && (
              <div className="crm-workflow-verification-summary">
                Approval is allowed, but this plan was prepared without verified Dataverse metadata.
              </div>
            )}
            {verification.verdict === 'fail' && !planApproved && (
              <div className="crm-workflow-verification-summary">
                Approving now means approving with known verification issues.
              </div>
            )}
            {verification.verdict === 'warnings' && !planApproved && (
              <div className="crm-workflow-verification-summary">
                Approving now means accepting the metadata verification warnings for planning purposes.
              </div>
            )}
          </div>
        )}
        {technicalPlan && !planApproved && onApproveTechnicalPlan && (
          <button
            className="btn btn-primary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onApproveTechnicalPlan(); }}
            disabled={savingPlanApproval}
            title="Approve this local draft plan without generating code"
          >
            {savingPlanApproval
              ? <><span className="btn-spinner" /> Saving...</>
              : <><Icon name="check" size={12} /> Approve technical plan</>}
          </button>
        )}
        {technicalPlan && planApproved && onRevokeTechnicalPlanApproval && (
          <button
            className="btn btn-secondary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onRevokeTechnicalPlanApproval(); }}
            disabled={savingPlanApproval}
            title="Revoke local technical plan approval"
          >
            {savingPlanApproval
              ? <><span className="btn-spinner" /> Saving...</>
              : 'Revoke approval'}
          </button>
        )}
        {onGenerateTechnicalPlan && (
          <button
            className="btn btn-secondary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onGenerateTechnicalPlan(); }}
            disabled={generatingTechnicalPlan}
            title="Generate a local draft technical plan without editing files or external systems"
          >
            {generatingTechnicalPlan
              ? <><span className="btn-spinner" /> Generating...</>
              : <><Icon name="layers" size={12} /> Generate technical plan</>}
          </button>
        )}
      </div>

      <div className="crm-workflow-readiness">
        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">Code generation readiness</span>
          <span className={`crm-workflow-verdict ${
            codeReadiness.ready
              ? codeReadiness.warnings.length > 0
                ? 'crm-workflow-verdict--warnings'
                : 'crm-workflow-verdict--pass'
              : 'crm-workflow-verdict--error'
          }`}>
            {codeReadinessStatus}
          </span>
        </div>
        <div className="crm-workflow-verification-summary">{codeReadiness.reason}</div>
        {codeReadiness.blockers.length > 0 && (
          <PlanList title="Blockers" items={codeReadiness.blockers} />
        )}
        {codeReadiness.warnings.length > 0 && (
          <PlanList title="Warnings" items={codeReadiness.warnings} />
        )}
        <div className="crm-workflow-verification-summary">
          This readiness gate only controls whether future draft/code generation should be allowed. It does not generate code or write files.
        </div>
      </div>

      <div className="crm-workflow-diff">
        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">Diff review</span>
          <span className={`crm-workflow-verdict ${
            diffReview.approved
              ? diffReview.warnings.length > 0
                ? 'crm-workflow-verdict--warnings'
                : 'crm-workflow-verdict--pass'
              : diffReview.approvable
                ? 'crm-workflow-verdict--warnings'
                : 'crm-workflow-verdict--error'
          }`}>
            {diffReview.approved
              ? diffReview.warnings.length > 0 ? 'APPROVED WITH WARNINGS' : 'APPROVED'
              : diffReview.approvable ? 'READY FOR APPROVAL' : 'NOT READY'}
          </span>
        </div>
        <div className="crm-workflow-verification-summary">{diffReview.reason}</div>
        {diffApproval?.approvedAt && diffReview.approved && (
          <div className="crm-workflow-verification-meta">
            <span>Approved {formatDate(diffApproval.approvedAt)}</span>
          </div>
        )}
        {diffReview.hasReviewableChanges ? (
          <div className="crm-workflow-verification-summary">
            Reviewable changes are based on a saved generated artifact or a saved AI file/diff review.
          </div>
        ) : (
          <div className="crm-workflow-verification-summary">
            No generated artifact or saved code review is available yet.
          </div>
        )}
        {diffReview.blockers.length > 0 && (
          <PlanList title="Blockers" items={diffReview.blockers} />
        )}
        {diffReview.warnings.length > 0 && (
          <PlanList title="Warnings" items={diffReview.warnings} />
        )}
        {diffReview.approved && diffReview.warnings.length > 0 && (
          <div className="crm-workflow-verification-summary">
            Diff approved with warnings. Resolve or explicitly accept those warnings before any external action.
          </div>
        )}
        <div className="crm-workflow-verification-summary">
          Approving the diff only records local review approval. It does not register plugins, upload scripts, modify Dataverse, create commits, or create pull requests.
        </div>
        {diffReview.approvable && !diffReview.approved && onApproveDiffReview && (
          <button
            className="btn btn-primary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onApproveDiffReview(); }}
            disabled={savingDiffApproval}
            title="Approve reviewed code changes locally"
          >
            {savingDiffApproval
              ? <><span className="btn-spinner" /> Saving...</>
              : <><Icon name="check" size={12} /> Approve reviewed diff</>}
          </button>
        )}
        {diffReview.approved && onRevokeDiffReviewApproval && (
          <button
            className="btn btn-secondary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onRevokeDiffReviewApproval(); }}
            disabled={savingDiffApproval}
            title="Revoke local diff approval"
          >
            {savingDiffApproval
              ? <><span className="btn-spinner" /> Saving...</>
              : 'Revoke diff approval'}
          </button>
        )}
      </div>

      <div className="crm-workflow-proposals">
        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">External action proposals</span>
          <span className={`crm-workflow-verdict ${
            externalApproval.approved
              ? externalApproval.warnings.length > 0
                ? 'crm-workflow-verdict--warnings'
                : 'crm-workflow-verdict--pass'
              : externalApproval.approvable
                ? 'crm-workflow-verdict--warnings'
                : ''
          }`}>
            {externalApproval.approved
              ? externalApproval.warnings.length > 0 ? 'APPROVED WITH WARNINGS' : 'APPROVED'
              : 'PROPOSAL ONLY'}
          </span>
        </div>
        <div className="crm-workflow-verification-summary">
          These cards describe likely next external actions. They cannot execute anything in this PR.
        </div>
        <div className={`crm-workflow-approval-state${externalApproval.approved ? ' crm-workflow-approval-state--approved' : ''}`}>
          {externalApproval.reason}
          {externalApprovalGate?.approvedAt && externalApproval.approved && (
            <span>Approved {formatDate(externalApprovalGate.approvedAt)}</span>
          )}
          {!externalApproval.approved && externalApprovalGate?.invalidatedAt && (
            <span>
              Previous external action approval invalidated {formatDate(externalApprovalGate.invalidatedAt)}
              {externalApprovalGate.invalidationReason ? `: ${externalApprovalGate.invalidationReason}.` : '.'}
            </span>
          )}
        </div>
        {externalApproval.blockers.length > 0 && (
          <PlanList title="External approval blockers" items={externalApproval.blockers} />
        )}
        {externalApproval.warnings.length > 0 && (
          <PlanList title="External approval warnings" items={externalApproval.warnings} />
        )}
        {externalProposals.map((proposal) => (
          <div
            key={proposal.id}
            className={`crm-workflow-proposal-card crm-workflow-proposal-card--${proposal.riskLevel}`}
          >
            <div className="crm-workflow-proposal-header">
              <div>
                <div className="crm-workflow-check-label">{proposal.title}</div>
                <div className="crm-workflow-verification-summary">
                  {formatProposalType(proposal.type)} - risk: {proposal.riskLevel}
                </div>
              </div>
              <span className={`crm-workflow-verdict ${
                proposal.readyForFutureExecution ? 'crm-workflow-verdict--warnings' : 'crm-workflow-verdict--error'
              }`}>
                {proposal.readyForFutureExecution ? 'READY FOR FUTURE STEP' : 'BLOCKED'}
              </span>
            </div>
            <div className="crm-workflow-verification-summary">{proposal.description}</div>
            {proposal.blockedReason && (
              <div className="crm-workflow-verification-summary">
                Blocked: {proposal.blockedReason}
              </div>
            )}
            {proposal.warnings.length > 0 && (
              <PlanList title="Warnings" items={proposal.warnings} />
            )}
            <PlanList title="Required before execution" items={proposal.requiredBeforeExecution} />
            <ProposalPayload payload={proposal.previewPayload} />
            <button
              className="btn btn-secondary btn-sm crm-workflow-save-btn"
              type="button"
              disabled
              title="External execution is planned for a future explicit approval step"
            >
              Future step
            </button>
          </div>
        ))}
        <div className="crm-workflow-verification-summary">
          External action approval only records that the proposed action plan is acceptable for a future execution step. It does not register plugins, upload web resources, modify Dataverse, publish customizations, create commits, or create pull requests.
        </div>
        {externalApproval.approvable && !externalApproval.approved && onApproveExternalActionPlan && (
          <button
            className="btn btn-primary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onApproveExternalActionPlan(); }}
            disabled={savingExternalActionApproval}
            title="Approve proposed external actions locally without executing them"
          >
            {savingExternalActionApproval
              ? <><span className="btn-spinner" /> Saving...</>
              : <><Icon name="check" size={12} /> Approve external action plan</>}
          </button>
        )}
        {externalApproval.approved && onRevokeExternalActionApproval && (
          <button
            className="btn btn-secondary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onRevokeExternalActionApproval(); }}
            disabled={savingExternalActionApproval}
            title="Revoke local external action approval"
          >
            {savingExternalActionApproval
              ? <><span className="btn-spinner" /> Saving...</>
              : 'Revoke external action approval'}
          </button>
        )}
        {externalApproval.approved && onOpenExecutionPreview && (
          <button
            className="btn btn-primary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { onOpenExecutionPreview(); }}
            title="Open a read-only preview of what future execution would do"
          >
            <Icon name="eye" size={12} /> Open execution preview
          </button>
        )}
      </div>

      <div className="crm-workflow-execution-tracking">
        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">Manual execution tracking</span>
          <span className={`crm-workflow-verdict ${
            executionStatus.completed
              ? 'crm-workflow-verdict--pass'
              : executionStatus.invalidatedAt
                ? 'crm-workflow-verdict--error'
                : ''
          }`}>
            {executionStatus.completed ? 'COMPLETED' : executionStatus.invalidatedAt ? 'INVALIDATED' : 'NOT RECORDED'}
          </span>
        </div>
        <div className="crm-workflow-verification-summary">
          Local tracking only. The app never executes anything — this records that you completed external actions manually outside the app.
        </div>
        {executionStatus.completed && executionTracking?.completedAt && (
          <div className="crm-workflow-verification-meta">
            <span>Recorded {formatDate(executionTracking.completedAt)}</span>
          </div>
        )}
        {executionStatus.completed && executionTracking?.notes && (
          <div className="crm-workflow-verification-summary">
            Note: {executionTracking.notes}
          </div>
        )}
        {!executionStatus.completed && executionTracking?.invalidatedAt && (
          <div className="crm-workflow-verification-summary">
            Previous completion invalidated {formatDate(executionTracking.invalidatedAt)}
            {executionTracking.invalidationReason ? `: ${executionTracking.invalidationReason}.` : '.'}
          </div>
        )}
        {executionStatus.blockers.length > 0 && (
          <PlanList title="Blockers" items={executionStatus.blockers} />
        )}
        {executionStatus.completable && !executionStatus.completed && (onMarkExternalExecutionCompleted != null) && (
          <div className="crm-workflow-execution-note-form">
            <div className="crm-workflow-muted-label">Completion note (required)</div>
            <textarea
              className="crm-workflow-execution-note"
              value={executionNote}
              onChange={(e) => setExecutionNote(e.target.value)}
              placeholder="Describe what was done (e.g. plugin step registered in production, PR merged)."
              rows={3}
              maxLength={500}
            />
            <button
              className="btn btn-primary btn-sm crm-workflow-save-btn"
              type="button"
              onClick={() => {
                void onMarkExternalExecutionCompleted(executionNote);
                setExecutionNote('');
              }}
              disabled={savingExternalExecution || executionNote.trim().length === 0}
              title="Record that external actions were completed manually outside the app"
            >
              {savingExternalExecution
                ? <><span className="btn-spinner" /> Saving...</>
                : <><Icon name="check" size={12} /> Mark as manually completed</>}
            </button>
          </div>
        )}
        {executionStatus.completed && onRevokeExternalExecution && (
          <button
            className="btn btn-secondary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onRevokeExternalExecution(); }}
            disabled={savingExternalExecution}
            title="Revoke manual completion record"
          >
            {savingExternalExecution
              ? <><span className="btn-spinner" /> Saving...</>
              : 'Revoke completion record'}
          </button>
        )}
      </div>

      <div className="crm-workflow-pull-request">
        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">Pull request proposal</span>
          <span className={`crm-workflow-verdict ${
            prTrackingStatus.tracked
              ? 'crm-workflow-verdict--pass'
              : prProposalStatus.generated
                ? 'crm-workflow-verdict--warnings'
                : prProposalStatus.invalidatedAt || prTrackingStatus.invalidatedAt
                  ? 'crm-workflow-verdict--error'
                  : ''
          }`}>
            {prTrackingStatus.tracked
              ? 'MANUALLY TRACKED'
              : prProposalStatus.generated
                ? 'PROPOSAL GENERATED'
                : prProposalStatus.invalidatedAt || prTrackingStatus.invalidatedAt
                  ? 'INVALIDATED'
                  : 'NOT GENERATED'}
          </span>
        </div>
        <div className="crm-workflow-verification-summary">
          Local proposal only. The app prepares PR text, but does not create a branch, commit, or pull request.
        </div>
        <div className={`crm-workflow-approval-state${prProposalStatus.generated ? ' crm-workflow-approval-state--approved' : ''}`}>
          {prProposalStatus.reason}
          {prProposal?.generatedAt && prProposalStatus.generated && (
            <span>Generated {formatDate(prProposal.generatedAt)}</span>
          )}
          {prProposal?.invalidatedAt && !prProposalStatus.generated && (
            <span>
              Previous PR proposal invalidated {formatDate(prProposal.invalidatedAt)}
              {prProposal.invalidationReason ? `: ${prProposal.invalidationReason}.` : '.'}
            </span>
          )}
        </div>
        {prProposalStatus.blockers.length > 0 && (
          <PlanList title="PR proposal blockers" items={prProposalStatus.blockers} />
        )}
        {prProposalStatus.warnings.length > 0 && (
          <PlanList title="PR proposal warnings" items={prProposalStatus.warnings} />
        )}
        {onGeneratePullRequestProposal && (
          <button
            className="btn btn-primary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onGeneratePullRequestProposal(); }}
            disabled={savingPullRequest || !prProposalStatus.generatable}
            title="Generate local PR title and body without creating a branch, commit, or pull request"
          >
            {savingPullRequest
              ? <><span className="btn-spinner" /> Saving...</>
              : <><Icon name="check" size={12} /> Generate PR proposal</>}
          </button>
        )}
        {prProposal && !prProposal.invalidatedAt && (
          <div className="crm-workflow-pr-proposal-card">
            <div className="crm-workflow-muted-label">Suggested PR title</div>
            <textarea
              className="crm-workflow-copy-field"
              value={prProposal.title}
              readOnly
              rows={2}
            />
            <div className="crm-workflow-muted-label">Suggested PR body</div>
            <textarea
              className="crm-workflow-copy-field crm-workflow-copy-field--body"
              value={prProposal.body}
              readOnly
              rows={12}
            />
            <PlanList title="Checklist" items={prProposal.checklist} />
            {prProposal.warnings.length > 0 && (
              <PlanList title="Known warnings" items={prProposal.warnings} />
            )}
            {prProposal.relatedArtifactPath && (
              <div className="crm-workflow-verification-summary">
                Changed artifact hint: {prProposal.relatedArtifactPath}
              </div>
            )}
          </div>
        )}

        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">Manual PR tracking</span>
          <span className={`crm-workflow-verdict ${
            prTrackingStatus.tracked
              ? 'crm-workflow-verdict--pass'
              : prTrackingStatus.invalidatedAt
                ? 'crm-workflow-verdict--error'
                : ''
          }`}>
            {prTrackingStatus.tracked ? 'RECORDED' : prTrackingStatus.invalidatedAt ? 'INVALIDATED' : 'NOT RECORDED'}
          </span>
        </div>
        <div className="crm-workflow-verification-summary">
          Record a PR you created manually outside task-workbench. This does not call GitHub or Azure DevOps.
        </div>
        <div className="crm-workflow-approval-state">
          {prTrackingStatus.reason}
          {prTrackingStatus.tracked && prTracking?.createdAt && (
            <span>Recorded {formatDate(prTracking.createdAt)}</span>
          )}
          {prTracking?.prUrl && <span>PR URL: {prTracking.prUrl}</span>}
          {prTracking?.notes && <span>Note: {prTracking.notes}</span>}
          {!prTrackingStatus.tracked && prTracking?.invalidatedAt && (
            <span>
              Previous manual PR tracking invalidated {formatDate(prTracking.invalidatedAt)}
              {prTracking.invalidationReason ? `: ${prTracking.invalidationReason}.` : '.'}
            </span>
          )}
        </div>
        {prTrackingStatus.blockers.length > 0 && (
          <PlanList title="Manual PR tracking blockers" items={prTrackingStatus.blockers} />
        )}
        {prTrackingStatus.requiresExternalExecution && !executionStatus.completed && (
          <div className="crm-workflow-verification-summary">
            This workflow includes proposed external actions, so manual external execution must be recorded before PR tracking.
          </div>
        )}
        {prTrackingStatus.trackable && !prTrackingStatus.tracked && onMarkPullRequestCreatedManually && (
          <div className="crm-workflow-execution-note-form">
            <div className="crm-workflow-muted-label">PR URL or note (one is required)</div>
            <input
              className="crm-workflow-input"
              value={manualPrUrl}
              onChange={(e) => setManualPrUrl(e.target.value)}
              placeholder="https://dev.azure.com/... or https://github.com/..."
              maxLength={300}
            />
            <textarea
              className="crm-workflow-execution-note"
              value={manualPrNotes}
              onChange={(e) => setManualPrNotes(e.target.value)}
              placeholder="Optional note, or explain where the PR was created."
              rows={3}
              maxLength={500}
            />
            <button
              className="btn btn-primary btn-sm crm-workflow-save-btn"
              type="button"
              onClick={() => { void onMarkPullRequestCreatedManually(manualPrUrl, manualPrNotes); }}
              disabled={savingPullRequest || (manualPrUrl.trim().length === 0 && manualPrNotes.trim().length === 0)}
              title="Record a manually created pull request locally"
            >
              {savingPullRequest
                ? <><span className="btn-spinner" /> Saving...</>
                : <><Icon name="check" size={12} /> Mark PR as created manually</>}
            </button>
          </div>
        )}
        {prTrackingStatus.tracked && onRevokePullRequestTracking && (
          <button
            className="btn btn-secondary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onRevokePullRequestTracking(); }}
            disabled={savingPullRequest}
            title="Revoke local manual PR tracking"
          >
            {savingPullRequest
              ? <><span className="btn-spinner" /> Saving...</>
              : 'Revoke manual PR tracking'}
          </button>
        )}

        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">PR review intake</span>
          <span className={`crm-workflow-verdict ${
            prReview?.invalidatedAt
              ? 'crm-workflow-verdict--error'
              : prReviewStatus.available
                ? prReview?.attentionRequired
                  ? 'crm-workflow-verdict--warnings'
                  : 'crm-workflow-verdict--pass'
                : ''
          }`}>
            {prReview?.invalidatedAt
              ? 'INVALIDATED'
              : prReviewStatus.available
                ? prReview?.attentionRequired
                  ? 'ATTENTION NEEDED'
                  : 'SNAPSHOT SAVED'
                : 'NOT FETCHED'}
          </span>
        </div>
        <div className="crm-workflow-verification-summary">
          Read-only intake only. This section never replies to comments, resolves threads, approves a PR, or updates GitHub/Azure DevOps.
        </div>
        <div className="crm-workflow-approval-state">
          {prReviewStatus.reason}
          {prTracking?.prUrl && <span>Tracked PR URL: {prTracking.prUrl}</span>}
          <span>Provider: {prReviewStatus.provider ?? 'not detected'}</span>
          {prReview?.fetchedAt && !prReview.invalidatedAt && (
            <span>Last intake {formatDate(prReview.fetchedAt)}</span>
          )}
          {prReview?.state && !prReview.invalidatedAt && (
            <span>PR status: {prReview.state}</span>
          )}
          {prReview?.author && !prReview.invalidatedAt && (
            <span>Author: {prReview.author}</span>
          )}
          {(prReview?.baseBranch || prReview?.headBranch) && !prReview.invalidatedAt && (
            <span>
              Branches: {prReview.headBranch ?? 'unknown'} {'->'} {prReview.baseBranch ?? 'unknown'}
            </span>
          )}
          {prReviewStatus.unresolvedCount != null && (
            <span>Unresolved comments: {prReviewStatus.unresolvedCount}</span>
          )}
          {prReviewStatus.attentionRequired != null && (
            <span>Attention required: {prReviewStatus.attentionRequired ? 'yes' : 'no'}</span>
          )}
          {prReview?.invalidatedAt && (
            <span>
              Previous PR review intake invalidated {formatDate(prReview.invalidatedAt)}
              {prReview.invalidationReason ? `: ${prReview.invalidationReason}.` : '.'}
            </span>
          )}
        </div>
        {prReviewStatus.blockers.length > 0 && (
          <PlanList title="PR review intake blockers" items={prReviewStatus.blockers} />
        )}
        {prReview?.summary && !prReview.invalidatedAt && (
          <div className="crm-workflow-verification-summary">{prReview.summary}</div>
        )}
        {prReview?.warnings && prReview.warnings.length > 0 && !prReview.invalidatedAt && (
          <PlanList title="PR review intake warnings" items={prReview.warnings} />
        )}
        {prReview?.error && !prReview.invalidatedAt && (
          <div className="crm-workflow-verification-summary">
            Fetch note: {prReview.error}
          </div>
        )}
        {prReview?.comments && prReview.comments.length > 0 && !prReview.invalidatedAt && (
          <div className="crm-workflow-pr-comments">
            {prReview.comments.map((comment, index) => (
              <div key={comment.id ?? `comment-${index}`} className="crm-workflow-pr-comment">
                <div className="crm-workflow-check-label">
                  {comment.author ?? 'Reviewer'}{comment.filePath ? ` - ${comment.filePath}` : ''}
                  {comment.line ? `:${comment.line}` : ''}
                </div>
                {comment.createdAt && (
                  <div className="crm-workflow-verification-summary">
                    Created {formatDate(comment.createdAt)}
                  </div>
                )}
                <div className="crm-workflow-verification-summary">{comment.body}</div>
                <span className={`crm-workflow-verdict ${comment.isResolved ? 'crm-workflow-verdict--pass' : 'crm-workflow-verdict--warnings'}`}>
                  {comment.isResolved == null ? 'RESOLUTION UNKNOWN' : comment.isResolved ? 'RESOLVED' : 'OPEN'}
                </span>
              </div>
            ))}
          </div>
        )}
        {prTrackingStatus.tracked && !prTracking?.prUrl && (
          <div className="crm-workflow-verification-summary">
            Manual PR tracking has no URL, so automatic read-only intake cannot identify a provider.
          </div>
        )}
        {prReviewStatus.fetchable && prTracking?.prUrl && onFetchPullRequestReviewStatus && (
          <button
            className="btn btn-secondary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onFetchPullRequestReviewStatus(); }}
            disabled={savingPullRequestReview}
            title="Save a read-only PR review intake snapshot without updating the remote PR"
          >
            {savingPullRequestReview
              ? <><span className="btn-spinner" /> Fetching...</>
              : <><Icon name="search" size={12} /> {prReviewStatus.provider === 'github' ? 'Fetch GitHub PR status' : 'Save PR review intake'}</>}
          </button>
        )}

        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">PR review analysis</span>
          <span className={`crm-workflow-verdict ${
            prReviewAnalysis?.invalidatedAt
              ? 'crm-workflow-verdict--error'
              : prReviewAnalysisStatus.generated
                ? prReviewAnalysis?.attentionRequired
                  ? 'crm-workflow-verdict--warnings'
                  : 'crm-workflow-verdict--pass'
                : ''
          }`}>
            {prReviewAnalysis?.invalidatedAt
              ? 'INVALIDATED'
              : prReviewAnalysisStatus.generated
                ? prReviewAnalysis?.attentionRequired
                  ? 'ATTENTION NEEDED'
                  : 'PLAN READY'
                : 'NOT GENERATED'}
          </span>
        </div>
        <div className="crm-workflow-verification-summary">
          Local fix plan only. This does not edit files, push commits, reply to comments, resolve threads, approve the PR, or update the remote PR.
        </div>
        <div className="crm-workflow-approval-state">
          {prReviewAnalysisStatus.reason}
          {prReviewAnalysis?.generatedAt && !prReviewAnalysis.invalidatedAt && (
            <span>Generated {formatDate(prReviewAnalysis.generatedAt)}</span>
          )}
          {prReviewAnalysis?.sourceReviewFetchedAt && !prReviewAnalysis.invalidatedAt && (
            <span>Based on intake {formatDate(prReviewAnalysis.sourceReviewFetchedAt)}</span>
          )}
          {prReviewAnalysisStatus.generated && (
            <span>Attention required: {prReviewAnalysis?.attentionRequired ? 'yes' : 'no'}</span>
          )}
          {prReviewAnalysis?.invalidatedAt && (
            <span>
              Previous PR review analysis invalidated {formatDate(prReviewAnalysis.invalidatedAt)}
              {prReviewAnalysis.invalidationReason ? `: ${prReviewAnalysis.invalidationReason}.` : '.'}
            </span>
          )}
        </div>
        {prReviewAnalysisStatus.blockers.length > 0 && (
          <PlanList title="PR review analysis blockers" items={prReviewAnalysisStatus.blockers} />
        )}
        {prReviewAnalysisStatus.generated && prReviewAnalysis && !prReviewAnalysis.invalidatedAt && (
          <div className="crm-workflow-pr-proposal-card">
            <div className="crm-workflow-verification-summary">{prReviewAnalysis.summary}</div>
            {prReviewAnalysis.groupedFindings.length > 0 ? (
              <div className="crm-workflow-pr-comments">
                {prReviewAnalysis.groupedFindings.map((finding, index) => (
                  <div key={`${finding.filePath ?? 'general'}-${index}`} className="crm-workflow-pr-comment">
                    <div className="crm-workflow-proposal-header">
                      <div>
                        <div className="crm-workflow-check-label">{finding.title}</div>
                        <div className="crm-workflow-verification-summary">
                          {finding.suggestedAction}
                        </div>
                      </div>
                      <span className={`crm-workflow-verdict ${
                        finding.riskLevel === 'high'
                          ? 'crm-workflow-verdict--error'
                          : finding.riskLevel === 'medium'
                            ? 'crm-workflow-verdict--warnings'
                            : 'crm-workflow-verdict--pass'
                      }`}>
                        {finding.riskLevel.toUpperCase()} RISK
                      </span>
                    </div>
                    {finding.comments.map((comment, commentIndex) => (
                      <div key={comment.id ?? `analysis-comment-${commentIndex}`} className="crm-workflow-verification-summary">
                        <strong>{comment.author ?? 'Reviewer'}</strong>
                        {comment.line ? ` line ${comment.line}` : ''}
                        {comment.createdAt ? ` (${formatDate(comment.createdAt)})` : ''}: {comment.body}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <div className="crm-workflow-verification-summary">
                No review comments found in the fetched snapshot.
              </div>
            )}
            <PlanList title="Action items" items={prReviewAnalysis.actionItems} />
            <PlanList title="Test checklist" items={prReviewAnalysis.testChecklist} />
            <PlanList title="Warnings" items={prReviewAnalysis.warnings} />
            <PlanList title="Limitations" items={prReviewAnalysis.limitations} />
          </div>
        )}
        {prReviewAnalysisStatus.generatable && onGeneratePullRequestReviewAnalysis && (
          <button
            className="btn btn-secondary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onGeneratePullRequestReviewAnalysis(); }}
            disabled={savingPullRequestReviewAnalysis}
            title="Generate a local PR review fix plan from the stored review snapshot"
          >
            {savingPullRequestReviewAnalysis
              ? <><span className="btn-spinner" /> Saving...</>
              : <><Icon name="check" size={12} /> {prReviewAnalysisStatus.generated ? 'Regenerate review fix plan' : 'Generate review fix plan'}</>}
          </button>
        )}

        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">Fix draft proposal</span>
          <span className={`crm-workflow-verdict ${
            prFixProposal?.invalidatedAt
              ? 'crm-workflow-verdict--error'
              : prFixProposalStatus.generated
                ? prFixProposal?.canGenerateCodeLater
                  ? 'crm-workflow-verdict--pass'
                  : 'crm-workflow-verdict--warnings'
                : ''
          }`}>
            {prFixProposal?.invalidatedAt
              ? 'INVALIDATED'
              : prFixProposalStatus.generated
                ? prFixProposal?.canGenerateCodeLater
                  ? 'PROPOSAL READY'
                  : 'MANUAL PROPOSAL'
                : 'NOT GENERATED'}
          </span>
        </div>
        <div className="crm-workflow-verification-summary">
          Proposal-only. This does not change files, generate a diff, apply patches, create commits, reply to comments, resolve threads, or update the PR.
        </div>
        <div className="crm-workflow-approval-state">
          {prFixProposalStatus.reason}
          {prFixProposal?.generatedAt && !prFixProposal.invalidatedAt && (
            <span>Generated {formatDate(prFixProposal.generatedAt)}</span>
          )}
          {prFixProposal?.sourceAnalysisGeneratedAt && !prFixProposal.invalidatedAt && (
            <span>Based on analysis {formatDate(prFixProposal.sourceAnalysisGeneratedAt)}</span>
          )}
          {prFixProposalStatus.generated && (
            <span>Future automatic code draft candidate: {prFixProposal?.canGenerateCodeLater ? 'yes' : 'no'}</span>
          )}
          {prFixProposal?.invalidatedAt && (
            <span>
              Previous fix proposal invalidated {formatDate(prFixProposal.invalidatedAt)}
              {prFixProposal.invalidationReason ? `: ${prFixProposal.invalidationReason}.` : '.'}
            </span>
          )}
        </div>
        {prFixProposalStatus.blockers.length > 0 && (
          <PlanList title="Fix proposal blockers" items={prFixProposalStatus.blockers} />
        )}
        {prFixProposalStatus.generated && prFixProposal && !prFixProposal.invalidatedAt && (
          <div className="crm-workflow-pr-proposal-card">
            <div className="crm-workflow-verification-summary">{prFixProposal.summary}</div>
            {prFixProposal.proposedChanges.length > 0 ? (
              <div className="crm-workflow-pr-comments">
                {prFixProposal.proposedChanges.map((change, index) => (
                  <div key={`${change.filePath ?? 'manual'}-${index}`} className="crm-workflow-pr-comment">
                    <div className="crm-workflow-proposal-header">
                      <div>
                        <div className="crm-workflow-check-label">{change.title}</div>
                        <div className="crm-workflow-verification-summary">
                          {change.filePath ? `File: ${change.filePath}` : 'File: not identified'}
                        </div>
                      </div>
                      <span className={`crm-workflow-verdict ${
                        change.riskLevel === 'high'
                          ? 'crm-workflow-verdict--error'
                          : change.riskLevel === 'medium'
                            ? 'crm-workflow-verdict--warnings'
                            : 'crm-workflow-verdict--pass'
                      }`}>
                        {change.riskLevel.toUpperCase()} RISK
                      </span>
                    </div>
                    <div className="crm-workflow-verification-summary">{change.description}</div>
                    <div className="crm-workflow-verification-summary">
                      Confidence: {change.confidence}
                    </div>
                    {change.addressesCommentIds && change.addressesCommentIds.length > 0 && (
                      <PlanList title="Addresses comment IDs" items={change.addressesCommentIds} />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="crm-workflow-verification-summary">
                No review-comment-driven file changes are proposed from the stored analysis.
              </div>
            )}
            <PlanList title="Implementation order" items={prFixProposal.implementationOrder} />
            <PlanList title="Test checklist" items={prFixProposal.testChecklist} />
            <PlanList title="Warnings" items={prFixProposal.warnings} />
            <PlanList title="Limitations" items={prFixProposal.limitations} />
          </div>
        )}
        {prFixProposalStatus.generatable && onGeneratePullRequestFixProposal && (
          <button
            className="btn btn-secondary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onGeneratePullRequestFixProposal(); }}
            disabled={savingPullRequestFixProposal}
            title="Generate a local fix draft proposal without editing files"
          >
            {savingPullRequestFixProposal
              ? <><span className="btn-spinner" /> Saving...</>
              : <><Icon name="check" size={12} /> {prFixProposalStatus.generated ? 'Regenerate fix proposal' : 'Generate fix proposal'}</>}
          </button>
        )}

        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">Fix proposal ready for draft generation</span>
          <span className={`crm-workflow-verdict ${
            fixProposalDraftReady ? 'crm-workflow-verdict--pass' : ''
          }`}>
            {fixProposalDraftReady ? 'READY' : 'NOT READY'}
          </span>
        </div>
        <div className="crm-workflow-verification-summary">
          This only passes the local fix proposal into the existing draft generation flow. No file is changed until the existing preview/apply path is used, and diff review approval is still required afterwards.
        </div>
        <div className="crm-workflow-approval-state">
          {fixDraftContext.reason}
          {!codeReadiness.ready && <span>Existing draft readiness: {codeReadiness.reason}</span>}
          {fixDraftContext.targetFileHints.length > 0 && (
            <span>Target hint(s): {fixDraftContext.targetFileHints.join(', ')}</span>
          )}
          <span>PR comments are not replied to or resolved by this step.</span>
        </div>
        {fixDraftContext.blockers.length > 0 && (
          <PlanList title="Draft context blockers" items={fixDraftContext.blockers} />
        )}
        {!codeReadiness.ready && (
          <PlanList title="Existing draft readiness blockers" items={codeReadiness.blockers} />
        )}
        {fixDraftContext.ready && fixDraftContext.proposedChanges.length > 0 && (
          <PlanList
            title="Context proposed changes"
            items={fixDraftContext.proposedChanges.map((change) => (
              `${change.title}${change.filePath ? ` (${change.filePath})` : ''}`
            ))}
          />
        )}
        {fixDraftContext.warnings.length > 0 && (
          <PlanList title="Draft context warnings" items={fixDraftContext.warnings} />
        )}
        {fixDraftContext.ready && onUseFixProposalForDraftGeneration && (
          <button
            className="btn btn-primary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onUseFixProposalForDraftGeneration(); }}
            disabled={generatingDraftFromFixProposal || !codeReadiness.ready}
            title="Run the existing draft generation flow with the local fix proposal included as context"
          >
            {generatingDraftFromFixProposal
              ? <><span className="btn-spinner" /> Generating...</>
              : <><Icon name="layers" size={12} /> Use fix proposal in existing draft flow</>}
          </button>
        )}

        <div className="crm-workflow-verification-top">
          <span className="crm-workflow-muted-label">Manual PR fix update tracking</span>
          <span className={`crm-workflow-verdict ${
            fixUpdateTracking?.invalidatedAt
              ? 'crm-workflow-verdict--error'
              : fixUpdateStatus.tracked
                ? 'crm-workflow-verdict--pass'
                : ''
          }`}>
            {fixUpdateTracking?.invalidatedAt
              ? 'INVALIDATED'
              : fixUpdateStatus.tracked
                ? 'RECORDED'
                : 'NOT RECORDED'}
          </span>
        </div>
        <div className="crm-workflow-verification-summary">
          Local tracking only. Record that you manually pushed or updated the PR outside the app. task-workbench does not commit, push, update the PR, reply to comments, or resolve threads.
        </div>
        <div className="crm-workflow-approval-state">
          {fixUpdateStatus.reason}
          {fixUpdateTracking?.updatedAt && !fixUpdateTracking.invalidatedAt && (
            <span>Recorded {formatDate(fixUpdateTracking.updatedAt)}</span>
          )}
          {fixUpdateTracking?.relatedFixProposalGeneratedAt && !fixUpdateTracking.invalidatedAt && (
            <span>Related fix proposal {formatDate(fixUpdateTracking.relatedFixProposalGeneratedAt)}</span>
          )}
          {fixUpdateTracking?.commitSha && !fixUpdateTracking.invalidatedAt && (
            <span>Commit SHA: {fixUpdateTracking.commitSha}</span>
          )}
          {fixUpdateTracking?.branchName && !fixUpdateTracking.invalidatedAt && (
            <span>Branch: {fixUpdateTracking.branchName}</span>
          )}
          {fixUpdateTracking?.notes && !fixUpdateTracking.invalidatedAt && (
            <span>Note: {fixUpdateTracking.notes}</span>
          )}
          {fixUpdateTracking?.invalidatedAt && (
            <span>
              Previous manual PR fix update invalidated {formatDate(fixUpdateTracking.invalidatedAt)}
              {fixUpdateTracking.invalidationReason ? `: ${fixUpdateTracking.invalidationReason}.` : '.'}
            </span>
          )}
          <span>Recommended next step: fetch PR review status again.</span>
        </div>
        {fixUpdateStatus.blockers.length > 0 && (
          <PlanList title="Manual PR fix update blockers" items={fixUpdateStatus.blockers} />
        )}
        {fixUpdateStatus.warnings.length > 0 && (
          <PlanList title="Manual PR fix update warnings" items={fixUpdateStatus.warnings} />
        )}
        {fixUpdateStatus.trackable && !fixUpdateStatus.tracked && onMarkPullRequestFixUpdatedManually && (
          <div className="crm-workflow-execution-note-form">
            <div className="crm-workflow-muted-label">Manual PR update note or commit SHA (one is required)</div>
            <textarea
              className="crm-workflow-execution-note"
              value={manualFixUpdateNotes}
              onChange={(e) => setManualFixUpdateNotes(e.target.value)}
              placeholder="Summarize what changed and how the PR was updated outside the app."
              rows={3}
              maxLength={700}
            />
            <input
              className="crm-workflow-input"
              value={manualFixUpdateCommitSha}
              onChange={(e) => setManualFixUpdateCommitSha(e.target.value)}
              placeholder="Optional commit SHA"
              maxLength={80}
            />
            <input
              className="crm-workflow-input"
              value={manualFixUpdateBranch}
              onChange={(e) => setManualFixUpdateBranch(e.target.value)}
              placeholder="Optional branch name"
              maxLength={160}
            />
            <button
              className="btn btn-primary btn-sm crm-workflow-save-btn"
              type="button"
              onClick={() => { void onMarkPullRequestFixUpdatedManually(manualFixUpdateNotes, manualFixUpdateCommitSha, manualFixUpdateBranch); }}
              disabled={savingPullRequestFixUpdate || (manualFixUpdateNotes.trim().length === 0 && manualFixUpdateCommitSha.trim().length === 0)}
              title="Record a manually pushed PR update locally"
            >
              {savingPullRequestFixUpdate
                ? <><span className="btn-spinner" /> Saving...</>
                : <><Icon name="check" size={12} /> Mark PR as manually updated</>}
            </button>
          </div>
        )}
        {fixUpdateStatus.tracked && onRevokePullRequestFixUpdateTracking && (
          <button
            className="btn btn-secondary btn-sm crm-workflow-save-btn"
            type="button"
            onClick={() => { void onRevokePullRequestFixUpdateTracking(); }}
            disabled={savingPullRequestFixUpdate}
            title="Revoke local manual PR fix update tracking"
          >
            {savingPullRequestFixUpdate
              ? <><span className="btn-spinner" /> Saving...</>
              : 'Revoke manual PR fix update tracking'}
          </button>
        )}

        {postFixRefreshStatus.visible && (
          <>
            <div className="crm-workflow-verification-top">
              <span className="crm-workflow-muted-label">Post-fix PR review refresh</span>
              <span className={`crm-workflow-verdict ${
                postFixRefreshStatus.refreshed
                  ? postFixRefreshStatus.needsAnalysis
                    ? 'crm-workflow-verdict--warnings'
                    : 'crm-workflow-verdict--pass'
                  : ''
              }`}>
                {postFixRefreshStatus.refreshed
                  ? postFixRefreshStatus.needsAnalysis
                    ? 'COMMENTS FOUND'
                    : 'REFRESHED'
                  : 'NEEDS FETCH'}
              </span>
            </div>
            <div className="crm-workflow-verification-summary">
              Reuse the existing read-only PR review fetch to check whether review comments remain after your manual PR update. This does not update the PR or resolve comments.
            </div>
            <div className="crm-workflow-approval-state">
              {postFixRefreshStatus.reason}
              {postFixRefreshStatus.updatedAt && (
                <span>Manual update recorded {formatDate(postFixRefreshStatus.updatedAt)}</span>
              )}
              {postFixRefreshStatus.refreshedAt && (
                <span>Latest review snapshot {formatDate(postFixRefreshStatus.refreshedAt)}</span>
              )}
              {postFixRefreshStatus.latestCommentCount != null && (
                <span>Latest snapshot comments: {postFixRefreshStatus.latestCommentCount}</span>
              )}
            </div>
            {postFixRefreshStatus.blockers.length > 0 && (
              <PlanList title="Post-fix refresh blockers" items={postFixRefreshStatus.blockers} />
            )}
            {postFixRefreshStatus.warnings.length > 0 && (
              <PlanList title="Post-fix refresh warnings" items={postFixRefreshStatus.warnings} />
            )}
            {!postFixRefreshStatus.refreshed && postFixRefreshStatus.refreshable && onFetchPullRequestReviewStatus && (
              <button
                className="btn btn-primary btn-sm crm-workflow-save-btn"
                type="button"
                onClick={() => { void onFetchPullRequestReviewStatus(); }}
                disabled={savingPullRequestReview}
                title="Fetch a read-only PR review snapshot after the manual PR update"
              >
                {savingPullRequestReview
                  ? <><span className="btn-spinner" /> Fetching...</>
                  : <><Icon name="search" size={12} /> Fetch PR review status again</>}
              </button>
            )}
            {postFixRefreshStatus.refreshed && postFixRefreshStatus.needsAnalysis && (
              <div className="crm-workflow-verification-summary">
                Analyze review comments again from the latest snapshot before preparing another fix proposal.
              </div>
            )}
          </>
        )}
      </div>

      <div className="crm-workflow-readonly-note">
        This panel only saves local task workflow state, can start the existing read-only metadata verification, and can generate or approve local plan/diff/PR proposal gates. It does not write code, generate diffs, apply patches, register plugin steps, upload web resources, modify Dataverse, create commits, create branches, or create pull requests.
      </div>
    </div>
  );
}
