/**
 * TaskModeSwitch — compact Developer / General toggle for a task.
 *
 * Renders two pill buttons side-by-side. When taskMode is undefined the active
 * side is derived from heuristics and a small "auto" label is shown.
 */

import type { Task } from '../types';
import { inferTaskMode } from '../lib/taskMode';

interface Props {
  task: Task;
  onSetMode: (mode: 'developer' | 'general') => void;
}

export default function TaskModeSwitch({ task, onSetMode }: Props) {
  const { mode, isAuto } = inferTaskMode(task);

  return (
    <div className="task-mode-switch" role="group" aria-label="Task mode">
      <button
        className={`tms-btn${mode === 'developer' ? ' tms-btn--active' : ''}`}
        title="Use this when the task needs repository, script, plugin, draft, or code review workflow."
        onClick={() => onSetMode('developer')}
      >
        Developer
        {mode === 'developer' && isAuto && (
          <span className="tms-auto">auto</span>
        )}
      </button>
      <button
        className={`tms-btn${mode === 'general' ? ' tms-btn--active' : ''}`}
        title="Use this for non-code tasks that only need analysis and completion."
        onClick={() => onSetMode('general')}
      >
        General
        {mode === 'general' && isAuto && (
          <span className="tms-auto">auto</span>
        )}
      </button>
    </div>
  );
}
