/**
 * PlanningView — bucket-grouped task list for the Planning mode on TasksPage.
 *
 * Shows tasks sorted into five time-box buckets (Now → Later), with priority
 * scores, due dates, effort estimates, and inline quick-planning actions.
 */

import type { Task, PlanningBucket } from '../types';
import { useApp } from '../context/AppContext';
import { TaskStateBadges, SourceBadge, TypeBadge } from './StatusBadge';
import Icon from './Icon';
import TaskRecordPanel from './TaskRecordPanel';
import {
  BUCKET_META,
  BUCKET_ORDER,
  computePlanning,
  effectiveBucket,
  groupByBucket,
} from '../lib/planning';
import { isOverdue, formatRelativeDate } from '../lib/dates';
import { getLatestStatusNote } from '../lib/taskRecord';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Active focus filter for the planning view.
 *   null    — no filter, show everything
 *   focus   — now + today + overdue
 *   overdue — tasks past their due date
 *   today   — tasks in the Today bucket
 *   blocked — blocked status
 *   waiting — tasks waiting on someone else
 *   pr-comments — imported review feedback that needs attention
 *   locked  — manually locked bucket
 */
export type PlanningFilter = 'focus' | 'overdue' | 'today' | 'blocked' | 'waiting' | 'pr-comments' | 'locked' | null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function effortLabel(hours: number): string {
  if (hours < 1)  return `${Math.round(hours * 60)}m`;
  if (hours === 1) return '1h';
  return `${hours}h`;
}

/** Score bar color thresholds. */
function scoreClass(score: number): string {
  if (score >= 80) return 'planning-score--high';
  if (score >= 50) return 'planning-score--mid';
  return 'planning-score--low';
}

/**
 * Returns true when a task passes the active planning filter.
 * All tasks pass when filter is null.
 */
function passesFilter(task: Task, filter: PlanningFilter): boolean {
  if (!filter) return true;
  const bucket  = effectiveBucket(task);
  const overdue = task.dueAt ? isOverdue(task.dueAt, task.status) : false;
  switch (filter) {
    case 'focus':   return overdue || bucket === 'now' || bucket === 'today';
    case 'overdue': return overdue;
    case 'today':   return bucket === 'today';
    case 'blocked': return task.status === 'blocked';
    case 'waiting': return !!task.waitingState || bucket === 'waiting';
    case 'pr-comments': return task.attentionState === 'pr-comments';
    case 'locked':  return !!task.isPlanningLocked;
  }
}

// ---------------------------------------------------------------------------
// SummaryBar — compact status line at the top of the planning view
// ---------------------------------------------------------------------------

interface SummaryBarProps {
  tasks: Task[];
}

