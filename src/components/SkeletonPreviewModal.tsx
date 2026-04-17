import { useState } from 'react';
import type { SkeletonPreview, Customer } from '../types';
import Modal from './Modal';
import * as tauriApi from '../lib/tauriCommands';

interface SkeletonPreviewModalProps {
  preview: SkeletonPreview;
  customer: Customer | undefined;
  onClose: () => void;
}

/** Builds the absolute save path from customer pluginFolder + targetPath + fileName. */
function buildSavePath(preview: SkeletonPreview, customer: Customer | undefined): string | null {
  const base = customer?.pluginFolder;
  if (!base) return null;
  const rel = preview.targetPath?.trim();
  const parts = rel ? [base, rel, preview.fileName] : [base, preview.fileName];
  return parts.join('/');
}

export default function SkeletonPreviewModal({ preview, customer, onClose }: SkeletonPreviewModalProps) {
  const [copied, setCopied]     = useState(false);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const savePath = buildSavePath(preview, customer);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(preview.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard unavailable — silently ignore
    }
  }

  async function handleSave() {
    if (!savePath) return;
    setSaving(true);
    setSaveError(null);
    try {
      await tauriApi.saveGeneratedFile(savePath, preview.content);
      setSaved(true);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <>
      {copied && <span className="reply-copy-success">✓ Copied</span>}
      {saved  && <span className="reply-copy-success">✓ Saved to {preview.fileName}</span>}
      <button className="btn btn-ghost btn-sm" onClick={handleCopy} disabled={saving}>
        Copy
      </button>
      {savePath ? (
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSave}
          disabled={saving || saved}
          title={`Save to: ${savePath}`}
        >
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save to File'}
        </button>
      ) : (
        <button className="btn btn-secondary btn-sm" disabled title="No plugin folder configured">
          Save to File
        </button>
      )}
      <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
    </>
  );

  return (
    <Modal title={`Skeleton: ${preview.fileName}`} onClose={onClose} footer={footer} size="lg">
      {/* Save path info */}
      <div className="skeleton-path-row">
        <span className="skeleton-path-label">Target</span>
        <span className="skeleton-path-value">
          {savePath ?? (
            <span style={{ color: 'var(--color-blocked)', fontStyle: 'italic' }}>
              No plugin folder configured for this customer
            </span>
          )}
        </span>
      </div>

      {saveError && (
        <div className="detail-fs-error">⚠ {saveError}</div>
      )}

      {/* Code preview */}
      <pre className="skeleton-code-preview">{preview.content}</pre>
    </Modal>
  );
}
