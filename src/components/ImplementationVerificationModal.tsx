/**
 * ImplementationVerificationModal
 *
 * Development-phase quality gates for plugin tasks (four sections):
 *   1. Build / Project Readiness       — soft check, non-blocking
 *   2. Dataverse Metadata Check        — HARD GATE (via Primarch, read-only)
 *   3. AI Internal Code Review         — HARD GATE
 *   4. Local Test Record               — soft check, non-blocking
 *
 * Build and Local Test stay non-blocking — the task can move to Consultant Testing regardless of
 * their results. Dataverse Metadata Check and AI Internal Code Review are hard gates computed by
 * computeProgressionGate (src/lib/implementationGate.ts): moving the task to Code Review /
 * Waiting for PR is blocked unless both gates cleanly pass or the user explicitly accepts
 * Dataverse warnings. See the footer's hard-block panel and Section 2/3 below.
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
import {
  normalizeDataverseGate,
  deriveDataverseRawStatus,
  getAiKitReviewGate,
  hasAiReviewDetail,
  computeProgressionGate,
} from '../lib/implementationGate';
import Modal from './Modal';
import Icon from './Icon';

// ---------------------------------------------------------------------------
// Status derivation helpers (exported for use in TaskDetail)
// ---------------------------------------------------------------------------

export function deriveBuildCheckStatus(task: Task): ImplCheckStatus {
  return task.implementationVerification?.buildCheck?.status ?? 'not-run';
}

/**
 * Thin wrapper around the shared deriveDataverseRawStatus (src/lib/implementationGate.ts) — kept
 * here so existing callers (TaskDetail, this modal) don't need to change their import. The
 * underlying logic is the single TypeScript port of task_mcp_derive_dataverse_check_status
 * (src-tauri/src/lib.rs); do not re-implement the derivation here.
 */
export function deriveDataverseCheckStatus(task: Task): ImplCheckStatus | 'needs_configuration' {
  return deriveDataverseRawStatus(task) as ImplCheckStatus | 'needs_configuration';
}

/**
 * Composes the same manual-action message as MCP's continue_developer_workflow /
 * get_task_workflow_overview.nextRecommendedStep / run_implementation_verification (see
 * composeManualVerificationStep in mcp/task-workbench-mcp.mjs and
 * task_mcp_compose_manual_verification_step in src-tauri/src/lib.rs — keep all three in sync).
 * The modal omits "in the Implementation Verification modal" since the user is already in it.
 */
function composeManualVerificationStep(dvNeeds: boolean, aiNeeds: boolean, localNeeds: boolean): string {
  const modalNames: string[] = [];
  if (dvNeeds) modalNames.push('Dataverse Metadata Check');
  if (aiNeeds) modalNames.push('AI Kit/Settings Review');

  const parts: string[] = [];
  if (modalNames.length > 0) parts.push(`Run ${modalNames.join(' and ')}.`);
  if (localNeeds) {
    parts.push(parts.length > 0
      ? 'Then upload/register the web resource manually and record Local Test/browser validation.'
      : 'Upload/register the web resource manually and record Local Test/browser validation.');
  }
  return parts.length > 0 ? parts.join(' ') : 'All Implementation Verification checks are resolved.';
}

