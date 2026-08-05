import { useEffect, useState } from 'react';
import type { Task } from '../types';
import { useApp } from '../context/AppContext';
import { formatRelativeDate, isOverdue } from '../lib/dates';
import { openExternalUrl } from '../lib/tauriCommands';
import { expectedOutcomeCzech } from '../lib/taskPresentation';
import { type TaskPhase, PHASE_OPTIONS, applyTaskPhase, getTaskPhase } from '../lib/taskPhase';
import { inferTaskMode, type TaskMode } from '../lib/taskMode';
import TaskModeSwitch from './TaskModeSwitch';
import { buildStatusNoteHistory, getStatusNotes } from '../lib/taskRecord';

interface TaskRecordPanelProps {
  task: Task;
  onOpenDetail: () => void;
}

const GENERAL_PHASE_OPTIONS: { value: TaskPhase; label: string }[] = [
  { value: 'new',            label: 'New' },
  { value: 'analyzed',       label: 'Analyzed' },
  { value: 'waiting-review', label: 'Waiting for colleague' },
  { value: 'done',           label: 'Done' },
];

function phaseForMode(phase: TaskPhase, mode: TaskMode): TaskPhase {
  if (mode === 'developer') return phase;
  if (phase === 'new' || phase === 'done' || phase === 'analyzed' || phase === 'waiting-review') return phase;
  if (phase.startsWith('waiting-')) return 'waiting-review';
  return 'analyzed';
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}h`;
}

export default function TaskRecordPanel({ task, onOpenDetail }: TaskRecordPanelProps) {
  const { updateTask } = useApp();
  const [notes, setNotes] = useState(task.notes ?? '');
  const [statusNoteInput, setStatusNoteInput] = useState('');
  const overdue = task.dueAt ? isOverdue(task.dueAt, task.status) : false;
  const devopsUrl = task.devopsTaskUrl ?? task.adoContext?.workItemUrl ?? task.adoContext?.prUrl;
  const { mode: taskMode } = inferTaskMode(task);
  const phaseOptions = taskMode === 'developer' ? PHASE_OPTIONS : GENERAL_PHASE_OPTIONS;
  const taskPhase = phaseForMode(getTaskPhase(task), taskMode);
  const recentStatusNotes = getStatusNotes(task).slice(-3).reverse();

  useEffect(() => setNotes(task.notes ?? ''), [task.id, task.notes]);
  useEffect(() => setStatusNoteInput(''), [task.id]);

  const openEdge = (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(url);
  };

  async function saveNotes() {
    if (notes !== (task.notes ?? '')) await updateTask(task.id, { notes });
  }

  async function addStatusNote() {
    const text = statusNoteInput.trim();
    if (!text) return;
    setStatusNoteInput('');
    await updateTask(task.id, { history: buildStatusNoteHistory(task, text, new Date().toISOString()) });
  }

  async function setMode(mode: TaskMode) {
    const nextPhase = phaseForMode(getTaskPhase(task), mode);
    await updateTask(task.id, {
      taskMode: mode,
      ...(mode === 'general' ? applyTaskPhase(nextPhase) : {}),
    });
  }

  return (
    <div
      className="tip-panel"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="tip-section">
        <div className="tip-section-label">Očekávaný výsledek</div>
        <div className="tip-summary">
          {expectedOutcomeCzech(task)}
        </div>
      </div>

      <div className="tip-columns tip-columns--record">
        <div className="tip-col-main">
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

          <div className="tip-section">
            <div className="tip-section-label">Workflow type</div>
            <TaskModeSwitch task={task} onSetMode={setMode} />
          </div>

          <div className="tip-section">
            <div className="tip-section-label">Record status</div>
            <select
              className="form-select"
              value={taskPhase}
              onChange={(event) => void updateTask(task.id, applyTaskPhase(event.target.value as TaskPhase))}
            >
              {phaseOptions.map((option) => (
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
            {task.budgetHours !== undefined && (
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                Budget: {formatHours(task.budgetHours)}
              </div>
            )}
            {task.budgetNote && (
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                Budget note: {task.budgetNote}
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

        <div className="tip-col-side">
          <div className="tip-section tip-section--notes">
            <div className="tip-section-label">Notes</div>
            <textarea
              className="tip-notes"
              value={notes}
              placeholder="Add decisions, context, or reminders…"
              onChange={(event) => setNotes(event.target.value)}
              onBlur={() => void saveNotes()}
            />
          </div>

          <div className="tip-section">
            <div className="tip-section-label">Status update</div>
            <div style={{ display: 'flex', gap: 6 }}>
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
            {recentStatusNotes.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                {recentStatusNotes.map((entry) => (
                  <div key={entry.id} style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{entry.summary}</span>
                    {' · '}
                    {new Date(entry.at).toLocaleString()}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
