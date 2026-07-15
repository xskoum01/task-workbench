import type { DisplayPhase, WorkflowStage } from '../lib/workflowPlan';

interface WorkflowStepperProps {
  displayPhase: DisplayPhase;
  /** Dynamic stage list from buildTaskWorkflowPlan(). */
  stages: WorkflowStage[];
  /** Called when the user clicks the active step to trigger its stage action. */
  onRunCurrentAction: () => void;
  /** True while the current stage action is running — disables + shows spinner. */
  isRunning: boolean;
  /**
   * Called when the user clicks the active Testing step.
   * When provided, the Testing step becomes clickable even though it has no next action.
   */
  onTestingAction?: () => void;
  /**
   * When set, overrides the actionLabel shown on the currently active step.
   * Used by the AI Kit workflow to surface the recommended action in the stepper.
   */
  actionLabelOverride?: string;
}

export function WorkflowStepper({ displayPhase, stages, onRunCurrentAction, isRunning, onTestingAction, actionLabelOverride }: WorkflowStepperProps) {
  const isBlocked    = displayPhase === 'blocked';
  const currentIndex = isBlocked ? -1 : stages.findIndex((s) => s.id === displayPhase);

  return (
    <div className="workflow-bpf" aria-label="Task workflow">
      {stages.map((stage, i) => {
        const isActive      = !isBlocked && stage.id === displayPhase;
        const isCompleted   = !isBlocked && i < currentIndex;
        const isTestingStep = stage.id === 'testing';
        // Testing step is clickable when active and the caller provided a handler,
        // even though it has no next action in the normal flow.
        const hasClickAction = isActive && (stage.next != null || (isTestingStep && !!onTestingAction));

        const stateClass = isActive    ? 'workflow-bpf-step--active'
                         : isCompleted ? 'workflow-bpf-step--completed'
                         :               'workflow-bpf-step--upcoming';

        const handleClick = hasClickAction
          ? (stage.next != null ? onRunCurrentAction : onTestingAction)
          : undefined;

        // Use override label for the active step when provided.
        const displayLabel = isActive && actionLabelOverride ? actionLabelOverride : stage.actionLabel;

        return (
          <button
            key={stage.id}
            type="button"
            className={`workflow-bpf-step workflow-bpf-step--${stage.id} ${stateClass}`}
            onClick={handleClick}
            disabled={!hasClickAction || isRunning}
            title={
              hasClickAction
                ? isRunning
                  ? `Running: ${displayLabel}…`
                  : isTestingStep
                    ? 'Click to view deployment & testing actions'
                    : `Click to run: ${displayLabel}`
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
              {hasClickAction && !isRunning && (
                <span className="workflow-bpf-action-arrow" aria-hidden="true">›&nbsp;</span>
              )}
              {isActive && isRunning && (
                <span className="workflow-bpf-spinner" aria-hidden="true" />
              )}
              {isCompleted ? 'Done' : displayLabel}
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