export function computeImplVerifyNextStep(task: Task): string {
  const bld = deriveBuildCheckStatus(task);
  const dv  = deriveDataverseCheckStatus(task);
  const ai: ImplCheckStatus        = task.implementationVerification?.aiCodeReview?.status ?? 'not-run';
  const local: LocalTestImplStatus = task.implementationVerification?.localTest?.status ?? 'not-run';

  if (bld === 'failed' || dv === 'failed' || ai === 'failed') {
    return 'Fix implementation blockers before testing or review';
  }
  if (dv === 'needs_configuration') {
    return 'Configure the Primarch/Dataverse connection (Settings -> CRM Metadata) before proceeding';
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
  if (allAccountedFor) {
    return 'Run local test or continue to consultant testing';
  }
  // Same wording MCP uses for needs_manual_action: only mention the rows still unresolved.
  return composeManualVerificationStep(dv === 'not-run', ai === 'not-run', true);
}

// ---------------------------------------------------------------------------
// Status display helpers
// ---------------------------------------------------------------------------

type DisplayStatus = ImplCheckStatus | LocalTestImplStatus | 'needs_configuration' | 'pending_ai_kit_review';

function statusColor(s: DisplayStatus): string {
  switch (s) {
    case 'passed':               return 'var(--color-done, #3fb950)';
    case 'warnings':              return 'var(--color-warning, #d29922)';
    case 'failed':                return 'var(--color-blocked, #e05555)';
    case 'skipped':               return 'var(--text-muted)';
    case 'manually-verified':     return 'var(--color-done, #3fb950)';
    case 'not-needed':            return 'var(--text-muted)';
    case 'needs_configuration':   return 'var(--color-warning, #d29922)';
    case 'pending_ai_kit_review': return 'var(--color-warning, #d29922)';
    default:                      return 'var(--text-muted)';
  }
}

function statusLabel(s: DisplayStatus): string {
  switch (s) {
    case 'passed':               return 'Passed';
    case 'warnings':              return 'Warnings';
    case 'failed':                return 'Failed';
    case 'skipped':               return 'Skipped';
    case 'manually-verified':     return 'Manually verified';
    case 'not-needed':            return 'Not needed';
    case 'needs_configuration':   return 'Needs configuration';
    case 'pending_ai_kit_review': return 'Pending AI Kit review';
    default:                      return 'Not run';
  }
}

function StatusBadge({ status }: { status: DisplayStatus }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 11.5, fontWeight: 600, color: statusColor(status) }}>
      <span>{statusLabel(status)}</span>
    </span>
  );
}

