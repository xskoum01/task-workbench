import type { TaskStatus } from '../types';

/** Ordered pipeline stages — "blocked" is orthogonal and shown separately. */
const FLOW_STAGES: TaskStatus[] = [
  'new',
  'analyzed',
  'in-progress',
  'ready-for-review',
  'done',
];

const STAGE_LABELS: Record<TaskStatus, string> = {
  'new':              'New',
  'analyzed':         'Analyzed',
  'in-progress':      'In Progress',
  'ready-for-review': 'For Review',
  'done':             'Done',
  'blocked':          'Blocked',
};

interface WorkflowStepperProps {
  status: TaskStatus;
  onChange?: (status: TaskStatus) => void;
}

export function WorkflowStepper({ status, onChange }: WorkflowStepperProps) {
  const isBlocked = status === 'blocked';
  const currentIndex = isBlocked ? -1 : FLOW_STAGES.indexOf(status);

  return (
    <div className="workflow-stepper" aria-label="Task workflow">
      {FLOW_STAGES.map((stage, i) => {
        const isActive    = !isBlocked && stage === status;
        const isCompleted = !isBlocked && i < currentIndex;
        const isUpcoming  = isBlocked || i > currentIndex;

        const classNames = [
          'workflow-step',
          `workflow-step--${stage}`,
          isActive    ? 'workflow-step--active'   : '',
          isCompleted ? 'workflow-step--completed' : '',
          isUpcoming  ? 'workflow-step--upcoming'  : '',
        ].filter(Boolean).join(' ');

        return (
          <button
            key={stage}
            className={classNames}
            onClick={() => onChange?.(stage)}
            title={`Set status: ${STAGE_LABELS[stage]}`}
            disabled={!onChange}
            type="button"
          >
            {isCompleted && <span className="workflow-step-check" aria-hidden>✓</span>}
            <span className="workflow-step-label">{STAGE_LABELS[stage]}</span>
          </button>
        );
      })}

      {isBlocked && (
        <span className="workflow-step-blocked-badge" title="Task is blocked">
          Blocked
        </span>
      )}
    </div>
  );
}
