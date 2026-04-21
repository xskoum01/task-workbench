/**
 * InlineTaskPanel — compact task workbench that expands inline when a task is selected.
 *
 * Shows:
 *  1. AI analysis (summary + next step, CZ and/or EN)
 *  2. Notes (editable, auto-saved on blur)
 *  3. Original message (truncated, expandable)
 *  4. Action links — DevOps URL, ticket URL, VS Code — only when available
 *  5. Quick controls: Mark Done, Detail (opens full TaskDetail)
 */

import { useState, useEffect } from 'react';
import type { Task } from '../types';
import { useApp } from '../context/AppContext';
import Icon from './Icon';
import * as tauriApi from '../lib/tauriCommands';

interface Props {
  task: Task;
  onOpenDetail: () => void;
}

const MSG_PREVIEW_LINES = 10;

export default function InlineTaskPanel({ task, onOpenDetail }: Props) {
  const { updateTask, getCustomerById } = useApp();
  const customer = getCustomerById(task.customerId);

  // Notes — local state saved on blur
  const [notes, setNotes]             = useState(task.notes ?? '');
  const [msgExpanded, setMsgExpanded] = useState(false);

  // Re-sync when the selected task changes
  useEffect(() => {
    setNotes(task.notes ?? '');
    setMsgExpanded(false);
  }, [task.id]);

  // Keep notes in sync when saved externally (e.g. from TaskDetail)
  useEffect(() => {
    setNotes(task.notes ?? '');
  }, [task.notes]);

  async function handleNotesSave() {
    if (notes !== (task.notes ?? '')) {
      await updateTask(task.id, { notes });
    }
  }

  function openUrl(url: string | undefined) {
    if (!url) return;
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    tauriApi.openUrl(href).catch(() => window.open(href, '_blank', 'noopener,noreferrer'));
  }

  // ---------------------------------------------------------------------------
  // Analysis — compact CZ + EN
  // ---------------------------------------------------------------------------
  const r         = task.analysisResult;
  const czSummary = r?.summaryCz?.trim();
  const czNext    = r?.nextStepCz?.trim();
  const enSummary = (r?.summaryEn ?? r?.summary)?.trim();
  const enNext    = (r?.nextStepEn ?? r?.nextStep)?.trim();
  const hasAnalysis = !!(czSummary || enSummary);

  // ---------------------------------------------------------------------------
  // Original message — truncated preview
  // ---------------------------------------------------------------------------
  const msg = task.originalMessage ?? '';
  const msgLines = msg.split('\n');
  const needsExpand = msgLines.length > MSG_PREVIEW_LINES;
  const msgPreview  = needsExpand && !msgExpanded
    ? msgLines.slice(0, MSG_PREVIEW_LINES).join('\n')
    : msg;

  // ---------------------------------------------------------------------------
  // Action links — only render what exists
  // ---------------------------------------------------------------------------
  const adoUrl    = task.adoContext?.workItemUrl || task.adoContext?.prUrl;
  const repoRoot  = customer?.repositoryRoot;
  const hasLinks  = !!(task.devopsTaskUrl || task.ticketUrl || adoUrl || repoRoot);

  return (
    <div className="task-inline-panel" onClick={(e) => e.stopPropagation()}>

      {/* ---- AI analysis ---- */}
      <div className="tip-section">
        <span className="tip-label">Analysis</span>
        {hasAnalysis ? (
          <div className="tip-analysis">
            {czSummary && <p className="tip-analysis-summary">{czSummary}</p>}
            {czNext    && (
              <div className="tip-analysis-next">
                <span className="tip-next-label">Další krok</span>
                {czNext}
              </div>
            )}
            {/* Show EN only when it differs from CZ */}
            {enSummary && enSummary !== czSummary && (
              <p className="tip-analysis-summary tip-analysis-summary--en">{enSummary}</p>
            )}
            {enNext && enNext !== czNext && (
              <div className="tip-analysis-next">
                <span className="tip-next-label">Next step</span>
                {enNext}
              </div>
            )}
          </div>
        ) : (
          <span className="tip-empty">No analysis yet — open Detail to run analysis.</span>
        )}
      </div>

      {/* ---- Notes ---- */}
      <div className="tip-section">
        <span className="tip-label">Notes</span>
        <textarea
          className="tip-notes"
          value={notes}
          placeholder="Write notes, context, or reminders…"
          rows={3}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={handleNotesSave}
        />
      </div>

      {/* ---- Original message ---- */}
      {msg && (
        <div className="tip-section">
          <span className="tip-label">Message</span>
          <div className="tip-message">
            <pre className="tip-message-body">{msgPreview}</pre>
            {needsExpand && (
              <button
                className="tip-expand-btn"
                onClick={() => setMsgExpanded((v) => !v)}
              >
                {msgExpanded ? 'Show less' : `Show more (${msgLines.length - MSG_PREVIEW_LINES} more lines)`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ---- Bottom action row ---- */}
      <div className="tip-action-row">
        {/* Context links — only shown when URLs exist */}
        {hasLinks && (
          <div className="tip-links">
            {adoUrl && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => openUrl(adoUrl)}
                title={adoUrl}
              >
                <Icon name="external-link" size={12} /> Open in DevOps
              </button>
            )}
            {task.devopsTaskUrl && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => openUrl(task.devopsTaskUrl)}
                title={task.devopsTaskUrl}
              >
                <Icon name="external-link" size={12} /> DevOps task
              </button>
            )}
            {task.ticketUrl && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => openUrl(task.ticketUrl)}
                title={task.ticketUrl}
              >
                <Icon name="external-link" size={12} /> Ticket
              </button>
            )}
            {repoRoot && (
              <button
                className="btn btn-ghost btn-sm"
                title={`Open ${repoRoot} in VS Code`}
                onClick={() => tauriApi.openInVscode(repoRoot).catch(() => {})}
              >
                <Icon name="terminal" size={12} /> VS Code
              </button>
            )}
          </div>
        )}

        {/* Right-side primary actions */}
        <div className="tip-primary-actions">
          {task.status !== 'done' && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => updateTask(task.id, { status: 'done' })}
              title="Mark as done"
            >
              <Icon name="check" size={12} /> Done
            </button>
          )}
          <button
            className="btn btn-secondary btn-sm"
            onClick={onOpenDetail}
          >
            Detail
          </button>
        </div>
      </div>
    </div>
  );
}
