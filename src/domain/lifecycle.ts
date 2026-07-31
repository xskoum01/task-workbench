import type { WorkItemStatus } from './workItem';

export const WORK_ITEM_TRANSITIONS: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> = {
  planned: ['ready', 'in_progress', 'waiting', 'blocked', 'cancelled'],
  ready: ['planned', 'in_progress', 'waiting', 'blocked', 'cancelled'],
  in_progress: ['waiting', 'blocked', 'review', 'completed', 'cancelled'],
  waiting: ['ready', 'in_progress', 'blocked', 'cancelled'],
  blocked: ['planned', 'ready', 'in_progress', 'cancelled'],
  review: ['in_progress', 'waiting', 'blocked', 'completed', 'cancelled'],
  completed: ['planned'],
  cancelled: ['planned'],
};

export interface TransitionValidation {
  allowed: boolean;
  requiresReason: boolean;
  reason?: string;
}

export function validateWorkItemTransition(
  from: WorkItemStatus,
  to: WorkItemStatus,
  reason?: string,
): TransitionValidation {
  if (from === to) {
    return { allowed: true, requiresReason: false };
  }

  if (!WORK_ITEM_TRANSITIONS[from].includes(to)) {
    return {
      allowed: false,
      requiresReason: false,
      reason: `Transition from ${from} to ${to} is not allowed.`,
    };
  }

  const requiresReason = to === 'blocked' || to === 'cancelled';
  if (requiresReason && !reason?.trim()) {
    return {
      allowed: false,
      requiresReason: true,
      reason: `Transition to ${to} requires a reason.`,
    };
  }

  return { allowed: true, requiresReason };
}

export function assertWorkItemTransition(
  from: WorkItemStatus,
  to: WorkItemStatus,
  reason?: string,
): void {
  const result = validateWorkItemTransition(from, to, reason);
  if (!result.allowed) throw new WorkItemTransitionError(from, to, result.reason);
}

export class WorkItemTransitionError extends Error {
  readonly code = 'invalid_transition';

  constructor(
    readonly from: WorkItemStatus,
    readonly to: WorkItemStatus,
    message = `Transition from ${from} to ${to} is not allowed.`,
  ) {
    super(message);
    this.name = 'WorkItemTransitionError';
  }
}
