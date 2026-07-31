import type { Task, TaskStatus } from '../types';
import { useApp } from '../context/AppContext';
import { formatRelativeDate, isOverdue } from '../lib/dates';
import { openExternalUrl } from '../lib/tauriCommands';
import { expectedOutcomeCzech } from '../lib/taskPresentation';

const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'analyzed', label: 'Clarified' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'ready-for-review', label: 'Awaiting review' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
];

interface TaskRecordPanelProps {
  task: Task;
  onOpenDetail: () => void;
}

export default function TaskRecordPanel({ task, onOpenDetail }: TaskRecordPanelProps) {
  const { updateTask } = useApp();
  const overdue = task.dueAt ? isOverdue(task.dueAt, task.status) : false;
  const devopsUrl = task.devopsTaskUrl ?? task.adoContext?.workItemUrl ?? task.adoContext?.prUrl;
  const openEdge = (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(url);
  };

  return (
    <div
      className="tip-panel"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="tip-grid">
        <div className="tip-column">
          <div className="tip-section">
            <div className="tip-section-label">Očekávaný výsledek</div>
            <div className="tip-summary">
              {expectedOutcomeCzech(task)}
            </div>
          </div>

          <div className="tip-section">
            <div className="tip-section-label">Responsibility</div>
            <div className="detail-repo-block">
              <div className="detail-repo-row">
                <span className="detail-repo-label">Kind</span>
                <span className="detail-repo-value">{task.obligationKind ?? 'task'}</span>
              </div>
              <div className="detail-repo-row">
                <span className="detail-repo-label">Responsible</span>
                <span className="detail-repo-value">{task.responsibleParty || 'Unassigned'}</span>
              </div>
              {task.accountableTo && (
                <div className="detail-repo-row">
                  <span className="detail-repo-label">Accountable to</span>
                  <span className="detail-repo-value">{task.accountableTo}</span>
                </div>
              )}
              {(task.ticketUrl || devopsUrl || task.sourceUrl) && (
                <>
                  {task.ticketUrl && (
                    <div className="detail-repo-row">
                      <span className="detail-repo-label">Tiket</span>
                      <a className="detail-link" href={task.ticketUrl} onClick={(event) => openEdge(event, task.ticketUrl!)}>
                        Otevřít tiket ↗
                      </a>
                    </div>
                  )}
                  {devopsUrl && (
                    <div className="detail-repo-row">
                      <span className="detail-repo-label">DevOps</span>
                      <a className="detail-link" href={devopsUrl} onClick={(event) => openEdge(event, devopsUrl)}>
                        Otevřít DevOps položku ↗
                      </a>
                    </div>
                  )}
                  {task.sourceUrl && (
                    <div className="detail-repo-row">
                      <span className="detail-repo-label">Zdroj</span>
                      <a className="detail-link" href={task.sourceUrl} onClick={(event) => openEdge(event, task.sourceUrl!)}>
                        Otevřít zdrojovou zprávu ↗
                      </a>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="tip-column">
          <div className="tip-section">
            <div className="tip-section-label">Record status</div>
            <select
              className="form-select"
              value={task.status}
              onChange={(event) => void updateTask(task.id, { status: event.target.value as TaskStatus })}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          <div className="tip-section">
            <div className="tip-section-label">Timing</div>
            <div style={{ fontSize: 12, color: overdue ? 'var(--color-blocked)' : 'var(--text-secondary)' }}>
              {task.dueAt
                ? `${formatRelativeDate(task.dueAt, task.status)}${overdue ? ' · overdue' : ''}`
                : 'No deadline'}
            </div>
            {task.estimatedEffort !== undefined && (
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                Estimated effort: {task.estimatedEffort}h
              </div>
            )}
          </div>

          <div className="tip-section">
            <div className="tip-section-label">Record</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Revision {task.revision ?? 1}
              {task.updatedAt ? ` · updated ${new Date(task.updatedAt).toLocaleString()}` : ''}
            </div>
            <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={onOpenDetail}>
              Open full record
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
