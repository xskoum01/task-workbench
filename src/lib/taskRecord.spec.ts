import { describe, expect, it } from 'vitest';
import type { Task } from '../types';
import {
  buildStatusNoteHistory,
  createTaskRecord,
  getLatestStatusNote,
  getStatusNotes,
  normalizeTaskRecord,
  updateTaskRecord,
} from './taskRecord';

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

  it('appends a status note as its own history entry, verbatim, without a field-diff entry', () => {
    const task = createTaskRecord(baseDraft, 'task-1', '2026-07-29T10:00:00.000Z');
    const withNote = { ...task, history: buildStatusNoteHistory(task, 'Implementováno, čekám na JKV', '2026-08-05T09:00:00.000Z') };
    expect(withNote.history).toHaveLength(2);
    const entry = withNote.history[1];
    expect(entry.action).toBe('status-note');
    expect(entry.summary).toBe('Implementováno, čekám na JKV');
    expect(entry.at).toBe('2026-08-05T09:00:00.000Z');
  });

  it('trims whitespace and keeps status notes in chronological order for lookup', () => {
    const task = createTaskRecord(baseDraft, 'task-1', '2026-07-29T10:00:00.000Z');
    let running = task;
    running = { ...running, history: buildStatusNoteHistory(running, '  first update  ', '2026-08-05T09:00:00.000Z') };
    running = { ...running, history: buildStatusNoteHistory(running, 'second update', '2026-08-05T10:00:00.000Z') };

    const notes = getStatusNotes(running);
    expect(notes.map((n) => n.summary)).toEqual(['first update', 'second update']);
    expect(getLatestStatusNote(running)?.summary).toBe('second update');
  });

  it('ignores non-status-note history entries when looking up status notes', () => {
    const task = createTaskRecord(baseDraft, 'task-1', '2026-07-29T10:00:00.000Z');
    const updated = updateTaskRecord(task, { status: 'done' }, '2026-07-29T11:00:00.000Z');
    expect(getStatusNotes(updated)).toEqual([]);
    expect(getLatestStatusNote(updated)).toBeUndefined();
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
