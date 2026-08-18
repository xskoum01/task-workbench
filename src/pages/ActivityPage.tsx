import { useMemo, useState, type ReactNode } from 'react';
import TaskRecordDetail from '../components/TaskRecordDetail';
import { useApp } from '../context/AppContext';

interface ActivityPageProps {
  weekLog: ReactNode;
}

export default function ActivityPage({ weekLog }: ActivityPageProps) {
  const { tasks } = useApp();
  const [mode, setMode] = useState<'history' | 'week'>('week');
  const [detailId, setDetailId] = useState<string | null>(null);
  const events = useMemo(
    () => tasks.flatMap((task) =>
      (task.history ?? []).map((event) => ({ task, event })))
      .sort((left, right) => right.event.at.localeCompare(left.event.at))
      .slice(0, 250),
    [tasks],
  );
  const selected = tasks.find((task) => task.id === detailId);

  return (
    <div className="workbench-page workbench-page--activity">
      <div className="record-toolbar">
        <div className="segmented-control">
          <button className={mode === 'history' ? 'active' : ''} onClick={() => setMode('history')}>
            Record history
          </button>
          <button className={mode === 'week' ? 'active' : ''} onClick={() => setMode('week')}>
            Week log
          </button>
        </div>
      </div>

      {mode === 'week' ? weekLog : (
        events.length === 0 ? (
          <div className="record-empty">No structured activity has been recorded yet.</div>
        ) : (
          <ol className="activity-list">
            {events.map(({ task, event }) => (
              <li key={`${task.id}-${event.id}`}>
                <span className="activity-dot" />
                <button onClick={() => setDetailId(task.id)}>
                  <span className="activity-time">{new Date(event.at).toLocaleString()}</span>
                  <strong>{event.summary}</strong>
                  <small>{task.title} · {event.actorName ?? event.actorType}</small>
                </button>
              </li>
            ))}
          </ol>
        )
      )}

      {selected && <TaskRecordDetail task={selected} onClose={() => setDetailId(null)} />}
    </div>
  );
}
