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

import { useCallback, useEffect, useState } from 'react';
import type { WorkItem } from '../domain/workItem';
import {
  addToDailyQueue,
  getDailyQueue,
  moveDailyQueueItem,
  removeFromDailyQueue,
  type DailyQueueEntry,
  type DailyQueueResult,
} from '../lib/tauriCommands';
import { activeEntry, positionAbove, positionBelow, queueableCandidates, upcomingEntries } from '../lib/dailyQueue';
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
  onDragStart: (workItemId: string) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (entry: DailyQueueEntry) => void;
}

function DailyQueueRow({ entry, isActive, queueLength, onMove, onRemove, onDragStart, onDragOver, onDrop }: DailyQueueRowProps) {
  const { workItem, position } = entry;
  const isDone = workItem.status === 'completed' || workItem.status === 'cancelled';

  return (
    <li
      className={`daily-queue-row${isActive ? ' daily-queue-row--active' : ''}${isDone ? ' daily-queue-row--done' : ''}`}
      draggable
      onDragStart={() => onDragStart(workItem.id)}
      onDragOver={onDragOver}
      onDrop={() => onDrop(entry)}
      data-testid="daily-queue-row"
    >
      <span className="daily-queue-position" aria-hidden="true">{position}</span>
      <span className="daily-queue-main">
        <span className="daily-queue-title">{workItem.title}</span>
        <span className="daily-queue-meta">
          {workItem.areaId && <span className="daily-queue-area">{workItem.areaId}</span>}
          <span className="daily-queue-status">{STATUS_LABELS[workItem.status]}</span>
          <span className="daily-queue-sep">·</span>
          <span className="daily-queue-priority">{PRIORITY_LABELS[workItem.priority]}</span>
        </span>
      </span>
      <span className="daily-queue-actions">
        <button
          type="button"
          className="daily-queue-action-btn"
          aria-label="Move up"
          title="Move up"
          disabled={position <= 1}
          onClick={() => onMove(workItem.id, positionAbove(position))}
        >
          ▲
        </button>
        <button
          type="button"
          className="daily-queue-action-btn"
          aria-label="Move down"
          title="Move down"
          disabled={position >= queueLength}
          onClick={() => onMove(workItem.id, positionBelow(position, queueLength))}
        >
          ▼
        </button>
        <button
          type="button"
          className="daily-queue-action-btn daily-queue-action-btn--remove"
          aria-label={`Remove ${workItem.title} from today's queue`}
          title="Remove from queue"
          onClick={() => onRemove(workItem.id)}
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
  const [dragId, setDragId] = useState<string | null>(null);
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

  function handleMove(workItemId: string, position: number) {
    applyMutation((current) => moveDailyQueueItem(current.date, workItemId, position, current.revision));
  }

  function handleRemove(workItemId: string) {
    applyMutation((current) => removeFromDailyQueue(current.date, workItemId, current.revision));
  }

  function handleAdd(workItemId: string) {
    setShowPicker(false);
    applyMutation((current) => addToDailyQueue(current.date, workItemId, current.revision));
  }

  function handleDrop(target: DailyQueueEntry) {
    const draggedId = dragId;
    setDragId(null);
    if (!draggedId || draggedId === target.workItem.id) return;
    handleMove(draggedId, target.position);
  }

  const entries = queue?.entries ?? [];
  const active = activeEntry(entries);
  const upcoming = upcomingEntries(entries);

  return (
    <section className="daily-queue" aria-label="Today's queue">
      <div className="daily-queue-header">
        <h3>Today's queue</h3>
        <button type="button" className="daily-queue-add-btn" onClick={() => setShowPicker(true)}>
          + Add task
        </button>
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
                  onDragStart={setDragId}
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
                    key={entry.workItem.id}
                    entry={entry}
                    isActive={false}
                    queueLength={entries.length}
                    onMove={handleMove}
                    onRemove={handleRemove}
                    onDragStart={setDragId}
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
