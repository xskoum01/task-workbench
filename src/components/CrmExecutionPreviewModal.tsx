import type { CrmExternalExecutionPreview } from '../lib/crmDeveloperWorkflow';
import Icon from './Icon';

interface CrmExecutionPreviewModalProps {
  preview: CrmExternalExecutionPreview;
  onClose: () => void;
}

function formatDate(value: string | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

function RiskBadge({ level }: { level: string }) {
  return (
    <span className={`crm-preview-risk crm-preview-risk--${level}`}>
      {level} risk
    </span>
  );
}

function PayloadRow({ label, value }: { label: string; value: string | string[] | undefined }) {
  if (!value || (Array.isArray(value) && value.length === 0)) return null;
  const text = Array.isArray(value) ? value.join(', ') : value;
  return (
    <div className="crm-preview-payload-row">
      <span className="crm-preview-payload-key">{label}:</span>
      <span className="crm-preview-payload-val">{text}</span>
    </div>
  );
}

export default function CrmExecutionPreviewModal({ preview, onClose }: CrmExecutionPreviewModalProps) {
  return (
    <div className="crm-preview-overlay" role="dialog" aria-modal="true" aria-label="Execution preview">
      <div className="crm-preview-modal">

        <div className="crm-preview-modal-header">
          <div>
            <div className="crm-preview-modal-title">Execution Preview</div>
            <div className="crm-preview-modal-subtitle">{preview.taskTitle}</div>
          </div>
          <button className="btn btn-secondary btn-sm" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="crm-preview-notice">
          <Icon name="alert-triangle" size={14} />
          <span>
            Preview only — nothing will be executed. This modal shows what a future execution step would do.
            No plugins will be registered, no web resources uploaded, no Dataverse changes made,
            no customizations published, no commits created, and no pull requests opened.
          </span>
        </div>

        <div className="crm-preview-gates">
          <div className="crm-preview-gates-title">Approved gates</div>
          <div className="crm-preview-gates-row">
            <span className={`crm-preview-gate ${preview.planApprovedAt ? 'crm-preview-gate--ok' : 'crm-preview-gate--missing'}`}>
              {preview.planApprovedAt
                ? `Technical plan approved ${formatDate(preview.planApprovedAt)}`
                : 'Technical plan not approved'}
            </span>
            <span className={`crm-preview-gate ${preview.diffApprovedAt ? 'crm-preview-gate--ok' : 'crm-preview-gate--missing'}`}>
              {preview.diffApprovedAt
                ? `Diff approved ${formatDate(preview.diffApprovedAt)}`
                : 'Diff not approved'}
            </span>
            <span className={`crm-preview-gate ${preview.externalActionApprovedAt ? 'crm-preview-gate--ok' : 'crm-preview-gate--missing'}`}>
              {preview.externalActionApprovedAt
                ? `External action approved ${formatDate(preview.externalActionApprovedAt)}`
                : 'External action not approved'}
            </span>
          </div>
        </div>

        {preview.verificationVerdict && preview.verificationVerdict !== 'pass' && (
          <div className={`crm-preview-verification-banner crm-preview-verification-banner--${preview.verificationVerdict}`}>
            <Icon name="alert-triangle" size={13} />
            <span>
              Dataverse metadata verification: <strong>{preview.verificationVerdict.toUpperCase()}</strong>.
              {preview.verificationVerdict === 'fail'
                ? ' Issues must be resolved or explicitly accepted before any future execution.'
                : ' Review warnings before any future execution.'}
            </span>
          </div>
        )}

        {preview.globalBlockers.length > 0 && (
          <div className="crm-preview-global-blockers">
            <div className="crm-preview-section-label">Approval blockers</div>
            <ul className="crm-preview-list">
              {preview.globalBlockers.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        )}

        {preview.globalWarnings.length > 0 && (
          <div className="crm-preview-global-warnings">
            <div className="crm-preview-section-label">Warnings</div>
            <ul className="crm-preview-list">
              {preview.globalWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        <div className="crm-preview-entries">
          {preview.entries.map((entry) => (
            <div key={entry.proposalId} className={`crm-preview-entry crm-preview-entry--${entry.riskLevel}`}>
              <div className="crm-preview-entry-header">
                <div>
                  <div className="crm-preview-entry-title">{entry.title}</div>
                  <div className="crm-preview-entry-type">{entry.proposalType.replace(/-/g, ' ')}</div>
                </div>
                <RiskBadge level={entry.riskLevel} />
              </div>

              <div className="crm-preview-entry-desc">{entry.description}</div>

              {entry.blockedReason && (
                <div className="crm-preview-entry-blocked">Blocked: {entry.blockedReason}</div>
              )}

              {entry.warnings.length > 0 && (
                <div className="crm-preview-entry-section">
                  <div className="crm-preview-section-label">Warnings</div>
                  <ul className="crm-preview-list">
                    {entry.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              {entry.previewPayload && Object.keys(entry.previewPayload).length > 0 && (
                <div className="crm-preview-entry-section">
                  <div className="crm-preview-section-label">Proposed payload (preview only)</div>
                  <div className="crm-preview-payload">
                    {Object.entries(entry.previewPayload).map(([k, v]) => (
                      <PayloadRow key={k} label={k} value={v} />
                    ))}
                  </div>
                </div>
              )}

              {entry.requiredBeforeExecution.length > 0 && (
                <div className="crm-preview-entry-section">
                  <div className="crm-preview-section-label">Required before execution</div>
                  <ul className="crm-preview-list">
                    {entry.requiredBeforeExecution.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              )}

              <button
                className="btn btn-secondary btn-sm crm-preview-future-btn"
                type="button"
                disabled
                title="Execution is a future explicit gate — not available in this PR"
              >
                Execute in future step
              </button>
            </div>
          ))}
        </div>

        <div className="crm-preview-footer">
          Generated {formatDate(preview.generatedAt)} — work kind: {preview.workKind}
        </div>

        <div className="crm-preview-modal-actions">
          <button className="btn btn-secondary btn-sm" type="button" onClick={onClose}>Close</button>
        </div>

      </div>
    </div>
  );
}
