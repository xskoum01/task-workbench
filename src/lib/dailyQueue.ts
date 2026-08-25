/**
 * Pure helpers for the Daily Queue UI — the explicit, user-chosen execution
 * order for one calendar day. Kept dependency-free (no React, no Tauri) so
 * the ordering/filtering rules are unit-testable without rendering anything.
 *
 * Daily Queue is a distinct concept from both `WorkItem.status` (workflow
 * state) and `WorkItem.planningBucket` (relevance grouping, e.g. "today").
 * See docs/task-workbench-mcp.md for the full contract. Membership and order
 * here are never inferred from priority, due date, or status — only from
 * explicit add/move/remove/replace calls.
 */

import type { DailyQueueEntry } from './tauriCommands';
import type { WorkItem } from '../domain/workItem';

const TERMINAL_STATUSES = new Set<WorkItem['status']>(['completed', 'cancelled']);

/** MIME-like key shared by draggable Work rows and the queue drop target. */
export const WORK_ITEM_DRAG_TYPE = 'application/x-task-workbench-work-item';

/** Internal drag type used when reordering entries already in Today's queue. */
export const DAILY_QUEUE_ENTRY_DRAG_TYPE = 'application/x-task-workbench-daily-queue-entry';

export type QueueDropPlacement = 'before' | 'after';

/**
 * Convert a visual before/after drop target into the final 1-based position
 * expected by move_daily_queue_item. Removing the source first shifts the
 * target by one when the source was above it.
 */
export function positionForDrop(
  sourcePosition: number,
  targetPosition: number,
  placement: QueueDropPlacement,
): number {
  if (placement === 'before') {
    return sourcePosition < targetPosition ? targetPosition - 1 : targetPosition;
  }
  return sourcePosition < targetPosition ? targetPosition : targetPosition + 1;
}

/** True once a work item's status means there is no more work left to do on it. */
export function isTerminal(workItem: WorkItem): boolean {
  return TERMINAL_STATUSES.has(workItem.status);
}

/** Completion is stored on notes and remains authoritative on WorkItems. */
export function isQueueEntryDone(entry: DailyQueueEntry): boolean {
  return entry.kind === 'note' ? !!entry.completedAt : isTerminal(entry.workItem);
}

/**
 * The first non-terminal entry — shown as "Právě teď" (Right now) in the UI.
 * This is purely a display convention: it never implies `status=in_progress`
 * and reordering never sets it either — starting work is always a separate,
 * explicit status transition.
 */
export function activeEntry(entries: DailyQueueEntry[]): DailyQueueEntry | undefined {
  return entries.find((entry) => !isQueueEntryDone(entry));
}

/** Completed text notes rendered by Week Log; full tasks come from Task storage. */
export function completedQueueNotes(entries: DailyQueueEntry[]) {
  return entries.filter(
    (entry): entry is Extract<DailyQueueEntry, { kind: 'note' }> =>
      entry.kind === 'note' && !!entry.completedAt,
  );
}

/** Entries after (and including, if none is active) the "Právě teď" entry — shown as "Dále". */
export function upcomingEntries(entries: DailyQueueEntry[]): DailyQueueEntry[] {
  const active = activeEntry(entries);
  if (!active) return entries;
  return entries.filter((entry) => entry !== active);
}

/** True when `workItemId` is already present in the queue (add must reject re-adding it). */
export function isAlreadyQueued(entries: DailyQueueEntry[], workItemId: string): boolean {
  return entries.some((entry) => entry.kind === 'work_item' && entry.workItem.id === workItemId);
}

/**
 * Bounded candidate list for the "+ Add task" picker: active (not archived),
 * not completed/cancelled, and not already in the queue. Matches the
 * canonical WorkItem's own active-record definition — the picker never
 * offers work that could not legally be added.
 */
export function queueableCandidates(workItems: WorkItem[], entries: DailyQueueEntry[]): WorkItem[] {
  return workItems.filter(
    (item) => !item.archivedAt && !isTerminal(item) && !isAlreadyQueued(entries, item.id),
  );
}

/** 1-based target position of "move up" — clamped to 1 (already at the top is a no-op). */
export function positionAbove(currentPosition: number): number {
  return Math.max(1, currentPosition - 1);
}

/** 1-based target position of "move down" — clamped to the queue length (already last is a no-op). */
export function positionBelow(currentPosition: number, queueLength: number): number {
  return Math.min(queueLength, currentPosition + 1);
}
