import type { Task, TaskStatus, WorkflowSetup } from '../types';
import { inferTaskMode } from './taskMode';

export interface WorkflowStage {
  id: TaskStatus;
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
  | 'generate-draft'
  | 'start-work'
  | 'run-review'
  | 'mark-done'
  | 'none';

export interface TaskWorkflowPlan {
  stages: WorkflowStage[];
  workflowKind: WorkflowKind;
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
const S_ANA_DRAFT: WorkflowStage = { id: 'analyzed', label: 'Analyzed', actionLabel: 'Generate Draft', next: 'in-progress' };
const S_ANA_START: WorkflowStage = { id: 'analyzed', label: 'Analyzed', actionLabel: 'Start Work', next: 'in-progress' };
const S_ANA_FIX: WorkflowStage = { id: 'analyzed', label: 'Analyzed', actionLabel: 'Start Fixing', next: 'in-progress' };
const S_ANA_REVIEW: WorkflowStage = { id: 'analyzed', label: 'Analyzed', actionLabel: 'Run Review', next: 'ready-for-review' };
const S_ANA_DONE: WorkflowStage = { id: 'analyzed', label: 'Analyzed', actionLabel: 'Mark Done', next: 'done' };
const S_IN_PROGRESS: WorkflowStage = { id: 'in-progress', label: 'In Progress', actionLabel: 'Send for Review', next: 'ready-for-review' };
const S_FOR_REVIEW: WorkflowStage = { id: 'ready-for-review', label: 'For Review', actionLabel: 'Mark Done', next: 'done' };
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
  // taskMode = developer + no confirmed plugin/script → still not code until setup is done.
  const isPluginOrScript = devKind === 'plugin' || devKind === 'script';
  const isCode = taskMode === 'general'
    ? false
    : taskMode === 'developer'
      ? isPluginOrScript && !!confirmedKind   // requires explicit user confirmation
      : isPluginOrScript;

  // For developer tasks where setup is not yet confirmed (no plugin/script chosen),
  // use a minimal analyze-only stage.
  const isDeveloperAwaitingSetup = taskMode === 'developer' && !confirmedKind;

  const isCreate = workIntent === 'create';
  const isFix    = workIntent === 'fix';
  const isReview = workIntent === 'review';

  let workflowKind: WorkflowKind;
  if (!isCode)       workflowKind = 'general';
  else if (isCreate) workflowKind = 'dev-create';
  else if (isFix)    workflowKind = 'dev-fix';
  else if (isReview) workflowKind = 'dev-review';
  else               workflowKind = 'dev-update';

  let stages: WorkflowStage[];
  if (!isCode) {
    stages = [S_NEW, S_ANA_DONE, S_DONE];
  } else if (isReview) {
    stages = [S_NEW, S_ANA_REVIEW, S_FOR_REVIEW, S_DONE];
  } else {
    const mid = isCreate ? S_ANA_DRAFT : isFix ? S_ANA_FIX : S_ANA_START;
    stages = [S_NEW, mid, S_IN_PROGRESS, S_FOR_REVIEW, S_DONE];
  }

  let currentAction: PlanAction = 'none';
  switch (task.status) {
    case 'new':
      currentAction = 'analyze'; break;
    case 'analyzed':
      if (!isCode)       currentAction = 'mark-done';
      else if (isReview) currentAction = 'run-review';
      else if (isCreate) currentAction = 'generate-draft';
      else               currentAction = 'start-work';
      break;
    case 'in-progress':
      currentAction = 'run-review'; break;
    case 'ready-for-review':
      currentAction = 'mark-done'; break;
    default:
      currentAction = 'none';
  }

  const currentStage = stages.find((s) => s.id === task.status);
  const currentActionLabel = currentStage?.actionLabel ?? 'Analyze';

  return {
    stages,
    workflowKind,
    targetKind: (confirmedKind ?? devKind) as TargetKind,
    currentAction,
    currentActionLabel,
    requiresDevTools:         isCode,
    requiresDraftGeneration:  isCode && !isReview,
    draftIsPrimaryAction:     isCode && isCreate,
    requiresExistingArtifact: isCode && !isCreate,
    requiresAiFileReview:     isCode,
    requiresPluginCreate:     confirmedKind === 'plugin' && isCreate,
    requiresScriptCreate:     confirmedKind === 'script' && isCreate,
    shouldInferReviewFile:    isCode && !isCreate,
    isDeveloperAwaitingSetup,
  };
}
