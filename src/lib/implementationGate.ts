/**
 * implementationGate
 *
 * Single TypeScript port of the hard-gate logic that decides whether a task may move to
 * Code Review / Waiting for PR. This mirrors, function-for-function, the Rust implementation in
 * src-tauri/src/lib.rs (task_mcp_normalize_dataverse_gate, task_mcp_ai_kit_review_gate,
 * task_mcp_derive_dataverse_check_status, task_mcp_dataverse_warnings_accepted,
 * task_mcp_compute_progression_gate) so the MCP-facing workflow and the human-facing
 * Implementation Verification modal / "Move to Code Review" button enforce identical rules.
 *
 * Keep this file in sync with src-tauri/src/lib.rs and mcp/task-workbench-mcp.mjs — those two
 * are owned by other work and must not be edited here, but the branch logic and (closely) the
 * reason strings must match so the UI and the AI agent tell a consistent story.
 */

import type { Task, DataverseGateStatus, AiReviewGateStatus, ImplCheckRecord } from '../types';

// ---------------------------------------------------------------------------
// Dataverse gate
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw Dataverse Metadata Check status (from deriveDataverseRawStatus, or a manual
 * override such as "skipped"/"manually-verified") into the hard-gate status used to decide
 * workflow progression. "warnings" only becomes "passed" once the user has explicitly accepted
 * them (implementationVerification.dataverseCheck.warningsAccepted.accepted) — otherwise it is
 * "warnings_unaccepted" and blocks progression.
 * Mirrors task_mcp_normalize_dataverse_gate in src-tauri/src/lib.rs.
 */
export function normalizeDataverseGate(rawStatus: string, warningsAccepted: boolean): DataverseGateStatus {
  switch (rawStatus) {
    case 'passed':
    case 'skipped':
    case 'manually-verified':
      return 'passed';
    case 'warnings':
      return warningsAccepted ? 'passed' : 'warnings_unaccepted';
    case 'failed':
      return 'failed';
    case 'needs_configuration':
      return 'needs_configuration';
    default:
      return 'not_run';
  }
}

/**
 * Mirrors task_mcp_derive_dataverse_check_status in src-tauri/src/lib.rs (which itself mirrors
 * ImplementationVerificationModal's deriveDataverseCheckStatus — see that function for the exact
 * same logic used to drive the modal's status badge). A manual override of "skipped",
 * "manually-verified", or "needs_configuration" always wins over the latest report verdict.
 */
export function deriveDataverseRawStatus(task: Task): string {
  const overrideStatus = task.implementationVerification?.dataverseCheck?.status ?? '';
  if (overrideStatus === 'skipped' || overrideStatus === 'manually-verified' || overrideStatus === 'needs_configuration') {
    return overrideStatus;
  }
  const verdict = task.crmVerificationReports?.[0]?.verdict ?? '';
  switch (verdict) {
    case 'pass':      return 'passed';
    case 'warnings':  return 'warnings';
    case 'fail':      return 'failed';
    // not_configured: assistant is set up but MCP has no metadata tools — treat as warnings.
    case 'not_configured': return 'warnings';
    default: return 'not-run';
  }
}

/** Reads whether the user has explicitly accepted the current Dataverse Metadata Check warnings. */
export function dataverseWarningsAccepted(task: Task): boolean {
  return !!task.implementationVerification?.dataverseCheck?.warningsAccepted?.accepted;
}

// ---------------------------------------------------------------------------
// AI Kit review gate
// ---------------------------------------------------------------------------

export interface AiKitReviewGateResult {
  status: AiReviewGateStatus;
  missing: string[];
}

/**
 * Evaluates whether a persisted AI Kit review payload (implementationVerification.aiCodeReview)
 * satisfies the hard-gate requirements: status must be "passed", fixableFindings must be empty,
 * and reviewedFiles/rulesFiles/checklistFiles/knownPrReviewFiles must all be non-empty — a
 * "passed" status with missing details is treated as incomplete, not passed.
 * Mirrors task_mcp_ai_kit_review_gate in src-tauri/src/lib.rs.
 */
export function getAiKitReviewGate(review: ImplCheckRecord | undefined | null): AiKitReviewGateResult {
  if (!review || typeof review !== 'object') {
    return { status: 'not_run', missing: [] };
  }
  const status = review.status ?? '';
  if (!status) {
    return { status: 'not_run', missing: [] };
  }

  const hasItems = (arr: unknown[] | undefined): boolean => Array.isArray(arr) && arr.length > 0;

  const missing: string[] = [];
  if (!hasItems(review.reviewedFiles))      missing.push('reviewedFiles is empty');
  if (!hasItems(review.rulesFiles))         missing.push('rulesFiles is empty');
  if (!hasItems(review.checklistFiles))     missing.push('checklistFiles is empty');
  if (!hasItems(review.knownPrReviewFiles)) missing.push('knownPrReviewFiles is empty');

  if (hasItems(review.fixableFindings)) {
    missing.push('fixableFindings is non-empty');
    return { status: 'failed', missing };
  }

  switch (status) {
    case 'failed':   return { status: 'failed', missing };
    case 'warnings': return { status: 'pending', missing };
    case 'passed':   return missing.length === 0 ? { status: 'passed', missing: [] } : { status: 'incomplete', missing };
    default:         return { status: 'not_run', missing: [] };
  }
}

