import { useEffect, useState } from 'react';
import type { Task } from '../types';
import { useApp } from '../context/AppContext';
import Modal from './Modal';
import TaskForm from './TaskForm';
import { SourceBadge, TaskStateBadges, TypeBadge } from './StatusBadge';
import { formatRelativeDate, isOverdue } from '../lib/dates';
import { openExternalUrl } from '../lib/tauriCommands';
import { expectedOutcomeCzech } from '../lib/taskPresentation';
import { type TaskPhase, PHASE_OPTIONS, applyTaskPhase, getTaskPhase } from '../lib/taskPhase';
import { buildStatusNoteHistory } from '../lib/taskRecord';

interface TaskRecordDetailProps {
  task: Task;
  onClose: () => void;
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}h`;
}

export default function TaskRecordDetail({ task, onClose }: TaskRecordDetailProps) {
  const { getCustomerById, updateTask } = useApp();
  const [showEditForm, setShowEditForm] = useState(false);
  const [notes, setNotes] = useState(task.notes ?? '');
  const [statusNoteInput, setStatusNoteInput] = useState('');
  const customer = getCustomerById(task.customerId);
  const overdue = task.dueAt ? isOverdue(task.dueAt, task.status) : false;
  const devopsUrl = task.devopsTaskUrl ?? task.adoContext?.workItemUrl ?? task.adoContext?.prUrl;
  const openEdge = (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault();
    void openExternalUrl(url);
  };

  useEffect(() => setNotes(task.notes ?? ''), [task.id, task.notes]);
  useEffect(() => setStatusNoteInput(''), [task.id]);

  async function saveNotes() {
    if (notes !== (task.notes ?? '')) await updateTask(task.id, { notes });
  }

  async function addStatusNote() {
    const text = statusNoteInput.trim();
    if (!text) return;
    setStatusNoteInput('');
    await updateTask(task.id, { history: buildStatusNoteHistory(task, text, new Date().toISOString()) });
  }

  const footer = (
    <>
      <button className="btn btn-ghost" onClick={onClose}>Close</button>
      <button className="btn btn-primary" onClick={() => setShowEditForm(true)}>Edit record</button>
    </>
  );

  return (
    <>
      <Modal title={task.title} onClose={onClose} footer={footer} size="xl">
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          <TaskStateBadges task={task} />
          <SourceBadge source={task.source} />
          <TypeBadge type={task.taskType} />
          <span className="tracking-pill">{task.obligationKind ?? 'task'}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
            revision {task.revision ?? 1}
          </span>
        </div>

        <div className="form-row">
          <div className="detail-section">
            <span className="detail-section-label">Status</span>
            <select
              className="form-select"
              value={getTaskPhase(task)}
              onChange={(event) => void updateTask(task.id, applyTaskPhase(event.target.value as TaskPhase))}
            >
              {PHASE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="detail-section">
            <span className="detail-section-label">Customer / context owner</span>
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{customer?.name ?? (task.customerId || 'None')}</div>
          </div>
        </div>

        <div className="detail-section">
          <span className="detail-section-label">Popis / očekávaný výsledek</span>
          <div className="detail-message">
            <div className="email-body" style={{ padding: 12, whiteSpace: 'pre-wrap' }}>
              {expectedOutcomeCzech(task)}
            </div>
          </div>
        </div>

        <div className="form-row-3">
          <div className="detail-section">
            <span className="detail-section-label">Responsible party</span>
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{task.responsibleParty || 'Unassigned'}</div>
          </div>
          <div className="detail-section">
            <span className="detail-section-label">Accountable to</span>
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{task.accountableTo || 'Not specified'}</div>
          </div>
          <div className="detail-section">
            <span className="detail-section-label">Deadline</span>
            <div style={{ color: overdue ? 'var(--color-blocked)' : 'var(--text-secondary)', fontSize: 13 }}>
              {task.dueAt ? formatRelativeDate(task.dueAt, task.status) : 'No deadline'}
              {overdue ? ' · overdue' : ''}
            </div>
          </div>
        </div>

        {(task.estimatedEffort !== undefined || task.budgetHours !== undefined || task.budgetNote) && (
          <div className="form-row-3">
            {task.estimatedEffort !== undefined && (
              <div className="detail-section">
                <span className="detail-section-label">Estimated effort</span>
                <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{formatHours(task.estimatedEffort)}</div>
              </div>
            )}
            {task.budgetHours !== undefined && (
              <div className="detail-section">
                <span className="detail-section-label">Budget</span>
                <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{formatHours(task.budgetHours)}</div>
              </div>
            )}
            {task.budgetNote && (
              <div className="detail-section">
                <span className="detail-section-label">Budget note</span>
                <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{task.budgetNote}</div>
              </div>
            )}
          </div>
        )}

        <div className="detail-section">
          <span className="detail-section-label">Related context</span>
          <div className="detail-repo-block">
            {task.ticketUrl && <div className="detail-repo-row"><span className="detail-repo-label">Tiket</span><a className="detail-link" href={task.ticketUrl} onClick={(event) => openEdge(event, task.ticketUrl!)}>Otevřít tiket ↗</a></div>}
            {devopsUrl && <div className="detail-repo-row"><span className="detail-repo-label">DevOps</span><a className="detail-link" href={devopsUrl} onClick={(event) => openEdge(event, devopsUrl)}>Otevřít DevOps položku ↗</a></div>}
            {task.sourceUrl && <div className="detail-repo-row"><span className="detail-repo-label">Zdroj</span><a className="detail-link" href={task.sourceUrl} onClick={(event) => openEdge(event, task.sourceUrl!)}>Otevřít zdrojovou zprávu ↗</a></div>}
            {task.senderName && <div className="detail-repo-row"><span className="detail-repo-label">Sender</span><span className="detail-repo-value">{task.senderName}{task.senderEmail ? ` <${task.senderEmail}>` : ''}</span></div>}
            {!task.ticketUrl && !devopsUrl && !task.sourceUrl && !task.senderName && (
              <span className="detail-empty-inline">No related links or sender context.</span>
            )}
          </div>
        </div>

        {task.originalMessage && (
          <div className="detail-section">
            <span className="detail-section-label">Original source context</span>
            <div className="detail-message">
              <div className="email-body" style={{ padding: 12, whiteSpace: 'pre-wrap' }}>{task.originalMessage}</div>
            </div>
          </div>
        )}

        <div className="detail-section">
          <span className="detail-section-label">Notes</span>
          <textarea
            className="detail-notes-textarea"
            value={notes}
            placeholder="Add decisions, context, or reminders…"
            onChange={(event) => setNotes(event.target.value)}
            onBlur={() => void saveNotes()}
          />
        </div>

        <div className="detail-section">
          <span className="detail-section-label">Status update</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              className="form-input"
              style={{ flex: 1 }}
              value={statusNoteInput}
              placeholder="e.g. Implemented, waiting for JKV…"
              onChange={(event) => setStatusNoteInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addStatusNote();
                }
              }}
            />
            <button
              className="btn btn-secondary"
              disabled={!statusNoteInput.trim()}
              onClick={() => void addStatusNote()}
            >
              Add
            </button>
          </div>
        </div>

        <div className="detail-section">
          <span className="detail-section-label">History ({task.history?.length ?? 0})</span>
          {(task.history?.length ?? 0) === 0 ? (
            <span className="detail-empty-inline">Legacy record; structured history begins with the next change.</span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[...(task.history ?? [])].reverse().map((entry) => (
                <div key={entry.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 4, background: 'var(--bg-overlay)', padding: '8px 10px' }}>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                    {new Date(entry.at).toLocaleString()} · {entry.actorName || entry.actorType}
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 3 }}>{entry.summary}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {showEditForm && (
        <TaskForm initialTask={task} onClose={() => setShowEditForm(false)} />
      )}
    </>
  );
}
