import { useEffect, useState } from 'react';
import type { SkeletonPreview, Customer } from '../types';
import Modal from './Modal';
import * as tauriApi from '../lib/tauriCommands';

interface SkeletonPreviewModalProps {
  preview: SkeletonPreview;
  /** @deprecated No longer used in path calculation; kept only for call-site compatibility. */
  customer?: Customer;
  onClose: () => void;
  /**
   * Called after "Save to File" succeeds with the absolute path that was written.
   * The parent should persist metadata only; workflow state and IDE opening remain explicit.
   */
  onSaved?: (filePath: string) => void;
  /**
   * Explicit plugin project base path (e.g. pluginsDir/selectedPluginProject).
   * When set, takes priority over customer.pluginFolder so the save path
   * always matches the project actually selected in the Dev panel.
   */
  resolvedPluginBase?: string;
  /**
   * Explicit absolute save path override, used for script drafts where the target
   * is a flat file in the scripts folder, not a nested plugin project layout.
   */
  overrideSavePath?: string;
  /** Override the modal title. Defaults to "Skeleton: <fileName>". */
  modalTitle?: string;
  /**
   * When set, shows a visible warning above the code preview and before Save to File.
   * Used to alert the user that the technical plan was auto-generated and not yet approved.
   */
  unapprovedPlanWarning?: string;
}

function buildSavePath(
  preview: SkeletonPreview,
  resolvedPluginBase?: string,
): string | null {
  if (resolvedPluginBase) {
    const projectName = resolvedPluginBase.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
    return `${resolvedPluginBase}/${projectName}/${preview.fileName}`;
  }
  return null;
}

export default function SkeletonPreviewModal({
  preview,
  customer: _customer,
  onClose,
  onSaved,
  resolvedPluginBase,
  overrideSavePath,
  modalTitle,
  unapprovedPlanWarning,
}: SkeletonPreviewModalProps) {
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [targetExists, setTargetExists] = useState<boolean | null>(null);
  const [conflictPath, setConflictPath] = useState<string | null>(null);

  const savePath = overrideSavePath ?? buildSavePath(preview, resolvedPluginBase);

  useEffect(() => {
    let cancelled = false;
    setTargetExists(null);
    setConflictPath(null);
    if (!savePath) return;
    tauriApi.checkPathExists(savePath)
      .then((exists) => { if (!cancelled) setTargetExists(exists); })
      .catch(() => { if (!cancelled) setTargetExists(null); });
    return () => { cancelled = true; };
  }, [savePath]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(preview.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard unavailable; preview is still visible for manual copy.
    }
  }

  function buildSaveAsPath(path: string): string {
    const norm = path.replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    const dir = slash >= 0 ? norm.slice(0, slash + 1) : '';
    const file = slash >= 0 ? norm.slice(slash + 1) : norm;
    const dot = file.lastIndexOf('.');
    const stem = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot) : '';
    return `${dir}${stem}.draft-${Date.now()}${ext}`;
  }

  async function writeDraft(path: string) {
    setSaving(true);
    setSaveError(null);
    try {
      await tauriApi.saveGeneratedFile(path, preview.content);
      setSaved(true);
      onSaved?.(path);
      onClose();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!savePath) return;
    const exists = targetExists ?? await tauriApi.checkPathExists(savePath).catch(() => false);
    if (exists) {
      setConflictPath(savePath);
      return;
    }
    await writeDraft(savePath);
  }

  async function handleOverwrite() {
    if (!conflictPath) return;
    const path = conflictPath;
    setConflictPath(null);
    await writeDraft(path);
  }

  async function handleSaveAsNew() {
    if (!conflictPath) return;
    const nextPath = buildSaveAsPath(conflictPath);
    setConflictPath(null);
    await writeDraft(nextPath);
  }

  const footer = (
    <>
      {copied && <span className="reply-copy-success">Copied</span>}
      {saved && <span className="reply-copy-success">Saved to {preview.fileName}</span>}
      {conflictPath && (
        <span className="detail-devmode-hint" style={{ color: 'var(--color-warning, #d29922)' }}>
          Target exists
        </span>
      )}
      <button className="btn btn-ghost btn-sm" onClick={handleCopy} disabled={saving}>
        Copy
      </button>
      {conflictPath ? (
        <>
          <button className="btn btn-danger btn-sm" onClick={handleOverwrite} disabled={saving}>
            Overwrite
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleSaveAsNew} disabled={saving}>
            Save as New
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setConflictPath(null)} disabled={saving}>
            Cancel
          </button>
        </>
      ) : savePath ? (
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSave}
          disabled={saving || saved}
          title={`Save to: ${savePath}`}
        >
          {saving ? 'Saving...' : saved ? 'Saved' : 'Save to File'}
        </button>
      ) : (
        <button className="btn btn-secondary btn-sm" disabled title="Select a plugin project in the Dev panel first">
          Save to File
        </button>
      )}
      <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
    </>
  );

  return (
    <Modal title={modalTitle ?? `Skeleton: ${preview.fileName}`} onClose={onClose} footer={footer} size="lg">
      <div className="skeleton-path-row">
        <span className="skeleton-path-label">Target</span>
        <span className="skeleton-path-value">
          {savePath ?? (
            <span style={{ color: 'var(--color-blocked)', fontStyle: 'italic' }}>
              Select a plugin project in the Dev panel to see the target path
            </span>
          )}
        </span>
      </div>
      {savePath && (
        <div className="skeleton-path-row">
          <span className="skeleton-path-label">Exists</span>
          <span className="skeleton-path-value">
            {targetExists === null ? 'Checking...' : targetExists ? 'Yes - choose Overwrite or Save as New' : 'No'}
          </span>
        </div>
      )}
      {saveError && (
        <div className="detail-fs-error">! {saveError}</div>
      )}
      {unapprovedPlanWarning && (
        <div style={{
          fontSize: 12,
          lineHeight: 1.5,
          color: 'var(--color-warning, #d29922)',
          border: '1px solid var(--color-warning, #d29922)',
          borderRadius: 4,
          padding: '7px 10px',
          marginBottom: 6,
        }}>
          ! {unapprovedPlanWarning}
        </div>
      )}
      <pre className="skeleton-code-preview">{preview.content}</pre>
    </Modal>
  );
}
