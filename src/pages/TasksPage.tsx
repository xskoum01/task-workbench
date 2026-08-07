import { useState } from 'react';
import type { TaskStatus } from '../types';
import { useApp } from '../context/AppContext';
import { TaskStateBadges, TypeBadge, SourceBadge } from '../components/StatusBadge';
import Icon from '../components/Icon';
import TaskRecordDetail from '../components/TaskRecordDetail';
import TaskRecordPanel from '../components/TaskRecordPanel';
import TaskForm from '../components/TaskForm';
import PlanningView, { type PlanningFilter } from '../components/PlanningView';
import { isOverdue, formatRelativeDate, formatShortPastDate } from '../lib/dates';
import { effectiveBucket } from '../lib/planning';
import { getLatestStatusNote } from '../lib/taskRecord';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type ViewMode = 'list' | 'planning';

/** Filters available in planning view. */
const PLANNING_FILTERS: { value: PlanningFilter; label: string; title: string }[] = [
  { value: 'focus',   label: 'Focus',   title: 'Now + Today + Overdue tasks' },
  { value: 'overdue', label: 'Overdue', title: 'Tasks past their due date'   },
  { value: 'today',   label: 'Today',   title: 'Tasks in the Today bucket'   },
  { value: 'blocked', label: 'Blocked', title: 'Blocked tasks'               },
  { value: 'waiting', label: 'Waiting', title: 'Tasks waiting on someone else'},
  { value: 'pr-comments', label: 'Needs attention', title: 'Records with review feedback to handle' },
  { value: 'locked',  label: 'Locked',  title: 'Manually locked bucket'      },
];

