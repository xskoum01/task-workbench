import type { TaskStatus } from '../types';

interface StageConfig {
  id: TaskStatus;
  label: string;
  actionLabel: string;
  /** Status to move to after clicking this stage's action. Null = terminal stage. */
  next: TaskStatus | null;
}

export const STAGES: StageConfig[] = [
  { id: 'new',              label: 'New',         actionLabel: 'Analyze',         next: 'analyzed'         },
  { id: 'analyzed',         label: 'Analyzed',    actionLabel: 'Generate Draft',  next: 'in-progress'      },
  { id: 'in-progress',      label: 'In Progress', actionLabel: 'Send for Review', next: 'ready-for-review' },
  { id: 'ready-for-review', label: 'For Review',  actionLabel: 'Mark Done',       next: 'done'             },
  { id: 'done',             label: 'Done',        actionLabel: 'Completed',       next: null               },
];

interface WorkflowStepperProps {
  status: TaskStatus;
  /** Called when the user clicks the active step to trigger its stage action. */
  onRunCurrentAction: () => void;
  /** True while the current stage action is running — disables + shows spinner. */
  isRunning: boolean;
}

export function WorkflowStepper({ status, onRunCurrentAction, isRunning }: WorkflowStepperProps) {
  const isBlocked    = status === 'blocked';
  const currentIndex = isBlocked ? -1 : STAGES.findIndex((s) => s.id === status);

  return (
    <div className="workflow-bpf" aria-label="Task workflow">
      {STAGES.map((stage, i) => {
        const isActive    = !isBlocked && stage.id === status;
        const isCompleted = !isBlocked && i < currentIndex;

        const stateClass = isActive    ? 'workflow-bpf-step--active'
                         : isCompleted ? 'workflow-bpf-step--completed'
                         :               'workflow-bpf-step--upcoming';

        return (
          <button
            key={stage.id}
            type="button"
            className={`workflow-bpf-step workflow-bpf-step--${stage.id} ${stateClass}`}
            onClick={isActive && stage.next ? onRunCurrentAction : undefined}
            disabled={!isActive || !stage.next || isRunning}
            title={
              isActive && stage.next
                ? isRunning
                  ? `Running: ${stage.actionLabel}…`
                  : `Click to run: ${stage.actionLabel}`
                : isCompleted
                  ? stage.label
                  : `Not yet reached: ${stage.label}`
            }
          >
            <span className="workflow-bpf-stage-name">
              {isCompleted && <span className="workflow-bpf-check" aria-hidden="true">✓ </span>}
              {stage.label}
            </span>
            <span className="workflow-bpf-action-label">
              {isActive && stage.next && !isRunning && (
                <span className="workflow-bpf-action-arrow" aria-hidden="true">›&nbsp;</span>
              )}
              {isActive && isRunning && (
                <span className="workflow-bpf-spinner" aria-hidden="true" />
              )}
              {isCompleted ? 'Done' : stage.actionLabel}
            </span>
          </button>
        );
      })}

      {isBlocked && (
        <div className="workflow-bpf-blocked" role="status">
          <span className="workflow-bpf-blocked-dot" aria-hidden="true" />
          Blocked
        </div>
      )}
    </div>
  );
}
