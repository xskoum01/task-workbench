/**
 * Shared task phase vocabulary.
 *
 * TaskPhase is a form/UI-layer type that combines status + waitingState + attentionState
 * into a single user-visible concept.  It is never stored directly — use getTaskPhase()
 * to read and applyTaskPhase() to produce the Partial<Task> patch before saving.
 */
import type { Task, TaskWaitingState } from '../types';

export type TaskPhase =
  | 'new'
  | 'waiting-estimate-approval'
  | 'analyzed'
  | 'development'
  | 'waiting-consultant-testing'
  | 'waiting-review'
  | 'pr-comments'
  | 'blocked'
  | 'done';

export const PHASE_OPTIONS: { value: TaskPhase; label: string }[] = [
  { value: 'new',                        label: 'New'                           },
  { value: 'analyzed',                   label: 'Need estimate'                 },
  { value: 'waiting-estimate-approval',  label: 'Waiting for estimate approval' },
  { value: 'development',                label: 'Development'                   },
  { value: 'waiting-consultant-testing', label: 'Testing'                       },
  { value: 'waiting-review',             label: 'Waiting for code review'       },
  { value: 'done',                       label: 'Done'                          },
];

/**
 * Derives the UI TaskPhase from the persisted task fields.
 * Priority: attentionState → status extremes (blocked/done) → waitingState → status.
 */
export function getTaskPhase(
  task: Pick<Task, 'status' | 'waitingState' | 'attentionState'>,
): TaskPhase {
  if (task.attentionState === 'pr-comments')        return 'pr-comments';
  if (task.status === 'blocked')                    return 'blocked';
  if (task.status === 'done')                       return 'done';
  if (task.waitingState === 'pricing-approval')     return 'waiting-estimate-approval';
  if (task.waitingState === 'consultant-testing')   return 'waiting-consultant-testing';
  if (task.waitingState === 'code-review')          return 'waiting-review';
  if (task.status === 'in-progress')                return 'development';
  if (task.status === 'ready-for-review')           return 'waiting-review';
  if (task.status === 'analyzed')                   return 'analyzed';
  return 'new';
}

type PhasePatch = Pick<Task, 'status'> &
  Pick<Partial<Task>, 'waitingState' | 'attentionState' | 'planningBucket' | 'isPlanningLocked'>;

/**
 * Returns the task patch that should be applied when the user selects a phase.
 * `status` is always present; all waiting/attention states are explicitly cleared.
 */
export function applyTaskPhase(phase: TaskPhase): PhasePatch {
  switch (phase) {
    case 'new':
      return { status: 'new', waitingState: null, attentionState: null, planningBucket: 'today', isPlanningLocked: false };
    case 'waiting-estimate-approval':
      return { status: 'new', waitingState: 'pricing-approval' as TaskWaitingState, attentionState: null, planningBucket: 'waiting', isPlanningLocked: false };
    case 'analyzed':
      return { status: 'analyzed', waitingState: null, attentionState: null, planningBucket: 'now', isPlanningLocked: false };
    case 'development':
      return { status: 'in-progress', waitingState: null, attentionState: null, planningBucket: 'now', isPlanningLocked: false };
    case 'waiting-consultant-testing':
      return { status: 'in-progress', waitingState: 'consultant-testing' as TaskWaitingState, attentionState: null, planningBucket: 'today', isPlanningLocked: false };
    case 'waiting-review':
      return { status: 'ready-for-review', waitingState: 'code-review' as TaskWaitingState, attentionState: null, planningBucket: 'waiting', isPlanningLocked: false };
    case 'pr-comments':
      return { status: 'in-progress', waitingState: null, attentionState: 'pr-comments', planningBucket: 'now', isPlanningLocked: false };
    case 'blocked':
      return { status: 'blocked', waitingState: null, attentionState: null };
    case 'done':
      return { status: 'done', waitingState: null, attentionState: null };
  }
}
