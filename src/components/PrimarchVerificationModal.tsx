import type { CrmVerificationReport } from '../types';
import Modal from './Modal';
import CrmVerificationReportView from './CrmVerificationReportView';

export type PrimarchVerifyStepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface PrimarchVerifyStep {
  id: string;
  label: string;
  status: PrimarchVerifyStepStatus;
  detail?: string;
}

interface PrimarchVerificationModalProps {
  filePath?: string;
  primaryEntityOverride?: string;
  steps: PrimarchVerifyStep[];
  running: boolean;
  result: CrmVerificationReport | null;
  error: string | null;
  crmMetadataEnabled?: boolean;
  mcpCommandConfigured?: boolean;
  mcpArgsConfigured?: boolean;
  onClose: () => void;
}

function statusLabel(status: PrimarchVerifyStepStatus): string {
  switch (status) {
    case 'running': return 'Running';
    case 'done': return 'Done';
    case 'failed': return 'Failed';
    default: return 'Pending';
  }
}

function statusClass(status: PrimarchVerifyStepStatus): string {
  switch (status) {
    case 'running': return 'repo-status-missing';
    case 'done': return 'repo-status-linked';
    case 'failed': return 'repo-status-not-created';
    default: return 'repo-status-not-created';
  }
}

export default function PrimarchVerificationModal({
  filePath,
  primaryEntityOverride,
  steps,
  running,
  result,
  error,
  crmMetadataEnabled,
  mcpCommandConfigured,
  mcpArgsConfigured,
  onClose,
}: PrimarchVerificationModalProps) {
  const footerLabel = running ? 'Cancel' : 'Close';

  return (
    <Modal
      title="Verify against Dataverse"
      size="xl"
      onClose={onClose}
      footer={(
        <button className="btn btn-secondary btn-sm" type="button" onClick={onClose}>
          {footerLabel}
        </button>
      )}
    >
      <div className="detail-analysis-block" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="analysis-subsection">
          <span className="analysis-subsection-label">Target file</span>
          <div className="settings-field-hint" style={{ wordBreak: 'break-word' }}>
            {filePath || 'Resolving target file...'}
          </div>
        </div>

        <div className="analysis-subsection">
          <span className="analysis-subsection-label">CRM metadata configuration</span>
          <div className="settings-field-hint">CRM metadata assistant: {crmMetadataEnabled ? 'enabled' : 'disabled'}</div>
          <div className="settings-field-hint">MCP command configured: {mcpCommandConfigured ? 'yes' : 'no'}</div>
          <div className="settings-field-hint">MCP args configured: {mcpArgsConfigured ? 'yes' : 'no'}</div>
          <div className="settings-field-hint">Primary entity override: {primaryEntityOverride || 'none'}</div>
          <div className="settings-field-hint">Source: persisted settings</div>
        </div>

        <div className="analysis-subsection">
          <span className="analysis-subsection-label">Progress</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {steps.map((step) => (
              <div
                key={step.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '8px 10px',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 4,
                  background: 'var(--bg-overlay)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{step.label}</div>
                  {step.detail && <div className="settings-field-hint" style={{ marginTop: 2 }}>{step.detail}</div>}
                </div>
                <span className={`repo-status-badge ${statusClass(step.status)}`} style={{ flexShrink: 0 }}>
                  {statusLabel(step.status)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="detail-fs-error">! {error}</div>
        )}

        {result && (
          <div className="analysis-subsection">
            <span className="analysis-subsection-label">Final result</span>
            <CrmVerificationReportView report={result} />
          </div>
        )}
      </div>
    </Modal>
  );
}