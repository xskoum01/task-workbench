/**
 * taskMode.ts — resolves the effective developer/general mode for a task.
 *
 * Priority:
 *   1. task.taskMode (explicit user override)
 *   2. ADO work-item or PR assignment → developer
 *   3. workflowSetup.devTargetKind = plugin | script → developer
 *   4. devopsTaskUrl present → developer
 *   5. default → general
 */
import type { Task } from '../types';

export type TaskMode = 'developer' | 'general';

export interface ResolvedTaskMode {
  mode: TaskMode;
  /** True when the mode is derived from heuristics, false when user-set. */
  isAuto: boolean;
}

/**
 * Returns the effective task mode and whether it is heuristically inferred.
 * Components should use this instead of reading task.taskMode directly.
 */
export function inferTaskMode(task: Task): ResolvedTaskMode {
  // Explicit user override always wins.
  if (task.taskMode) {
    return { mode: task.taskMode, isAuto: false };
  }

  // ADO work-item assignment emails are almost always developer tasks.
  if (task.adoContext?.type === 'work-item') {
    return { mode: 'developer', isAuto: true };
  }

  // ADO PR comments are code review → developer.
  if (task.adoContext?.type === 'pr-comment') {
    return { mode: 'developer', isAuto: true };
  }

  // Explicit devops URL → developer context.
  if (task.devopsTaskUrl) {
    return { mode: 'developer', isAuto: true };
  }

  // User already confirmed a dev kind → developer.
  const devKind = task.workflowSetup?.devTargetKind;
  if (devKind === 'plugin' || devKind === 'script' || devKind === 'repo') {
    return { mode: 'developer', isAuto: true };
  }

  return { mode: 'general', isAuto: true };
}