function SummaryBar({ tasks }: SummaryBarProps) {
  const active  = tasks.filter((t) => t.status !== 'done');
  const overdue = active.filter((t) => t.dueAt && isOverdue(t.dueAt, t.status));
  const today   = active.filter((t) => {
    const b = effectiveBucket(t);
    return b === 'today' || b === 'now';
  });
  const blocked = active.filter((t) => t.status === 'blocked');
  const waiting = active.filter((t) => t.waitingState);
  const prComments = active.filter((t) => t.attentionState === 'pr-comments');
  const done    = tasks.filter((t) => t.status === 'done');

  const items: { label: string; count: number; cls?: string }[] = [];
  if (overdue.length > 0) items.push({ label: 'overdue', count: overdue.length, cls: 'summary-item--overdue' });
  if (today.length > 0)   items.push({ label: 'today',   count: today.length                                 });
  if (prComments.length > 0) items.push({ label: 'needs attention', count: prComments.length, cls: 'summary-item--blocked' });
  if (waiting.length > 0) items.push({ label: 'waiting', count: waiting.length });
  if (blocked.length > 0) items.push({ label: 'blocked', count: blocked.length, cls: 'summary-item--blocked' });
  if (done.length > 0)    items.push({ label: 'done',    count: done.length,    cls: 'summary-item--done'    });

  if (items.length === 0) return null;

  return (
    <div className="planning-summary-bar">
      {items.map((item, i) => (
        <span key={item.label} className={`planning-summary-item${item.cls ? ` ${item.cls}` : ''}`}>
          {i > 0 && <span className="planning-summary-sep">/</span>}
          <strong>{item.count}</strong>{' '}{item.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BucketSection
// ---------------------------------------------------------------------------

interface BucketSectionProps {
  bucket: PlanningBucket;
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenDetail: (id: string) => void;
  isFiltered: boolean;
}

function BucketSection({ bucket, tasks, selectedId, onSelect, onOpenDetail, isFiltered }: BucketSectionProps) {
  const meta = BUCKET_META[bucket];

  // When a filter is active, skip empty buckets entirely for a cleaner view
  if (isFiltered && tasks.length === 0) return null;

  return (
    <section className="planning-bucket">
      <div className="planning-bucket-header">
        <Icon name={meta.icon} size={12} className="planning-bucket-icon" />
        <span className="planning-bucket-label">{meta.label}</span>
        <span className="planning-bucket-count">{tasks.length}</span>
      </div>

      {tasks.length === 0 ? (
        <div className="planning-bucket-empty">No tasks</div>
      ) : (
        <div className="planning-task-list">
          {tasks.map((task) => (
            <div key={task.id} className="planning-task-row-wrap">
              <PlanningTaskRow
                task={task}
                selected={selectedId === task.id}
                onSelect={onSelect}
              />
              {selectedId === task.id && (
                <TaskRecordPanel
                  task={task}
                  onOpenDetail={() => onOpenDetail(task.id)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// PlanningTaskRow
// ---------------------------------------------------------------------------

/** Compact quick-action bucket buttons shown on hover. */
const QUICK_BUCKETS: { bucket: PlanningBucket; label: string }[] = [
  { bucket: 'now',      label: 'Now'      },
  { bucket: 'today',    label: 'Today'    },
  { bucket: 'tomorrow', label: 'Tomorrow' },
  { bucket: 'later',    label: 'Later'    },
  { bucket: 'queue',    label: 'Queue'    },
  { bucket: 'waiting',  label: 'Waiting'  },
];

interface PlanningTaskRowProps {
  task: Task;
  selected: boolean;
  onSelect: (id: string) => void;
}

function PlanningTaskRow({ task, selected, onSelect }: PlanningTaskRowProps) {
  const { getCustomerById, updateTask } = useApp();
  const customer = getCustomerById(task.customerId);
  const latestStatusNote = getLatestStatusNote(task);

  // Use stored planning data, or compute on the fly as fallback
  const planning = task.priorityScore !== undefined
    ? { priorityScore: task.priorityScore, priorityReason: task.priorityReason ?? '' }
    : computePlanning(task);

  const score     = planning.priorityScore;
  const overdue   = task.dueAt ? isOverdue(task.dueAt, task.status) : false;
  const blocked   = task.status === 'blocked';
  const effective = effectiveBucket(task);
  const sc        = scoreClass(score);

  /** Apply a quick bucket choice — locks planning to the chosen bucket. */
  async function handleQuickBucket(bucket: PlanningBucket, e: React.MouseEvent) {
    e.stopPropagation(); // prevent row selection
    const computed = computePlanning(task);
    await updateTask(task.id, {
      planningBucket:          bucket,
      suggestedPlanningBucket: computed.suggestedPlanningBucket,
      priorityScore:           computed.priorityScore,
      priorityReason:          computed.priorityReason,
      isPlanningLocked:        true,
    });
  }

  // Row receives score class so CSS can colour the border-left accordingly
  let rowClass = `planning-task-row ${sc}`;
  if (selected) rowClass += ' selected';
  if (overdue)  rowClass += ' overdue';
  if (blocked)  rowClass += ' blocked';

  return (
    <button className={rowClass} onClick={() => onSelect(task.id)}>
      {/* Main content — same structure as task-list-item-main */}
      <div className="planning-task-main">
        <div className="planning-task-title-row">
          <div className="planning-task-title">{task.title}</div>
        </div>

        <div className="planning-task-meta">
          <SourceBadge source={task.source} />
          <TypeBadge type={task.taskType} />
          <span className="task-meta-sep">·</span>
          <span className="planning-task-customer">
            {customer?.name ?? task.customerId}
          </span>
          {latestStatusNote && (
            <span className="planning-task-status-note" title={new Date(latestStatusNote.at).toLocaleString()}>
              {latestStatusNote.summary}
            </span>
          )}

          {task.dueAt && (
            <>
              <span className="task-meta-sep">·</span>
              <span className={`planning-task-due${overdue ? ' planning-task-due--overdue' : ''}`}>
                {formatRelativeDate(task.dueAt, task.status)}
              </span>
            </>
          )}

          {task.estimatedEffort !== undefined && (
            <>
              <span className="task-meta-sep">·</span>
              <span className="planning-task-effort">
                {effortLabel(task.estimatedEffort)}
              </span>
            </>
          )}

          {task.isPlanningLocked && (
            <>
              <span className="task-meta-sep">·</span>
              <span className="planning-task-locked" title="Planning manually locked">
                <Icon name="pin" size={11} />
              </span>
            </>
          )}
        </div>
      </div>

      {/* Right side — mirrors task-list-item-side: status badge + score */}
      <div className="planning-task-side">
        <TaskStateBadges task={task} />
        {overdue && <span className="overdue-badge">overdue</span>}
        <span
          className={`planning-score-pill ${sc}`}
          title={`Priority: ${score} — ${planning.priorityReason}`}
        >
          {score}
        </span>
      </div>

      {/* Quick-action bucket buttons — revealed on hover via absolute overlay.
          Absolute positioning keeps the row layout stable when they appear. */}
      <div className="planning-row-actions" onClick={(e) => e.stopPropagation()}>
        {QUICK_BUCKETS.map(({ bucket, label }) => (
          <button
            key={bucket}
            className={`planning-row-action-btn${effective === bucket ? ' active' : ''}`}
            title={`Plan for: ${label}`}
            onClick={(e) => handleQuickBucket(bucket, e)}
          >
            {label}
          </button>
        ))}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// PlanningView (exported)
// ---------------------------------------------------------------------------

interface PlanningViewProps {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenDetail: (id: string) => void;
  /** Active focus filter; null means no filter. */
  filter: PlanningFilter;
  /** When true, a Done section is shown below the active buckets. */
  showCompleted?: boolean;
}

export default function PlanningView({ tasks, selectedId, onSelect, onOpenDetail, filter, showCompleted }: PlanningViewProps) {
  const isFiltered = filter !== null;

  // Apply filter before grouping (done tasks are excluded inside groupByBucket)
  const visibleTasks = isFiltered
    ? tasks.filter((t) => passesFilter(t, filter))
    : tasks;

  const groups = groupByBucket(visibleTasks);
  const totalVisible = Object.values(groups).reduce((s, g) => s + g.length, 0);

  const doneTasks = showCompleted ? tasks.filter((t) => t.status === 'done') : [];

  return (
    <div className="planning-view">
      {/* Summary bar always reflects the full task set, not the filtered subset */}
      <SummaryBar tasks={tasks} />

      {isFiltered && (
        <div className="planning-filter-active-note">
          Showing <strong>{filter}</strong> — {totalVisible} task{totalVisible !== 1 ? 's' : ''}
        </div>
      )}

      <div className="planning-buckets">
        {BUCKET_ORDER.map((bucket) => (
          <BucketSection
            key={bucket}
            bucket={bucket}
            tasks={groups[bucket]}
            selectedId={selectedId}
            onSelect={onSelect}
            onOpenDetail={onOpenDetail}
            isFiltered={isFiltered}
          />
        ))}
      </div>

      {isFiltered && totalVisible === 0 && (
        <div className="empty-state" style={{ margin: 'var(--gap-xl) 0' }}>
          <div className="empty-state-icon">—</div>
          <div className="empty-state-text">No tasks match this filter</div>
        </div>
      )}

      {showCompleted && (
        <section className="planning-bucket planning-bucket--done">
          <div className="planning-bucket-header">
            <Icon name="check" size={12} className="planning-bucket-icon" />
            <span className="planning-bucket-label">Completed</span>
            <span className="planning-bucket-count">{doneTasks.length}</span>
          </div>
          {doneTasks.length === 0 ? (
            <div className="planning-bucket-empty">No completed tasks</div>
          ) : (
            <div className="planning-task-list">
              {doneTasks.map((task) => (
                <div key={task.id} className="planning-task-row-wrap">
                  <PlanningTaskRow
                    task={task}
                    selected={selectedId === task.id}
                    onSelect={onSelect}
                  />
                  {selectedId === task.id && (
                    <TaskRecordPanel
                      task={task}
                      onOpenDetail={() => onOpenDetail(task.id)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** Convenience: returns the effective planning bucket for a task record. */
export function bucketInfo(task: Task): {
  effective: PlanningBucket;
  suggested: PlanningBucket | undefined;
  isMismatch: boolean;
} {
  const effective = effectiveBucket(task);
  const suggested = task.suggestedPlanningBucket;
  return {
    effective,
    suggested,
    isMismatch: !!suggested && suggested !== effective,
  };
}
