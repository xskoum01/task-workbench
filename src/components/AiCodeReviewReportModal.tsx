/**
 * AiCodeReviewReportModal
 *
 * Read-only "Open report" viewer for AI Code Review results, regardless of whether the review was
 * produced by a native Task Workbench reviewer (aiFileReviews entry with structured comments) or
 * by Claude through MCP record_ai_kit_review_result (canonical implementationVerification.aiCodeReview
 * detail only). Renders the AiCodeReviewReport view-model built by buildAiCodeReviewReport
 * (src/lib/aiCodeReviewReport.ts). Purely presentational — never starts a review, changes the gate,
 * or mutates task data.
 */
import type { AiCodeReviewReport } from '../lib/aiCodeReviewReport';
import type { ImplCheckStatus } from '../types';
import Modal from './Modal';
import AiReviewResultView from './AiReviewResultView';

function statusColor(s: ImplCheckStatus): string {
  switch (s) {
    case 'passed':           return 'var(--color-done, #3fb950)';
    case 'warnings':         return 'var(--color-warning, #d29922)';
    case 'failed':           return 'var(--color-blocked, #e05555)';
    case 'skipped':          return 'var(--text-muted)';
    case 'manually-verified':return 'var(--color-done, #3fb950)';
    default:                 return 'var(--text-muted)';
  }
}

function statusLabel(s: ImplCheckStatus): string {
  switch (s) {
    case 'passed':            return 'Passed';
    case 'warnings':          return 'Warnings';
    case 'failed':             return 'Failed';
    case 'skipped':            return 'Skipped';
    case 'manually-verified':  return 'Manually verified';
    default:                   return 'Not run';
  }
}

function DetailList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ fontSize: 11.5 }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--text-secondary)' }}>
        {items.map((item, i) => <li key={i}>{item}</li>)}
      </ul>
    </div>
  );
}

interface Props {
  report: AiCodeReviewReport;
  /** Opens the reviewed file/project on disk. Only wired when the report has a resolvable path. */
  onOpenFile?: (filePath: string) => void;
  onClose: () => void;
}

export default function AiCodeReviewReportModal({ report, onOpenFile, onClose }: Props) {
  const skippedItemLabels = report.skippedItems.map((it) =>
    typeof it === 'string' ? it : `${it.item}${it.reason ? ` — ${it.reason}` : ''}`,
  );
  const fixableFindingLabels = report.fixableFindings.map((f) => f.description);

  return (
    <Modal
      title="AI Code Review Report"
      size="xl"
      onClose={onClose}
      footer={
        <button className="btn btn-secondary btn-sm" onClick={onClose} type="button">Close</button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Header: source, status, timestamp */}
        <div style={{
          border: '1px solid var(--border-subtle)', borderRadius: 5, background: 'var(--bg-overlay)',
          padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
            {report.sourceLabel}
          </span>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: statusColor(report.status) }}>
            {statusLabel(report.status)}
          </span>
          {report.reviewedAt && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {new Date(report.reviewedAt).toLocaleString()}
            </span>
          )}
        </div>

        {report.summary && (
          <div style={{
            border: '1px solid var(--border-subtle)', borderRadius: 4, background: 'var(--bg-surface)',
            padding: '8px 12px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5,
          }}>
            {report.summary}
          </div>
        )}

        {/* Native review detail — structured comments, line references, markdown, suggestions */}
        {report.native && (report.native.structured || report.native.markdown) && (
          <AiReviewResultView
            structured={report.native.structured}
            markdown={report.native.markdown}
            onOpenFile={onOpenFile}
          />
        )}

        {/* Canonical detail — always sourced from implementationVerification.aiCodeReview */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <DetailList label="Reviewed files" items={report.reviewedFiles} />
          <DetailList label="Rules files" items={report.rulesFiles} />
          <DetailList label="Checklist files" items={report.checklistFiles} />
          <DetailList label="Known PR review files" items={report.knownPrReviewFiles} />
          <DetailList label="Checked items" items={report.checkedItems} />
          <DetailList label="Skipped items" items={skippedItemLabels} />
          <DetailList label="Findings" items={report.findings} />
          {fixableFindingLabels.length > 0 && (
            <div style={{ fontSize: 11.5 }}>
              <div style={{ color: 'var(--color-blocked, #e05555)', marginBottom: 2 }}>Fixable findings</div>
              <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--color-blocked, #e05555)' }}>
                {fixableFindingLabels.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}
          {report.nonFixableWarnings.length > 0 && (
            <div style={{ fontSize: 11.5 }}>
              <div style={{ color: 'var(--color-warning, #d29922)', marginBottom: 2 }}>Non-fixable warnings</div>
              <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--color-warning, #d29922)' }}>
                {report.nonFixableWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
