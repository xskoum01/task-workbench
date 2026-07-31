import { describe, expect, it } from 'vitest';
import type { Task } from '../types';
import { createTaskRecord, normalizeTaskRecord, updateTaskRecord } from './taskRecord';

const baseDraft: Omit<Task, 'id' | 'receivedAt' | 'suggestedActions'> = {
  title: 'Confirm renewal',
  description: 'Confirm the annual renewal with the customer.',
  source: 'manual',
  customerId: 'customer-1',
  taskType: 'other',
  obligationKind: 'commitment',
  responsibleParty: 'Viktor',
  status: 'new',
  confidence: 100,
  originalMessage: '',
};

describe('taskRecord', () => {
  it('creates a revisioned task with an initial structured history entry', () => {
    const task = createTaskRecord(baseDraft, 'task-1', '2026-07-29T10:00:00.000Z');
    expect(task.revision).toBe(1);
    expect(task.createdAt).toBe('2026-07-29T10:00:00.000Z');
    expect(task.updatedAt).toBe('2026-07-29T10:00:00.000Z');
    expect(task.history).toHaveLength(1);
    expect(task.history?.[0].action).toBe('created');
  });

  it('records changed fields and completion in one canonical update', () => {
    const task = createTaskRecord(baseDraft, 'task-1', '2026-07-29T10:00:00.000Z');
    const updated = updateTaskRecord(
      task,
      { status: 'done', accountableTo: 'Contoso' },
      '2026-07-29T11:00:00.000Z',
    );
    expect(updated.revision).toBe(2);
    expect(updated.completedAt).toBe('2026-07-29T11:00:00.000Z');
    const lastEntry = updated.history?.[updated.history.length - 1];
    expect(lastEntry?.action).toBe('status-changed');
    expect(lastEntry?.changes?.map((change) => change.field)).toEqual([
      'status',
      'accountableTo',
    ]);
  });

  it('normalizes legacy tasks without discarding their data', () => {
    const { obligationKind: _legacyMissingKind, ...legacyDraft } = baseDraft;
    const legacy = {
      ...legacyDraft,
      id: 'legacy',
      receivedAt: '2025-01-01T00:00:00.000Z',
      suggestedActions: [],
    } satisfies Task;
    const normalized = normalizeTaskRecord(legacy);
    expect(normalized.obligationKind).toBe('task');
    expect(normalized.revision).toBe(1);
    expect(normalized.history).toEqual([]);
  });

  it('preserves reversible archive and restore actions in structured history', () => {
    const task = createTaskRecord(baseDraft, 'task-1', '2026-07-29T10:00:00.000Z');
    const archived = updateTaskRecord(task, { archivedAt: '2026-07-29T12:00:00.000Z' }, '2026-07-29T12:00:00.000Z');
    expect(archived.history?.[archived.history.length - 1]?.action).toBe('archived');
    const restored = updateTaskRecord(archived, { archivedAt: undefined }, '2026-07-29T13:00:00.000Z');
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.history?.[restored.history.length - 1]?.action).toBe('restored');
  });

  it('does not present an unconfirmed AI effort guess as a real estimate', () => {
    const task = createTaskRecord({
      ...baseDraft,
      analysisResult: { summary: 'AI summary', suggestedActions: [], confidence: 90 },
      estimatedEffort: 4,
    }, 'task-ai', '2026-07-29T10:00:00.000Z');
    expect(normalizeTaskRecord(task).estimatedEffort).toBeUndefined();
    expect(normalizeTaskRecord({ ...task, estimatedEffortConfirmed: true }).estimatedEffort).toBe(4);
  });
});
