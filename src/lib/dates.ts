/**
 * Shared date formatting and comparison utilities.
 *
 * All functions work in local time so displayed labels match what the user
 * expects when they see "Today" or "Tomorrow".
 */

import type { TaskStatus } from '../types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns today as a YYYY-MM-DD string in local time. */
export function localTodayStr(): string {
  const d = new Date();
  return ymdStr(d);
}

/** Returns a YYYY-MM-DD string offset by `days` from today (local time). */
function localOffsetStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return ymdStr(d);
}

/** Formats a Date to a YYYY-MM-DD string. */
function ymdStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Converts an ISO datetime string to a local YYYY-MM-DD string. */
export function toLocalDateStr(iso: string): string {
  return ymdStr(new Date(iso));
}

// ---------------------------------------------------------------------------
// Overdue detection
// ---------------------------------------------------------------------------

/**
 * Returns true when a task's due date has already passed (local date) and the
 * task is not finished.
 *
 * @param dueAt   ISO date/datetime string from `task.dueAt`
 * @param status  Current task status — done tasks are never overdue
 */
export function isOverdue(dueAt: string, status: TaskStatus): boolean {
  if (status === 'done') return false;
  return toLocalDateStr(dueAt) < localTodayStr();
}

// ---------------------------------------------------------------------------
// Relative date formatting
// ---------------------------------------------------------------------------

/**
 * Formats a due-date ISO string as a compact, human-friendly label.
 *
 * | Condition              | Example output |
 * |------------------------|---------------|
 * | Same local date        | Today          |
 * | Next local date        | Tomorrow       |
 * | Past date              | Overdue        |
 * | 2–6 days from now      | In 3 days      |
 * | 7 days from now        | In 1 week      |
 * | Otherwise              | 16 Apr         |
 *
 * @param iso     ISO date/datetime string
 * @param status  Optionally checked so overdue is shown only for active tasks
 */
export function formatRelativeDate(iso: string, status?: TaskStatus): string {
  const dateStr = toLocalDateStr(iso);
  const today   = localTodayStr();

  // Past date
  if (dateStr < today) {
    if (status && status === 'done') {
      // For done tasks show the actual date rather than "Overdue"
      return shortDate(new Date(iso));
    }
    return 'Overdue';
  }

  // Today / tomorrow
  if (dateStr === today)              return 'Today';
  if (dateStr === localOffsetStr(1))  return 'Tomorrow';

  // Days out (2–13 days)
  const daysOut = daysBetween(today, dateStr);
  if (daysOut >= 2 && daysOut <= 6)   return `In ${daysOut} days`;
  if (daysOut >= 7 && daysOut <= 13)  return 'In 1 week';
  if (daysOut >= 14 && daysOut <= 20) return 'In 2 weeks';

  // Fallback — "16 Apr"
  return shortDate(new Date(iso));
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

/** Returns the number of whole days between two YYYY-MM-DD strings. */
function daysBetween(from: string, to: string): number {
  const msPerDay = 86_400_000;
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / msPerDay);
}

/** Formats a Date as "16 Apr". */
function shortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
