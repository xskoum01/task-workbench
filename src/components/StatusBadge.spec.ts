import { describe, expect, it } from 'vitest';
import { shouldShowWaitingBadge } from './StatusBadge';

describe('shouldShowWaitingBadge', () => {
  it('hides the waiting badge when its label is identical to the status label ("Waiting for code review")', () => {
    expect(shouldShowWaitingBadge({ status: 'ready-for-review', waitingState: 'code-review' })).toBe(false);
  });

  it('shows the waiting badge when the labels differ, e.g. in-progress + code-review', () => {
    expect(shouldShowWaitingBadge({ status: 'in-progress', waitingState: 'code-review' })).toBe(true);
  });

  it('shows the waiting badge for pricing-approval regardless of status', () => {
    expect(shouldShowWaitingBadge({ status: 'new', waitingState: 'pricing-approval' })).toBe(true);
    expect(shouldShowWaitingBadge({ status: 'in-progress', waitingState: 'pricing-approval' })).toBe(true);
  });

  it('shows the waiting badge for consultant-testing regardless of status', () => {
    expect(shouldShowWaitingBadge({ status: 'in-progress', waitingState: 'consultant-testing' })).toBe(true);
  });

  it('returns false when there is no waiting state at all', () => {
    expect(shouldShowWaitingBadge({ status: 'ready-for-review', waitingState: undefined })).toBe(false);
    expect(shouldShowWaitingBadge({ status: 'in-progress', waitingState: null })).toBe(false);
  });
});