// ---------------------------------------------------------------------------
// Combined progression gate
// ---------------------------------------------------------------------------

export interface BlockingCheck {
  check: 'dataverseCheck' | 'aiCodeReview';
  status: string;
  reason: string;
}

export interface BlockingFinding {
  check: string;
  description: string;
}

export type NextRecommendedAction =
  | 'fix_code'
  | 'run_ai_kit_review'
  | 'review_dataverse_warnings'
  | 'needs_configuration'
  | 'wait_for_user'
  | 'continue_workflow';

export interface ProgressionGateResult {
  canProceed: boolean;
  blockingChecks: BlockingCheck[];
  blockingFindings: BlockingFinding[];
  requiresUserAction: boolean;
  nextRecommendedAction: NextRecommendedAction;
  dataverseGateStatus: DataverseGateStatus;
  aiReviewGateStatus: AiReviewGateStatus;
}

/**
 * Single source of truth for "can this task move to Code Review / Waiting for PR". Computed from
 * the exact same fields (implementationVerification.dataverseCheck /
 * implementationVerification.aiCodeReview) that MCP's run_implementation_verification and the
 * Implementation Verification modal both read/write, so the MCP-facing workflow and the
 * human-facing "Move to Code Review" button enforce identical rules. Pure — no I/O.
 * Mirrors task_mcp_compute_progression_gate in src-tauri/src/lib.rs.
 */
export function computeProgressionGate(task: Task): ProgressionGateResult {
  const dvRaw = deriveDataverseRawStatus(task);
  const dvWarningsAccepted = dataverseWarningsAccepted(task);
  const dvGate = normalizeDataverseGate(dvRaw, dvWarningsAccepted);

  const aiReview = task.implementationVerification?.aiCodeReview;
  const { status: aiGate, missing: aiMissing } = getAiKitReviewGate(aiReview);

  const blockingChecks: BlockingCheck[] = [];
  const blockingFindings: BlockingFinding[] = [];

  switch (dvGate) {
    case 'passed':
      break;
    case 'warnings_unaccepted':
      blockingChecks.push({
        check: 'dataverseCheck', status: dvGate,
        reason: 'Dataverse Metadata Check completed with warnings that have not been explicitly accepted.',
      });
      break;
    case 'needs_configuration':
      blockingChecks.push({
        check: 'dataverseCheck', status: dvGate,
        reason: 'Dataverse Metadata Check cannot run — Primarch/Dataverse connection is not configured or does not match the task\'s environment.',
      });
      break;
    case 'failed': {
      const missingRefs = task.crmVerificationReports?.[0]?.missingReferences ?? [];
      for (const m of missingRefs) {
        blockingFindings.push({ check: 'dataverseCheck', description: `'${m.displayName ?? 'unknown'}' was not found in Dataverse.` });
      }
      blockingChecks.push({
        check: 'dataverseCheck', status: dvGate,
        reason: 'Dataverse Metadata Check found missing/incorrect references.',
      });
      break;
    }
    default:
      blockingChecks.push({
        check: 'dataverseCheck', status: dvGate,
        reason: 'Dataverse Metadata Check has not run yet.',
      });
  }

  switch (aiGate) {
    case 'passed':
      break;
    case 'failed': {
      for (const f of aiReview?.fixableFindings ?? []) {
        blockingFindings.push({ check: 'aiCodeReview', description: f.description });
      }
      blockingChecks.push({
        check: 'aiCodeReview', status: aiGate,
        reason: 'AI Kit Code Review found fixable findings or an explicit failed verdict.',
      });
      break;
    }
    case 'incomplete':
      blockingChecks.push({
        check: 'aiCodeReview', status: aiGate,
        reason: `AI Kit Code Review is missing required details: ${aiMissing.join(', ')}.`,
      });
      break;
    case 'pending':
      blockingChecks.push({
        check: 'aiCodeReview', status: aiGate,
        reason: "AI Kit Code Review verdict is 'warnings' — must be resolved to 'passed'.",
      });
      break;
    default:
      blockingChecks.push({
        check: 'aiCodeReview', status: aiGate,
        reason: 'AI Kit Code Review has not run yet.',
      });
  }

  const canProceed = blockingChecks.length === 0;
  const requiresUserAction = dvGate === 'warnings_unaccepted' || dvGate === 'needs_configuration';

  let nextRecommendedAction: NextRecommendedAction;
  if (canProceed) {
    nextRecommendedAction = 'continue_workflow';
  } else if (blockingFindings.length > 0) {
    nextRecommendedAction = 'fix_code';
  } else if (aiGate === 'incomplete' || aiGate === 'pending' || aiGate === 'not_run') {
    nextRecommendedAction = 'run_ai_kit_review';
  } else if (dvGate === 'needs_configuration') {
    nextRecommendedAction = 'needs_configuration';
  } else if (dvGate === 'warnings_unaccepted') {
    nextRecommendedAction = 'review_dataverse_warnings';
  } else {
    nextRecommendedAction = 'wait_for_user';
  }

  return {
    canProceed,
    blockingChecks,
    blockingFindings,
    requiresUserAction,
    nextRecommendedAction,
    dataverseGateStatus: dvGate,
    aiReviewGateStatus: aiGate,
  };
}
