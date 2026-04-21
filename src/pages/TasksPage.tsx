import { useState } from 'react';
import type { TaskStatus } from '../types';
import { useApp } from '../context/AppContext';
import { StatusBadge, TypeBadge, SourceBadge } from '../components/StatusBadge';
import Icon from '../components/Icon';
import TaskDetail from '../components/TaskDetail';
import TaskForm from '../components/TaskForm';
import PlanningView, { type PlanningFilter } from '../components/PlanningView';
import { isOverdue, formatRelativeDate } from '../lib/dates';
import { effectiveBucket } from '../lib/planning';

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
  { value: 'locked',  label: 'Locked',  title: 'Manually locked bucket'      },
];

const STATUS_FILTERS: { value: TaskStatus | 'all'; label: string }[] = [
  { value: 'all',              label: 'All'        },
  { value: 'new',              label: 'New'        },
  { value: 'analyzed',         label: 'Analyzed'   },
  { value: 'in-progress',      label: 'In Progress'},
  { value: 'ready-for-review', label: 'For Review' },
  { value: 'blocked',          label: 'Blocked'    },
  { value: 'done',             label: 'Done'       },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TasksPage() {
  const { tasks, getCustomerById, updateTask, deleteTask } = useApp();

  const [viewMode, setViewMode]           = useState<ViewMode>('planning');
  const [filter, setFilter]               = useState<TaskStatus | 'all'>('all');
  const [planningFilter, setPlanningFilter] = useState<PlanningFilter>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [selectedId, setSelectedId]       = useState<string | null>(null);
  const [showTaskForm, setShowTaskForm]   = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function handleSelect(id: string) {
    setSelectedId((prev) => (prev === id ? null : id));
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
  const realTasks = tasks.filter(
    (t) => !t.classificationState || t.classificationState === 'created',
  );

  const filtered = filter === 'all'
    ? realTasks
    : realTasks.filter((t) => t.status === filter);

  const selectedTask = realTasks.find((t) => t.id === selectedId) ?? null;

  // Quick counts for planning filter badges
  const activeTasks = realTasks.filter((t) => t.status !== 'done');
  const overdueCount = activeTasks.filter((t) => t.dueAt && isOverdue(t.dueAt, t.status)).length;
  const todayCount   = activeTasks.filter((t) => effectiveBucket(t) === 'today').length;
  const blockedCount = activeTasks.filter((t) => t.status === 'blocked').length;
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
    locked:  lockedCount,
  };

  return (
    <>
      <div className="page-content">
        <div className="page-header">
          <div>
            <div className="page-title">Tasks</div>
            <div className="page-subtitle">
              {viewMode === 'list'
                ? `${filtered.length} task${filtered.length !== 1 ? 's' : ''}`
                : `${realTasks.filter((t) => t.status !== 'done').length} active tasks`}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                  {realTasks.filter((t) => t.status === 'done').length > 0 && (
                    <span className="planning-filter-chip-count">
                      {realTasks.filter((t) => t.status === 'done').length}
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
                    ? realTasks.length
                    : realTasks.filter((t) => t.status === f.value).length;
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

            <button className="btn btn-secondary" onClick={() => setShowTaskForm(true)}>
              <span className="btn-icon">+</span>
              New Task
            </button>
          </div>
        </div>

        {/* ---- List view ---- */}
        {viewMode === 'list' && (
          filtered.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">—</div>
              <div className="empty-state-text">No tasks match this filter</div>
            </div>
          ) : (
            <div className="task-list">
              {filtered.map((task) => {
                const customer = getCustomerById(task.customerId);
                const isConfirmingDelete = confirmDeleteId === task.id;
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
                      <div className="task-list-item-title">{task.title}</div>
                      <div className="task-list-item-meta">
                        <SourceBadge source={task.source} />
                        <TypeBadge type={task.taskType} />
                        <span className="task-meta-sep">·</span>
                        <span className="task-list-item-customer">
                          {customer?.name ?? task.customerId}
                        </span>
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
                      <StatusBadge status={task.status} />
                      <span className="task-list-item-confidence">
                        {task.confidence}%
                      </span>
                      <div
                        className="task-list-item-actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {task.status !== 'done' && (
                          <button
                            className="tli-action-btn tli-action-btn--done"
                            title="Mark as done"
                            onClick={() => updateTask(task.id, { status: 'done' })}
                          >
                            <Icon name="check" size={12} />
                          </button>
                        )}
                        {isConfirmingDelete ? (
                          <>
                            <button
                              className="tli-action-btn tli-action-btn--confirm"
                              title="Confirm delete"
                              onClick={() => { deleteTask(task.id); setConfirmDeleteId(null); }}
                            >
                              del?
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
                            title="Delete task"
                            onClick={() => setConfirmDeleteId(task.id)}
                          >
                            <Icon name="trash-2" size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}

        {/* ---- Planning view ---- */}
        {viewMode === 'planning' && (
          <PlanningView
            tasks={realTasks}
            selectedId={selectedId}
            onSelect={handleSelect}
            filter={planningFilter}
            showCompleted={showCompleted}
          />
        )}
      </div>

      {selectedTask && (
        <TaskDetail task={selectedTask} onClose={() => setSelectedId(null)} />
      )}

      {showTaskForm && (
        <TaskForm onClose={() => setShowTaskForm(false)} />
      )}
    </>
  );
}
