/**
 * ImplementationVerificationModal
 *
 * Optional Development-phase quality gates for plugin tasks (four sections):
 *   1. Build / Project Readiness
 *   2. Dataverse Metadata Check   (via Primarch  read-only)
 *   3. AI Internal Code Review
 *   4. Local Test Record
 *
 * All checks are non-blocking. The task stays in Development regardless of
 * results.  Only explicit footer actions move it to Testing or Code Review.
 */

import { useState } from 'react';
import type {
  Task,
  Customer,
  ImplCheckStatus,
  LocalTestImplStatus,
  ImplementationVerification,
} from '../types';
import type { BuildCheckItem } from '../lib/tauriCommands';
import Modal from './Modal';
import Icon from './Icon';

// ---------------------------------------------------------------------------
// Status derivation helpers (exported for use in TaskDetail)
// ---------------------------------------------------------------------------

export function deriveBuildCheckStatus(task: Task): ImplCheckStatus {
  return task.implementationVerification?.buildCheck?.status ?? 'not-run';
}

export function deriveDataverseCheckStatus(task: Task): ImplCheckStatus {
  const ov = task.implementationVerification?.dataverseCheck;
  if (ov?.status === 'skipped' || ov?.status === 'manually-verified') return ov.status;
  const v = task.crmVerificationReports?.[0]?.verdict;
  if (v === 'pass') return 'passed';
  if (v === 'warnings') return 'warnings';
  if (v === 'fail') return 'failed';
  return 'not-run';
}

export function computeImplVerifyNextStep(task: Task): string {
  const bld = deriveBuildCheckStatus(task);
  const dv  = deriveDataverseCheckStatus(task);
  const ai: ImplCheckStatus        = task.implementationVerification?.aiCodeReview?.status ?? 'not-run';
  const local: LocalTestImplStatus = task.implementationVerification?.localTest?.status ?? 'not-run';

  if (bld === 'failed' || dv === 'failed' || ai === 'failed') {
    return 'Fix implementation blockers before testing or review';
  }
  if (bld === 'warnings' || dv === 'warnings' || ai === 'warnings') {
    return 'Review implementation warnings before proceeding';
  }
  if (local === 'failed') {
    return 'Fix local test failures before sending for review';
  }
  if (local === 'passed' || local === 'not-needed') {
    return 'Send to consultant testing or request code review';
  }
  const allAccountedFor =
    ['passed', 'warnings', 'skipped', 'manually-verified'].includes(bld) &&
    ['passed', 'warnings', 'skipped', 'manually-verified'].includes(dv) &&
    ['passed', 'warnings', 'skipped', 'manually-verified'].includes(ai);
  return allAccountedFor
    ? 'Run local test or continue to consultant testing'
    : 'Continue with manual verification or consultant testing';
}

// ---------------------------------------------------------------------------
// Status display helpers
// ---------------------------------------------------------------------------

function statusColor(s: ImplCheckStatus | LocalTestImplStatus): string {
  switch (s) {
    case 'passed':            return 'var(--color-done, #3fb950)';
    case 'warnings':          return 'var(--color-warning, #d29922)';
    case 'failed':            return 'var(--color-blocked, #e05555)';
    case 'skipped':           return 'var(--text-muted)';
    case 'manually-verified': return 'var(--color-done, #3fb950)';
    case 'not-needed':        return 'var(--text-muted)';
    default:                  return 'var(--text-muted)';
  }
}

function statusLabel(s: ImplCheckStatus | LocalTestImplStatus): string {
  switch (s) {
    case 'passed':            return 'Passed';
    case 'warnings':          return 'Warnings';
    case 'failed':            return 'Failed';
    case 'skipped':           return 'Skipped';
    case 'manually-verified': return 'Manually verified';
    case 'not-needed':        return 'Not needed';
    default:                  return 'Not run';
  }
}

function StatusBadge({ status }: { status: ImplCheckStatus | LocalTestImplStatus }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 11.5, fontWeight: 600, color: statusColor(status) }}>
      <span>{statusLabel(status)}</span>
    </span>
  );
}

function SectionHeader({ num, title, status }: { num: string; title: string; status: ImplCheckStatus | LocalTestImplStatus }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{
        fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.06em',
        background: 'var(--bg-secondary)', padding: '1px 5px', borderRadius: 3, flexShrink: 0,
      }}>{num}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>{title}</span>
      <StatusBadge status={status} />
    </div>
  );
}

