import { describe, it, expect } from 'vitest';
import { effectiveBucket, groupByBucket } from './planning';
import type { Task } from '../types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    title: '[TEST] Task',
    status: 'in-progress',
    customerId: 'customer-acme',
    ...overrides,
  } as unknown as Task;
}

describe('effectiveBucket', () => {
  it('matches only the explicit planningBucket, mirroring the backend exact-match rule', () => {
    const locked = makeTask({ planningBucket: 'now' });
    expect(effectiveBucket(locked)).toBe('now');
  });

  it('does not infer Now/Today from a due date when no bucket is explicitly set', () => {
    // This is the exact class of task that used to diverge from REST:
    // due today, never locked into a bucket by the user.
    const dueToday = makeTask({ dueAt: new Date().toISOString(), planningBucket: undefined });
    expect(effectiveBucket(dueToday)).not.toBe('today');
    expect(effectiveBucket(dueToday)).not.toBe('now');
  });

  it('falls back to queue — not a computed suggestion — when unbucketed', () => {
    const unbucketed = makeTask({});
    expect(effectiveBucket(unbucketed)).toBe('queue');
  });

  it('ignores suggestedPlanningBucket for membership purposes', () => {
    // suggestedPlanningBucket is a hint for quick-action buttons only; it
    // must never silently promote a task into Now/Today the way the old
    // heuristic fallback did.
    const suggested = makeTask({ suggestedPlanningBucket: 'today' });
    expect(effectiveBucket(suggested)).toBe('queue');
  });

  it('routes waiting tasks to the waiting bucket when no explicit bucket is set', () => {
    const waiting = makeTask({ waitingState: 'code-review' });
    expect(effectiveBucket(waiting)).toBe('waiting');
  });

  it('an explicit planningBucket wins over waitingState', () => {
    const lockedWhileWaiting = makeTask({ waitingState: 'code-review', planningBucket: 'later' });
    expect(effectiveBucket(lockedWhileWaiting)).toBe('later');
  });

  it('no longer auto-promotes pr-comments attention into Now without an explicit bucket', () => {
    const prComments = makeTask({ attentionState: 'pr-comments' });
    expect(effectiveBucket(prComments)).toBe('queue');
  });
});

describe('groupByBucket — parity with REST/MCP planning/today counts', () => {
  it('reproduces the reported live NOW=2 / TODAY=1 split from explicit buckets alone', () => {
    const tasks: Task[] = [
      makeTask({ id: '1', title: 'Portál email s pozvánkou + css', planningBucket: 'now' }),
      makeTask({ id: '2', title: 'Nahrávky chyba', planningBucket: 'now' }),
      makeTask({ id: '3', title: 'Jan Kvicala zpráva dashboard', planningBucket: 'today' }),
      // Unrelated, unbucketed task with a due date today — must NOT leak
      // into now/today the way the pre-fix heuristic would have.
      makeTask({ id: '4', title: 'Unbucketed noise', dueAt: new Date().toISOString() }),
    ];

    const groups = groupByBucket(tasks);
    expect(groups.now.map((t) => t.id)).toEqual(['1', '2']);
    expect(groups.today.map((t) => t.id)).toEqual(['3']);
    expect(groups.queue.map((t) => t.id)).toEqual(['4']);
  });
});
