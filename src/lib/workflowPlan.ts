import type { Task, TaskStatus, WorkflowSetup } from '../types';
import { inferTaskMode } from './taskMode';

/** Extends TaskStatus with the virtual 'testing' phase used for display only. */
export type DisplayPhase = TaskStatus | 'testing';

export interface WorkflowStage {
  id: DisplayPhase;
  label: string;
  actionLabel: string;
  next: TaskStatus | null;
}

export type WorkflowKind =
  | 'dev-create'
  | 'dev-update'
  | 'dev-fix'
  | 'dev-review'
  | 'general';

export type TargetKind = 'plugin' | 'script' | 'repo';

export type PlanAction =
  | 'analyze'
  | 'confirm-setup'
  | 'start-development'
  | 'verify-implementation'
  | 'mark-waiting-review'
  | 'mark-done'
  | 'none';

export interface TaskWorkflowPlan {
  stages: WorkflowStage[];
  workflowKind: WorkflowKind;
  /** Display phase — equals task.status normally; 'testing' when in-progress with consultant-testing waitingState. */
  displayPhase: DisplayPhase;
  targetKind: TargetKind;
  currentAction: PlanAction;
  currentActionLabel: string;
  requiresDevTools: boolean;
  requiresDraftGeneration: boolean;
  draftIsPrimaryAction: boolean;
  requiresExistingArtifact: boolean;
  requiresAiFileReview: boolean;
  requiresPluginCreate: boolean;
  requiresScriptCreate: boolean;
  shouldInferReviewFile: boolean;
  /** True when taskMode=developer but the user has not yet confirmed plugin or script target. */
  isDeveloperAwaitingSetup: boolean;
}

type DevKind = NonNullable<WorkflowSetup['devTargetKind']>;
type WorkIntent = NonNullable<WorkflowSetup['workIntent']>;

const S_NEW: WorkflowStage = { id: 'new', label: 'New', actionLabel: 'Analyze', next: 'analyzed' };
// Used for developer tasks awaiting plugin/script selection — New step opens Confirm Setup.
const S_NEW_CONFIRM: WorkflowStage = { id: 'new', label: 'New', actionLabel: 'Confirm Setup', next: 'analyzed' };
// Fallback: task already reached Analyzed state but plugin/script was never confirmed.
const S_ANA_SETUP_REQ: WorkflowStage = { id: 'analyzed', label: 'Analyzed', actionLabel: 'Setup Required', next: 'in-progress' };
const S_ANA_START: WorkflowStage = { id: 'analyzed', label: 'Analyzed', actionLabel: 'Start Development', next: 'in-progress' };
const S_ANA_DONE: WorkflowStage = { id: 'analyzed', label: 'Analyzed', actionLabel: 'Mark Done', next: 'done' };
const S_IN_PROGRESS: WorkflowStage = { id: 'in-progress', label: 'Development', actionLabel: 'Mark Waiting for Code Review', next: 'ready-for-review' };
/** Development stage for confirmed plugin tasks — primary action opens verification checks modal. */
const S_IN_PROGRESS_PLUGIN: WorkflowStage = { id: 'in-progress', label: 'Development', actionLabel: 'Verify Implementation', next: 'ready-for-review' };
/** Virtual Testing stage — active when displayPhase === 'testing' (any status with consultant-testing waitingState). */
const S_TESTING: WorkflowStage = { id: 'testing', label: 'Testing', actionLabel: 'Testing in progress', next: null };
/** Display-only Development stage used in the general stage array (not actionable via the stepper). */
const S_IN_PROGRESS_GEN: WorkflowStage = { id: 'in-progress', label: 'Development', actionLabel: '', next: null };
const S_FOR_REVIEW: WorkflowStage = { id: 'ready-for-review', label: 'Code Review', actionLabel: 'Mark Done', next: 'done' };
const S_DONE: WorkflowStage = { id: 'done', label: 'Done', actionLabel: 'Completed', next: null };