function SectionHeader({ num, title, status }: { num: string; title: string; status: DisplayStatus }) {
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

function issueColor(severity: 'error' | 'warning' | 'suggestion' | undefined): string {
  if (severity === 'error') return 'var(--color-blocked, #e05555)';
  if (severity === 'warning') return 'var(--color-warning, #d29922)';
  return 'var(--text-muted)';
}

// ---------------------------------------------------------------------------
// Dataverse "checked entities/fields" — read-only passthrough of
// task.implementationVerification.mcpVerification.checks[Dataverse Metadata Check].checkedReferences
// (written by run_implementation_verification — see task_mcp_build_verified_references_list in
// src-tauri/src/lib.rs). Not part of the ImplementationVerification TS type since it is a loosely
// typed MCP-only side channel; read defensively and render nothing when absent.
// ---------------------------------------------------------------------------

interface McpCheckedReference {
  kind?: string;
  logicalName?: string;
  entityLogicalName?: string;
  attributeLogicalName?: string;
  status?: 'found' | 'missing' | 'unverified';
}

function getDataverseCheckedReferences(task: Task): McpCheckedReference[] | null {
  const mcpVerification = (task.implementationVerification as unknown as {
    mcpVerification?: { checks?: Array<{ name?: string; checkedReferences?: McpCheckedReference[] }> };
  } | undefined)?.mcpVerification;
  const entry = mcpVerification?.checks?.find((c) => c.name === 'Dataverse Metadata Check');
  return entry?.checkedReferences ?? null;
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
  onRunSettingsReviewer: () => Promise<void>;
  onUpdate: (iv: ImplementationVerification) => Promise<void>;
  onContinueToTesting: () => Promise<void>;
  onProceedToReview: () => Promise<void>;
  onUpdateNextStepAndClose: (nextStep: string) => Promise<void>;
  onOpenAiReview?: () => void;
  /** Opens the stored Dataverse metadata check result. Present when a result exists. */
  onOpenDvReview?: () => void;
  /** Full reset: clears crmVerificationReports, dataverseCheck override, appends activity note. */
  onResetDvCheck?: () => Promise<void>;
  /** Full reset: clears aiFileReviews, aiCodeReview override, appends activity note. */
  onResetAiReview?: () => Promise<void>;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ImplementationVerificationModal({
  task, customer, selectedPluginProject, targetKind = 'plugin',
  resolvedArtifactPath, artifactInferred,
  buildCheckRunning, dataverseCheckRunning, aiCodeReviewRunning,
  onRunBuildCheck, onRunDataverseCheck, onRunAiCodeReview, onRunSettingsReviewer,
  onUpdate, onContinueToTesting, onProceedToReview, onUpdateNextStepAndClose,
  onOpenAiReview, onOpenDvReview, onResetDvCheck, onResetAiReview, onClose,
}: Props) {
  const [busy,               setBusy]               = useState(false);
  const [skipTarget,         setSkipTarget]         = useState<SkipTarget | null>(null);
  const [skipReason,         setSkipReason]         = useState('Skipped by user.');
  const [confirmResetTarget, setConfirmResetTarget] = useState<'dataverse' | 'aiReview' | null>(null);
  const [testingBusy,        setTestingBusy]        = useState(false);
  const [reviewBusy,         setReviewBusy]         = useState(false);
  const [continueBusy,       setContinueBusy]       = useState(false);
  const [reviewConfirmPending, setReviewConfirmPending] = useState(false);
  const [testingConfirmPending, setTestingConfirmPending] = useState(false);
  const [reviewRunKind, setReviewRunKind] = useState<'ai-kit' | 'settings' | null>(null);
  const [dvAcceptReasonOpen, setDvAcceptReasonOpen] = useState(false);
  const [dvAcceptReason,     setDvAcceptReason]     = useState('');

  const iv           = task.implementationVerification;
  const bldStatus    = deriveBuildCheckStatus(task);
  const dvRawStatus  = deriveDataverseCheckStatus(task);
  const dvStatus     = dvRawStatus; // display status for Section 2's badge
  const dvWarningsAccepted = !!iv?.dataverseCheck?.warningsAccepted?.accepted;
  const dvGateStatus = normalizeDataverseGate(dvRawStatus, dvWarningsAccepted);
  const dvEnv        = iv?.dataverseCheck?.environment;
  const dvCheckedRefs = getDataverseCheckedReferences(task);
  const aiStatus: ImplCheckStatus        = iv?.aiCodeReview?.status ?? 'not-run';
  const localStatus: LocalTestImplStatus = iv?.localTest?.status ?? 'not-run';
  const aiGate       = getAiKitReviewGate(iv?.aiCodeReview);
  // Never show a "Passed" badge for an AI Kit review recorded as passed but missing required
  // detail — render it as pending_ai_kit_review instead (hardening requirement).
  const aiDisplayStatus: DisplayStatus = aiGate.status === 'incomplete' ? 'pending_ai_kit_review' : aiStatus;
  const progressionGate = computeProgressionGate(task);
  const latestReport = task.crmVerificationReports?.[0];
  // Active AI review: look up by reviewId when present; fall back to aiFileReviews[0] for
  // older records; return undefined when status is not-run so Open review is hidden after reset.
  const latestAiReview = (() => {
    if (aiStatus === 'not-run') return undefined;
    const reviewId = iv?.aiCodeReview?.reviewId;
    if (reviewId) return task.aiFileReviews?.find((r) => r.id === reviewId);
    return task.aiFileReviews?.[0];
  })();
  // Use the resolved path (which includes inferred paths) for display and guard checks.
  const artifactPath = resolvedArtifactPath ?? task.workflowSetup?.artifactPath;
  const entity       = task.workflowSetup?.primaryEntityLogicalName
    ?? task.scriptAnalysis?.entityLogicalName
    ?? latestReport?.inspectedEntities?.[0];
  const nextStep     = computeImplVerifyNextStep(task);
  const currentNext  = task.mcpNextStep?.action;

  const anyBusy = busy || buildCheckRunning || dataverseCheckRunning || aiCodeReviewRunning || testingBusy || reviewBusy || continueBusy;

  // Check if any of the four gates are still untouched (not-run). Soft confirmation only —
  // does not apply to the hard Dataverse/AI Kit gate, which is enforced separately below.
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

  function startReset(target: 'dataverse' | 'aiReview') { setConfirmResetTarget(target); }
  function cancelReset() { setConfirmResetTarget(null); }

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

  async function handleDataverseResetConfirm() {
    setBusy(true);
    try {
      await onResetDvCheck?.();
    } finally {
      setConfirmResetTarget(null);
      setBusy(false);
    }
  }

  /** Persists the user's explicit acceptance of the current Dataverse warnings (hard-gate unlock). */
  async function handleAcceptDataverseWarnings() {
    const reason = dvAcceptReason.trim();
    if (!reason) return;
    setBusy(true);
    await applyUpdate({
      dataverseCheck: {
        ...(iv?.dataverseCheck ?? { status: 'warnings' }),
        warningsAccepted: {
          accepted: true,
          acceptedAt: new Date().toISOString(),
          acceptedBy: 'user',
          reason,
          acceptedWarningIds: [],
        },
      },
    });
    setDvAcceptReasonOpen(false);
    setDvAcceptReason('');
    setBusy(false);
  }

  /** Sends the task back to Claude to fix Dataverse warnings, without accepting them. */
  async function handleSendDataverseWarningsBackToClaude() {
    setBusy(true);
    await onUpdateNextStepAndClose('Review and address the Dataverse Metadata Check warnings, then rerun the check or accept the warnings before moving to Code Review.');
    setBusy(false);
  }

  // ---------------------------------------------------------------------------

  async function handleAiKitReviewRun() {
    setReviewRunKind('ai-kit');
    setBusy(true);
    try { await onRunAiCodeReview(); } finally { setBusy(false); setReviewRunKind(null); }
  }

  async function handleSettingsReviewerRun() {
    setReviewRunKind('settings');
    setBusy(true);
    try { await onRunSettingsReviewer(); } finally { setBusy(false); setReviewRunKind(null); }
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

  async function handleAiResetConfirm() {
    setBusy(true);
    try {
      await onResetAiReview?.();
    } finally {
      setConfirmResetTarget(null);
      setBusy(false);
    }
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

  function handleTestingClick() {
    if (hasUntouchedChecks && !testingConfirmPending) {
      setTestingConfirmPending(true);
    } else {
      void handleTestingConfirmed();
    }
  }

  async function handleTestingConfirmed() {
    setTestingConfirmPending(false);
    await handleTesting();
  }

  function handleReviewClick() {
    // Hard gate: Dataverse Metadata Check and AI Internal Code Review must both resolve before
    // the task can move to Code Review / Waiting for PR. There is no confirm-through path here.
    if (!progressionGate.canProceed) return;
    if (hasUntouchedChecks && !reviewConfirmPending) {
      setReviewConfirmPending(true);
    } else {
      void handleReviewConfirmed();
    }
  }

  async function handleReviewConfirmed() {
    if (!progressionGate.canProceed) return;
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

  function ConfirmReset({ onConfirm }: { onConfirm: () => void }) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          Reset this verification result? This will clear the current result and allow the check to be run again.
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-danger btn-sm" onClick={onConfirm} disabled={busy} type="button">
            {busy ? <><span className="btn-spinner" /> Resetting</> : 'Confirm Reset'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={cancelReset} disabled={busy} type="button">Cancel</button>
        </div>
      </div>
    );
  }

  /**
   * The three hard-gate actions for unaccepted Dataverse warnings — shared between Section 2 and
   * the footer's hard-block panel so the user can act from either place without hunting for it.
   */
  function DataverseWarningsActions() {
    if (dvAcceptReasonOpen) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            className="form-input form-input-sm"
            value={dvAcceptReason}
            onChange={(e) => setDvAcceptReason(e.target.value)}
            placeholder="Reason for accepting these warnings (required)"
            disabled={busy}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-secondary btn-sm" onClick={handleAcceptDataverseWarnings} disabled={busy || !dvAcceptReason.trim()} type="button">
              {busy ? <><span className="btn-spinner" /> Accepting</> : 'Confirm accept warnings'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setDvAcceptReasonOpen(false); setDvAcceptReason(''); }} disabled={busy} type="button">Cancel</button>
          </div>
        </div>
      );
    }
    return (
      <div style={btnRow}>
        <button className="btn btn-secondary btn-sm" onClick={() => setDvAcceptReasonOpen(true)} disabled={anyBusy} type="button">
          Accept Dataverse warnings and continue
        </button>
        <button className="btn btn-ghost btn-sm" onClick={handleSendDataverseWarningsBackToClaude} disabled={anyBusy} type="button">
          Send back to Claude to fix
        </button>
        <button className="btn btn-ghost btn-sm" onClick={handleDataverseRun} disabled={anyBusy || dataverseCheckRunning} type="button">
          Rerun Dataverse check
        </button>
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
          {/* Hard block  Dataverse Metadata Check / AI Internal Code Review gate not resolved */}
          {!progressionGate.canProceed && (
            <div style={{
              fontSize: 12, color: 'var(--color-blocked, #e05555)',
              border: '1px solid var(--color-blocked, #e05555)', borderRadius: 4,
              padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <div style={{ fontWeight: 600 }}>Cannot move to Code Review yet:</div>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {progressionGate.blockingChecks.map((c, i) => (
                  <li key={`check-${i}`}>{c.reason}</li>
                ))}
                {progressionGate.blockingFindings.map((f, i) => (
                  <li key={`finding-${i}`}>{f.description}</li>
                ))}
              </ul>
              {progressionGate.nextRecommendedAction === 'review_dataverse_warnings' && <DataverseWarningsActions />}
              {progressionGate.nextRecommendedAction === 'needs_configuration' && (
                <div style={{ fontSize: 11.5 }}>
                  Configure the Primarch/Dataverse connection (Settings -&gt; CRM Metadata) so it matches this task&apos;s environment, then rerun the check.
                </div>
              )}
              {progressionGate.nextRecommendedAction === 'run_ai_kit_review' && (
                <div style={{ fontSize: 11.5 }}>
                  Run the AI Kit Review in Section 3 with full detail (reviewed files, rules, checklist, known PR comments).
                </div>
              )}
              {progressionGate.nextRecommendedAction === 'fix_code' && (
                <div style={{ fontSize: 11.5 }}>Fix the findings above, then rerun the relevant check.</div>
              )}
            </div>
          )}
          {/* Confirmation prompt  shown when some soft checks are untouched (build/local test) */}
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
          {testingConfirmPending && (
            <div style={{
              fontSize: 12, color: 'var(--color-warning, #d29922)',
              border: '1px solid var(--color-warning, #d29922)', borderRadius: 4,
              padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ flex: 1 }}>
                Some implementation checks are not completed. Continue to Consultant Testing anyway?
              </span>
              <button className="btn btn-danger btn-sm" onClick={() => void handleTestingConfirmed()} disabled={testingBusy} type="button">
                {testingBusy ? <><span className="btn-spinner" /> Moving</> : 'Continue to Consultant Testing'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setTestingConfirmPending(false)} type="button">
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
              onClick={handleTestingClick}
              disabled={anyBusy || testingConfirmPending}
              title="Move task to Consultant Testing phase"
              type="button"
            >
              {testingBusy ? <><span className="btn-spinner" /> Moving</> : <><Icon name="play" size={13} /> Continue to Consultant Testing</>}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleReviewClick}
              disabled={anyBusy || reviewConfirmPending || !progressionGate.canProceed}
              title={progressionGate.canProceed
                ? 'Mark task as Waiting for PR / Code Review'
                : 'Blocked: resolve the Dataverse Metadata Check and AI Internal Code Review gates first'}
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

        {/* 2. Dataverse Metadata Check  HARD GATE */}
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

          {/* Environment used  expected vs active, with mismatch styling */}
          {dvEnv && (dvEnv.expected || dvEnv.active) && (
            <div style={{
              fontSize: 11, marginBottom: 6,
              color: dvEnv.mismatch ? 'var(--color-warning, #d29922)' : 'var(--text-muted)',
              border: dvEnv.mismatch ? '1px solid var(--color-warning, #d29922)' : 'none',
              borderRadius: 4, padding: dvEnv.mismatch ? '4px 6px' : 0,
            }}>
              Environment  expected: {dvEnv.expected ?? '(not set)'}, active: {dvEnv.active ?? '(unknown)'}
              {dvEnv.mismatch && <strong> — mismatch detected</strong>}
            </div>
          )}

          {/* Warnings/failures from the latest verification report */}
          {latestReport && (latestReport.issues?.length ?? 0) > 0 && dvStatus !== 'skipped' && dvStatus !== 'manually-verified' && (
            <ul style={{ margin: '0 0 6px 0', paddingLeft: 16 }}>
              {latestReport.issues!.map((iss, i) => (
                <li key={i} style={{ fontSize: 11, color: issueColor(iss.severity), lineHeight: 1.5 }}>
                  <strong>{iss.title}</strong>{iss.detail ? `: ${iss.detail}` : ''}
                </li>
              ))}
            </ul>
          )}

          {/* Checked entities/fields, grouped by status */}
          {dvCheckedRefs && dvCheckedRefs.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              {(['found', 'missing', 'unverified'] as const).map((grp) => {
                const items = dvCheckedRefs!.filter((r) => r.status === grp);
                if (items.length === 0) return null;
                return (
                  <div key={grp} style={{ marginBottom: 4 }}>
                    <div style={{
                      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
                      color: grp === 'found' ? 'var(--color-done, #3fb950)' : grp === 'missing' ? 'var(--color-blocked, #e05555)' : 'var(--color-warning, #d29922)',
                    }}>
                      {grp} ({items.length})
                    </div>
                    <ul style={{ margin: '2px 0 0 0', paddingLeft: 16 }}>
                      {items.map((r, i) => (
                        <li key={i} style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                          {r.kind ? `${r.kind}: ` : ''}{r.entityLogicalName ? `${r.entityLogicalName}.` : ''}{r.attributeLogicalName ?? r.logicalName ?? ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}

          {/* Acceptance state */}
          {iv?.dataverseCheck?.warningsAccepted?.accepted && (
            <div style={hintStyle}>
              Warnings accepted by {iv.dataverseCheck.warningsAccepted.acceptedBy ?? 'user'}
              {iv.dataverseCheck.warningsAccepted.acceptedAt ? ` on ${new Date(iv.dataverseCheck.warningsAccepted.acceptedAt).toLocaleString()}` : ''}
              {iv.dataverseCheck.warningsAccepted.reason ? `: ${iv.dataverseCheck.warningsAccepted.reason}` : ''}
            </div>
          )}

          {dvGateStatus === 'needs_configuration' && (
            <div style={{ fontSize: 11.5, color: 'var(--color-warning, #d29922)', marginBottom: 6 }}>
              {iv?.dataverseCheck?.message ?? "Dataverse Metadata Check cannot run until the Primarch/Dataverse connection is configured and matches this task's environment."}
            </div>
          )}

          {skipTarget === 'dataverse' ? (
            <SkipForm onConfirm={handleDataverseSkipConfirm} />
          ) : confirmResetTarget === 'dataverse' ? (
            <ConfirmReset onConfirm={handleDataverseResetConfirm} />
          ) : dvGateStatus === 'warnings_unaccepted' ? (
            <DataverseWarningsActions />
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
              {latestReport && onOpenDvReview && (
                <button className="btn btn-secondary btn-sm" onClick={onOpenDvReview}
                  disabled={anyBusy} type="button">
                  <Icon name="search" size={12} /> Open review
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
              {dvStatus !== 'not-run' && (
                <button className="btn btn-ghost btn-sm" onClick={() => startReset('dataverse')} disabled={anyBusy} type="button">Reset</button>
              )}
            </div>
          )}
        </section>

        {/* 3. AI Internal Code Review  HARD GATE */}
        <section style={sectionStyle}>
          <SectionHeader num="3" title="AI Internal Code Review" status={aiDisplayStatus} />

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
          {aiStatus !== 'not-run' && aiStatus !== 'skipped' && aiStatus !== 'manually-verified' && !hasAiReviewDetail(iv?.aiCodeReview) && (
            <div style={{ fontSize: 11.5, color: 'var(--color-warning, #d29922)', marginBottom: 6 }}>
              Review details are missing. Run AI Code Review again.
            </div>
          )}

          {/* Full detail payload  reviewed files, rules/checklist/PR-comment files, findings */}
          {iv?.aiCodeReview && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 6 }}>
              {!!iv.aiCodeReview.reviewedFiles?.length && <div>Reviewed files: {iv.aiCodeReview.reviewedFiles.join(', ')}</div>}
              {!!iv.aiCodeReview.rulesFiles?.length && <div>Rules files: {iv.aiCodeReview.rulesFiles.join(', ')}</div>}
              {!!iv.aiCodeReview.checklistFiles?.length && <div>Checklist files: {iv.aiCodeReview.checklistFiles.join(', ')}</div>}
              {!!iv.aiCodeReview.knownPrReviewFiles?.length && <div>Known PR review files: {iv.aiCodeReview.knownPrReviewFiles.join(', ')}</div>}
              {!!iv.aiCodeReview.checkedItems?.length && <div>Checked items: {iv.aiCodeReview.checkedItems.join(', ')}</div>}
              {!!iv.aiCodeReview.summary && <div>Summary: {iv.aiCodeReview.summary}</div>}
            </div>
          )}
          {!!iv?.aiCodeReview?.fixableFindings?.length && (
            <ul style={{ margin: '0 0 6px 0', paddingLeft: 16 }}>
              {iv.aiCodeReview.fixableFindings.map((f) => (
                <li key={f.id} style={{ fontSize: 11, color: 'var(--color-blocked, #e05555)', lineHeight: 1.5 }}>{f.description}</li>
              ))}
            </ul>
          )}
          {!!iv?.aiCodeReview?.nonFixableWarnings?.length && (
            <ul style={{ margin: '0 0 6px 0', paddingLeft: 16 }}>
              {iv.aiCodeReview.nonFixableWarnings.map((w, i) => (
                <li key={i} style={{ fontSize: 11, color: 'var(--color-warning, #d29922)', lineHeight: 1.5 }}>{w}</li>
              ))}
            </ul>
          )}
          {aiGate.status === 'incomplete' && (
            <div style={{ fontSize: 11.5, color: 'var(--color-warning, #d29922)', marginBottom: 6 }}>
              Recorded as passed but missing required review details: {aiGate.missing.join(', ')}. Ask Claude to re-run the AI Kit review with full details.
            </div>
          )}

          {skipTarget === 'aiReview' ? (
            <SkipForm onConfirm={handleAiSkipConfirm} />
          ) : confirmResetTarget === 'aiReview' ? (
            <ConfirmReset onConfirm={handleAiResetConfirm} />
          ) : (
            <div style={btnRow}>
              {aiStatus !== 'manually-verified' && !!artifactPath && (
                <>
                  <button className="btn btn-secondary btn-sm" onClick={handleAiKitReviewRun}
                    disabled={anyBusy || aiCodeReviewRunning} type="button"
                    title="Run AI Kit review using AI Kit rules and prompts">
                    {(aiCodeReviewRunning && reviewRunKind === 'ai-kit') ? <><span className="btn-spinner" /> Reviewing</> : <><Icon name="eye" size={12} /> AI Kit Review</>}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={handleSettingsReviewerRun}
                    disabled={anyBusy || aiCodeReviewRunning} type="button"
                    title="Run review using configured Settings reviewer profile">
                    {(aiCodeReviewRunning && reviewRunKind === 'settings') ? <><span className="btn-spinner" /> Reviewing</> : <><Icon name="eye" size={12} /> Settings Reviewer</>}
                  </button>
                </>
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
              {aiStatus !== 'not-run' && (
                <button className="btn btn-ghost btn-sm" onClick={() => startReset('aiReview')} disabled={anyBusy} type="button">Reset</button>
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
