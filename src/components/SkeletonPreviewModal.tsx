import { useState } from 'react';
import type { SkeletonPreview, Customer } from '../types';
import Modal from './Modal';
import * as tauriApi from '../lib/tauriCommands';

interface SkeletonPreviewModalProps {
  preview: SkeletonPreview;
  /** @deprecated No longer used in path calculation; kept only for call-site compatibility. */
  customer?: Customer;
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
 * Requires `resolvedPluginBase` (<pluginsDir>/<projectName>) to be provided.
 * The .cs file lives in the nested C# project folder which has the same name
 * as the solution root:
 *   <resolvedPluginBase>/<projectName>/<fileName>
 *
 * Returns null when no project is selected, so the Save to File button is
 * disabled and the user is directed to pick a project in the Dev panel.
 * This matches the path built by TaskDetail.handleApplyDraft.
 */
function buildSavePath(
  preview: SkeletonPreview,
  resolvedPluginBase?: string,
): string | null {
  if (resolvedPluginBase) {
    // Extract project name from last path segment of the solution root.
    // Convention (matches TaskDetail.handleApplyDraft):
    //   <pluginsDir>/<project>/<project>/<fileName>
    const projectName = resolvedPluginBase.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
    return `${resolvedPluginBase}/${projectName}/${preview.fileName}`;
  }
  // No project selected — return null so "Save to File" is disabled.
  // The AI-supplied targetPath is not reliable for plugin folder layout and
  // would produce a path inconsistent with handleApplyDraft in TaskDetail.
  // Users must either select a project in the Dev panel or use "Apply Draft (Create Project)".
  return null;
}

export default function SkeletonPreviewModal({ preview, customer, onClose, onCreateAndApply, resolvedPluginBase }: SkeletonPreviewModalProps) {
  const [copied, setCopied]         = useState(false);
  const [saving, setSaving]         = useState(false);
  const [saved, setSaved]           = useState(false);
  const [saveError, setSaveError]   = useState<string | null>(null);
  const [creating, setCreating]     = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const savePath = buildSavePath(preview, resolvedPluginBase);

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
        <button className="btn btn-secondary btn-sm" disabled title="Select a plugin project in the Dev panel first">
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
              Select a plugin project in the Dev panel to see the target path
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
