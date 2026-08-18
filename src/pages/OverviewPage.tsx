import { useMemo, useState } from 'react';
import TaskRecordDetail from '../components/TaskRecordDetail';
import DailyQueue from '../components/DailyQueue';
import { useApp } from '../context/AppContext';

type FocusKey = 'now' | 'overdue' | 'today' | 'blocked' | 'waiting' | 'obligations';

function localDay(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default function OverviewPage() {
  const { tasks, workItems } = useApp();
  const [focus, setFocus] = useState<FocusKey>('overdue');
  const [detailId, setDetailId] = useState<string | null>(null);
  const today = localDay(new Date());

  const records = useMemo(
    () => workItems
      .filter((item) => !item.archivedAt)
      .map((item) => ({ item })),
    [workItems],
  );
  const active = records.filter(({ item }) => !['completed', 'cancelled'].includes(item.status));
  const groups: Record<FocusKey, typeof records> = {
    now: active.filter(({ item }) => item.planningBucket === 'now'),
    overdue: active.filter(({ item }) => !!item.dueAt && item.dueAt.slice(0, 10) < today),
    today: active.filter(({ item }) => item.dueAt?.slice(0, 10) === today),
    blocked: active.filter(({ item }) => item.status === 'blocked'),
    waiting: active.filter(({ item }) => item.status === 'waiting'),
    obligations: active.filter(({ item }) => item.kind === 'obligation'),
  };
  const selected = tasks.find((task) => task.id === detailId);

  return (
    <div className="workbench-page">
      <section className="overview-hero">
        <div>
          <div className="overview-eyebrow">Source of truth</div>
          <h2>What needs your attention</h2>
          <p>Deadlines, blockers, waiting states, and ongoing responsibilities in one place.</p>
        </div>
        <div className="overview-total">
          <strong>{active.length}</strong>
          <span>active records</span>
        </div>
      </section>

      <DailyQueue workItems={workItems.filter((item) => !item.archivedAt)} />

      <div className="overview-metrics" role="list" aria-label="Attention categories">
        {([
          ['now', 'Now'],
          ['overdue', 'Overdue'],
          ['today', 'Due today'],
          ['blocked', 'Blocked'],
          ['waiting', 'Waiting'],
          ['obligations', 'Obligations'],
        ] as Array<[FocusKey, string]>).map(([key, label]) => (
          <button
            key={key}
            className={`overview-metric${focus === key ? ' overview-metric--active' : ''}`}
            onClick={() => setFocus(key)}
          >
            <strong>{groups[key].length}</strong>
            <span>{label}</span>
          </button>
        ))}
      </div>

      <section className="record-section">
        <div className="record-section-heading">
          <h3>{focus === 'obligations' ? 'Active obligations' : `Attention: ${focus}`}</h3>
          <span>{groups[focus].length} records</span>
        </div>
        {groups[focus].length === 0 ? (
          <div className="record-empty">Nothing in this category.</div>
        ) : (
          <div className="record-list">
            {groups[focus].map(({ item }) => (
              <button key={item.id} className="record-row" onClick={() => setDetailId(item.id)}>
                <span className={`record-status record-status--${item.status}`} />
                <span className="record-row-main">
                  <strong>{item.title}</strong>
                  <small>
                    {item.owner?.displayName ?? 'Unassigned'}
                    {item.accountableTo ? ` · accountable to ${item.accountableTo.displayName}` : ''}
                  </small>
                </span>
                <span className="record-row-meta">
                  {item.dueAt ? item.dueAt.slice(0, 10) : item.status.replace('_', ' ')}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {selected && <TaskRecordDetail task={selected} onClose={() => setDetailId(null)} />}
    </div>
  );
}
