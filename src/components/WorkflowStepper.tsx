import type { TaskStatus } from '../types';

interface StageConfig {
  id: TaskStatus;
  /** Short display name shown at the top of the step. */
  label: string;
  /** The action the user takes while in this stage to advance. */
  actionLabel: string;
  /** Status to move to when the user clicks the advance CTA on this stage. */
  next: TaskStatus | null;
}

const STAGES: StageConfig[] = [
  { id: 'new',              label: 'New',         actionLabel: 'Analyze',         next: 'analyzed'         },
  { id: 'analyzed',         label: 'Analyzed',    actionLabel: 'Start Work',      next: 'in-progress'      },
  { id: 'in-progress',      label: 'In Progress', actionLabel: 'Send for Review', next: 'ready-for-review' },
  { id: 'ready-for-review', label: 'For Review',  actionLabel: 'Mark Done',       next: 'done'             },
  { id: 'done',             label: 'Done',        actionLabel: 'Completed',       next: null               },
];

interface WorkflowStepperProps {
  status: TaskStatus;
  /** Called with the target status whenever the user clicks a step or the advance CTA. */
  onChange?: (status: TaskStatus) => void;
}

export function WorkflowStepper({ status, onChange }: WorkflowStepperProps) {
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

        const handleClick = () => {
          if (!onChange) return;
          // Active step → advance to next; all others → navigate to that stage
          if (isActive && stage.next) onChange(stage.next);
          else onChange(stage.id);
        };

        return (
          <button
            key={stage.id}
            type="button"
            className={`workflow-bpf-step workflow-bpf-step--${stage.id} ${stateClass}`}
            onClick={handleClick}
            disabled={!onChange || (isActive && !stage.next)}
            title={
              isActive && stage.next
                ? `Click to advance: ${stage.actionLabel}`
                : isCompleted
                  ? `Go back to: ${stage.label}`
                  : `Jump to: ${stage.label}`
            }
          >
            <span className="workflow-bpf-stage-name">
              {isCompleted && <span className="workflow-bpf-check" aria-hidden="true">✓ </span>}
              {stage.label}
            </span>
            <span className="workflow-bpf-action-label">
              {isActive && stage.next && (
                <span className="workflow-bpf-action-arrow" aria-hidden="true">›&nbsp;</span>
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
