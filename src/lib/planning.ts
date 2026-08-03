/**
 * Rule-based planning logic.
 *
 * All functions are pure (no side-effects) and depend only on the task data.
 * The goal is to give the developer a quick, opinionated starting point they
 * can then lock with `isPlanningLocked`.
 */

import type { Task, PlanningBucket } from '../types';
import type { IconName } from '../components/Icon';
import { localTodayStr, toLocalDateStr, isOverdue } from './dates';

// Re-export so existing callers of localToday() from planning.ts still work.
export { localTodayStr as localToday };

/** Returns a YYYY-MM-DD string offset by `days` from today (local time). */
function localOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ---------------------------------------------------------------------------
// Bucket constants
// ---------------------------------------------------------------------------

export const BUCKET_META: Record<PlanningBucket, { label: string; icon: IconName }> = {
  now:       { label: 'Now',       icon: 'bolt'          },
  today:     { label: 'Today',     icon: 'sun'           },
  tomorrow:  { label: 'Tomorrow',  icon: 'arrow-right'   },
  this_week: { label: 'This Week', icon: 'calendar'      },
  later:     { label: 'Later',     icon: 'clock'         },
  queue:     { label: 'Queue',     icon: 'layers'        },
  waiting:   { label: 'Waiting',   icon: 'pause'         },
};

export const BUCKET_ORDER: PlanningBucket[] = [
  'now',
  'today',
  'tomorrow',
  'this_week',
  'later',
  'queue',
  'waiting',
];

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

interface PlanningResult {
  suggestedPlanningBucket: PlanningBucket;
  priorityScore: number;
  priorityReason: string;
}

/**
 * Derives a suggested planning bucket, a numeric priority score (0–100),
 * and a short human-readable reason for use in the UI.
 *
 * Rule precedence (first match wins for bucket):
 *  1. Done tasks → excluded (callers should filter by status)
 *  2. Due today  → today
 *  3. Due tomorrow → tomorrow
 *  4. Due within 7 days → this_week
 *  5. High-urgency type (bug-fix or deployment) and not blocked → today
 *  6. Blocked → later
 *  7. Default → this_week
 */
export function computePlanning(task: Task): PlanningResult {
  const today    = localTodayStr();
  const tomorrow = localOffset(1);
  const in7Days  = localOffset(7);

  const dueStr      = task.dueAt ? toLocalDateStr(task.dueAt) : null;
  const taskOverdue = task.dueAt ? isOverdue(task.dueAt, task.status) : false;
  const isBlocked   = task.status === 'blocked';
  const isUrgent    = task.taskType === 'bug-fix' || task.taskType === 'deployment';

  // --- Priority score ---
  let score = 50;
  const reasons: string[] = [];

  if (isUrgent) {
    score += 20;
    reasons.push(task.taskType === 'bug-fix' ? 'bug fix' : 'deployment');
  }
  if (dueStr) {
    if (taskOverdue)             { score += 40; reasons.push('overdue'); }
    else if (dueStr === today)   { score += 35; reasons.push('due today'); }
    else if (dueStr <= tomorrow) { score += 20; reasons.push('due tomorrow'); }
    else if (dueStr <= in7Days)  { score += 10; reasons.push('due this week'); }
  }
  if (task.status === 'new' || task.status === 'analyzed') {
    score += 5;
    reasons.push('action needed');
  }
  if (task.status === 'in-progress') {
    score += 10;
    reasons.push('in progress');
  }
  if (task.waitingState) {
    score -= 35;
    reasons.push(task.waitingState === 'code-review' ? 'waiting for code review' : 'waiting for estimate approval');
  }
  if (task.attentionState === 'pr-comments') {
    score += 35;
    reasons.push('PR comments');
  }
  if (isBlocked) {
    score -= 50;
    reasons.push('blocked');
  }

  // Clamp 0–100
  score = Math.min(100, Math.max(0, score));

  // --- Bucket suggestion ---
  let bucket: PlanningBucket;

  if (task.waitingState) {
    bucket = 'waiting';
  } else if (task.attentionState === 'pr-comments') {
    bucket = 'now';
  } else if (isBlocked) {
    // Blocked tasks always go to later regardless of due date
    bucket = 'later';
  } else if (taskOverdue) {
    // Overdue and not blocked → surface immediately
    bucket = score >= 90 ? 'now' : 'today';
  } else if (dueStr && dueStr === today) {
    bucket = 'today';
  } else if (dueStr && dueStr <= tomorrow) {
    bucket = 'tomorrow';
  } else if (dueStr && dueStr <= in7Days) {
    bucket = 'this_week';
  } else if (isUrgent) {
    bucket = 'today';
  } else if (score >= 70) {
    bucket = 'this_week';
  } else {
    bucket = 'later';
  }

  const priorityReason = reasons.length > 0
    ? reasons.join(', ')
    : 'no urgent signals';

  return {
    suggestedPlanningBucket: bucket,
    priorityScore: score,
    priorityReason,
  };
}

/**
 * Returns the effective bucket for a task.
 *
 * Canonical planning membership (Now / Today, in particular) is decided by
 * the explicitly stored `planningBucket` alone — never inferred from due
 * date, status, or "today". This mirrors exactly what the backend's
 * `get_planning_today` / `WorkItemApplicationService::list` does (an exact
 * match on the stored bucket), so this view and the REST/MCP planning
 * surfaces can never disagree about which tasks are Now/Today. A task with
 * no explicit bucket falls into `queue` — "not yet planned" — rather than
 * being silently promoted into Today by a heuristic the backend can't see.
 * `computePlanning()` remains available to *suggest* a bucket for the
 * quick-action buttons; it no longer decides membership on its own.
 */
export function effectiveBucket(task: Task): PlanningBucket {
  if (task.planningBucket) return task.planningBucket;
  if (task.waitingState) return 'waiting';
  return 'queue';
}

/**
 * Groups an array of tasks into buckets, sorted by priorityScore descending
 * within each bucket. Done tasks are excluded.
 */
export function groupByBucket(tasks: Task[]): Record<PlanningBucket, Task[]> {
  const groups: Record<PlanningBucket, Task[]> = {
    now: [], today: [], tomorrow: [], this_week: [], later: [], queue: [], waiting: [],
  };

  for (const task of tasks) {
    if (task.status === 'done') continue;
    const bucket = effectiveBucket(task);
    groups[bucket].push(task);
  }

  // Sort each bucket by priorityScore descending (higher score = show first)
  for (const bucket of BUCKET_ORDER) {
    groups[bucket].sort((a, b) => (b.priorityScore ?? 50) - (a.priorityScore ?? 50));
  }

  return groups;
}
