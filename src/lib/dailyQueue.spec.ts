import { describe, expect, it } from 'vitest';
import {
  activeEntry,
  isAlreadyQueued,
  isTerminal,
  positionAbove,
  positionBelow,
  queueableCandidates,
  upcomingEntries,
} from './dailyQueue';
import type { DailyQueueEntry } from './tauriCommands';
import type { WorkItem } from '../domain/workItem';

function workItem(id: string, status: WorkItem['status'] = 'ready', archived = false): WorkItem {
  return {
    schemaVersion: 1,
    id,
    kind: 'task',
    title: `Task ${id}`,
    status,
    priority: 'normal',
    source: 'manual',
    externalReferences: [],
    tags: [],
    context: [],
    createdAt: '2026-08-17T08:00:00Z',
    updatedAt: '2026-08-17T08:00:00Z',
    revision: 1,
    history: [],
    ...(archived ? { archivedAt: '2026-08-17T09:00:00Z' } : {}),
  };
}

function entry(position: number, item: WorkItem): DailyQueueEntry {
  return { id: item.id, kind: 'work_item', position, workItem: item, addedAt: '2026-08-17T08:00:00Z' };
}

describe('isTerminal', () => {
  it('treats completed and cancelled as terminal', () => {
    expect(isTerminal(workItem('a', 'completed'))).toBe(true);
    expect(isTerminal(workItem('a', 'cancelled'))).toBe(true);
  });

  it('treats every other status as non-terminal', () => {
    for (const status of ['planned', 'ready', 'in_progress', 'waiting', 'blocked', 'review'] as const) {
      expect(isTerminal(workItem('a', status))).toBe(false);
    }
  });
});

describe('activeEntry / upcomingEntries', () => {
  it('allows a text note to be the active entry', () => {
    const note: DailyQueueEntry = {
      id: 'note-1', kind: 'note', position: 1, text: 'Send email', addedAt: '2026-08-17T08:00:00Z',
    };
    expect(activeEntry([note])).toBe(note);
  });

  it('picks the first non-terminal entry as active', () => {
    const entries = [entry(1, workItem('a', 'completed')), entry(2, workItem('b', 'ready')), entry(3, workItem('c', 'ready'))];
    expect(activeEntry(entries)?.id).toBe('b');
    expect(upcomingEntries(entries).map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('returns undefined active entry when every entry is terminal', () => {
    const entries = [entry(1, workItem('a', 'completed')), entry(2, workItem('b', 'cancelled'))];
    expect(activeEntry(entries)).toBeUndefined();
    // With nothing active, "upcoming" is just everything — no special-casing needed downstream.
    expect(upcomingEntries(entries)).toEqual(entries);
  });

  it('returns undefined active entry for an empty queue', () => {
    expect(activeEntry([])).toBeUndefined();
    expect(upcomingEntries([])).toEqual([]);
  });
});

describe('isAlreadyQueued', () => {
  it('detects a work item already present in the queue', () => {
    const entries = [entry(1, workItem('a'))];
    expect(isAlreadyQueued(entries, 'a')).toBe(true);
    expect(isAlreadyQueued(entries, 'b')).toBe(false);
  });
});

describe('queueableCandidates', () => {
  it('excludes archived, completed, cancelled, and already-queued items', () => {
    const workItems = [
      workItem('active', 'ready'),
      workItem('done', 'completed'),
      workItem('cancelled', 'cancelled'),
      workItem('archived', 'ready', true),
      workItem('already-queued', 'ready'),
    ];
    const entries = [entry(1, workItem('already-queued', 'ready'))];
    const candidates = queueableCandidates(workItems, entries).map((item) => item.id);
    expect(candidates).toEqual(['active']);
  });

  it('returns an empty list when there is nothing queueable', () => {
    expect(queueableCandidates([], [])).toEqual([]);
  });
});

describe('positionAbove / positionBelow', () => {
  it('moves up by one, clamped at the top', () => {
    expect(positionAbove(3)).toBe(2);
    expect(positionAbove(1)).toBe(1);
  });

  it('moves down by one, clamped at the queue length', () => {
    expect(positionBelow(1, 3)).toBe(2);
    expect(positionBelow(3, 3)).toBe(3);
  });
});
