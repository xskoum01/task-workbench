/**
 * InlineTaskPanel — compact 2-column workbench that expands inline when a task is selected.
 *
 * Layout:
 *   ┌──────────────────────────────┬──────────────────┐
 *   │  Analysis                    │  Notes (tall)    │
 *   ├──────────────────────────────┤──────────────────┤
 *   │  Message (collapsible)        │  Actions/Links   │
 *   └──────────────────────────────┴──────────────────┘
 */

import { useState, useEffect } from 'react';
import type { Task } from '../types';
import { useApp } from '../context/AppContext';
import Icon from './Icon';
import * as tauriApi from '../lib/tauriCommands';
import TaskEmailContent from './TaskEmailContent';
import TaskDevModePanel from './TaskDevModePanel';
import TaskModeSwitch from './TaskModeSwitch';
import { resolveTaskDevTarget, getPluginsDir } from '../lib/resolveTaskDevTarget';
import { buildTaskWorkflowPlan } from '../lib/workflowPlan';
import { inferTaskMode } from '../lib/taskMode';

interface Props {
  task: Task;
  onOpenDetail: () => void;
}

const MSG_PREVIEW_LINES = 8;

export default function InlineTaskPanel({ task, onOpenDetail }: Props) {
  const { updateTask, getCustomerById, deleteTask, settings } = useApp();
  const customer = getCustomerById(task.customerId);

  const [notes, setNotes]             = useState(task.notes ?? '');
  const [msgExpanded, setMsgExpanded] = useState(false);
  const [analyzing, setAnalyzing]     = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setNotes(task.notes ?? '');
    setMsgExpanded(false);
    setConfirmDelete(false);
  }, [task.id]);

  useEffect(() => {
    setNotes(task.notes ?? '');
  }, [task.notes]);

  async function handleNotesSave() {
    if (notes !== (task.notes ?? '')) {
      await updateTask(task.id, { notes });
    }
  }

  async function handleSetMode(mode: 'developer' | 'general') {
    await updateTask(task.id, { taskMode: mode });
  }

  function openUrl(url: string | undefined) {
    if (!url) return;
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    tauriApi.openUrl(href).catch(() => window.open(href, '_blank', 'noopener,noreferrer'));
  }

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      const result = await tauriApi.analyzeTask(task, customer ?? null);
      await updateTask(task.id, { analysisResult: result, status: 'analyzed' });
    } finally {
      setAnalyzing(false);
    }
  }
  // ── Analysis ────────────────────────────────────────────────────────────────
  const r           = task.analysisResult;
  const czSummary   = r?.summaryCz?.trim();
  const czNext      = r?.nextStepCz?.trim();
  const enSummary   = (r?.summaryEn ?? r?.summary)?.trim();
  const enNext      = (r?.nextStepEn ?? r?.nextStep)?.trim();
  const hasAnalysis = !!(czSummary || enSummary);

  // ── Original message ────────────────────────────────────────────────────────
  const msg         = task.originalMessage ?? '';
  const msgLines    = msg.split('\n');
  const needsExpand = msgLines.length > MSG_PREVIEW_LINES;
  const msgPreview  = needsExpand && !msgExpanded
    ? msgLines.slice(0, MSG_PREVIEW_LINES).join('\n')
    : msg;

  // ── Action links ────────────────────────────────────────────────────────────
  const adoUrl   = task.adoContext?.workItemUrl || task.adoContext?.prUrl;
  const repoRoot = customer?.repositoryRoot;
  const crmFolderPath = (settings?.crmBaseDirectory && customer?.folderName)
    ? `${settings.crmBaseDirectory}/${customer.folderName}`
    : undefined;
  const heuristicDevTarget   = resolveTaskDevTarget(task, customer, crmFolderPath);
  const devTarget = task.workflowSetup?.devTargetKind
    ? { ...heuristicDevTarget, kind: task.workflowSetup.devTargetKind as typeof heuristicDevTarget.kind }
    : heuristicDevTarget;
  const effectiveVscodePath = devTarget.path;
  const pluginsDir       = getPluginsDir(customer, crmFolderPath);
  const repoRootForGit   = customer?.resolvedRepositoryPath ?? customer?.repositoryRoot;
  const hasRepo          = !!repoRoot;
  const hasVscodePath    = !!effectiveVscodePath;
  // Centralized workflow plan — pass heuristic kind for backward compat with unconfirmed tasks
  const plan = buildTaskWorkflowPlan(task, heuristicDevTarget.kind);
  const { mode: effectiveMode } = inferTaskMode(task);
  // Use the same resolver as TaskDetail for consistent branching.
  const isScriptTask = devTarget.kind === 'script';
  const showOpenRepo = !!(repoRoot && isScriptTask);
  // Is this an email-sourced task that should use rich email rendering?
  const isEmailTask = !!(task.emailBodyHtml || task.senderName || task.senderEmail);

  return (
    <div className="tip-panel" onClick={(e) => e.stopPropagation()}>
      <div className="tip-columns">

        {/* ────── Left column: Message + Analysis ────── */}
        <div className="tip-col-main">

          {/* Message */}
          {isEmailTask ? (
            <div className="tip-section">
              <div className="tip-sec-label">Message</div>
              <TaskEmailContent task={task} />
            </div>
          ) : msg ? (
            <div className="tip-section">
              <div className="tip-sec-label">Message</div>
              <pre className="tip-message-body">{msgPreview}</pre>
              {needsExpand && (
                <button className="tip-expand-btn" onClick={() => setMsgExpanded((v) => !v)}>
                  {msgExpanded ? '↑ Show less' : `↓ ${msgLines.length - MSG_PREVIEW_LINES} more lines…`}
                </button>
              )}
            </div>
          ) : null}

          {/* Analysis */}
          <div className="tip-section">
            <div className="tip-sec-label">Analysis</div>
            {hasAnalysis ? (
              <div className="tip-analysis-body">
                {czSummary
                  ? <p className="tip-content-text">{czSummary}</p>
                  : enSummary && <p className="tip-content-text">{enSummary}</p>
                }
                {(czNext || enNext) && (
                  <div className="tip-nextstep">
                    <span className="tip-nextstep-label">Další krok</span>
                    <span className="tip-nextstep-text">{czNext ?? enNext}</span>
                  </div>
                )}
                <div>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={analyzing}
                    onClick={handleAnalyze}
                  >
                    <Icon name="search" size={12} />
                    {analyzing ? 'Analyzing…' : 'Re-analyze'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="tip-empty-state">
                <p className="tip-empty-text">No analysis yet. Run AI analysis to get a summary and suggested next step.</p>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={analyzing}
                  onClick={handleAnalyze}
                >
                  <Icon name="search" size={12} />
                  {analyzing ? 'Analyzing…' : 'Analyze'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ────── Right column: Notes + Actions ────── */}
        <div className="tip-col-side">

          {/* Actions */}
          <div className="tip-section tip-section--actions">

            {/* External links */}
            {(adoUrl || task.devopsTaskUrl || task.ticketUrl || showOpenRepo) && (
              <div className="tip-action-group">
                <div className="tip-group-label">Links</div>
                <div className="tip-action-list">
                  {adoUrl && (
                    <button className="tip-action-btn" onClick={() => openUrl(adoUrl)} title={adoUrl}>
                      <Icon name="external-link" size={11} /> Open in DevOps
                    </button>
                  )}
                  {task.devopsTaskUrl && (
                    <button className="tip-action-btn" onClick={() => openUrl(task.devopsTaskUrl)} title={task.devopsTaskUrl}>
                      <Icon name="external-link" size={11} /> DevOps task
                    </button>
                  )}
                  {task.ticketUrl && (
                    <button className="tip-action-btn" onClick={() => openUrl(task.ticketUrl)} title={task.ticketUrl}>
                      <Icon name="external-link" size={11} /> Ticket
                    </button>
                  )}
                  {showOpenRepo && (
                    <button className="tip-action-btn" onClick={() => tauriApi.openPath(repoRoot!).catch(() => {})} title={repoRoot}>
                      <Icon name="folder" size={11} /> Open Repository
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Task mode switch */}
            <div className="tip-action-group">
              <div className="tip-group-label">Mode</div>
              <TaskModeSwitch task={task} onSetMode={handleSetMode} />
            </div>

            {/* Developer awaiting setup prompt */}
            {effectiveMode === 'developer' && plan.isDeveloperAwaitingSetup && (
              <div className="tip-action-group">
                <div className="tip-group-label">Development</div>
                <div className="tip-dev-setup-prompt">
                  <span className="tip-dev-setup-text">Choose Plugin or Script target to enable developer tools.</span>
                  <button className="btn btn-secondary btn-sm" onClick={onOpenDetail}>
                    Confirm developer setup →
                  </button>
                </div>
              </div>
            )}

            {/* Development */}
            {effectiveMode === 'developer' && (hasRepo || hasVscodePath) && plan.requiresDevTools && (
              <div className="tip-action-group">
                <div className="tip-group-label">Development</div>
                <TaskDevModePanel
                  task={task}
                  customer={customer}
                  pluginsDir={pluginsDir}
                  repoRootForGit={repoRootForGit}
                  defaultMode={devTarget.kind === 'plugin' ? 'plugin' : 'script'}
                  scriptOpenPath={task.workflowSetup?.scriptPath ?? customer?.scriptFolder ?? effectiveVscodePath}
                  onError={() => {}}
                  autoCollapsed={false}
                  selectedPluginProject={task.workflowSetup?.pluginProject ?? task.selectedPluginProject}
                  onSelectedPluginChange={(plugin) =>
                    updateTask(task.id, { selectedPluginProject: plugin || undefined }).catch(() => {})
                  }
                  reviewerConfigs={plan.requiresAiFileReview ? settings.aiReviewers : undefined}
                />
              </div>
            )}

            {/* AI Code Review indicator — shown when a saved review exists */}
            {task.aiFileReviews?.[0] && (() => {
              const r = task.aiFileReviews![0];
              const VERDICT_COLOR: Record<string, string> = {
                pass: '#3fb950', comment: '#388bfd', needs_changes: '#d29922',
              };
              const VERDICT_LABEL: Record<string, string> = {
                pass: 'Bez připomínek', comment: 'Komentář', needs_changes: 'Vyžaduje úpravy',
              };
              const verdict = r.structured?.verdict;
              return (
                <div style={{ padding: '3px 8px', fontSize: 11, color: 'var(--text-muted)',
                  display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ color: 'var(--text-muted)' }}>AI recenze:</span>
                  {verdict ? (
                    <span style={{ color: VERDICT_COLOR[verdict] ?? 'var(--text-muted)', fontWeight: 600 }}>
                      {VERDICT_LABEL[verdict] ?? verdict}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>k dispozici</span>
                  )}
                </div>
              );
            })()}

            {/* Task actions */}
            <div className="tip-action-group">
              <div className="tip-group-label">Task</div>
              <div className="tip-primary-btns">
                {task.status !== 'done' && (
                  <button
                    className="btn btn-accent btn-sm"
                    onClick={() => updateTask(task.id, { status: 'done' })}
                  >
                    <Icon name="check" size={12} /> Done
                  </button>
                )}
                <button className="btn btn-secondary btn-sm" onClick={onOpenDetail}>
                  Detail →
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
            <textarea
              className="tip-notes"
              value={notes}
              placeholder="Notes, context, reminders…"
              onChange={(e) => setNotes(e.target.value)}
              onBlur={handleNotesSave}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
