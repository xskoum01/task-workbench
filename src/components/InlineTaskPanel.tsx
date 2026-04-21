/**
 * InlineTaskPanel — compact task workbench that expands inline when a task is selected.
 *
 * Layout:
 *   ┌───────────────────────────┬─────────────────┐
 *   │  Analysis                 │  Notes          │
 *   │  (summary + next step)    │  (editable)     │
 *   │                           ├─────────────────┤
 *   │                           │  Actions        │
 *   ├───────────────────────────┴─────────────────┤
 *   │  Original message (collapsible, full width)  │
 *   └─────────────────────────────────────────────┘
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

const MSG_PREVIEW_LINES = 8;

export default function InlineTaskPanel({ task, onOpenDetail }: Props) {
  const { updateTask, getCustomerById } = useApp();
  const customer = getCustomerById(task.customerId);

  const [notes, setNotes]             = useState(task.notes ?? '');
  const [msgExpanded, setMsgExpanded] = useState(false);

  useEffect(() => {
    setNotes(task.notes ?? '');
    setMsgExpanded(false);
  }, [task.id]);

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
  const hasLinks = !!(task.devopsTaskUrl || task.ticketUrl || adoUrl || repoRoot);

  return (
    <div className="tip-panel" onClick={(e) => e.stopPropagation()}>

      {/* ── Two-column body ─────────────────────────────────────────────────── */}
      <div className="tip-body">

        {/* Left — Analysis */}
        <div className="tip-main">
          <div className="tip-card">
            <div className="tip-card-label">Analysis</div>
            {hasAnalysis ? (
              <>
                {czSummary && <p className="tip-analysis-text">{czSummary}</p>}
                {czNext && (
                  <div className="tip-nextstep">
                    <span className="tip-nextstep-pill">Další krok</span>
                    <span className="tip-nextstep-text">{czNext}</span>
                  </div>
                )}
                {enSummary && enSummary !== czSummary && (
                  <p className="tip-analysis-text tip-analysis-text--en">{enSummary}</p>
                )}
                {enNext && enNext !== czNext && (
                  <div className="tip-nextstep">
                    <span className="tip-nextstep-pill tip-nextstep-pill--en">Next step</span>
                    <span className="tip-nextstep-text">{enNext}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="tip-analysis-empty">
                No analysis yet.
                <button className="tip-link-btn" onClick={onOpenDetail}>Open Detail to run analysis.</button>
              </div>
            )}
          </div>
        </div>

        {/* Right — Notes + Actions */}
        <div className="tip-side">

          {/* Notes */}
          <div className="tip-card tip-card--notes">
            <div className="tip-card-label">Notes</div>
            <textarea
              className="tip-notes"
              value={notes}
              placeholder="Notes or context…"
              rows={3}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={handleNotesSave}
            />
          </div>

          {/* Actions */}
          <div className="tip-actions">
            {hasLinks && (
              <div className="tip-links">
                {adoUrl && (
                  <button className="tip-action-link" onClick={() => openUrl(adoUrl)} title={adoUrl}>
                    <Icon name="external-link" size={11} /> Open in DevOps
                  </button>
                )}
                {task.devopsTaskUrl && (
                  <button className="tip-action-link" onClick={() => openUrl(task.devopsTaskUrl)} title={task.devopsTaskUrl}>
                    <Icon name="external-link" size={11} /> DevOps task
                  </button>
                )}
                {task.ticketUrl && (
                  <button className="tip-action-link" onClick={() => openUrl(task.ticketUrl)} title={task.ticketUrl}>
                    <Icon name="external-link" size={11} /> Ticket
                  </button>
                )}
                {repoRoot && (
                  <button className="tip-action-link" onClick={() => tauriApi.openInVscode(repoRoot).catch(() => {})} title={repoRoot}>
                    <Icon name="terminal" size={11} /> VS Code
                  </button>
                )}
              </div>
            )}
            <div className="tip-primary">
              {task.status !== 'done' && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => updateTask(task.id, { status: 'done' })}
                >
                  <Icon name="check" size={12} /> Done
                </button>
              )}
              <button className="btn btn-secondary btn-sm" onClick={onOpenDetail}>
                Detail →
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Original message (full width, below grid) ───────────────────────── */}
      {msg && (
        <div className="tip-message-wrap">
          <div className="tip-card-label">Message</div>
          <div className="tip-message">
            <pre className="tip-message-body">{msgPreview}</pre>
            {needsExpand && (
              <button className="tip-expand-btn" onClick={() => setMsgExpanded((v) => !v)}>
                {msgExpanded ? '↑ Show less' : `↓ ${msgLines.length - MSG_PREVIEW_LINES} more lines`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
