/**
 * Canonical "reset task workflow to NEW" operation.
 *
 * Changing an existing task's phase to NEW must fully reset its local workflow/execution state —
 * not just status/waitingState/attentionState (that partial reset was the bug: a task visually
 * returned to NEW could still carry a stale approved plan, verification report, AI review, test
 * result, or Git workflow state that let downstream gates be reused without redoing the work).
 *
 * Reset boundary — this touches Task Workbench's persisted local task state only. It never
 * deletes/edits implementation files, changes the current Git branch, deletes branches/commits,
 * stages/commits/pushes/resets Git, touches Dataverse or any external system, or deletes the task.
 *
 * Mirrors RESETTABLE_WORKFLOW_KEYS / taskHasResettableWorkflowState / resetTaskWorkflowToNew in
 * mcp/task-workbench-mcp.mjs and TASK_MCP_RESETTABLE_WORKFLOW_KEYS / task_mcp_reset_task_workflow_to_new
 * in src-tauri/src/lib.rs — keep all three in sync so the UI, JS MCP fallback, and Rust live MCP
 * bridge always agree on exactly what a reset to NEW clears.
 */
import type { Task, SuggestedAction } from '../types';
import { appendActivityNote } from './taskActivityFormatter';

export const DEFAULT_WORKFLOW_RESET_AUDIT_NOTE = 'Developer workflow reset to NEW by user.';

/**
 * Task fields representing generated analysis, setup confirmation, approvals, implementation,
 * verification, deployment/testing, source-control progression, PR/review, external-action, or
 * workflow-progression state. Cleared by a reset to NEW. Deliberately excludes
 * status/waitingState/attentionState/suggestedActions — those are unconditionally reset to their
 * NEW-equivalent value by buildTaskWorkflowResetPatch regardless of whether any of the keys below
 * are set (this is also how the Code Review 'waiting for colleague review' state is always
 * cleared, even though it has no dedicated key of its own).
 *
 * 'deploymentTesting' (manual deployment + browser/application test, see
 * src/lib/deploymentTestingGate.ts) and 'gitWorkflow' (commit/push progression) are both cleared
 * here. Pull request creation/tracking state lives inside 'crmDeveloperWorkflow'
 * (pullRequestProposal/pullRequestTracking) and is cleared as part of that key, not separately.
 */
export const RESETTABLE_WORKFLOW_KEYS = [
  'completedAt',
  'estimatedEffort',
  'planningBucket',
  'suggestedPlanningBucket',
  'priorityScore',
  'priorityReason',
  'isPlanningLocked',
  'analysisResult',
  'generatedReply',
  'scriptAnalysis',
  'selectedPluginProject',
  'aiFileReviews',
  'crmSkeletons',
  'crmVerificationReports',
  'crmDeveloperWorkflow',
  'workflowSetup',
  'taskMode',
  'implementationVerification',
  'deploymentTesting',
  'localTestRecord',
  'consultantTestRecord',
  'mcpChecklistOverrides',
  'mcpNextStep',
  'gitWorkflow',
] as const satisfies readonly (keyof Task)[];

/** True for any value that represents real, meaningful workflow state worth warning about —
 *  false for undefined/null and for empty arrays/objects (nothing was actually recorded there). */
function isNonEmptyWorkflowValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * True when the task carries any generated/derived workflow state that a reset to NEW would
 * discard. Used to decide whether resetting requires an explicit confirmation (UI dialog, or MCP
 * confirmReset) — a task with none of this state is already effectively clean, and resetting it
 * is a safe no-op.
 */
export function taskHasResettableWorkflowState(task: Task): boolean {
  return RESETTABLE_WORKFLOW_KEYS.some((key) => isNonEmptyWorkflowValue(task[key]));
}

/**
 * The field patch a reset to NEW applies — the equivalent of a fresh NEW task's workflow state.
 * Pure and unconditional: always returns the exact same shape regardless of the task's current
 * state, which is what makes the reset idempotent. Optional fields are set to `undefined` so they
 * are dropped on JSON serialization (the local task store persists via JSON — an `undefined` key
 * never round-trips back).
 */
export function buildTaskWorkflowResetPatch(): Partial<Task> {
  const patch: Partial<Task> & { suggestedActions: SuggestedAction[] } = {
    status: 'new',
    waitingState: null,
    attentionState: null,
    suggestedActions: [],
  };
  for (const key of RESETTABLE_WORKFLOW_KEYS) {
    (patch as Record<string, unknown>)[key] = undefined;
  }
  return patch;
}

/**
 * The complete task patch for resetting to NEW, including an appended audit note preserving
 * existing notes/activity history. Pass the result directly to `updateTask(task.id, ...)`.
 * Identity, original assignment, user notes, and import/tracking metadata are untouched — only
 * the fields in buildTaskWorkflowResetPatch (plus `notes`) are included in the returned patch.
 */
export function resetTaskWorkflowToNew(task: Task, auditNote: string = DEFAULT_WORKFLOW_RESET_AUDIT_NOTE): Partial<Task> {
  return {
    ...buildTaskWorkflowResetPatch(),
    notes: appendActivityNote(task.notes, auditNote),
  };
}
