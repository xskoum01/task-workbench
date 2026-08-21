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
  getDailyQueue,
  moveDailyQueueItem,
  removeFromDailyQueue,
  type DailyQueueEntry,
  type DailyQueueResult,
} from '../lib/tauriCommands';
import { activeEntry, positionAbove, positionBelow, queueableCandidates, upcomingEntries, WORK_ITEM_DRAG_TYPE } from '../lib/dailyQueue';
import { localTodayStr } from '../lib/dates';
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
  isActive: boolean;
  queueLength: number;
  onMove: (workItemId: string, position: number) => void;
  onRemove: (workItemId: string) => void;
  onDragStart: (entryId: string) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent, entry: DailyQueueEntry) => void;
}

function DailyQueueRow({ entry, isActive, queueLength, onMove, onRemove, onDragStart, onDragOver, onDrop }: DailyQueueRowProps) {
  const { position } = entry;
  const workItem = entry.kind === 'work_item' ? entry.workItem : null;
  const title = entry.kind === 'work_item' ? entry.workItem.title : entry.text;
  const isDone = workItem ? workItem.status === 'completed' || workItem.status === 'cancelled' : false;

  return (
    <li
      className={`daily-queue-row${isActive ? ' daily-queue-row--active' : ''}${isDone ? ' daily-queue-row--done' : ''}`}
      draggable
      onDragStart={() => onDragStart(entry.id)}
      onDragOver={onDragOver}
      onDrop={(event) => onDrop(event, entry)}
      data-testid="daily-queue-row"
    >
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
            </>
          ) : (
            <span className="daily-queue-note-label">Text note</span>
          )}
        </span>
      </span>
      <span className="daily-queue-actions">
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
}

export default function DailyQueue({ workItems }: DailyQueueProps) {
  const [queue, setQueue] = useState<DailyQueueResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const dragIdRef = useRef<string | null>(null);
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

  function handleDrop(event: React.DragEvent, target?: DailyQueueEntry) {
    event.preventDefault();
    event.stopPropagation();
    const droppedWorkItemId = event.dataTransfer?.getData(WORK_ITEM_DRAG_TYPE) ?? '';
    if (droppedWorkItemId) {
      handleAdd(droppedWorkItemId, target?.position);
      return;
    }
    const draggedId = dragIdRef.current;
    dragIdRef.current = null;
    if (!draggedId || !target || draggedId === target.id) return;
    handleMove(draggedId, target.position);
  }

  const entries = queue?.entries ?? [];
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
                  isActive
                  queueLength={entries.length}
                  onMove={handleMove}
                  onRemove={handleRemove}
                  onDragStart={(entryId) => { dragIdRef.current = entryId; }}
                  onDragOver={(event) => event.preventDefault()}
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
                    isActive={false}
                    queueLength={entries.length}
                    onMove={handleMove}
                    onRemove={handleRemove}
                    onDragStart={(entryId) => { dragIdRef.current = entryId; }}
                    onDragOver={(event) => event.preventDefault()}
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
