import { useMemo, useState } from 'react';
import TaskRecordDetail from '../components/TaskRecordDetail';
import { useApp } from '../context/AppContext';

type ObligationFilter = 'active' | 'waiting' | 'completed' | 'all';

export default function ObligationsPage() {
  const { tasks, workItems, getCustomerById } = useApp();
  const [filter, setFilter] = useState<ObligationFilter>('active');
  const [detailId, setDetailId] = useState<string | null>(null);
  const obligations = useMemo(
    () => workItems
      .filter((item) => !item.archivedAt && item.kind === 'obligation')
      .map((item) => ({
        item,
        task: tasks.find((task) => task.id === item.id),
      }))
      .filter((entry): entry is typeof entry & { task: NonNullable<typeof entry.task> } => !!entry.task),
    [tasks, workItems],
  );
  const visible = obligations.filter(({ item }) => {
    if (filter === 'all') return true;
    if (filter === 'completed') return item.status === 'completed';
    if (filter === 'waiting') return item.status === 'waiting';
    return !['completed', 'cancelled'].includes(item.status);
  });
  const selected = tasks.find((task) => task.id === detailId);

  return (
    <div className="workbench-page">
      <div className="record-toolbar">
        <div className="segmented-control" aria-label="Obligation filter">
          {(['active', 'waiting', 'completed', 'all'] as ObligationFilter[]).map((value) => (
            <button
              key={value}
              className={filter === value ? 'active' : ''}
              onClick={() => setFilter(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        <span className="record-count">{visible.length} of {obligations.length}</span>
      </div>

      {visible.length === 0 ? (
        <div className="record-empty">
          No obligations match this view. Mark a record as a responsibility, commitment, or follow-up.
        </div>
      ) : (
        <div className="obligation-grid">
          {visible.map(({ task, item }) => (
            <button key={item.id} className="obligation-card" onClick={() => setDetailId(item.id)}>
              <div className="obligation-card-top">
                <span>{item.obligationMode === 'ongoing' ? 'Ongoing responsibility' : 'Commitment'}</span>
                <span className={`obligation-state obligation-state--${item.status}`}>
                  {item.status.replace('_', ' ')}
                </span>
              </div>
              <strong>{item.title}</strong>
              <p>{item.description || 'No canonical description yet.'}</p>
              <dl>
                <div><dt>Owner</dt><dd>{item.owner?.displayName ?? 'Unassigned'}</dd></div>
                <div><dt>Accountable to</dt><dd>{item.accountableTo?.displayName ?? 'Not recorded'}</dd></div>
                <div><dt>Area</dt><dd>{getCustomerById(task.customerId)?.name ?? 'No area'}</dd></div>
                <div><dt>Due / review</dt><dd>{item.nextReviewAt?.slice(0, 10) ?? item.dueAt?.slice(0, 10) ?? 'Not set'}</dd></div>
              </dl>
            </button>
          ))}
        </div>
      )}

      {selected && <TaskRecordDetail task={selected} onClose={() => setDetailId(null)} />}
    </div>
  );
}