export function buildTaskWorkflowPlan(task: Task, heuristicKind?: DevKind): TaskWorkflowPlan {
  const setup = task.workflowSetup;
  // Normalize legacy 'repo' devTargetKind to undefined — repo is no longer a workflow target.
  const rawKind: DevKind = setup?.devTargetKind ?? heuristicKind ?? 'repo';
  const devKind: DevKind = rawKind === 'repo' ? 'script' : rawKind;
  const confirmedKind: 'plugin' | 'script' | undefined =
    (setup?.devTargetKind && setup.devTargetKind !== 'repo')
      ? (setup.devTargetKind as 'plugin' | 'script')
      : undefined;

  const workIntent: WorkIntent = setup?.workIntent ?? 'update';

  const { mode: taskMode } = inferTaskMode(task);

  // "code task": developer mode AND user has explicitly confirmed plugin or script target.
  // taskMode = general → never code.
  // taskMode = developer + no confirmed plugin/script → not yet full code workflow, but
  //   still a developer task — use developer stages without dev-tool flags.
  const isPluginOrScript = devKind === 'plugin' || devKind === 'script';
  const isCode = taskMode === 'general'
    ? false
    : taskMode === 'developer'
      ? isPluginOrScript && !!confirmedKind   // requires explicit user confirmation
      : isPluginOrScript;

  // True when developer mode but plugin/script target not yet confirmed.
  const isDeveloperAwaitingSetup = taskMode === 'developer' && !confirmedKind;
  // True for the general (non-developer) workflow shape.
  const isGeneral = taskMode === 'general';

  const isFix    = workIntent === 'fix';
  const isReview = workIntent === 'review';
  const isCreate = workIntent === 'create';

  let workflowKind: WorkflowKind;
  if (!isCode && !isDeveloperAwaitingSetup) workflowKind = 'general';
  else if (isCreate) workflowKind = 'dev-create';
  else if (isFix)    workflowKind = 'dev-fix';
  else if (isReview) workflowKind = 'dev-review';
  else               workflowKind = 'dev-update';

  // Stage shape:
  //   - general                  -> New(Analyze)       -> Analyzed(Mark Done) -> Done
  //   - developer awaiting setup -> New(Confirm Setup) -> Analyzed(Start Development) -> Development -> Review -> Done
  //   - developer confirmed      -> New(Analyze)       -> Analyzed(Start Development) -> Development -> Review -> Done
  //
  // Tooling such as draft generation, opening IDEs, AI review, and plugin
  // scaffolding is intentionally not represented as a required timeline step.
  // The timeline is a lifecycle map; tools live in the side panel.
  let stages: WorkflowStage[];
  if (isGeneral) {
    // Include Development, Testing, and Review so any status shows an active step.
    stages = [S_NEW, S_ANA_DONE, S_IN_PROGRESS_GEN, S_TESTING, S_FOR_REVIEW, S_DONE];
  } else {
    const devStage = ((devKind === 'plugin' || devKind === 'script') && !!confirmedKind) ? S_IN_PROGRESS_PLUGIN : S_IN_PROGRESS;
    stages = [isDeveloperAwaitingSetup ? S_NEW_CONFIRM : S_NEW, S_ANA_START, devStage, S_TESTING, S_FOR_REVIEW, S_DONE];
  }

  // Display phase: 'testing' whenever consultant-testing waitingState is set, regardless of status.
  // This covers local-testing-in-progress (in-progress) and waiting-for-consultant (any status).
  const displayPhase: DisplayPhase =
    task.waitingState === 'consultant-testing' ? 'testing' : task.status;

  let currentAction: PlanAction = 'none';
  switch (task.status) {
    case 'new':
      // Developer tasks awaiting setup: Confirm Setup action opens the setup modal.
      // All other tasks: Analyze action runs analysis (may include re-confirm for edge cases).
      currentAction = isDeveloperAwaitingSetup ? 'confirm-setup' : 'analyze';
      break;
    case 'analyzed':
      if (isGeneral)                       currentAction = 'mark-done';
      // Edge case: task reached Analyzed without confirmed plugin/script (e.g. legacy data).
      else if (isDeveloperAwaitingSetup)   currentAction = 'confirm-setup';
      else                                 currentAction = 'start-development';
      break;
    case 'in-progress':
      if (isCode) {
        // Plugin tasks get "Verify Implementation" as the primary Development action.
        // Script/other dev tasks keep "Mark Waiting for Review".
        currentAction = ((devKind === 'plugin' || devKind === 'script') && !!confirmedKind)
          ? 'verify-implementation'
          : 'mark-waiting-review';
      } else {
        currentAction = 'none';
      }
      break;
    case 'ready-for-review':
      currentAction = 'mark-done'; break;
    default:
      currentAction = 'none';
  }

  // For the edge-case analyzed+awaiting state, override the stage label so it reads 'Setup Required'.
  const currentStage = (isDeveloperAwaitingSetup && task.status === 'analyzed')
    ? S_ANA_SETUP_REQ
    : stages.find((s) => s.id === task.status);
  const currentActionLabel = currentStage?.actionLabel ?? 'Analyze';

  return {
    stages,
    workflowKind,
    displayPhase,
    targetKind: (confirmedKind ?? devKind) as TargetKind,
    currentAction,
    currentActionLabel,
    requiresDevTools:         isCode,
    requiresDraftGeneration:  isCode && !isReview,
    draftIsPrimaryAction:     isCode && isCreate,
    requiresExistingArtifact: isCode && !isCreate,
    requiresAiFileReview:     isCode,
    // Kept for compatibility; plugin project creation is now an optional helper, not a workflow gate.
    requiresPluginCreate:     false,
    requiresScriptCreate:     confirmedKind === 'script' && isCreate,
    shouldInferReviewFile:    isCode && !isCreate,
    isDeveloperAwaitingSetup,
  };
}
