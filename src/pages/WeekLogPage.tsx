import { useState, useCallback, useEffect, useRef } from 'react';
import type { Task } from '../types';
import { useApp } from '../context/AppContext';
import Icon from '../components/Icon';
import Modal from '../components/Modal';
import TaskDetail from '../components/TaskDetail';
import { TypeBadge, SourceBadge } from '../components/StatusBadge';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Returns Monday of the ISO week containing `date` (local time). */
function getMondayOf(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Formats a Date as YYYY-MM-DD using local time. */
function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Short day name. */
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Format like "21 Apr". */
function fmtDay(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Format week header like "21 Apr – 27 Apr 2026". */
function fmtWeekRange(monday: Date): string {
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  return `${monday.toLocaleDateString('en-GB', opts)} – ${sunday.toLocaleDateString('en-GB', { ...opts, year: 'numeric' })}`;
}

/** Returns the local YYYY-MM-DD string for today. */
function todayYmd(): string {
  return toYmd(new Date());
}

// ---------------------------------------------------------------------------
// Completed-task date resolution
// ---------------------------------------------------------------------------

/**
 * Returns the local YYYY-MM-DD key for when a done task was completed.
 * Uses completedAt (set automatically when status changes to done).
 */
function completionDateKey(task: Task): string | null {
  if (task.status !== 'done') return null;
  if (!task.completedAt) return null;
  return toYmd(new Date(task.completedAt));
}

// ---------------------------------------------------------------------------
// DayNote — single day card textarea with debounced autosave
// ---------------------------------------------------------------------------

interface DayNoteProps {
  dateKey: string;
  initialNote: string;
  onSave: (dateKey: string, note: string) => void;
  /** Number of visible textarea rows. Default 3 (inline), pass more in the modal. */
  rows?: number;
}

function DayNote({ dateKey, initialNote, onSave, rows = 3 }: DayNoteProps) {
  const [value, setValue] = useState(initialNote);
  const [saved, setSaved] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync when switching weeks or opening a different day in the modal
  useEffect(() => {
    setValue(initialNote);
    setSaved(true);
  }, [dateKey, initialNote]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setValue(v);
    setSaved(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onSave(dateKey, v);
      setSaved(true);
    }, 800);
  }

  function handleBlur() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    onSave(dateKey, value);
    setSaved(true);
  }

  return (
    <div className="wl-note-wrap">
      <textarea
        className="wl-note-textarea"
        value={value}
        placeholder="What did you work on today?"
        onChange={handleChange}
        onBlur={handleBlur}
        rows={rows}
      />
      {!saved && <span className="wl-note-saving">saving…</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NotePreviewButton — compact button shown in day cards instead of a textarea
// ---------------------------------------------------------------------------

interface NotePreviewButtonProps {
  note: string;
  onClick: () => void;
}

function NotePreviewButton({ note, onClick }: NotePreviewButtonProps) {
  const hasNote = note.trim().length > 0;
  // Single-line preview: collapse newlines, cap at 100 chars
  const preview = hasNote
    ? note.trim().replace(/\n+/g, ' · ').slice(0, 100)
    : null;
  return (
    <button
      className={`wl-note-preview${hasNote ? '' : ' wl-note-preview--empty'}`}
      onClick={onClick}
      type="button"
      title={hasNote ? note : 'Add a note for this day'}
    >
      {preview ?? 'Add note…'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// CompletedTaskRow — compact completed task chip
// ---------------------------------------------------------------------------

interface CompletedTaskRowProps {
  task: Task;
  customerName: string | undefined;
  onClick: () => void;
}

function CompletedTaskRow({ task, customerName, onClick }: CompletedTaskRowProps) {
  return (
    <button className="wl-task-row" onClick={onClick} type="button" title="Open task detail">
      <span className="wl-task-title">{task.title}</span>
      <div className="wl-task-meta">
        {customerName && <span className="wl-task-customer">{customerName}</span>}
        <TypeBadge type={task.taskType} />
        <SourceBadge source={task.source} />
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function WeekLogPage() {
  const { tasks, settings, updateWeeklyNote, getCustomerById } = useApp();

  const [weekStart, setWeekStart] = useState<Date>(() => getMondayOf(new Date()));
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [noteModalDateKey, setNoteModalDateKey] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  // Clear selection when the task is deleted or no longer in the list.
  useEffect(() => {
    if (selectedTaskId && !tasks.find((t) => t.id === selectedTaskId)) {
      setSelectedTaskId(null);
    }
  }, [tasks, selectedTaskId]);

  const today = todayYmd();
  const weekRange = fmtWeekRange(weekStart);

  // Build 7 day entries for this week
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return { date: d, key: toYmd(d), name: DAY_NAMES[i] };
  });

  // Group completed tasks by their completion date
  const completedByDay = useCallback((): Map<string, Task[]> => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      const key = completionDateKey(task);
      if (!key) continue;
      const arr = map.get(key) ?? [];
      arr.push(task);
      map.set(key, arr);
    }
    return map;
  }, [tasks]);

  const tasksByDay = completedByDay();

  // Resolve the day entry for the currently open note modal (may be null when
  // the modal is closed or when the note date is outside the visible week).
  const noteModalDay = noteModalDateKey
    ? (days.find((d) => d.key === noteModalDateKey) ?? null)
    : null;

  // Navigation
  function goBack() {
    setWeekStart((prev) => {
      const d = new Date(prev);
      d.setDate(d.getDate() - 7);
      return d;
    });
  }

  function goForward() {
    setWeekStart((prev) => {
      const d = new Date(prev);
      d.setDate(d.getDate() + 7);
      return d;
    });
  }

  function goToday() {
    setWeekStart(getMondayOf(new Date()));
  }

  const selectedTask = selectedTaskId ? (tasks.find((t) => t.id === selectedTaskId) ?? null) : null;

  // Scroll detail into view whenever a task is selected.
  useEffect(() => {
    if (selectedTask && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedTask]);

  return (
    <div className="wl-root">
      {/* Header row */}
      <div className="page-header" style={{ alignItems: 'center' }}>
        <div>
          <div className="page-title">Week Log</div>
          <div className="page-subtitle">{weekRange}</div>
        </div>
        <div className="wl-nav-controls">
          <button className="btn btn-ghost btn-sm" onClick={goBack} title="Previous week">
            <Icon name="arrow-left" size={13} /> Prev
          </button>
          <button className="btn btn-secondary btn-sm" onClick={goToday} title="Go to current week">
            Today
          </button>
          <button className="btn btn-ghost btn-sm" onClick={goForward} title="Next week">
            Next <Icon name="arrow-right" size={13} />
          </button>
        </div>
      </div>

      {/* Content area: grid stacked, detail below */}
      <div className="wl-content">
        {/* 7-day grid */}
        <div className="wl-grid">
          {days.map(({ date, key, name }) => {
            const isToday = key === today;
            const dayTasks = tasksByDay.get(key) ?? [];
            const note = settings.weeklyNotes?.[key] ?? '';
            const isEmpty = !note.trim() && dayTasks.length === 0;

            return (
              <div key={key} className={`wl-day-card${isToday ? ' wl-day-card--today wl-day-card--featured' : ''}`}>
                {/* Card header */}
                <div className="wl-day-header">
                  <span className="wl-day-name">{name}</span>
                  <span className="wl-day-date">{fmtDay(date)}</span>
                  {isToday && <span className="wl-today-badge">Today</span>}
                </div>

                {/* Compact note preview — click opens the edit modal */}
                <NotePreviewButton
                  note={note}
                  onClick={() => setNoteModalDateKey(key)}
                />

                {/* Completed tasks */}
                {dayTasks.length > 0 && (
                  <div className="wl-tasks">
                    <div className="wl-tasks-label">Completed</div>
                    {dayTasks.map((t) => (
                      <CompletedTaskRow
                        key={t.id}
                        task={t}
                        customerName={getCustomerById(t.customerId)?.name}
                        onClick={() => setSelectedTaskId(t.id === selectedTaskId ? null : t.id)}
                      />
                    ))}
                  </div>
                )}

                {/* Empty state — no tasks and no note */}
                {isEmpty && (
                  <div className="wl-empty">No activity logged.</div>
                )}
              </div>
            );
          })}
        </div>

        {/* Task detail block below the week grid */}
        {selectedTask && (
          <div className="wl-detail-block" ref={detailRef}>
            <TaskDetail
              task={selectedTask}
              onClose={() => setSelectedTaskId(null)}
            />
          </div>
        )}
      </div>

      {/* Note edit modal — opens when the user clicks a day's note preview button */}
      {noteModalDateKey && (
        <Modal
          title={
            noteModalDay
              ? `Note — ${noteModalDay.name} ${fmtDay(noteModalDay.date)}`
              : 'Day Note'
          }
          onClose={() => setNoteModalDateKey(null)}
          footer={
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setNoteModalDateKey(null)}
              type="button"
            >
              Close
            </button>
          }
        >
          <DayNote
            dateKey={noteModalDateKey}
            initialNote={settings.weeklyNotes?.[noteModalDateKey] ?? ''}
            onSave={updateWeeklyNote}
            rows={7}
          />
        </Modal>
      )}
    </div>
  );
}
