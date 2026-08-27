/**
 * taskMode.ts — resolves the effective developer/general mode for a task.
 *
 * Priority:
 *   1. task.taskMode (explicit user override)
 *   2. ADO work-item or PR assignment → developer
 *   3. devopsTaskUrl present → developer
 *   4. workflowSetup.devTargetKind = plugin | script | repo → developer
 *   5. Text-based heuristic: plugin/script/Dataverse technical keywords → developer
 *   6. default → general
 */
import type { Task } from '../types';
import taskModeContract from './taskModeContract.json';

export type TaskMode = 'developer' | 'general';

export interface ResolvedTaskMode {
  mode: TaskMode;
  /** True when the mode is derived from heuristics, false when user-set. */
  isAuto: boolean;
}

/**
 * Plugin/script technical keywords that reliably indicate a developer task.
 * Requires a meaningful technical signal — generic words like "update" or "fix" are excluded.
 *
 * NOTE: Czech accented characters (ě, á, ž …) are \W in JS regex, so \b after them
 * does NOT work. Use explicit alternatives (e.g. entit[eě]) instead.
 */
const DEVELOPER_ADO_CONTEXT_TYPES = new Set(taskModeContract.developerAdoContextTypes);
const DEVELOPER_TARGET_KINDS = new Set(taskModeContract.developerTargetKinds);
const DEVELOPER_KEYWORDS = taskModeContract.developerKeywordPatterns.map(
  (pattern) => new RegExp(pattern, 'i'),
);

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
  if (task.adoContext?.type && DEVELOPER_ADO_CONTEXT_TYPES.has(task.adoContext.type)) {
    return { mode: 'developer', isAuto: true };
  }

  // Explicit devops URL → developer context.
  if (task.devopsTaskUrl) {
    return { mode: 'developer', isAuto: true };
  }

  // User already confirmed a dev kind → developer.
  const devKind = task.workflowSetup?.devTargetKind;
  if (devKind && DEVELOPER_TARGET_KINDS.has(devKind)) {
    return { mode: 'developer', isAuto: true };
  }

  // Text-based heuristic: scan title + originalMessage for technical developer signals.
  // Requires at least one strong keyword match — generic task words are intentionally excluded.
  const textToScan = `${task.title} ${task.originalMessage ?? ''} ${task.analysisResult?.summary ?? ''}`;
  for (const kw of DEVELOPER_KEYWORDS) {
    if (kw.test(textToScan)) {
      return { mode: 'developer', isAuto: true };
    }
  }

  return { mode: 'general', isAuto: true };
}
