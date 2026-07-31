import type {
  Task,
  TaskActorType,
  TaskHistoryChange,
  TaskHistoryEntry,
} from '../types';

const MAX_HISTORY_ENTRIES = 250;
const HISTORY_IGNORED_FIELDS = new Set(['history', 'updatedAt', 'revision']);

function historyId(at: string): string {
  return `event-${at}-${Math.random().toString(36).slice(2, 9)}`;
}

function scalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function describeUpdate(changes: TaskHistoryChange[]): string {
  if (changes.length === 0) return 'Task record updated';
  if (changes.length === 1) return `Updated ${changes[0].field}`;
  return `Updated ${changes.length} fields: ${changes.map((change) => change.field).join(', ')}`;
}

export function createHistoryEntry(
  action: TaskHistoryEntry['action'],
  summary: string,
  at: string,
  actorType: TaskActorType = 'user',
  changes?: TaskHistoryChange[],
  actorName?: string,
): TaskHistoryEntry {
  return {
    id: historyId(at),
    at,
    actorType,
    ...(actorName ? { actorName } : {}),
    action,
    summary,
    ...(changes?.length ? { changes } : {}),
  };
}

export function normalizeTaskRecord(task: Task): Task {
  const createdAt = task.createdAt ?? task.receivedAt;
  // Older AI-enriched records could contain a guessed effort (commonly 4h)
  // even though the user never entered one. Do not present that guess as a
  // fact; an explicit value entered in the form is marked as confirmed.
  const inferredEffort = task.analysisResult && task.estimatedEffort !== undefined && !task.estimatedEffortConfirmed;
  return {
    ...task,
    obligationKind: task.obligationKind ?? 'task',
    createdAt,
    updatedAt: task.updatedAt ?? createdAt,
    revision: Math.max(1, task.revision ?? 1),
    history: Array.isArray(task.history) ? task.history : [],
    ...(inferredEffort ? { estimatedEffort: undefined } : {}),
  };
}

export function createTaskRecord(
  draft: Omit<Task, 'id' | 'receivedAt' | 'suggestedActions'>,
  id: string,
  at: string,
): Task {
  const task: Task = {
    ...draft,
    id,
    obligationKind: draft.obligationKind ?? 'task',
    receivedAt: at,
    createdAt: at,
    updatedAt: at,
    revision: 1,
    suggestedActions: [],
    history: [],
  };
  task.history = [
    createHistoryEntry(
      task.source === 'manual' ? 'created' : 'imported',
      task.source === 'manual' ? 'Task created' : `Task imported from ${task.source}`,
      at,
      task.source === 'manual' ? 'user' : 'integration',
    ),
  ];
  return task;
}

export function updateTaskRecord(
  current: Task,
  updates: Partial<Task>,
  at: string,
  actorType: TaskActorType = 'user',
  actorName?: string,
): Task {
  const normalized = normalizeTaskRecord(current);
  const changes: TaskHistoryChange[] = [];

  for (const key of Object.keys(updates) as Array<keyof Task>) {
    if (HISTORY_IGNORED_FIELDS.has(key) || Object.is(current[key], updates[key])) continue;
    changes.push({
      field: key,
      from: scalar(current[key]),
      to: scalar(updates[key]),
    });
  }

  const merged: Task = {
    ...normalized,
    ...updates,
    updatedAt: at,
    revision: (normalized.revision ?? 1) + 1,
  };

  if (updates.status === 'done' && current.status !== 'done') {
    merged.completedAt = at;
  } else if (updates.status && updates.status !== 'done' && current.status === 'done') {
    merged.completedAt = undefined;
  }

  if (changes.length > 0) {
    const statusChange = changes.find((change) => change.field === 'status');
    const archiveChange = changes.find((change) => change.field === 'archivedAt');
    const action = archiveChange
      ? (archiveChange.to ? 'archived' : 'restored')
      : statusChange ? 'status-changed' : 'updated';
    const entry = createHistoryEntry(
      action,
      archiveChange
        ? (archiveChange.to ? 'Task archived' : 'Task restored from archive')
        : statusChange
        ? `Status changed from ${String(statusChange.from)} to ${String(statusChange.to)}`
        : describeUpdate(changes),
      at,
      actorType,
      changes,
      actorName,
    );
    merged.history = [...(normalized.history ?? []), entry].slice(-MAX_HISTORY_ENTRIES);
  }

  return merged;
}
