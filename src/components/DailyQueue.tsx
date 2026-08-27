/**
 * DailyQueue — "Dnešní fronta" (Today's queue).
 *
 * Answers "in what order do I actually intend to work through today's
 * items?" — a distinct concept from WorkItem.status (workflow state) and
 * WorkItem.planningBucket (relevance grouping, e.g. "today"). The queue is
 * always an explicit user choice: nothing here is generated from priority,
 * due date, or status, and reordering never changes a work item's own
 * fields. See docs/task-workbench-mcp.md for the full contract shared with
 * the MCP tools.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkItem } from '../domain/workItem';
import {
  addNoteToDailyQueue,
  addToDailyQueue,
  completeDailyQueueEntry,
  getDailyQueue,
  moveDailyQueueItem,
  removeFromDailyQueue,
  type DailyQueueEntry,
  type DailyQueueResult,
} from '../lib/tauriCommands';
import {
  activeEntry,
  DAILY_QUEUE_ENTRY_DRAG_TYPE,
  isQueueEntryDone,
  positionAbove,
  positionBelow,
  positionForDrop,
  queueableCandidates,
  type QueueDropPlacement,
  upcomingEntries,
  WORK_ITEM_DRAG_TYPE,
} from '../lib/dailyQueue';
import { formatShortPastDate, localTodayStr } from '../lib/dates';
import { getLatestStatusNote } from '../lib/taskRecord';
import Modal from './Modal';
import Icon from './Icon';

const STATUS_LABELS: Record<WorkItem['status'], string> = {
  planned: 'Planned',
  ready: 'Ready',
  in_progress: 'In progress',
  waiting: 'Waiting',
  blocked: 'Blocked',
  review: 'Review',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const PRIORITY_LABELS: Record<WorkItem['priority'], string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  critical: 'Critical',
};

function isRevisionConflict(message: string): boolean {
  return message.includes('revision_conflict') || /current revision is/i.test(message);
}

interface DailyQueueRowProps {
  entry: DailyQueueEntry;
  currentWorkItem?: WorkItem;
  isActive: boolean;
  queueLength: number;
  onMove: (workItemId: string, position: number) => void;
  onRemove: (workItemId: string) => void;
  onComplete: (entry: DailyQueueEntry) => void;
  isDragging: boolean;
  dropPlacement: QueueDropPlacement | null;
  onDragStart: (event: React.DragEvent, entry: DailyQueueEntry) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent, entry: DailyQueueEntry) => void;
  onDrop: (event: React.DragEvent, entry: DailyQueueEntry) => void;
}

function DailyQueueRow({ entry, currentWorkItem, isActive, queueLength, onMove, onRemove, onComplete, isDragging, dropPlacement, onDragStart, onDragEnd, onDragOver, onDrop }: DailyQueueRowProps) {
  const { position } = entry;
  const workItem = entry.kind === 'work_item' ? currentWorkItem ?? entry.workItem : null;
  const title = entry.kind === 'work_item' ? entry.workItem.title : entry.text;
  const isDone = isQueueEntryDone(entry);
  const latestStatusNote = workItem ? getLatestStatusNote(workItem) : undefined;

  return (
    <li
      className={`daily-queue-row${isActive ? ' daily-queue-row--active' : ''}${isDone ? ' daily-queue-row--done' : ''}${isDragging ? ' daily-queue-row--dragging' : ''}${dropPlacement ? ` daily-queue-row--drop-${dropPlacement}` : ''}`}
      draggable
      onDragStart={(event) => onDragStart(event, entry)}
      onDragEnd={onDragEnd}
      onDragOver={(event) => onDragOver(event, entry)}
      onDrop={(event) => onDrop(event, entry)}
      data-testid="daily-queue-row"
      title="Drag to reorder"
    >
      <span className="daily-queue-drag-handle" aria-hidden="true">⠿</span>
      <span className="daily-queue-position" aria-hidden="true">{position}</span>
      <span className="daily-queue-main">
        <span className="daily-queue-title">{title}</span>
        <span className="daily-queue-meta">
          {workItem ? (
            <>
              {workItem.areaId && <span className="daily-queue-area">{workItem.areaId}</span>}
              <span className="daily-queue-status">{STATUS_LABELS[workItem.status]}</span>
              <span className="daily-queue-sep">·</span>
              <span className="daily-queue-priority">{PRIORITY_LABELS[workItem.priority]}</span>
              {latestStatusNote && (
                <span className="task-list-item-status-note" title={new Date(latestStatusNote.at).toLocaleString()}>
                  <span className="task-list-item-status-note-text">{latestStatusNote.summary}</span>
                  <span className="task-list-item-status-note-date">{formatShortPastDate(latestStatusNote.at)}</span>
                </span>
              )}
            </>
          ) : (
            <span className="daily-queue-note-label">Text note</span>
          )}
        </span>
      </span>
      <span className="daily-queue-actions">
        {!isDone && (
          <button
            type="button"
            className="daily-queue-action-btn daily-queue-action-btn--done"
            aria-label={`Mark ${title} as done`}
            title="Mark as done"
            onClick={() => onComplete(entry)}
          >
            <Icon name="check" size={13} />
          </button>
        )}
        <button
          type="button"
          className="daily-queue-action-btn"
          aria-label="Move up"
          title="Move up"
          disabled={position <= 1}
          onClick={() => onMove(entry.id, positionAbove(position))}
        >
          ▲
        </button>
        <button
          type="button"
          className="daily-queue-action-btn"
          aria-label="Move down"
          title="Move down"
          disabled={position >= queueLength}
          onClick={() => onMove(entry.id, positionBelow(position, queueLength))}
        >
          ▼
        </button>
        <button
          type="button"
          className="daily-queue-action-btn daily-queue-action-btn--remove"
          aria-label={`Remove ${title} from today's queue`}
          title="Remove from queue"
          onClick={() => onRemove(entry.id)}
        >
          <Icon name="trash-2" size={13} />
        </button>
      </span>
    </li>
  );
}

interface AddTaskPickerProps {
  candidates: WorkItem[];
  onPick: (workItemId: string) => void;
  onClose: () => void;
}

function AddTaskPicker({ candidates, onPick, onClose }: AddTaskPickerProps) {
  return (
    <Modal title="Add task to today's queue" onClose={onClose}>
      {candidates.length === 0 ? (
        <div className="daily-queue-picker-empty">Nothing available to add — everything active is already queued.</div>
      ) : (
        <ul className="daily-queue-picker-list">
          {candidates.map((item) => (
            <li key={item.id}>
              <button type="button" className="daily-queue-picker-item" onClick={() => onPick(item.id)}>
                <span className="daily-queue-picker-title">{item.title}</span>
                <span className="daily-queue-picker-meta">
                  {item.areaId && <span>{item.areaId}</span>}
                  <span>{STATUS_LABELS[item.status]}</span>
                  <span>{PRIORITY_LABELS[item.priority]}</span>
                  {item.dueAt && <span>{item.dueAt.slice(0, 10)}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export interface DailyQueueProps {
  /** Active (non-archived) canonical work items, used to populate the "+ Add task" picker. */
  workItems: WorkItem[];
  /** Uses the existing canonical task completion flow so Week Log remains authoritative. */
  onCompleteWorkItem?: (workItemId: string) => Promise<void>;
}

