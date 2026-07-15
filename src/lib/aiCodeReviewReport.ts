/**
 * aiCodeReviewReport
 *
 * Read-only view-model adapter for the AI Code Review "Open report" action in
 * ImplementationVerificationModal. task.implementationVerification.aiCodeReview is the canonical
 * gate result and common report data — it is written both by native UI reviewers (AI Kit /
 * Settings buttons) and by Claude/MCP's record_ai_kit_review_result. task.aiFileReviews is
 * optional richer history produced only by native app reviewers (structured comments, line
 * references, markdown, general suggestions) — Claude/MCP reviews never create an entry there.
 *
 * buildAiCodeReviewReport merges the two into a single displayable report so the modal can show
 * one "Open report" action regardless of which path produced the review, without fabricating a
 * fake AiFileReviewResult for MCP reviews. Pure — no I/O, no mutation.
 */

import type { AiFileReviewResult, ImplCheckRecord, ImplCheckStatus, Task } from '../types';
import { inferReviewSource } from './aiReviewers';

export type AiCodeReviewReportSource = 'claude-ai-kit' | 'ai-kit' | 'settings' | 'legacy';

export interface AiCodeReviewReport {
  status: ImplCheckStatus;
  source: AiCodeReviewReportSource;
  /** Human-readable source label per the required mapping (see labelForSource below). */
  sourceLabel: string;
  reviewedAt?: string;
  summary?: string;
  reviewedFiles: string[];
  rulesFiles: string[];
  checklistFiles: string[];
  knownPrReviewFiles: string[];
  checkedItems: string[];
  skippedItems: Array<{ item: string; reason: string } | string>;
  findings: string[];
  fixableFindings: Array<{ id: string; description: string }>;
  nonFixableWarnings: string[];
  /**
   * The matching native aiFileReviews entry, when one exists — carries structured comments, line
   * references, markdown/raw answer, general suggestions, reviewer name, and review mode/source.
   * Undefined for a Claude/MCP review, which never creates an aiFileReviews entry.
   */
  native?: AiFileReviewResult;
}

/** True when the canonical record carries any detail worth rendering in a report. */
function hasCanonicalDetail(review: ImplCheckRecord): boolean {
  const hasItems = (arr: unknown[] | undefined): boolean => Array.isArray(arr) && arr.length > 0;
  return (
    hasItems(review.reviewedFiles) ||
    hasItems(review.rulesFiles) ||
    hasItems(review.checklistFiles) ||
    hasItems(review.knownPrReviewFiles) ||
    hasItems(review.checkedItems) ||
    hasItems(review.skippedItems) ||
    hasItems(review.findings) ||
    hasItems(review.fixableFindings) ||
    hasItems(review.nonFixableWarnings) ||
    !!review.summary
  );
}

/**
 * Source label mapping (requirement):
 *   reviewSource === 'claude-ai-kit'        -> 'Claude AI Kit Review'
 *   native entry inferred as 'ai-kit'        -> 'Task Workbench AI Kit Review'
 *   native entry inferred as 'settings'/'legacy', or no native entry -> the reviewer's configured
 *     name when known, otherwise 'Settings Reviewer'
 */
function labelForSource(
  review: ImplCheckRecord,
  native: AiFileReviewResult | undefined,
): { source: AiCodeReviewReportSource; label: string } {
  if (review.reviewSource === 'claude-ai-kit') {
    return { source: 'claude-ai-kit', label: 'Claude AI Kit Review' };
  }
  if (native) {
    const nativeSource = inferReviewSource(native);
    if (nativeSource === 'ai-kit') {
      return { source: 'ai-kit', label: 'Task Workbench AI Kit Review' };
    }
    return { source: 'settings', label: native.reviewerName || 'Settings Reviewer' };
  }
  return { source: 'settings', label: 'Settings Reviewer' };
}

/**
 * Builds a displayable, read-only AI Code Review report from the canonical
 * implementationVerification.aiCodeReview record plus the matching native aiFileReviews entry
 * (when one exists). Returns null when there is nothing to show:
 *   - aiCodeReview.status is 'not-run' or absent (including after a reset, even if historical
 *     aiFileReviews entries remain on the task — those are orphaned once reviewId is cleared), or
 *   - neither canonical detail nor a linked/native aiFileReviews result exists (e.g. a manual
 *     override recorded with no underlying review detail at all).
 */
export function buildAiCodeReviewReport(task: Task): AiCodeReviewReport | null {
  const review = task.implementationVerification?.aiCodeReview;
  if (!review || !review.status || review.status === 'not-run') return null;

  const reviewId = review.reviewId;
  const native = reviewId
    ? task.aiFileReviews?.find((r) => r.id === reviewId)
    : task.aiFileReviews?.[0];

  if (!hasCanonicalDetail(review) && !native) return null;

  const { source, label } = labelForSource(review, native);

  return {
    status: review.status,
    source,
    sourceLabel: label,
    reviewedAt: review.reviewedAt ?? review.runAt,
    summary: review.summary,
    reviewedFiles: review.reviewedFiles ?? [],
    rulesFiles: review.rulesFiles ?? [],
    checklistFiles: review.checklistFiles ?? [],
    knownPrReviewFiles: review.knownPrReviewFiles ?? [],
    checkedItems: review.checkedItems ?? [],
    skippedItems: review.skippedItems ?? [],
    findings: review.findings ?? [],
    fixableFindings: review.fixableFindings ?? [],
    nonFixableWarnings: review.nonFixableWarnings ?? [],
    native,
  };
}
