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
  | 'confirm-setup'
  | 'create-plugin-project'
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
// Used for developer tasks awaiting plugin/script selection — New step opens Confirm Setup.
const S_NEW_CONFIRM: WorkflowStage = { id: 'new', label: 'New', actionLabel: 'Confirm Setup', next: 'analyzed' };
// Fallback: task already reached Analyzed state but plugin/script was never confirmed.
const S_ANA_SETUP_REQ: WorkflowStage = { id: 'analyzed', label: 'Analyzed', actionLabel: 'Setup Required', next: 'in-progress' };
const S_ANA_CREATE_PLUGIN: WorkflowStage = { id: 'analyzed', label: 'Analyzed', actionLabel: 'Create Plugin Project', next: 'in-progress' };
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

  const isCreate = workIntent === 'create';
  const isFix    = workIntent === 'fix';
  const isReview = workIntent === 'review';

  let workflowKind: WorkflowKind;
  if (!isCode && !isDeveloperAwaitingSetup) workflowKind = 'general';
  else if (isCreate) workflowKind = 'dev-create';
  else if (isFix)    workflowKind = 'dev-fix';
  else if (isReview) workflowKind = 'dev-review';
  else               workflowKind = 'dev-update';

  // Stage shape:
  //   - general                     -> New(Analyze)         -> Analyzed(Mark Done) -> Done
  //   - developer awaiting setup    -> New(Confirm Setup)   -> Analyzed(Start Work*) -> In Progress -> For Review -> Done
  //        *placeholder: once confirmed, label reflects real workIntent action
  //   - developer confirmed review  -> New(Analyze)         -> Analyzed(Run Review) -> For Review -> Done
  //   - developer confirmed create  -> New(Analyze)         -> Analyzed(Generate Draft) -> In Progress -> For Review -> Done
  //   - developer confirmed update/fix -> New(Analyze)      -> Analyzed(Start Work / Start Fixing) -> In Progress -> For Review -> Done
  // For create+plugin: split the Analyzed stage based on whether the project has been scaffolded.
  // Before the project exists the BPF action is "Create Plugin Project"; after, "Generate Draft".
  const isCreatePlugin = isCreate && devKind === 'plugin' && isCode;
  const pluginProjectExists = isCreatePlugin && !!setup?.pluginProject;

  let stages: WorkflowStage[];
  if (isGeneral) {
    stages = [S_NEW, S_ANA_DONE, S_DONE];
  } else if (isDeveloperAwaitingSetup) {
    // Use S_NEW_CONFIRM so the active New button says 'Confirm Setup'.
    // S_ANA_START is a placeholder — once setup is confirmed isDeveloperAwaitingSetup=false
    // and the stage will reflect the real workIntent action.
    stages = [S_NEW_CONFIRM, S_ANA_START, S_IN_PROGRESS, S_FOR_REVIEW, S_DONE];
  } else if (isReview) {
    stages = [S_NEW, S_ANA_REVIEW, S_FOR_REVIEW, S_DONE];
  } else if (isCreatePlugin) {
    // create+plugin: show the correct Analyzed stage label depending on project state.
    const mid = pluginProjectExists ? S_ANA_DRAFT : S_ANA_CREATE_PLUGIN;
    stages = [S_NEW, mid, S_IN_PROGRESS, S_FOR_REVIEW, S_DONE];
  } else {
    const mid = isCreate ? S_ANA_DRAFT : isFix ? S_ANA_FIX : S_ANA_START;
    stages = [S_NEW, mid, S_IN_PROGRESS, S_FOR_REVIEW, S_DONE];
  }

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
      else if (isReview)                   currentAction = 'run-review';
      else if (isCreatePlugin && !pluginProjectExists)
                                           currentAction = 'create-plugin-project';
      else if (isCreate)                   currentAction = 'generate-draft';
      else                                 currentAction = 'start-work';
      break;
    case 'in-progress':
      currentAction = isCode ? 'run-review' : 'none'; break;
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
    targetKind: (confirmedKind ?? devKind) as TargetKind,
    currentAction,
    currentActionLabel,
    requiresDevTools:         isCode,
    // For create+plugin: draft actions are only available once the project exists.
    requiresDraftGeneration:  isCode && !isReview && (!isCreatePlugin || pluginProjectExists),
    draftIsPrimaryAction:     isCode && isCreate && (!isCreatePlugin || pluginProjectExists),
    requiresExistingArtifact: isCode && !isCreate,
    requiresAiFileReview:     isCode,
    // Show the "Create Plugin Project" sidebar button only when the project doesn't exist yet.
    requiresPluginCreate:     isCreatePlugin && !pluginProjectExists,
    requiresScriptCreate:     confirmedKind === 'script' && isCreate,
    shouldInferReviewFile:    isCode && !isCreate,
    isDeveloperAwaitingSetup,
  };
}
