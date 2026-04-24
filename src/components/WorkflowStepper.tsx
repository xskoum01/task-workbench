import type { TaskStatus } from '../types';
import type { WorkflowStage } from '../lib/workflowPlan';

interface WorkflowStepperProps {
  status: TaskStatus;
  /** Dynamic stage list from buildTaskWorkflowPlan(). */
  stages: WorkflowStage[];
  /** Called when the user clicks the active step to trigger its stage action. */
  onRunCurrentAction: () => void;
  /** True while the current stage action is running — disables + shows spinner. */
  isRunning: boolean;
}

export function WorkflowStepper({ status, stages, onRunCurrentAction, isRunning }: WorkflowStepperProps) {
  const isBlocked    = status === 'blocked';
  const currentIndex = isBlocked ? -1 : stages.findIndex((s) => s.id === status);

  return (
    <div className="workflow-bpf" aria-label="Task workflow">
      {stages.map((stage, i) => {
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
