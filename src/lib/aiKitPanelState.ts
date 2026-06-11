/**
 * Pure phase helpers for the AI Kit Actions Panel state machine.
 * Extracted here so they can be unit-tested without a React environment.
 */

export type ActionPhase =
  | 'idle'
  | 'preparing'  // loading AI Kit context (formerly: loading-context)
  | 'preview'    // preview modal open, waiting for user confirmation
  | 'running'    // AI generation in progress (formerly: running-ai)
  | 'result'     // showing proposed content / diff
  | 'applying'   // writing file to disk (formerly: writing-file)
  | 'done'       // write completed successfully
  | 'error';     // error occurred, shown inline with dismiss button

export type ActiveAction = 'implement' | 'reviewDiff' | 'applyFixes';

/** True during any long-running async operation that should disable UI controls. */
export function isPhaseRunning(phase: ActionPhase): boolean {
  return phase === 'preparing' || phase === 'running' || phase === 'applying';
}

/** True when the modal can be safely dismissed without leaving inconsistent state. */
export function canDismissModal(phase: ActionPhase): boolean {
  return phase !== 'running' && phase !== 'applying';
}

/**
 * True when the preview modal should be visible.
 * Includes 'running' so the modal stays open during AI generation — prevents the
 * modal from closing and re-opening (flash) between confirmation and result display.
 */
export function shouldShowPreviewModal(phase: ActionPhase, action: ActiveAction | null): boolean {
  if (action !== 'implement' && action !== 'applyFixes') return false;
  return phase === 'preview' || phase === 'running';
}

/**
 * True when the result modal should be visible.
 * Includes 'applying' so the modal stays open while the file is being written.
 */
export function shouldShowResultModal(phase: ActionPhase, action: ActiveAction | null): boolean {
  if (action === 'reviewDiff') return false;
  return phase === 'result' || phase === 'applying' || phase === 'done';
}

/**
 * Validates state before runImplement / runApplyFixes is called.
 * Returns an error message string if state is invalid, null if valid.
 *
 * Uses explicit null checks for artifactContent so that empty string ("")
 * is accepted in create mode (file does not exist yet).
 */
export function validateRunState(state: {
  kitContext: unknown;
  artifactContent: string | null | undefined;
  taskKind: unknown;
  latestReview?: unknown;
  requiresReview?: boolean;
}): string | null {
  if (!state.kitContext) return 'AI Kit context not loaded. Close and try again.';
  if (state.artifactContent == null) return 'Artifact content is missing. Close and try again.';
  if (!state.taskKind) return 'Task kind could not be determined. Close and try again.';
  if (state.requiresReview && !state.latestReview) return 'No AI Kit review found. Run Review Diff first.';
  return null;
}
