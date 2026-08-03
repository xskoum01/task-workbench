import { describe, expect, it } from 'vitest';
import { applyTaskPhase, PHASE_OPTIONS } from './taskPhase';

describe('task phase planning mapping', () => {
  it('exposes the requested record statuses in order', () => {
    expect(PHASE_OPTIONS.map((option) => option.label)).toEqual([
      'New',
      'Need estimate',
      'Waiting for estimate approval',
      'Development',
      'Testing',
      'Waiting for code review',
      'Done',
    ]);
  });

  it('stores each record status in the requested planning bucket', () => {
    expect(applyTaskPhase('new')).toMatchObject({ status: 'new', planningBucket: 'today' });
    expect(applyTaskPhase('analyzed')).toMatchObject({ status: 'analyzed', planningBucket: 'now' });
    expect(applyTaskPhase('waiting-estimate-approval')).toMatchObject({
      status: 'new',
      waitingState: 'pricing-approval',
      planningBucket: 'waiting',
    });
    expect(applyTaskPhase('development')).toMatchObject({ status: 'in-progress', planningBucket: 'now' });
    expect(applyTaskPhase('waiting-consultant-testing')).toMatchObject({
      status: 'in-progress',
      waitingState: 'consultant-testing',
      planningBucket: 'today',
    });
    expect(applyTaskPhase('waiting-review')).toMatchObject({
      status: 'ready-for-review',
      waitingState: 'code-review',
      planningBucket: 'waiting',
    });
  });
});
