import { describe, expect, it } from 'vitest';
import type { Task } from '../types';
import { taskToWorkItem } from './workItem';

const task: Task = {
  id: 'task-1',
  title: 'Renew support agreement',
  description: 'Confirm scope and renewal date.',
  source: 'manual',
  customerId: 'customer-1',
  taskType: 'other',
  obligationKind: 'responsibility',
  responsibleParty: 'Viktor',
  accountableTo: 'Contoso',
  status: 'in-progress',
  confidence: 100,
  originalMessage: 'Original request',
  receivedAt: '2026-07-01T08:00:00.000Z',
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-07-29T08:00:00.000Z',
  revision: 4,
  notes: 'Waiting for the account owner.',
  waitingState: 'pricing-approval',
  suggestedActions: [],
};

describe('canonical work item contract', () => {
  it('projects a legacy responsibility without discarding its context', () => {
    const item = taskToWorkItem(task);
    expect(item.kind).toBe('obligation');
    expect(item.obligationMode).toBe('ongoing');
    expect(item.status).toBe('waiting');
    expect(item.owner?.displayName).toBe('Viktor');
    expect(item.areaId).toBe('customer-1');
    expect(item.context.map((entry) => entry.type)).toEqual(['note', 'source']);
    expect(item.revision).toBe(4);
  });

  it('projects the explicit planning bucket used by overview categories', () => {
    const item = taskToWorkItem({ ...task, planningBucket: 'now' });
    expect(item.planningBucket).toBe('now');
  });

  it('preserves canonical-only context when the compatibility task changes', () => {
    const canonical = taskToWorkItem(task);
    canonical.tags = ['renewal'];
    canonical.nextReviewAt = '2026-08-01T08:00:00.000Z';
    canonical.context.push({
      id: 'decision-1',
      type: 'decision',
      text: 'Renew for one year.',
      createdAt: '2026-07-29T09:00:00.000Z',
      actorType: 'user',
    });
    const compatibilityTask = {
      ...task,
      title: 'Updated in the compatibility UI',
      _canonicalWorkItem: canonical,
    };

    const projected = taskToWorkItem(compatibilityTask);
    expect(projected.title).toBe('Updated in the compatibility UI');
    expect(projected.tags).toEqual(['renewal']);
    expect(projected.nextReviewAt).toBe('2026-08-01T08:00:00.000Z');
    expect(projected.context.some((entry) => entry.id === 'decision-1')).toBe(true);
  });

  it('keeps a task without customer context valid', () => {
    const item = taskToWorkItem({ ...task, customerId: '' });
    expect(item.areaId).toBeUndefined();
  });
});
