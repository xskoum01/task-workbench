/**
 * InlineTaskPanel - compact inline card shown when a task row is expanded.
 */

import { useState, useEffect } from 'react';
import type { Task } from '../types';
import { useApp } from '../context/AppContext';
import Icon from './Icon';
import * as tauriApi from '../lib/tauriCommands';
import TaskEmailContent from './TaskEmailContent';
import TaskModeSwitch from './TaskModeSwitch';
import { TYPE_LABELS } from './StatusBadge';
import { formatTaskActivityNotes, splitTaskNotes } from '../lib/taskActivityFormatter';
import { type TaskPhase, PHASE_OPTIONS, getTaskPhase, applyTaskPhase } from '../lib/taskPhase';
import { taskHasResettableWorkflowState, resetTaskWorkflowToNew } from '../lib/taskWorkflowReset';
import ResetWorkflowConfirmModal from './ResetWorkflowConfirmModal';

interface Props {
  task: Task;
  onOpenDetail: () => void;
}

function deriveDevClassification(task: Task): string | null {
  const kind = task.workflowSetup?.devTargetKind;
  const intent = task.workflowSetup?.workIntent;
  if (!kind) return null;
  if (kind === 'plugin') {
    if (intent === 'create') return 'New plugin';
    if (intent === 'update' || intent === 'fix') return 'Existing plugin update';
    if (intent === 'review') return 'Plugin review';
    return 'Plugin';
  }
  if (kind === 'script') {
    if (intent === 'create') return 'New script';
    if (intent === 'update' || intent === 'fix') return 'Existing script update';
    if (intent === 'review') return 'Script review';
    return 'Script';
  }
  if (kind === 'repo') return 'Repository change';
  return null;
}

