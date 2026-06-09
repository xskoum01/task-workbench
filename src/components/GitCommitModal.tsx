import { useState, useEffect, useCallback } from 'react';
import type { Task, Customer, GitCommitPreview } from '../types';
import * as tauriApi from '../lib/tauriCommands';
import { generateBranchName, validateBranchName } from '../lib/gitBranchName';

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
  /**
   * Called after a feature branch is successfully created so the parent can
   * record the activity note.
   */
  onBranchCreated?: (note: string) => void;
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
  onBranchCreated,
}: GitCommitModalProps) {
  const [preview, setPreview]             = useState<GitCommitPreview | null>(null);
  const [loading, setLoading]             = useState(true);
  const [loadError, setLoadError]         = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [working, setWorking]             = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [resultError, setResultError]     = useState<string | null>(null);

  // Feature branch creation state
  const [branchInput, setBranchInput]             = useState('');
  const [branchWorking, setBranchWorking]         = useState(false);
  const [branchCreateError, setBranchCreateError] = useState<string | null>(null);
  const [branchCreatedMsg, setBranchCreatedMsg]   = useState<string | null>(null);

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
      // Seed branch input only when on default branch and not yet set.
      const isDefault = p.branch === 'main' || p.branch === 'master';
      if (isDefault) {
        setBranchInput((prev) => prev || generateBranchName(task));
      }
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
          await onPostCommitPushSuccess(note, r.commitHash, r.branch);
        } else {
          onActivityNote?.(note);
        }
        setResultMessage(r.summary ?? 'Commit created and branch pushed.');
      } else {
        const r = await tauriApi.commitTaskChanges(repoRoot, files, commitMessage.trim());
        const note = `UI: git-commit-created -> ${r.commitHash ?? '?'}`;
        if (onCommitOnlySuccess) {
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

  async function handleCreateBranch() {
    const name = branchInput.trim();
    const validationError = validateBranchName(name);
    if (validationError) {
      setBranchCreateError(validationError);
      return;
    }
    setBranchWorking(true);
    setBranchCreateError(null);
    setBranchCreatedMsg(null);
    try {
      const r = await tauriApi.createGitBranch(repoRoot, name);
      const note = `UI: git-branch-created -> ${r.branch}`;
      onBranchCreated?.(note);
      onActivityNote?.(note);
      setBranchCreatedMsg(`Feature branch created: ${r.branch}`);
      await loadPreview();
    } catch (e) {
      setBranchCreateError(String(e));
    } finally {
      setBranchWorking(false);
    }
  }

  const isMainMaster   = preview?.branch === 'main' || preview?.branch === 'master';
  const hasFiles       = (preview?.changedFiles.length ?? 0) > 0;
  const noneSelected   = selectedFiles.size === 0;
  const baseBranch     = preview?.baseBranch;
  const hasMergeBase   = preview?.hasMergeBase;
  // No merge base on a feature branch means the PR will fail.
  const noMergeBaseOnFeature = !isMainMaster && baseBranch !== undefined && hasMergeBase === false;
  // Block Commit+Push (and Move to Review) when push would produce an unresolvable PR.
  const pushBlocked    = isMainMaster || noMergeBaseOnFeature;

  const branchValidationError = branchInput.trim() ? validateBranchName(branchInput.trim()) : null;

  // Label for the "create branch" button: include the detected base so the user knows what they're doing.
  const createBtnLabel = baseBranch
    ? `Create branch from ${baseBranch}`
    : 'Create branch';

  // Filter out the default-branch warning since we render it in its own styled block.
  const otherWarnings = (preview?.warnings ?? []).filter(
    (w) => !(w.startsWith("Branch '") && w.includes('default branch')) &&
           !(w.includes('no common history')),
  );

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
              Guided flow: Commit + Push will move the task to Code Review / Waiting for code review
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
                {baseBranch && (
                  <div style={{ fontSize: 11, color: noMergeBaseOnFeature ? 'var(--color-blocked)' : 'var(--color-text-muted)' }}>
                    <strong>Base branch for PR:</strong> <code style={{ fontSize: 11 }}>{baseBranch}</code>
                    {!isMainMaster && hasMergeBase === true && (
                      <span style={{ marginLeft: 6, color: 'var(--color-pass, #4c4)' }}>Branch is based on {baseBranch}.</span>
                    )}
                    {noMergeBaseOnFeature && (
                      <span style={{ marginLeft: 6 }}>No common history — PR compare will fail.</span>
                    )}
                  </div>
                )}
              </div>

              {/* Default-branch warning + feature branch creator */}
              {isMainMaster && (
                <div style={{
                  background: 'rgba(200,100,0,0.07)', border: '1px solid rgba(200,100,0,0.35)',
                  borderRadius: 4, padding: '8px 10px', marginBottom: 10, fontSize: 12,
                  display: 'flex', flexDirection: 'column', gap: 6,
                }}>
                  <div style={{ fontWeight: 600, color: 'var(--color-blocked)' }}>
                    Branch &apos;{preview.branch}&apos; is the default branch — push will be blocked.
                  </div>

                  <div style={{ color: 'var(--color-text-muted)' }}>
                    Create a feature branch before commit / push:
                  </div>

                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexDirection: 'column' }}>
                    <input
                      type="text"
                      className="form-input"
                      value={branchInput}
                      onChange={(e) => {
                        setBranchInput(e.target.value);
                        setBranchCreateError(null);
                        setBranchCreatedMsg(null);
                      }}
                      placeholder="feature/..."
                      disabled={branchWorking}
                      style={{ fontFamily: 'monospace', fontSize: 12, width: '100%', boxSizing: 'border-box' }}
                      aria-label="Feature branch name"
                    />
                    {branchValidationError && !branchCreateError && (
                      <span style={{ fontSize: 11, color: 'var(--color-blocked)' }}>{branchValidationError}</span>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void handleCreateBranch()}
                      disabled={branchWorking || !!branchValidationError || !branchInput.trim()}
                      style={{ alignSelf: 'flex-start' }}
                    >
                      {branchWorking ? 'Creating…' : createBtnLabel}
                    </button>
                  </div>

                  {branchCreateError && (
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--color-blocked)' }}>✗ {branchCreateError}</p>
                  )}
                  {branchCreatedMsg && (
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--color-pass, #4c4)' }}>✓ {branchCreatedMsg}</p>
                  )}
                </div>
              )}

              {/* Unrelated-history warning + repair guidance */}
              {noMergeBaseOnFeature && (
                <div style={{
                  background: 'rgba(200,50,0,0.07)', border: '1px solid rgba(200,50,0,0.4)',
                  borderRadius: 4, padding: '8px 10px', marginBottom: 10, fontSize: 12,
                  display: 'flex', flexDirection: 'column', gap: 4,
                }}>
                  <div style={{ fontWeight: 600, color: 'var(--color-blocked)' }}>
                    This branch has no common history with {baseBranch}. A normal PR cannot be created.
                  </div>
                  <div style={{ color: 'var(--color-text-muted)' }}>Recommended fix:</div>
                  <ol style={{ margin: '2px 0 0 18px', padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <li>Fetch origin: <code style={{ fontSize: 11 }}>git fetch origin</code></li>
                    <li>Create a new branch from {baseBranch}: <code style={{ fontSize: 11 }}>git checkout -b feature/my-fix {baseBranch}</code></li>
                    <li>Reapply or cherry-pick the intended changes onto the new branch.</li>
                    <li>Push the new branch.</li>
                  </ol>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                    Commit + Push and Move to Code Review are blocked until the branch has a valid base.
                  </div>
                </div>
              )}

              {/* Generic warnings */}
              {otherWarnings.length > 0 && (
                <div style={{
                  background: 'rgba(200,160,0,0.08)', border: '1px solid rgba(200,160,0,0.35)',
                  borderRadius: 4, padding: '6px 10px', marginBottom: 10, fontSize: 12,
                  display: 'flex', flexDirection: 'column', gap: 3,
                }}>
                  {otherWarnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
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
              disabled={loading || working || !hasFiles || noneSelected || pushBlocked}
              title={
                isMainMaster
                  ? 'Push to main/master is blocked — create a feature branch first'
                  : noMergeBaseOnFeature
                    ? `Branch has no common history with ${baseBranch ?? 'remote base'} — PR compare will fail`
                    : postCommitPushAction
                      ? 'Commit, push, move to Code Review, and open Azure DevOps'
                      : 'Commit selected files and push branch'
              }
            >
              {working ? 'Working…' : postCommitPushAction ? 'Commit + Push and Move to Code Review' : 'Commit + Push'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