function resultColor(r: BuildCheckItem['result']): string {
  if (r === 'pass') return 'var(--color-done, #3fb950)';
  if (r === 'warning') return 'var(--color-warning, #d29922)';
  if (r === 'fail') return 'var(--color-blocked, #e05555)';
  return 'var(--text-muted)';
}
// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type SkipTarget = 'build' | 'dataverse' | 'aiReview';

interface Props {
  task: Task;
  customer: Customer | undefined;
  selectedPluginProject: string;
  /** The development target kind for this task — determines which readiness checks apply. */
  targetKind?: 'plugin' | 'script' | 'repo';
  /** Resolved artifact path (explicit or inferred). Shown in context section. */
  resolvedArtifactPath: string | null;
  /** True when `resolvedArtifactPath` was inferred (not explicitly set). */
  artifactInferred: boolean;
  buildCheckRunning: boolean;
  dataverseCheckRunning: boolean;
  aiCodeReviewRunning: boolean;
  onRunBuildCheck: () => Promise<void>;
  /** Runs Dataverse check inline  no second modal. Returns when check is complete. */
  onRunDataverseCheck: () => Promise<void>;
  onRunAiCodeReview: () => Promise<void>;
  onUpdate: (iv: ImplementationVerification) => Promise<void>;
  onContinueToTesting: () => Promise<void>;
  onProceedToReview: () => Promise<void>;
  onUpdateNextStepAndClose: (nextStep: string) => Promise<void>;
  onOpenAiReview?: () => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ImplementationVerificationModal({
  task, customer, selectedPluginProject, targetKind = 'plugin',
  resolvedArtifactPath, artifactInferred,
  buildCheckRunning, dataverseCheckRunning, aiCodeReviewRunning,
  onRunBuildCheck, onRunDataverseCheck, onRunAiCodeReview,
  onUpdate, onContinueToTesting, onProceedToReview, onUpdateNextStepAndClose, onOpenAiReview, onClose,
}: Props) {
  const [busy,               setBusy]               = useState(false);
  const [skipTarget,         setSkipTarget]         = useState<SkipTarget | null>(null);
  const [skipReason,         setSkipReason]         = useState('Skipped by user.');
  const [testingBusy,        setTestingBusy]        = useState(false);
  const [reviewBusy,         setReviewBusy]         = useState(false);
  const [continueBusy,       setContinueBusy]       = useState(false);
  const [reviewConfirmPending, setReviewConfirmPending] = useState(false);

  const iv           = task.implementationVerification;
  const bldStatus    = deriveBuildCheckStatus(task);
  const dvStatus     = deriveDataverseCheckStatus(task);
  const aiStatus: ImplCheckStatus        = iv?.aiCodeReview?.status ?? 'not-run';
  const localStatus: LocalTestImplStatus = iv?.localTest?.status ?? 'not-run';
  const latestReport = task.crmVerificationReports?.[0];
  const latestAiReview = task.aiFileReviews?.[0];
  // Use the resolved path (which includes inferred paths) for display and guard checks.
  const artifactPath = resolvedArtifactPath ?? task.workflowSetup?.artifactPath;
  const entity       = task.workflowSetup?.primaryEntityLogicalName
    ?? task.scriptAnalysis?.entityLogicalName
    ?? latestReport?.inspectedEntities?.[0];
  const nextStep     = computeImplVerifyNextStep(task);
  const currentNext  = task.mcpNextStep?.action;

  const anyBusy = busy || buildCheckRunning || dataverseCheckRunning || aiCodeReviewRunning || testingBusy || reviewBusy || continueBusy;

  // Check if any of the four gates are still untouched (not-run).
  const hasUntouchedChecks = (
    bldStatus === 'not-run' ||
    dvStatus  === 'not-run' ||
    aiStatus  === 'not-run' ||
    localStatus === 'not-run'
  );

  const aiReviewMessage = (() => {
    switch (aiStatus) {
      case 'failed':
        return 'AI review found issues that require changes. Open the full review for details.';
      case 'passed':
        return 'AI review passed. No blocking issues found.';
      case 'warnings':
        return 'AI review completed with warnings. Open the full review for details.';
      case 'skipped':
        return 'AI review was skipped.';
      case 'manually-verified':
        return 'AI review was marked manually reviewed.';
      default:
        return artifactPath
          ? 'No AI review has been run yet.'
          : 'No AI review has been run yet. Save a generated draft first.';
    }
  })();

  const aiReviewMeta = (() => {
    if (!latestAiReview) return '';
    const parts: string[] = [];
    const commentCount = latestAiReview.structured?.comments?.length;
    if (commentCount != null) {
      parts.push(`${commentCount} comment${commentCount === 1 ? '' : 's'}`);
    }
    const filePath = latestAiReview.structured?.filePath ?? latestAiReview.filePath;
    const fileName = filePath?.replace(/\\/g, '/').split('/').filter(Boolean).pop();
    if (fileName) parts.push(fileName);
    return parts.join(' | ');
  })();

  // ---------------------------------------------------------------------------

  async function applyUpdate(patch: Partial<ImplementationVerification>) {
    await onUpdate({ ...iv, ...patch, updatedAt: new Date().toISOString() });
  }

  function startSkip(target: SkipTarget) {
    setSkipTarget(target);
    setSkipReason('Skipped by user.');
  }
  function cancelSkip() { setSkipTarget(null); setSkipReason('Skipped by user.'); }

  // ---------------------------------------------------------------------------

  async function handleBuildRun() {
    setBusy(true);
    try { await onRunBuildCheck(); } finally { setBusy(false); }
  }

  async function handleBuildManualVerify() {
    setBusy(true);
    await applyUpdate({ buildCheck: { ...iv?.buildCheck, status: 'manually-verified', manuallyVerifiedAt: new Date().toISOString() } });
    setBusy(false);
  }

  async function handleBuildSkipConfirm() {
    setBusy(true);
    await applyUpdate({ buildCheck: { status: 'skipped', skippedAt: new Date().toISOString(), skippedReason: skipReason || 'Skipped by user.' } });
    setSkipTarget(null); setSkipReason('Skipped by user.');
    setBusy(false);
  }

  async function handleBuildReset() {
    setBusy(true);
    await applyUpdate({ buildCheck: { status: 'not-run' } });
    setBusy(false);
  }

  // ---------------------------------------------------------------------------

  async function handleDataverseRun() {
    setBusy(true);
    try { await onRunDataverseCheck(); } finally { setBusy(false); }
  }

  async function handleDataverseManualVerify() {
    setBusy(true);
    await applyUpdate({ dataverseCheck: { status: 'manually-verified', manuallyVerifiedAt: new Date().toISOString() } });
    setBusy(false);
  }

  async function handleDataverseSkipConfirm() {
    setBusy(true);
    await applyUpdate({ dataverseCheck: { status: 'skipped', skippedAt: new Date().toISOString(), skippedReason: skipReason || 'Skipped by user.' } });
    setSkipTarget(null); setSkipReason('Skipped by user.');
    setBusy(false);
  }

  async function handleDataverseReset() {
    setBusy(true);
    await applyUpdate({ dataverseCheck: { status: 'not-run' } });
    setBusy(false);
  }

  // ---------------------------------------------------------------------------

  async function handleAiReviewRun() {
    setBusy(true);
    try { await onRunAiCodeReview(); } finally { setBusy(false); }
  }

  async function handleAiManualVerify() {
    setBusy(true);
    await applyUpdate({ aiCodeReview: { ...iv?.aiCodeReview, status: 'manually-verified', manuallyVerifiedAt: new Date().toISOString() } });
    setBusy(false);
  }

  async function handleAiSkipConfirm() {
    setBusy(true);
    await applyUpdate({ aiCodeReview: { status: 'skipped', skippedAt: new Date().toISOString(), skippedReason: skipReason || 'Skipped by user.' } });
    setSkipTarget(null); setSkipReason('Skipped by user.');
    setBusy(false);
  }

  async function handleAiReset() {
    setBusy(true);
    await applyUpdate({ aiCodeReview: { status: 'not-run' } });
    setBusy(false);
  }

  // ---------------------------------------------------------------------------

  async function handleLocalTest(status: LocalTestImplStatus) {
    setBusy(true);
    await applyUpdate({ localTest: { status, recordedAt: new Date().toISOString() } });
    setBusy(false);
  }

  // ---------------------------------------------------------------------------

  async function handleContinue() {
    setContinueBusy(true);
    await onUpdateNextStepAndClose(nextStep);
    setContinueBusy(false);
  }

  async function handleTesting() {
    setTestingBusy(true);
    await onContinueToTesting();
    setTestingBusy(false);
  }

  function handleReviewClick() {
    if (hasUntouchedChecks && !reviewConfirmPending) {
      setReviewConfirmPending(true);
    } else {
      void handleReviewConfirmed();
    }
  }

  async function handleReviewConfirmed() {
    setReviewConfirmPending(false);
    setReviewBusy(true);
    await onProceedToReview();
    setReviewBusy(false);
  }

  // ---------------------------------------------------------------------------

  function SkipForm({ onConfirm }: { onConfirm: () => void }) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          className="form-input form-input-sm"
          value={skipReason}
          onChange={(e) => setSkipReason(e.target.value)}
          placeholder="Skip reason (optional)"
          disabled={busy}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-danger btn-sm" onClick={onConfirm} disabled={busy} type="button">
            {busy ? <><span className="btn-spinner" /> Skipping</> : 'Confirm Skip'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={cancelSkip} disabled={busy} type="button">Cancel</button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------

  const sectionStyle: React.CSSProperties = {
    border: '1px solid var(--border-default, #30363d)',
    borderRadius: 4, padding: '10px 12px',
  };
  const hintStyle: React.CSSProperties = {
    fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.4,
  };
  const btnRow: React.CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap' };

  return (
    <Modal
      title="Implementation Verification"
      size="md"
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
          {/* Confirmation prompt  shown when some checks are untouched */}
          {reviewConfirmPending && (
            <div style={{
              fontSize: 12, color: 'var(--color-warning, #d29922)',
              border: '1px solid var(--color-warning, #d29922)', borderRadius: 4,
              padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ flex: 1 }}>
                Some implementation checks are not completed. Move to Code Review anyway?
              </span>
              <button className="btn btn-danger btn-sm" onClick={handleReviewConfirmed} disabled={reviewBusy} type="button">
                {reviewBusy ? <><span className="btn-spinner" /> Moving</> : 'Move to Code Review'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setReviewConfirmPending(false)} type="button">
                Cancel
              </button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={anyBusy} type="button">Cancel</button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleContinue}
              disabled={anyBusy}
              title="Save suggested next step and stay in Development"
              type="button"
            >
              {continueBusy ? <><span className="btn-spinner" /> Saving</> : 'Continue in Development'}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleTesting}
              disabled={anyBusy}
              title="Move task to Consultant Testing phase"
              type="button"
            >
              {testingBusy ? <><span className="btn-spinner" /> Moving</> : <><Icon name="play" size={13} /> Continue to Consultant Testing</>}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleReviewClick}
              disabled={anyBusy || reviewConfirmPending}
              title="Mark task as Waiting for PR / Code Review"
              type="button"
            >
              {reviewBusy ? <><span className="btn-spinner" /> Moving</> : <><Icon name="check" size={13} /> Move to Code Review / Waiting for PR</>}
            </button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Context */}
        <section style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {selectedPluginProject && <span><span style={{ color: 'var(--text-muted)' }}>Plugin:</span> {selectedPluginProject}</span>}
            {entity && <span><span style={{ color: 'var(--text-muted)' }}>Entity:</span> {entity}</span>}
            {customer?.name && <span><span style={{ color: 'var(--text-muted)' }}>Customer:</span> {customer.name}</span>}
            {artifactPath && (
              <span style={{ minWidth: 0 }}>
                <span style={{ color: 'var(--text-muted)' }}>Artifact:</span>{' '}
                <span style={{ fontFamily: 'var(--font-mono, Consolas, monospace)', wordBreak: 'break-all' }}>
                  {artifactPath.replace(/\\/g, '/').split('/').pop()}
                </span>
                {artifactInferred && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 10.5, marginLeft: 4 }}>(inferred)</span>
                )}
              </span>
            )}
            {!artifactPath && (
              <span style={{ color: 'var(--color-warning, #d29922)', fontSize: 11 }}>
                No artifact file  save a generated draft first.
              </span>
            )}
          </div>
          {currentNext && <div style={{ marginTop: 4, color: 'var(--text-muted)' }}><span style={{ marginRight: 4 }}>Next:</span>{currentNext}</div>}
        </section>

        {/* 1. Build / Project Readiness (or Script File Readiness for script tasks) */}
        <section style={sectionStyle}>
          <SectionHeader num="1" title={targetKind === 'script' ? 'Script File Readiness' : 'Build / Project Readiness'} status={bldStatus} />

          {iv?.buildCheck?.summary && bldStatus !== 'skipped' && bldStatus !== 'manually-verified' && (
            <div style={hintStyle}>{iv.buildCheck.summary}</div>
          )}
          {(iv?.buildCheck?.findings?.length ?? 0) > 0 && bldStatus !== 'skipped' && bldStatus !== 'manually-verified' && (
            <ul style={{ margin: '0 0 6px 0', paddingLeft: 16, listStyle: 'none' }}>
              {iv!.buildCheck!.findings!.map((f, i) => {
                const parts = f.split('|');
                const result = parts[0] as BuildCheckItem['result'];
                const label  = parts[1] ?? f;
                const detail = parts[2] ?? '';
                return (
                  <li key={i} style={{ fontSize: 11, color: resultColor(result), lineHeight: 1.5 }}>
                    <span><strong>{label}</strong>{detail ? `: ${detail}` : ''}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {bldStatus === 'skipped' && iv?.buildCheck?.skippedReason && (
            <div style={hintStyle}>Reason: {iv.buildCheck.skippedReason}</div>
          )}

          {skipTarget === 'build' ? (
            <SkipForm onConfirm={handleBuildSkipConfirm} />
          ) : (
            <div style={btnRow}>
              {bldStatus !== 'manually-verified' && (
                <button className="btn btn-secondary btn-sm" onClick={handleBuildRun}
                  disabled={anyBusy || buildCheckRunning} type="button"
                  title={targetKind === 'script' ? 'Verify script file exists and is readable' : 'Check project files and attempt msbuild'}>
                  {buildCheckRunning
                    ? <><span className="btn-spinner" /> Checking</>
                    : targetKind === 'script'
                      ? <><Icon name="search" size={12} /> Check Script File</>
                      : <><Icon name="search" size={12} /> Run Build Check</>}
                </button>
              )}
              {(bldStatus === 'not-run' || bldStatus === 'passed' || bldStatus === 'warnings' || bldStatus === 'failed') && (
                <button className="btn btn-ghost btn-sm" onClick={handleBuildManualVerify}
                  disabled={anyBusy} title="Mark as manually verified" type="button">
                  Mark manually verified
                </button>
              )}
              {(bldStatus === 'not-run' || bldStatus === 'warnings' || bldStatus === 'failed') && (
                <button className="btn btn-ghost btn-sm" onClick={() => startSkip('build')} disabled={anyBusy} type="button">Skip</button>
              )}
              {(bldStatus === 'skipped' || bldStatus === 'manually-verified') && (
                <button className="btn btn-ghost btn-sm" onClick={handleBuildReset} disabled={anyBusy} type="button">Reset</button>
              )}
            </div>
          )}
        </section>

        {/* 2. Dataverse Metadata Check */}
        <section style={sectionStyle}>
          <SectionHeader num="2" title="Dataverse Metadata Check" status={dvStatus} />

          {latestReport && dvStatus !== 'skipped' && dvStatus !== 'manually-verified' && (
            <div style={hintStyle}>
              {latestReport.summary || latestReport.answer || 'Verification report exists.'}
              {(latestReport.issues?.length ?? 0) > 0 && (
                <span> ({latestReport.issues!.length} issue{latestReport.issues!.length !== 1 ? 's' : ''})</span>
              )}
            </div>
          )}
          {dvStatus === 'skipped' && iv?.dataverseCheck?.skippedReason && (
            <div style={hintStyle}>Reason: {iv.dataverseCheck.skippedReason}</div>
          )}

          {skipTarget === 'dataverse' ? (
            <SkipForm onConfirm={handleDataverseSkipConfirm} />
          ) : (
            <div style={btnRow}>
              {dvStatus !== 'manually-verified' && (
                <button className="btn btn-secondary btn-sm" onClick={handleDataverseRun}
                  disabled={anyBusy || dataverseCheckRunning}
                  title="Verify Dataverse metadata inline (read-only, no second modal)" type="button">
                  {dataverseCheckRunning
                    ? <><span className="btn-spinner" /> Checking</>
                    : <><Icon name="search" size={12} /> Run Dataverse Check</>}
                </button>
              )}
              {(dvStatus === 'not-run' || dvStatus === 'passed' || dvStatus === 'warnings' || dvStatus === 'failed') && (
                <button className="btn btn-ghost btn-sm" onClick={handleDataverseManualVerify}
                  disabled={anyBusy} title="Mark as manually verified" type="button">
                  Mark manually verified
                </button>
              )}
              {(dvStatus === 'not-run' || dvStatus === 'warnings' || dvStatus === 'failed') && (
                <button className="btn btn-ghost btn-sm" onClick={() => startSkip('dataverse')} disabled={anyBusy} type="button">Skip</button>
              )}
              {(dvStatus === 'skipped' || dvStatus === 'manually-verified') && (
                <button className="btn btn-ghost btn-sm" onClick={handleDataverseReset} disabled={anyBusy} type="button">Reset</button>
              )}
            </div>
          )}
        </section>

        {/* 3. AI Internal Code Review */}
        <section style={sectionStyle}>
          <SectionHeader num="3" title="AI Internal Code Review" status={aiStatus} />

          <div style={hintStyle}>
            {aiReviewMessage}
            {aiReviewMeta && (
              <div style={{ marginTop: 3, fontSize: 11, color: 'var(--text-muted)' }}>
                {aiReviewMeta}
              </div>
            )}
          </div>
          {aiStatus === 'skipped' && iv?.aiCodeReview?.skippedReason && (
            <div style={hintStyle}>Reason: {iv.aiCodeReview.skippedReason}</div>
          )}

          {skipTarget === 'aiReview' ? (
            <SkipForm onConfirm={handleAiSkipConfirm} />
          ) : (
            <div style={btnRow}>
              {aiStatus !== 'manually-verified' && !!artifactPath && (
                <button className="btn btn-secondary btn-sm" onClick={handleAiReviewRun}
                  disabled={anyBusy || aiCodeReviewRunning} type="button"
                  title="Run AI internal code review against plugin conventions">
                  {aiCodeReviewRunning ? <><span className="btn-spinner" /> Reviewing</> : <><Icon name="eye" size={12} /> Run AI Code Review</>}
                </button>
              )}
              {latestAiReview && onOpenAiReview && (
                <button className="btn btn-secondary btn-sm" onClick={onOpenAiReview}
                  disabled={anyBusy} type="button">
                  <Icon name="search" size={12} /> Open review
                </button>
              )}
              {(aiStatus === 'not-run' || aiStatus === 'passed' || aiStatus === 'warnings' || aiStatus === 'failed') && (
                <button className="btn btn-ghost btn-sm" onClick={handleAiManualVerify}
                  disabled={anyBusy} title="Mark as manually reviewed" type="button">
                  Mark manually reviewed
                </button>
              )}
              {(aiStatus === 'not-run' || aiStatus === 'warnings' || aiStatus === 'failed') && (
                <button className="btn btn-ghost btn-sm" onClick={() => startSkip('aiReview')} disabled={anyBusy} type="button">Skip</button>
              )}
              {(aiStatus === 'skipped' || aiStatus === 'manually-verified') && (
                <button className="btn btn-ghost btn-sm" onClick={handleAiReset} disabled={anyBusy} type="button">Reset</button>
              )}
            </div>
          )}
        </section>

        {/* 4. Local Test */}
        <section style={sectionStyle}>
          <SectionHeader num="4" title="Local Test" status={localStatus} />

          {iv?.localTest?.notes && <div style={hintStyle}>{iv.localTest.notes}</div>}

          <div style={btnRow}>
            <button
              className={`btn btn-sm ${localStatus === 'passed' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => handleLocalTest('passed')} disabled={anyBusy} type="button">
              <Icon name="check" size={12} /> Record passed
            </button>
            <button
              className={`btn btn-sm ${localStatus === 'failed' ? 'btn-danger' : 'btn-secondary'}`}
              onClick={() => handleLocalTest('failed')} disabled={anyBusy} type="button">
              Record failed
            </button>
            <button
              className={`btn btn-sm ${localStatus === 'not-needed' ? 'btn-secondary' : 'btn-ghost'}`}
              onClick={() => handleLocalTest('not-needed')} disabled={anyBusy} type="button">
              Mark not needed
            </button>
            {localStatus !== 'not-run' && (
              <button className="btn btn-ghost btn-sm" onClick={() => handleLocalTest('not-run')} disabled={anyBusy} type="button">Reset</button>
            )}
          </div>
        </section>

        {/* Suggested next step */}
        {nextStep !== currentNext && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Suggested next step: {nextStep}
          </div>
        )}

      </div>
    </Modal>
  );
}