function sourceLabel(task: Task): string {
  if (task.workItemSource === 'azure_devops') return 'Azure DevOps';
  if (task.workItemSource === 'helpdesk') return 'Helpdesk';
  if (task.source === 'email') return 'Email';
  if (task.source === 'teams') return 'Teams';
  return 'Manual';
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function InlineTaskPanel({ task, onOpenDetail }: Props) {
  const { updateTask, getCustomerById, deleteTask } = useApp();
  const customer = getCustomerById(task.customerId);

  const [notes, setNotes]               = useState(task.notes ?? '');
  const [msgExpanded, setMsgExpanded]   = useState(false);
  const [analyzing, setAnalyzing]       = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linkError, setLinkError]       = useState<string | null>(null);
  const [resetConfirmBusy, setResetConfirmBusy] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  useEffect(() => {
    setNotes(task.notes ?? '');
    setMsgExpanded(false);
    setConfirmDelete(false);
    setLinkError(null);
    setShowResetConfirm(false);
  }, [task.id]);

  useEffect(() => {
    setNotes(task.notes ?? '');
  }, [task.notes]);

  const splitNotes = splitTaskNotes(notes);
  const activityItems = formatTaskActivityNotes(splitNotes.activityLines);
  const latestActivity = activityItems[activityItems.length - 1];

  async function handleNotesSave() {
    if (notes !== (task.notes ?? '')) {
      await updateTask(task.id, { notes });
    }
  }

  async function handleSetMode(mode: 'developer' | 'general') {
    await updateTask(task.id, { taskMode: mode });
  }

  async function handleSetPhase(phase: TaskPhase) {
    // Selecting NEW on a task that still carries workflow state requires explicit confirmation
    // before the canonical reset (src/lib/taskWorkflowReset.ts) is applied — see handleConfirmReset.
    if (phase === 'new' && taskHasResettableWorkflowState(task)) {
      setShowResetConfirm(true);
      return;
    }
    await updateTask(task.id, applyTaskPhase(phase));
  }

  async function handleConfirmReset() {
    setResetConfirmBusy(true);
    try {
      await updateTask(task.id, resetTaskWorkflowToNew(task));
    } finally {
      setResetConfirmBusy(false);
      setShowResetConfirm(false);
    }
  }

  async function handleOpenExternalUrl(url: string | undefined) {
    if (!url) return;
    setLinkError(null);
    try {
      await tauriApi.openExternalUrl(url);
    } catch (err) {
      setLinkError(String(err));
    }
  }

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      const result = await tauriApi.analyzeTask(task, customer ?? null);
      await updateTask(task.id, { analysisResult: result, status: 'analyzed', waitingState: null, attentionState: null });
    } finally {
      setAnalyzing(false);
    }
  }  // Derived display values
  const r         = task.analysisResult;
  const summary   = r?.summaryCz?.trim() || r?.summaryEn?.trim() || r?.summary?.trim();
  const devClass  = deriveDevClassification(task);
  const taskPhase = getTaskPhase(task);

  const adoUrl  = task.adoContext?.workItemUrl || task.adoContext?.prUrl;
  const hasMsg  = !!(task.originalMessage || task.emailBodyHtml || task.senderName);
  const isEmail = !!(task.emailBodyHtml || task.senderName || task.senderEmail);

  return (
    <>
    <div className="tip-panel" onClick={(e) => e.stopPropagation()}>
      <div className="tip-columns">        {/* Left column: compact summary + collapsible message */}
        <div className="tip-col-main">

          {/* Compact summary card */}
          <div className="tip-section tip-section--summary">
            <div className="tip-summary-meta">
              <span className="tip-meta-badge tip-meta-badge--source">{sourceLabel(task)}</span>
              <span className="tip-meta-badge tip-meta-badge--type">{TYPE_LABELS[task.taskType]}</span>
              {customer && (
                <span className="tip-meta-customer">{customer.name}</span>
              )}
            </div>

            {task.estimatedEffort !== undefined && (
              <div className="tip-summary-row">
                <span className="tip-summary-label">Estimate</span>
                <span className="tip-summary-value">
                  {task.estimatedEffort < 1
                    ? `${Math.round(task.estimatedEffort * 60)}m`
                    : `${task.estimatedEffort}h`}
                </span>
              </div>
            )}

            {devClass && (
              <div className="tip-summary-row">
                <span className="tip-summary-label">Dev type</span>
                <span className="tip-summary-value">{devClass}</span>
              </div>
            )}

            {summary && (
              <p className="tip-summary-text">{summary}</p>
            )}
          </div>

          {/* Collapsible original message */}
          {hasMsg && (
            <div className="tip-section tip-section--msg">
              <button
                className="tip-expand-btn"
                onClick={() => setMsgExpanded((v) => !v)}
              >
                {msgExpanded ? 'Hide original message' : 'Show original message'}
              </button>
              {msgExpanded && (
                isEmail ? (
                  <TaskEmailContent task={task} />
                ) : (
                  <pre className="tip-message-body">{task.originalMessage}</pre>
                )
              )}
            </div>
          )}
        </div>        {/* Right column: phase + mode + links + actions + notes */}
        <div className="tip-col-side">

          <div className="tip-section tip-section--actions">

            {/* Phase selector */}
            <div className="tip-action-group">
              <div className="tip-group-label">Task phase</div>
              <select
                className="form-select tip-phase-select"
                value={taskPhase}
                onChange={(e) => handleSetPhase(e.target.value as TaskPhase)}
                title="Set task lifecycle phase"
              >
                {PHASE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {/* Mode switch */}
            <div className="tip-action-group">
              <div className="tip-group-label">Mode</div>
              <TaskModeSwitch task={task} onSetMode={handleSetMode} />
            </div>

            {/* External links */}
            {(adoUrl || task.devopsTaskUrl || task.ticketUrl || task.sourceUrl) && (
              <div className="tip-action-group">
                <div className="tip-group-label">Links</div>
                <div className="tip-action-list">
                  {adoUrl && (
                    <button className="tip-action-btn" onClick={() => handleOpenExternalUrl(adoUrl)} title={adoUrl}>
                      <Icon name="external-link" size={11} /> Open in DevOps
                    </button>
                  )}
                  {task.devopsTaskUrl && (
                    <button className="tip-action-btn" onClick={() => handleOpenExternalUrl(task.devopsTaskUrl)} title={task.devopsTaskUrl}>
                      <Icon name="external-link" size={11} /> DevOps task
                    </button>
                  )}
                  {task.ticketUrl && (
                    <button className="tip-action-btn" onClick={() => handleOpenExternalUrl(task.ticketUrl)} title={task.ticketUrl}>
                      <Icon name="external-link" size={11} /> Ticket
                    </button>
                  )}
                  {task.sourceUrl && (
                    <button className="tip-action-btn" onClick={() => handleOpenExternalUrl(task.sourceUrl)} title={task.sourceUrl}>
                      <Icon name="external-link" size={11} /> Source message
                    </button>
                  )}
                </div>
                {linkError && (
                  <div className="detail-devmode-hint" style={{ color: 'var(--color-blocked)' }}>
                    {linkError}
                  </div>
                )}
              </div>
            )}

            {/* Primary task actions */}
            <div className="tip-action-group">
              <div className="tip-group-label">Task</div>
              <div className="tip-primary-btns">
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={analyzing}
                  onClick={handleAnalyze}
                >
                  <Icon name="search" size={12} />
                  {analyzing ? 'Analyzing...' : 'Analyze'}
                </button>
                {task.status !== 'done' && (
                  <button
                    className="btn btn-accent btn-sm"
                    onClick={() => updateTask(task.id, { status: 'done', waitingState: null, attentionState: null })}
                  >
                    <Icon name="check" size={12} /> Done
                  </button>
                )}
                <button className="btn btn-secondary btn-sm" onClick={onOpenDetail}>
                  Detail {'->'}
                </button>
                {confirmDelete ? (
                  <span className="tip-delete-confirm" onClick={(e) => e.stopPropagation()}>
                    <span className="tip-delete-confirm-label">Delete?</span>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={(e) => { e.stopPropagation(); deleteTask(task.id); }}
                    >
                      Yes
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                    >
                      No
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn btn-ghost btn-sm tip-delete-btn"
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                    title="Delete this task"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="tip-section tip-section--notes">
            <div className="tip-sec-label">Notes</div>
            {splitNotes.manualNotes.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {splitNotes.manualNotes.map((note, index) => (
                  <div key={`${index}-${note}`} style={{ border: '1px solid var(--border-subtle)', borderRadius: 4, background: 'var(--bg-overlay)', padding: '6px 8px', fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                    {note}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>No manual notes.</div>
            )}
            <details style={{ marginTop: 7 }}>
              <summary style={{ cursor: 'pointer', fontSize: 10.5, color: 'var(--text-muted)' }}>Raw notes editor</summary>
              <textarea
                className="tip-notes"
                value={notes}
                placeholder="Notes, context, reminders..."
                onChange={(e) => setNotes(e.target.value)}
                onBlur={handleNotesSave}
                style={{ marginTop: 6 }}
              />
            </details>
          </div>

          {activityItems.length > 0 && (
            <div className="tip-section tip-section--notes">
              <details>
                <summary style={{ cursor: 'pointer' }}>
                  <span className="tip-sec-label" style={{ display: 'inline' }}>Activity Log ({activityItems.length})</span>
                  {latestActivity && (
                    <span style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--text-muted)' }}>
                      {[latestActivity.timestampLabel, latestActivity.message].filter(Boolean).join(' | ')}
                    </span>
                  )}
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 7 }}>
                  {activityItems.map((item) => (
                    <div key={item.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 4, background: 'var(--bg-overlay)', padding: '6px 8px' }}>
                      {(item.timestampLabel || item.source) && (
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 2 }}>
                          {[item.timestampLabel, item.source].filter(Boolean).join(' | ')}
                        </div>
                      )}
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{item.message}</div>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
    {showResetConfirm && (
      <ResetWorkflowConfirmModal
        onConfirm={handleConfirmReset}
        onCancel={() => setShowResetConfirm(false)}
        busy={resetConfirmBusy}
      />
    )}
    </>
  );
}
