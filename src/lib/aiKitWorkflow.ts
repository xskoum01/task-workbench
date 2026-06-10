/**
 * AI Kit workflow state helper.
 *
 * Derives the recommended next AI Kit development action from the current
 * task state (activity notes, stored AI reviews, implementation verification).
 * Does NOT call AI, read files, or run git — pure in-memory derivation.
 */
import type { Task } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AiKitRecommendedAction =
  | 'implement-with-ai-kit'
  | 'review-diff-with-ai-kit'
  | 'apply-ai-review-fixes'
  | 'verify-implementation';

export interface AiKitWorkflowState {
  isConfigured: boolean;
  hasArtifactPath: boolean;
  /** True when there is activity evidence of generated/drafted implementation code. */
  hasImplementationActivity: boolean;
  /** Verdict of the most recent AI Kit diff review, or null if none. */
  latestReviewVerdict: 'pass' | 'comment' | 'needs_changes' | null;
  /** True when the latest review entry is from an AI Kit reviewer. */
  latestReviewIsAiKit: boolean;
  /** True when a file-write activity happened after the latest review (diff review needed again). */
  hasChangesAfterLatestReview: boolean;
  /** Next action in the guided AI Kit workflow, or null when AI Kit is not guiding. */
  recommendedAction: AiKitRecommendedAction | null;
  /** Human-readable status line for display in the development panel. */
  statusText: string;
}

// ---------------------------------------------------------------------------
// Internal activity parser
// ---------------------------------------------------------------------------

interface NoteIndices {
  lastImpl: number;   // UI: ai-kit-implementation-generated
  lastReview: number; // UI: ai-kit-diff-reviewed -> *
  lastFixes: number;  // UI: ai-kit-review-fixes-applied
  lastDraftGen: number; // script-draft-generated / Plugin project created…
}

function parseNoteIndices(notes: string | undefined): NoteIndices {
  const lines = (notes ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let lastImpl = -1;
  let lastReview = -1;
  let lastFixes = -1;
  let lastDraftGen = -1;

  lines.forEach((line, i) => {
    const body = line.replace(/^\[[^\]]+\]\s*/, '');
    if (body === 'UI: ai-kit-implementation-generated') lastImpl = i;
    if (/^UI: ai-kit-diff-reviewed -> /i.test(body)) lastReview = i;
    if (body === 'UI: ai-kit-review-fixes-applied') lastFixes = i;
    if (body === 'UI: script-draft-generated') lastDraftGen = i;
    if (body.includes('Plugin project created and draft generated')) lastDraftGen = i;
  });

  return { lastImpl, lastReview, lastFixes, lastDraftGen };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function getAiKitWorkflowState(
  task: Task,
  aiKitPath: string | undefined,
  artifactPath: string | undefined,
): AiKitWorkflowState {
  const isConfigured = !!(aiKitPath?.trim());
  const hasArtifactPath = !!(artifactPath?.trim());

  if (!isConfigured) {
    return {
      isConfigured: false,
      hasArtifactPath,
      hasImplementationActivity: false,
      latestReviewVerdict: null,
      latestReviewIsAiKit: false,
      hasChangesAfterLatestReview: false,
      recommendedAction: null,
      statusText: 'AI Kit is not configured — using built-in workflow.',
    };
  }

  const idx = parseNoteIndices(task.notes);
  const hasImplementationActivity = idx.lastImpl >= 0 || idx.lastDraftGen >= 0;
  // Any write (impl, draft gen, or fix application) after the last review means the diff
  // has changed and a new review is needed.
  const lastWrite = Math.max(idx.lastImpl, idx.lastFixes, idx.lastDraftGen);
  const hasChangesAfterLatestReview = idx.lastReview < 0 ? false : lastWrite > idx.lastReview;

  // Latest AI Kit review from stored review entries (most authoritative).
  const latestAiKitReview = task.aiFileReviews?.find(
    (r) => r.reviewerName?.startsWith('AI Kit') || r.reviewerName?.includes('AI Kit'),
  );
  const latestReviewVerdict = latestAiKitReview?.structured?.verdict ?? null;
  const latestReviewIsAiKit = !!latestAiKitReview;

  let recommendedAction: AiKitRecommendedAction | null = null;
  let statusText = '';

  if (!hasArtifactPath) {
    statusText = 'Set artifactPath or scriptPath to enable AI Kit guided workflow.';
  } else if (hasChangesAfterLatestReview) {
    // File was changed after last review — need a fresh review.
    recommendedAction = 'review-diff-with-ai-kit';
    statusText = 'Local changes detected after last review — run AI Kit diff review.';
  } else if (!latestReviewIsAiKit) {
    if (hasImplementationActivity) {
      // Drafted/implemented but not reviewed yet.
      recommendedAction = 'review-diff-with-ai-kit';
      statusText = 'Local changes detected — run AI Kit diff review before testing.';
    } else {
      // Nothing started yet.
      recommendedAction = 'implement-with-ai-kit';
      statusText = 'AI Kit implementation is available.';
    }
  } else {
    // We have a current AI Kit review — use its verdict.
    switch (latestReviewVerdict) {
      case 'needs_changes':
        recommendedAction = 'apply-ai-review-fixes';
        statusText = 'AI Kit review returned FAIL — fix review blockers before verification.';
        break;
      case 'comment':
        recommendedAction = 'apply-ai-review-fixes';
        statusText = 'AI Kit review returned WARN — fix review comments before verification.';
        break;
      case 'pass':
        recommendedAction = 'verify-implementation';
        statusText = 'AI Kit review passed — continue to implementation verification.';
        break;
      default:
        recommendedAction = 'review-diff-with-ai-kit';
        statusText = 'Run AI Kit diff review before testing.';
    }
  }

  return {
    isConfigured,
    hasArtifactPath,
    hasImplementationActivity,
    latestReviewVerdict,
    latestReviewIsAiKit,
    hasChangesAfterLatestReview,
    recommendedAction,
    statusText,
  };
}

// ---------------------------------------------------------------------------
// Label helper
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<string, string> = {
  'implement-with-ai-kit':    'Implement with AI Kit',
  'review-diff-with-ai-kit':  'Review Diff with AI Kit',
  'apply-ai-review-fixes':    'Apply AI Review Fixes',
  'verify-implementation':    'Verify Implementation',
  'mark-waiting-review':      'Mark Waiting for Review',
  'start-development':        'Start Development',
};

export function getAiKitActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}
