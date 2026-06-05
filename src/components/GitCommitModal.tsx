import { useState, useEffect, useCallback } from 'react';
import type { Task, Customer, GitCommitPreview } from '../types';
import * as tauriApi from '../lib/tauriCommands';

interface GitCommitModalProps {
  task: Task;
  customer: Customer | null;
  repoRoot: string;
  onClose: () => void;
  /** Called with the activity note string after a successful commit or push (normal mode). */
  onActivityNote?: (note: string) => void;
  /**
   * When set, activates guided mode: after commit+push the parent handles the
   * state transition (e.g. move task to Review and open Azure DevOps).
   */
  postCommitPushAction?: 'move-to-review-and-open-ado';
  /**
   * Guided mode — called instead of onActivityNote after a successful commit+push.
   * Receives the pre-built activity note, commit hash, and branch so the parent
   * can append both notes and update task state in a single atomic updateTask call.
   */
  onPostCommitPushSuccess?: (
    commitNote: string,
    hash: string | undefined,
    branch: string | undefined,
  ) => Promise<void>;
  /**
   * Guided mode — called instead of onActivityNote after a successful commit-only.
   * Receives the pre-built activity note and commit hash.
   */
  onCommitOnlySuccess?: (commitNote: string, hash: string | undefined) => Promise<void>;
}

