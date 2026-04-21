/**
 * InlineTaskPanel — compact task workbench that expands inline when a task is selected.
 *
 * Layout:
 *   ┌──────────────────────────────┬──────────────────┐
 *   │  Analysis (or Analyze button)│  Notes           │
 *   ├──────────────────────────────┴──────────────────┤
 *   │  Links …                        Done   Detail → │
 *   ├─────────────────────────────────────────────────┤
 *   │  Message (collapsible, optional)                │
 *   └─────────────────────────────────────────────────┘
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
  const [analyzing, setAnalyzing]     = useState(false);

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

  return (
    <div className="tip-panel" onClick={(e) => e.stopPropagation()}>

      {/* ── Top row: Analysis | Notes ─────────────────────────────────────── */}
      <div className="tip-row">

        {/* Analysis */}
        <div className="tip-analysis-col">
          <div className="tip-sec-label">Analysis</div>
          {hasAnalysis ? (
            <>
              {czSummary && <p className="tip-analysis-text">{czSummary}</p>}
              {czNext && (
                <div className="tip-nextstep">
                  <span className="tip-nextstep-label">Další krok</span>
                  <span className="tip-nextstep-text">{czNext}</span>
                </div>
              )}
              {enSummary && enSummary !== czSummary && (
                <p className="tip-analysis-text tip-analysis-en">{enSummary}</p>
              )}
              {enNext && enNext !== czNext && (
                <div className="tip-nextstep">
                  <span className="tip-nextstep-label tip-nextstep-label--en">Next step</span>
                  <span className="tip-nextstep-text">{enNext}</span>
                </div>
              )}
            </>
          ) : (
            <div className="tip-no-analysis">
              <span className="tip-no-analysis-note">No analysis yet</span>
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

        {/* Notes */}
        <div className="tip-notes-col">
          <div className="tip-sec-label">Notes</div>
          <textarea
            className="tip-notes"
            value={notes}
            placeholder="Notes or context…"
            rows={3}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={handleNotesSave}
          />
        </div>
      </div>

      {/* ── Footer: links + primary actions ─────────────────────────────── */}
      <div className="tip-footer">
        <div className="tip-footer-links">
          {adoUrl && (
            <button className="tip-footer-link" onClick={() => openUrl(adoUrl)} title={adoUrl}>
              <Icon name="external-link" size={11} /> Open in DevOps
            </button>
          )}
          {task.devopsTaskUrl && (
            <button className="tip-footer-link" onClick={() => openUrl(task.devopsTaskUrl)} title={task.devopsTaskUrl}>
              <Icon name="external-link" size={11} /> DevOps task
            </button>
          )}
          {task.ticketUrl && (
            <button className="tip-footer-link" onClick={() => openUrl(task.ticketUrl)} title={task.ticketUrl}>
              <Icon name="external-link" size={11} /> Ticket
            </button>
          )}
          {repoRoot && (
            <button className="tip-footer-link" onClick={() => tauriApi.openInVscode(repoRoot).catch(() => {})} title={repoRoot}>
              <Icon name="terminal" size={11} /> VS Code
            </button>
          )}
        </div>
        <div className="tip-footer-actions">
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

      {/* ── Original message (collapsible) ──────────────────────────────── */}
      {msg && (
        <div className="tip-message-wrap">
          <div className="tip-sec-label">Message</div>
          <pre className="tip-message-body">{msgPreview}</pre>
          {needsExpand && (
            <button className="tip-expand-btn" onClick={() => setMsgExpanded((v) => !v)}>
              {msgExpanded ? '↑ Show less' : `↓ ${msgLines.length - MSG_PREVIEW_LINES} more lines`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
