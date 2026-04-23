import { useState } from 'react';
import type { SkeletonPreview, Customer } from '../types';
import Modal from './Modal';
import * as tauriApi from '../lib/tauriCommands';

interface SkeletonPreviewModalProps {
  preview: SkeletonPreview;
  customer: Customer | undefined;
  onClose: () => void;
  /**
   * When provided and no plugin folder is configured, a "Create Project & Apply" button
   * is shown instead of the disabled "Save to File" button.
   * The callback should create the plugin project and write the draft file.
   * Throwing from the callback surfaces an error message in the modal.
   */
  onCreateAndApply?: () => Promise<void>;
  /**
   * Explicit plugin project base path (e.g. pluginsDir/selectedPluginProject).
   * When set, takes priority over customer.pluginFolder so the save path
   * always matches the project actually selected in the Dev panel.
   */
  resolvedPluginBase?: string;
}

/** Builds the absolute save path for the .cs file.
 *
 * When a plugin project is selected, resolvedPluginBase is the solution root
 * (<pluginsDir>/<projectName>). The .cs file lives in the nested C# project
 * folder which always has the same name as the project:
 *   <resolvedPluginBase>/<projectName>/<fileName>
 *
 * Without a selected project, falls back to customer.pluginFolder + targetPath.
 */
function buildSavePath(
  preview: SkeletonPreview,
  customer: Customer | undefined,
  resolvedPluginBase?: string,
): string | null {
  if (resolvedPluginBase) {
    // Extract project name from last path segment of the solution root.
    const projectName = resolvedPluginBase.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
    return `${resolvedPluginBase}/${projectName}/${preview.fileName}`;
  }
  const base = customer?.pluginFolder;
  if (!base) return null;
  const rel = preview.targetPath?.trim();
  const parts = rel ? [base, rel, preview.fileName] : [base, preview.fileName];
  return parts.join('/');
}

export default function SkeletonPreviewModal({ preview, customer, onClose, onCreateAndApply, resolvedPluginBase }: SkeletonPreviewModalProps) {
  const [copied, setCopied]         = useState(false);
  const [saving, setSaving]         = useState(false);
  const [saved, setSaved]           = useState(false);
  const [saveError, setSaveError]   = useState<string | null>(null);
  const [creating, setCreating]     = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const savePath = buildSavePath(preview, customer, resolvedPluginBase);

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

  async function handleCreateAndApply() {
    if (!onCreateAndApply) return;
    setCreating(true);
    setCreateError(null);
    try {
      await onCreateAndApply();
      // Parent closes the modal on success — no local state update needed.
    } catch (e) {
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  }

  const footer = (
    <>
      {copied && <span className="reply-copy-success">✓ Copied</span>}
      {saved  && <span className="reply-copy-success">✓ Saved to {preview.fileName}</span>}
      <button className="btn btn-ghost btn-sm" onClick={handleCopy} disabled={saving || creating}>
        Copy
      </button>
      {savePath ? (
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSave}
          disabled={saving || saved || creating}
          title={`Save to: ${savePath}`}
        >
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save to File'}
        </button>
      ) : onCreateAndApply ? (
        <button
          className="btn btn-primary btn-sm"
          onClick={handleCreateAndApply}
          disabled={creating || saving}
          title="Create a new plugin project from the inferred naming convention and write this draft into it"
        >
          {creating ? 'Creating…' : 'Apply Draft (Create Project)'}
        </button>
      ) : (
        <button className="btn btn-secondary btn-sm" disabled title="No plugin folder configured">
          Save to File
        </button>
      )}
      <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={creating || saving}>Cancel</button>
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

      {(saveError || createError) && (
        <div className="detail-fs-error">⚠ {saveError ?? createError}</div>
      )}

      {/* Code preview */}
      <pre className="skeleton-code-preview">{preview.content}</pre>
    </Modal>
  );
}