export default function GitCommitModal({
  task,
  customer: _customer,
  repoRoot,
  onClose,
  onActivityNote,
  postCommitPushAction,
  onPostCommitPushSuccess,
  onCommitOnlySuccess,
}: GitCommitModalProps) {
  const [preview, setPreview]             = useState<GitCommitPreview | null>(null);
  const [loading, setLoading]             = useState(true);
  const [loadError, setLoadError]         = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [working, setWorking]             = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [resultError, setResultError]     = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setResultMessage(null);
    setResultError(null);
    try {
      const p = await tauriApi.getGitCommitPreview(repoRoot, task);
      setPreview(p);
      if (!commitMessage) setCommitMessage(p.suggestedCommitMessage);
      setSelectedFiles(new Set(p.changedFiles.map((f) => f.path)));
    } catch (e) {
      setLoadError(String(e));
      setPreview(null);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot, task.id]);

  useEffect(() => { void loadPreview(); }, [loadPreview]);

  function toggleFile(path: string) {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  async function handleCommit(andPush: boolean) {
    if (!preview || working) return;
    const files = Array.from(selectedFiles);
    if (files.length === 0)    { setResultError('No files selected.'); return; }
    if (!commitMessage.trim()) { setResultError('Commit message is required.'); return; }

    setWorking(true);
    setResultMessage(null);
    setResultError(null);
    try {
      if (andPush) {
        const r = await tauriApi.commitAndPushTaskChanges(repoRoot, files, commitMessage.trim());
        const note = `UI: git-commit-and-push -> ${r.commitHash ?? '?'} ${r.branch ?? '?'}`;
        if (onPostCommitPushSuccess) {
          // Guided mode: parent handles all note+state updates atomically.
          await onPostCommitPushSuccess(note, r.commitHash, r.branch);
        } else {
          onActivityNote?.(note);
        }
        setResultMessage(r.summary ?? 'Commit created and branch pushed.');
      } else {
        const r = await tauriApi.commitTaskChanges(repoRoot, files, commitMessage.trim());
        const note = `UI: git-commit-created -> ${r.commitHash ?? '?'}`;
        if (onCommitOnlySuccess) {
          // Guided mode: parent handles all note+state updates atomically.
          await onCommitOnlySuccess(note, r.commitHash);
        } else {
          onActivityNote?.(note);
        }
        setResultMessage(r.summary ?? `Commit ${r.commitHash} created.`);
      }
      await loadPreview();
    } catch (e) {
      setResultError(String(e));
    } finally {
      setWorking(false);
    }
  }

  const isMainMaster = preview?.branch === 'main' || preview?.branch === 'master';
  const hasFiles = (preview?.changedFiles.length ?? 0) > 0;
  const noneSelected = selectedFiles.size === 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-commit-modal-title"
      >
        <div className="modal-header">
          <h3 className="modal-title" id="git-commit-modal-title">
            {postCommitPushAction ? 'Prepare Commit / PR' : 'Prepare Commit'}
          </h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body" style={{ overflowY: 'auto', maxHeight: '62vh' }}>
          {postCommitPushAction === 'move-to-review-and-open-ado' && (
            <div style={{
              background: 'rgba(60,120,200,0.08)', border: '1px solid rgba(60,120,200,0.25)',
              borderRadius: 4, padding: '6px 10px', marginBottom: 10, fontSize: 12,
            }}>
              Guided flow: Commit + Push will move the task to Review / Waiting for code review
              and open Azure DevOps. Commit only will create the commit but leave the task in Development.
            </div>
          )}

          {loading && <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-muted)' }}>Loading repository status…</p>}

          {loadError && (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--color-blocked)' }}>Error: {loadError}</p>
          )}

          {preview && (
            <>
              {/* Repo info */}
              <div style={{ fontSize: 12, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div><strong>Repository:</strong> <code style={{ fontSize: 11 }}>{preview.repoRoot}</code></div>
                <div><strong>Branch:</strong> <code style={{ fontSize: 11 }}>{preview.branch || '(unknown)'}</code></div>
                {preview.remoteUrl && (
                  <div><strong>Remote:</strong> <code style={{ fontSize: 11 }}>{preview.remoteUrl}</code></div>
                )}
              </div>

              {/* Warnings */}
              {preview.warnings.length > 0 && (
                <div style={{
                  background: 'rgba(200,160,0,0.08)', border: '1px solid rgba(200,160,0,0.35)',
                  borderRadius: 4, padding: '6px 10px', marginBottom: 10, fontSize: 12,
                  display: 'flex', flexDirection: 'column', gap: 3,
                }}>
                  {preview.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                </div>
              )}

              {/* Changed files */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  Files to commit ({preview.changedFiles.length} safe
                  {preview.ignoredFiles.length > 0 ? `, ${preview.ignoredFiles.length} excluded` : ''})
                </div>
                {!hasFiles && (
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted)' }}>
                    No safe files detected — all changes may be in the exclusion list.
                  </p>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {preview.changedFiles.map((f) => (
                    <label
                      key={f.path}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedFiles.has(f.path)}
                        onChange={() => toggleFile(f.path)}
                        disabled={working}
                      />
                      <code style={{ fontSize: 11 }}>{f.path}</code>
                      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>({f.status})</span>
                    </label>
                  ))}
                </div>
                {preview.ignoredFiles.length > 0 && (
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ fontSize: 12, color: 'var(--color-text-muted)', cursor: 'pointer' }}>
                      {preview.ignoredFiles.length} excluded (bin/, obj/, .vs/, …)
                    </summary>
                    <div style={{ paddingLeft: 16, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {preview.ignoredFiles.map((f) => (
                        <div key={f.path} style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                          {f.path} <span style={{ opacity: 0.6 }}>({f.status})</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>

              {/* Commit message */}
              <div className="form-group">
                <label className="form-label">Commit message</label>
                <textarea
                  className="form-textarea"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  rows={3}
                  disabled={working}
                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                />
              </div>

              {/* Result */}
              {resultMessage && (
                <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--color-pass, #4c4)' }}>✓ {resultMessage}</p>
              )}
              {resultError && (
                <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--color-blocked)' }}>✗ {resultError}</p>
              )}
            </>
          )}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void loadPreview()}
            disabled={loading || working}
          >
            Refresh
          </button>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={working}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleCommit(false)}
              disabled={loading || working || !hasFiles || noneSelected}
              title="Commit selected files (no push)"
            >
              {working ? 'Working…' : 'Commit'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleCommit(true)}
              disabled={loading || working || !hasFiles || noneSelected || isMainMaster}
              title={isMainMaster ? 'Push to main/master is blocked' : postCommitPushAction ? 'Commit, push, move to Review, and open Azure DevOps' : 'Commit selected files and push branch'}
            >
              {working ? 'Working…' : postCommitPushAction ? 'Commit + Push and Move to Review' : 'Commit + Push'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
