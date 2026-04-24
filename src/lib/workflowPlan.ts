/**
 * workflowPlan.ts — centralized task workflow planner.
 *
 * buildTaskWorkflowPlan() derives the full workflow configuration from a task
 * and its confirmed WorkflowSetup. All components (TaskDetail, InlineTaskPanel,
 * WorkflowStepper) consume this plan instead of scattering logic.
 *
 * Three workflow shapes:
 *   1. repo/general  — simplified:  New → Analyzed → Done
 *   2. review intent + plugin/script — New → Analyzed → For Review → Done
 *   3. create/update/fix + plugin/script — full: New → Analyzed → In Progress → For Review → Done
 *
 * Backward compatibility: tasks without workflowSetup fall back to heuristics.
 */
import type { Task, TaskStatus, WorkflowSetup } from '../types';

// ---------------------------------------------------------------------------
// Stage descriptor
// ---------------------------------------------------------------------------

export interface WorkflowStage {
  id: TaskStatus;
  /** Short label shown in the BPF strip */
  label: string;
  /** Label on the clickable action inside the current stage button */
  actionLabel: string;
  /** Status to advance to when this stage's action is triggered. null = terminal. */
  next: TaskStatus | null;
}

// ---------------------------------------------------------------------------
// Plan output
// ---------------------------------------------------------------------------

export interface TaskWorkflowPlan {
  /** Ordered stage definitions for the BPF strip */
  stages: WorkflowStage[];
  /** Which action will be triggered when the BPF step is clicked */
  currentActionLabel: string;
  /** What the dispatcher should do for the current status */
  currentAction: 'analyze' | 'generate-draft' | 'run-review' | 'mark-done' | 'none';
  /** Show Script/Plugin dev tools (TaskDevModePanel) */
  requiresDevTools: boolean;
  /** Generate Draft action is relevant for this task */
  requiresDraftGeneration: boolean;
  /** AI file review action is relevant for this task */
  requiresAiFileReview: boolean;
  /** Create Plugin Project button is relevant */
  requiresPluginCreate: boolean;
  /** Whether this is a "create new" intent (vs edit/fix/review existing) */
  isCreateIntent: boolean;
}

// ---------------------------------------------------------------------------
// Stage library — we pick from these per workflow shape
// ---------------------------------------------------------------------------

const STAGE_NEW: WorkflowStage = {
  id: 'new',
  label: 'New',
  actionLabel: 'Analyze',
  next: 'analyzed',
};

const STAGE_ANALYZED_DRAFT: WorkflowStage = {
  id: 'analyzed',
  label: 'Analyzed',
  actionLabel: 'Generate Draft',
  next: 'in-progress',
};

const STAGE_ANALYZED_START: WorkflowStage = {
  id: 'analyzed',
  label: 'Analyzed',
  actionLabel: 'Start Work',
  next: 'in-progress',
};

const STAGE_ANALYZED_REVIEW: WorkflowStage = {
  id: 'analyzed',
  label: 'Analyzed',
  actionLabel: 'Run Review',
  next: 'ready-for-review',
};

const STAGE_ANALYZED_DONE: WorkflowStage = {
  id: 'analyzed',
  label: 'Analyzed',
  actionLabel: 'Mark Done',
  next: 'done',
};

const STAGE_IN_PROGRESS: WorkflowStage = {
  id: 'in-progress',
  label: 'In Progress',
  actionLabel: 'Send for Review',
  next: 'ready-for-review',
};

const STAGE_FOR_REVIEW: WorkflowStage = {
  id: 'ready-for-review',
  label: 'For Review',
  actionLabel: 'Mark Done',
  next: 'done',
};

const STAGE_DONE: WorkflowStage = {
  id: 'done',
  label: 'Done',
  actionLabel: 'Completed',
  next: null,
};

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

type DevKind = NonNullable<WorkflowSetup['devTargetKind']>;
type WorkIntent = NonNullable<WorkflowSetup['workIntent']>;

/** Is the task targeting code (plugin or script)? */
function isCodeTask(kind: DevKind): boolean {
  return kind === 'plugin' || kind === 'script';
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildTaskWorkflowPlan(task: Task, heuristicKind?: DevKind): TaskWorkflowPlan {
  const setup = task.workflowSetup;
  // Confirmed setup wins; fall back to heuristic if no setup has been confirmed.
  // When neither is available, default to 'repo' (simplified workflow).
  const devKind: DevKind = setup?.devTargetKind ?? heuristicKind ?? 'repo';
  const workIntent: WorkIntent = setup?.workIntent ?? 'update';
  const isCreate = workIntent === 'create';
  const isReview = workIntent === 'review';
  const isCode   = isCodeTask(devKind);

  // ── Stage list ─────────────────────────────────────────────────────────────

  let stages: WorkflowStage[];
  let currentAction: TaskWorkflowPlan['currentAction'] = 'none';

  if (!isCode) {
    // Simplified: New → Analyzed → Done
    stages = [STAGE_NEW, STAGE_ANALYZED_DONE, STAGE_DONE];
  } else if (isReview) {
    // Review path: skip draft generation
    stages = [STAGE_NEW, STAGE_ANALYZED_REVIEW, STAGE_FOR_REVIEW, STAGE_DONE];
  } else {
    // Full dev path: New → Analyzed → In Progress → For Review → Done
    const analyzedStage = isCreate ? STAGE_ANALYZED_DRAFT : STAGE_ANALYZED_START;
    stages = [STAGE_NEW, analyzedStage, STAGE_IN_PROGRESS, STAGE_FOR_REVIEW, STAGE_DONE];
  }

  // Current stage's action label
  const currentStage = stages.find((s) => s.id === task.status);
  const currentActionLabel = currentStage?.actionLabel ?? 'Analyze';

  // Map task status to action dispatcher
  switch (task.status) {
    case 'new':
      currentAction = 'analyze';
      break;
    case 'analyzed':
      if (!isCode) {
        currentAction = 'mark-done';
      } else if (isReview) {
        currentAction = 'run-review';
      } else {
        currentAction = 'generate-draft';
      }
      break;
    case 'in-progress':
      currentAction = 'run-review';
      break;
    case 'ready-for-review':
      currentAction = 'mark-done';
      break;
    default:
      currentAction = 'none';
  }

  // ── Feature flags ──────────────────────────────────────────────────────────

  const requiresDevTools = isCode;
  const requiresDraftGeneration = isCode && !isReview;
  const requiresAiFileReview = isCode;
  const requiresPluginCreate = devKind === 'plugin' && isCreate;

  return {
    stages,
    currentActionLabel,
    currentAction,
    requiresDevTools,
    requiresDraftGeneration,
    requiresAiFileReview,
    requiresPluginCreate,
    isCreateIntent: isCreate,
  };
}