export default function DailyQueue({ workItems, onCompleteWorkItem }: DailyQueueProps) {
  const [queue, setQueue] = useState<DailyQueueResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const dragIdRef = useRef<string | null>(null);
  const [draggedEntryId, setDraggedEntryId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ entryId: string; placement: QueueDropPlacement } | null>(null);
  const [noteText, setNoteText] = useState('');
  const date = localTodayStr();

  const reload = useCallback(async () => {
    try {
      const result = await getDailyQueue(date);
      setQueue(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [date]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Every mutation reconciles with the authoritative queue afterwards — on success this is a
  // no-op re-render with the server's own response; on a stale-revision failure it is how the UI
  // recovers the current order instead of getting stuck showing a rejected optimistic state.
  const applyMutation = useCallback(
    async (mutate: (current: DailyQueueResult) => Promise<DailyQueueResult>) => {
      if (!queue) return;
      try {
        const updated = await mutate(queue);
        setQueue(updated);
        setError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(
          isRevisionConflict(message)
            ? "Today's queue changed elsewhere — refreshed with the latest order."
            : message,
        );
        await reload();
      }
    },
    [queue, reload],
  );

  function handleMove(entryId: string, position: number) {
    applyMutation((current) => moveDailyQueueItem(current.date, entryId, position, current.revision));
  }

  function handleRemove(entryId: string) {
    applyMutation((current) => removeFromDailyQueue(current.date, entryId, current.revision));
  }

  async function handleComplete(entry: DailyQueueEntry) {
    if (entry.kind === 'note') {
      await applyMutation((current) => completeDailyQueueEntry(current.date, entry.id, current.revision));
      return;
    }
    if (!onCompleteWorkItem) return;
    try {
      await onCompleteWorkItem(entry.workItem.id);
      await reload();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleAdd(workItemId: string, position?: number) {
    setShowPicker(false);
    applyMutation((current) => position === undefined
      ? addToDailyQueue(current.date, workItemId, current.revision)
      : addToDailyQueue(current.date, workItemId, current.revision, position));
  }

  function handleAddNote(event: React.FormEvent) {
    event.preventDefault();
    const text = noteText.trim();
    if (!text) return;
    setNoteText('');
    applyMutation((current) => addNoteToDailyQueue(current.date, text, current.revision));
  }

  function clearQueueDrag() {
    dragIdRef.current = null;
    setDraggedEntryId(null);
    setDropIndicator(null);
  }

  function handleQueueDragStart(event: React.DragEvent, entry: DailyQueueEntry) {
    dragIdRef.current = entry.id;
    setDraggedEntryId(entry.id);
    event.dataTransfer.effectAllowed = 'move';
    // WebView2 needs actual drag data for a reliable native drag operation.
    event.dataTransfer.setData(DAILY_QUEUE_ENTRY_DRAG_TYPE, entry.id);
  }

  function dropPlacementFor(event: React.DragEvent, target: DailyQueueEntry): QueueDropPlacement {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.height > 0) {
      return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
    }

    // jsdom and some synthetic drag events have no element geometry. Preserve
    // the intuitive direction: moving up inserts before, moving down after.
    const source = entries.find((entry) => entry.id === dragIdRef.current);
    return source && source.position < target.position ? 'after' : 'before';
  }

  function handleQueueDragOver(event: React.DragEvent, target: DailyQueueEntry) {
    event.preventDefault();
    event.stopPropagation();
    if (!dragIdRef.current || dragIdRef.current === target.id) {
      setDropIndicator(null);
      return;
    }
    event.dataTransfer.dropEffect = 'move';
    setDropIndicator({ entryId: target.id, placement: dropPlacementFor(event, target) });
  }

  function handleDrop(event: React.DragEvent, target?: DailyQueueEntry) {
    event.preventDefault();
    event.stopPropagation();
    const droppedWorkItemId = event.dataTransfer?.getData(WORK_ITEM_DRAG_TYPE) ?? '';
    if (droppedWorkItemId) {
      handleAdd(droppedWorkItemId, target?.position);
      return;
    }
    const draggedId = dragIdRef.current
      ?? event.dataTransfer?.getData(DAILY_QUEUE_ENTRY_DRAG_TYPE)
      ?? '';
    const source = entries.find((entry) => entry.id === draggedId);
    if (!source || !target || draggedId === target.id) {
      clearQueueDrag();
      return;
    }
    const placement = dropPlacementFor(event, target);
    const position = positionForDrop(source.position, target.position, placement);
    clearQueueDrag();
    if (position !== source.position) handleMove(draggedId, position);
  }

  const entries = queue?.entries ?? [];
  const currentWorkItems = new Map(workItems.map((item) => [item.id, item]));
  const active = activeEntry(entries);
  const upcoming = upcomingEntries(entries);

  return (
    <section
      className="daily-queue"
      aria-label="Today's queue"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => handleDrop(event)}
    >
      <div className="daily-queue-header">
        <h3>Today's queue</h3>
        <div className="daily-queue-header-actions">
          <form className="daily-queue-note-form" onSubmit={handleAddNote}>
            <input
              value={noteText}
              onChange={(event) => setNoteText(event.target.value)}
              placeholder="Add a quick note…"
              aria-label="Quick queue note"
              maxLength={500}
            />
            <button type="submit" className="daily-queue-add-btn" disabled={!noteText.trim()}>+ Add note</button>
          </form>
          <button type="button" className="daily-queue-add-btn" onClick={() => setShowPicker(true)}>
            + Add work item
          </button>
        </div>
      </div>

      {error && (
        <div className="daily-queue-error" role="alert">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="daily-queue-loading">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="daily-queue-empty">Nothing queued for today yet.</div>
      ) : (
        <>
          {active && (
            <div className="daily-queue-group daily-queue-group--now">
              <div className="daily-queue-group-label">Right now</div>
              <ol className="daily-queue-list">
                <DailyQueueRow
                  entry={active}
                  currentWorkItem={active.kind === 'work_item' ? currentWorkItems.get(active.id) : undefined}
                  isActive
                  queueLength={entries.length}
                  onMove={handleMove}
                  onRemove={handleRemove}
                  onComplete={(entry) => { void handleComplete(entry); }}
                  isDragging={draggedEntryId === active.id}
                  dropPlacement={dropIndicator?.entryId === active.id ? dropIndicator.placement : null}
                  onDragStart={handleQueueDragStart}
                  onDragEnd={clearQueueDrag}
                  onDragOver={handleQueueDragOver}
                  onDrop={handleDrop}
                />
              </ol>
            </div>
          )}
          {upcoming.length > 0 && (
            <div className="daily-queue-group daily-queue-group--next">
              <div className="daily-queue-group-label">Up next</div>
              <ol className="daily-queue-list">
                {upcoming.map((entry) => (
                  <DailyQueueRow
                    key={entry.id}
                    entry={entry}
                    currentWorkItem={entry.kind === 'work_item' ? currentWorkItems.get(entry.id) : undefined}
                    isActive={false}
                    queueLength={entries.length}
                    onMove={handleMove}
                    onRemove={handleRemove}
                    onComplete={(entry) => { void handleComplete(entry); }}
                    isDragging={draggedEntryId === entry.id}
                    dropPlacement={dropIndicator?.entryId === entry.id ? dropIndicator.placement : null}
                    onDragStart={handleQueueDragStart}
                    onDragEnd={clearQueueDrag}
                    onDragOver={handleQueueDragOver}
                    onDrop={handleDrop}
                  />
                ))}
              </ol>
            </div>
          )}
        </>
      )}

      {showPicker && (
        <AddTaskPicker
          candidates={queueableCandidates(workItems, entries)}
          onPick={handleAdd}
          onClose={() => setShowPicker(false)}
        />
      )}
    </section>
  );
}