const STATUS_FILTERS: { value: TaskStatus | 'all'; label: string }[] = [
  { value: 'all',              label: 'All'        },
  { value: 'new',              label: 'Planned'    },
  { value: 'analyzed',         label: 'Ready'      },
  { value: 'in-progress',      label: 'In Progress'},
  { value: 'ready-for-review', label: 'Review'     },
  { value: 'blocked',          label: 'Blocked'    },
  { value: 'done',             label: 'Completed'  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TasksPage() {
  const {
    tasks, getCustomerById, updateTask, deleteTask, reloadTasks,
    taskLoadFailed, error, taskStorageStatus, restoreTasksFromLatestBackup,
  } = useApp();

  const [viewMode, setViewMode]           = useState<ViewMode>('planning');
  const [filter, setFilter]               = useState<TaskStatus | 'all'>('all');
  const [planningFilter, setPlanningFilter] = useState<PlanningFilter>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showArchived, setShowArchived]   = useState(false);
  const [searchQuery, setSearchQuery]     = useState('');
  const [selectedId, setSelectedId]       = useState<string | null>(null);
  const [detailOpenId, setDetailOpenId]   = useState<string | null>(null);
  const [showTaskForm, setShowTaskForm]   = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [reloading, setReloading]   = useState(false);
  const [restoring, setRestoring]   = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  async function handleReload() {
    setReloading(true);
    try { await reloadTasks(); } finally { setReloading(false); }
  }

  async function handleRestore() {
    setRestoring(true);
    setRestoreError(null);
    try {
      await restoreTasksFromLatestBackup();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(false);
    }
  }

  function handleSelect(id: string) {
    setSelectedId((prev) => (prev === id ? null : id));
    // Opening a different task collapses any open detail panel
    setDetailOpenId((prev) => (prev && prev !== id ? null : prev));
  }

  // When switching view modes, clear irrelevant filter state
  function handleSetViewMode(mode: ViewMode) {
    setViewMode(mode);
    if (mode === 'list') setPlanningFilter(null);
  }

  function togglePlanningFilter(f: PlanningFilter) {
    setPlanningFilter((prev) => (prev === f ? null : f));
  }

  // Exclude inbox-only items (pending/analyzed/rejected) — they live in the Inbox page
  const taskRecords = tasks.filter(
    (t) => !t.classificationState || t.classificationState === 'created',
  );
  const archivedCount = taskRecords.filter((task) => !!task.archivedAt).length;
  const realTasks = taskRecords.filter((task) => showArchived ? !!task.archivedAt : !task.archivedAt);
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const searchedTasks = normalizedQuery
    ? realTasks.filter((task) => {
        const customer = getCustomerById(task.customerId);
        return [
          task.title,
          task.description,
          task.responsibleParty,
          task.accountableTo,
          task.status,
          task.obligationKind,
          customer?.name,
          task.ticketUrl,
          task.devopsTaskUrl,
        ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
      })
    : realTasks;

  const filtered = filter === 'all'
    ? searchedTasks
    : searchedTasks.filter((t) => t.status === filter);

  // Quick counts for planning filter badges
  const activeTasks = searchedTasks.filter((t) => t.status !== 'done');
  const overdueCount = activeTasks.filter((t) => t.dueAt && isOverdue(t.dueAt, t.status)).length;
  const todayCount   = activeTasks.filter((t) => effectiveBucket(t) === 'today').length;
  const blockedCount = activeTasks.filter((t) => t.status === 'blocked').length;
  const waitingCount = activeTasks.filter((t) => t.waitingState || effectiveBucket(t) === 'waiting').length;
  const prCommentsCount = activeTasks.filter((t) => t.attentionState === 'pr-comments').length;
  const lockedCount  = activeTasks.filter((t) => t.isPlanningLocked).length;
  const focusCount   = activeTasks.filter((t) =>
    (t.dueAt && isOverdue(t.dueAt, t.status)) ||
    effectiveBucket(t) === 'now' ||
    effectiveBucket(t) === 'today'
  ).length;

  const planningFilterCounts: Record<string, number> = {
    focus:   focusCount,
    overdue: overdueCount,
    today:   todayCount,
    blocked: blockedCount,
    waiting: waitingCount,
    'pr-comments': prCommentsCount,
    locked:  lockedCount,
  };

  return (
    <>
      {taskLoadFailed && (
        <div style={{
          background: '#5c1a1a',
          borderBottom: '1px solid #8b2020',
          color: '#f8b4b4',
          padding: '8px 16px',
          fontSize: 13,
          lineHeight: 1.5,
        }}>
          <strong style={{ color: '#ff6b6b' }}>Storage error:</strong>{' '}
          {error ?? 'Task data failed to load from disk.'}
          {' '}Saving is temporarily disabled to protect your data. Use the reload button to retry.
        </div>
      )}
      {!taskLoadFailed && taskStorageStatus?.empty_with_nonempty_backups && (
        <div style={{
          background: '#3a2a00',
          borderBottom: '1px solid #664a00',
          color: '#f0c060',
          padding: '8px 16px',
          fontSize: 13,
          lineHeight: 1.5,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <span>
            <strong style={{ color: '#ffcc44' }}>Tasks appear empty</strong>
            {' '}but a backup with {taskStorageStatus.newest_backup_task_count} task
            {taskStorageStatus.newest_backup_task_count !== 1 ? 's' : ''} was found.
            {' '}This may indicate accidental data loss.
            {restoreError && (
              <span style={{ color: '#ff8888', marginLeft: 8 }}>Restore failed: {restoreError}</span>
            )}
          </span>
          <button
            onClick={handleRestore}
            disabled={restoring}
            style={{
              background: '#664a00',
              border: '1px solid #997000',
              color: '#ffcc44',
              padding: '3px 10px',
              fontSize: 12,
              cursor: restoring ? 'default' : 'pointer',
              borderRadius: 3,
              flexShrink: 0,
            }}
          >
            {restoring ? 'Restoring...' : 'Restore from backup'}
          </button>
        </div>
      )}
      <div className="page-content">
        <div className="page-header">
          <div>
            <div className="page-title">Work records</div>
            <div className="page-subtitle">
              {viewMode === 'list'
                ? `${filtered.length} record${filtered.length !== 1 ? 's' : ''}`
                : `${searchedTasks.filter((t) => t.status !== 'done').length} active records`}
            </div>
          </div>

          <div className="page-header-actions">
            <input
              className="form-input"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search work, owners, context…"
              aria-label="Search work records"
              style={{ width: 230 }}
            />
            {/* View mode toggle */}
            <div className="view-mode-toggle">
              <button
                className={`view-mode-btn${viewMode === 'list' ? ' active' : ''}`}
                onClick={() => handleSetViewMode('list')}
                title="List view"
              >
                List
              </button>
              <button
                className={`view-mode-btn${viewMode === 'planning' ? ' active' : ''}`}
                onClick={() => handleSetViewMode('planning')}
                title="Planning view"
              >
                Planning
              </button>
            </div>

            <button
              className={`planning-filter-chip${showArchived ? ' active' : ''}`}
              onClick={() => {
                setShowArchived((value) => !value);
                setViewMode('list');
                setFilter('all');
                setSelectedId(null);
              }}
              title={showArchived ? 'Return to active records' : 'Show archived records'}
            >
              {showArchived ? 'Active records' : 'Archive'}
              {!showArchived && archivedCount > 0 && (
                <span className="planning-filter-chip-count">{archivedCount}</span>
              )}
            </button>

            {/* Planning focus filters — only visible in planning mode */}
            {viewMode === 'planning' && (
              <div className="planning-filter-bar">
                {PLANNING_FILTERS.map((f) => {
                  const count = f.value ? (planningFilterCounts[f.value] ?? 0) : 0;
                  return (
                    <button
                      key={f.value}
                      className={`planning-filter-chip${planningFilter === f.value ? ' active' : ''}`}
                      onClick={() => togglePlanningFilter(f.value)}
                      title={f.title}
                    >
                      {f.label}
                      {count > 0 && (
                        <span className="planning-filter-chip-count">{count}</span>
                      )}
                    </button>
                  );
                })}
                <button
                  className={`planning-filter-chip${showCompleted ? ' active' : ''}`}
                  onClick={() => setShowCompleted((v) => !v)}
                  title="Show completed tasks"
                >
                  Completed
                  {searchedTasks.filter((t) => t.status === 'done').length > 0 && (
                    <span className="planning-filter-chip-count">
                      {searchedTasks.filter((t) => t.status === 'done').length}
                    </span>
                  )}
                </button>
              </div>
            )}

            {/* Status filter chips — only visible in list mode */}
            {viewMode === 'list' && (
              <div className="planning-filter-bar">
                {STATUS_FILTERS.map((f) => {
                  const count = f.value === 'all'
                    ? searchedTasks.length
                    : searchedTasks.filter((t) => t.status === f.value).length;
                  return (
                    <button
                      key={f.value}
                      className={`planning-filter-chip${filter === f.value ? ' active' : ''}`}
                      onClick={() => setFilter(f.value)}
                      title={f.label}
                    >
                      {f.label}
                      {count > 0 && (
                        <span className="planning-filter-chip-count">{count}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            <button
              className="btn btn-ghost"
              onClick={handleReload}
              disabled={reloading}
              title="Reload records from storage (including integration changes)"
              style={{ minWidth: 0 }}
            >
              <Icon name="refresh-cw" size={14} className={reloading ? 'spin' : undefined} />
            </button>

            <button className="btn btn-secondary" onClick={() => setShowTaskForm(true)}>
              <span className="btn-icon">+</span>
              New work item
            </button>
          </div>
        </div>

        {/* ---- List view ---- */}
        {viewMode === 'list' && (
          filtered.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">—</div>
              <div className="empty-state-text">No work records match this filter</div>
            </div>
          ) : (
            <div className="task-list">
              {filtered.map((task) => {
                const customer = getCustomerById(task.customerId);
                const isConfirmingDelete = confirmDeleteId === task.id;
                const latestStatusNote = getLatestStatusNote(task);
                return (
                  <div
                    key={task.id}
                    role="button"
                    tabIndex={0}
                    className={`task-list-item${selectedId === task.id ? ' selected' : ''}${task.dueAt && isOverdue(task.dueAt, task.status) ? ' overdue' : ''}`}
                    onClick={() => handleSelect(task.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelect(task.id); }}
                  >
                    <div className="task-list-item-main">
                      <div className="task-list-item-title-row">
                        <div className="task-list-item-title">{task.title}</div>
                      </div>
                      <div className="task-list-item-meta">
                        <SourceBadge source={task.source} />
                        <TypeBadge type={task.taskType} />
                        <span className="task-meta-sep">·</span>
                        <span className="task-list-item-customer">
                          {customer?.name ?? task.customerId}
                        </span>
                        {latestStatusNote && (
                          <span className="task-list-item-status-note" title={new Date(latestStatusNote.at).toLocaleString()}>
                            <span className="task-list-item-status-note-text">{latestStatusNote.summary}</span>
                            <span className="task-list-item-status-note-date">{formatShortPastDate(latestStatusNote.at)}</span>
                          </span>
                        )}
                        {task.responsibleParty && (
                          <>
                            <span className="task-meta-sep">Â·</span>
                            <span title="Responsible party">Owner: {task.responsibleParty}</span>
                          </>
                        )}
                        {task.obligationKind && task.obligationKind !== 'task' && (
                          <span className="tracking-pill" title="Obligation kind">{task.obligationKind}</span>
                        )}
                        <span className="task-meta-sep">·</span>
                        <span className="task-list-item-time">{formatRelativeDate(task.receivedAt)}</span>
                        {task.dueAt && (
                          <>
                            <span className="task-meta-sep">·</span>
                            <span className={`task-list-item-due${task.dueAt && isOverdue(task.dueAt, task.status) ? ' task-due--overdue' : ''}`}>
                              {formatRelativeDate(task.dueAt, task.status)}
                            </span>
                          </>
                        )}
                        {task.estimatedEffort !== undefined && (
                          <>
                            <span className="task-meta-sep">·</span>
                            <span className="task-list-item-effort">
                              {task.estimatedEffort < 1
                                ? `${Math.round(task.estimatedEffort * 60)}m`
                                : `${task.estimatedEffort}h`}
                            </span>
                          </>
                        )}
                        {task.ticketUrl && (
                          <span className="tracking-pill tracking-pill--ticket" title="Has ticket">ticket</span>
                        )}
                        {task.devopsTaskUrl && (
                          <span className="tracking-pill tracking-pill--devops" title="Has DevOps work item">devops</span>
                        )}
                        {task.budgetHours !== undefined && (
                          <span className="tracking-pill tracking-pill--budget" title={`Budget: ${task.budgetHours}h`}>{task.budgetHours}h</span>
                        )}
                      </div>
                    </div>
                    <div className="task-list-item-side">
                      <TaskStateBadges task={task} />
                      <span className="task-list-item-confidence">
                        {task.confidence}%
                      </span>
                      <div
                        className="task-list-item-actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {!task.archivedAt && task.status !== 'done' && (
                          <button
                            className="tli-action-btn tli-action-btn--done"
                            title="Mark as done"
                            onClick={() => updateTask(task.id, { status: 'done', waitingState: null, attentionState: null })}
                          >
                            <Icon name="check" size={12} />
                          </button>
                        )}
                        {task.archivedAt ? (
                          <button
                            className="tli-action-btn tli-action-btn--done"
                            title="Restore task from archive"
                            onClick={() => void updateTask(task.id, { archivedAt: undefined })}
                          >
                            restore
                          </button>
                        ) : isConfirmingDelete ? (
                          <>
                            <button
                              className="tli-action-btn tli-action-btn--confirm"
                              title="Confirm archive"
                              onClick={() => { deleteTask(task.id); setConfirmDeleteId(null); }}
                            >
                              archive?
                            </button>
                            <button
                              className="tli-action-btn tli-action-btn--cancel"
                              title="Cancel"
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              <Icon name="x" size={12} />
                            </button>
                          </>
                        ) : (
                          <button
                            className="tli-action-btn tli-action-btn--delete"
                            title="Archive task"
                            onClick={() => setConfirmDeleteId(task.id)}
                          >
                            <Icon name="trash-2" size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                    {/* Canonical task record — expands below the task header when selected */}
                    {selectedId === task.id && (
                      <TaskRecordPanel
                        task={task}
                        onOpenDetail={() => setDetailOpenId(task.id)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )
        )}

        {/* ---- Planning view ---- */}
        {viewMode === 'planning' && (
          <PlanningView
            tasks={searchedTasks}
            selectedId={selectedId}
            onSelect={handleSelect}
            onOpenDetail={(id) => setDetailOpenId(id)}
            filter={planningFilter}
            showCompleted={showCompleted}
          />
        )}
      </div>

      {/* Canonical task record detail */}
      {detailOpenId && (() => {
        const t = realTasks.find((x) => x.id === detailOpenId);
        return t ? <TaskRecordDetail task={t} onClose={() => setDetailOpenId(null)} /> : null;
      })()}

      {showTaskForm && (
        <TaskForm onClose={() => setShowTaskForm(false)} />
      )}
    </>
  );
}
