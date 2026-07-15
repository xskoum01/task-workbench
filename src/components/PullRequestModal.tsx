/**
 * PullRequestModal
 *
 * Shown after a verified Commit + Push, before the task may enter Code Review. The app never
 * creates a pull request automatically — this is always a manual fallback: the user (or Claude,
 * only after this separate explicit approval) opens the repository, creates the PR there, and
 * records its URL here. Recording is a local Task Workbench write only (task.crmDeveloperWorkflow.
 * pullRequestTracking) — no GitHub/Azure DevOps API call is made.
 *
 * Approving a commit/push is NOT approval to create a pull request — this modal is the separate,
 * explicit approval step required before entering Code Review / waiting for colleague review.
 */
import { useState } from 'react';
import type { Task, Customer } from '../types';
import Modal from './Modal';

interface Props {
  task: Task;
  customer: Customer | null;
  onRecordPullRequestCreated: (prUrl: string, notes: string) => void | Promise<void>;
  onClose: () => void;
}

export default function PullRequestModal({ task, customer, onRecordPullRequestCreated, onClose }: Props) {
  const existing = task.crmDeveloperWorkflow?.pullRequestTracking;
  const [prUrl, setPrUrl] = useState(existing?.prUrl ?? '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const gw = task.gitWorkflow;
  const sourceBranch = gw?.lastPushedBranch ?? gw?.lastCommitBranch ?? gw?.confirmedBranch;
  const repoUrl = customer?.azureDevOpsRepoUrl;
  const provider: 'azure-devops' | 'unknown' = repoUrl?.includes('dev.azure.com') || repoUrl?.includes('visualstudio.com')
    ? 'azure-devops'
    : 'unknown';

  async function handleRecord() {
    const url = prUrl.trim();
    if (!url) return;
    setBusy(true);
    try {
      await onRecordPullRequestCreated(url, notes.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Pull Request"
      size="md"
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy} type="button">Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void handleRecord()}
            disabled={busy || !prUrl.trim()}
            title="Local record only — does not create a PR on GitHub/Azure DevOps"
            type="button"
          >
            {busy ? <><span className="btn-spinner" /> Recording</> : 'Record pull request created'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
        <p style={{ margin: 0 }}>
          Commit and push are verified. Task Workbench does not create pull requests automatically —
          create it in {provider === 'azure-devops' ? 'Azure DevOps' : 'your Git provider'}, then record
          its URL here. This is a separate approval from the commit/push you already confirmed.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div><span style={{ color: 'var(--text-muted)' }}>Source branch:</span> {sourceBranch ?? '(unknown — push not yet verified)'}</div>
          {repoUrl && (
            <div style={{ wordBreak: 'break-all' }}>
              <span style={{ color: 'var(--text-muted)' }}>Repository:</span>{' '}
              <a href={repoUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-fg, #388bfd)' }}>{repoUrl}</a>
            </div>
          )}
        </div>

        {existing?.createdManually && existing.prUrl && !existing.invalidatedAt && (
          <div style={{
            fontSize: 11.5, color: 'var(--color-warning, #d29922)',
            border: '1px solid var(--color-warning, #d29922)', borderRadius: 4, padding: '6px 8px',
          }}>
            A pull request is already recorded for this task: {existing.prUrl}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pull request URL (required)</label>
          <input
            className="form-input form-input-sm"
            value={prUrl}
            onChange={(e) => setPrUrl(e.target.value)}
            placeholder={provider === 'azure-devops'
              ? 'https://dev.azure.com/org/project/_git/repo/pullrequest/123'
              : 'https://github.com/org/repo/pull/123'}
            disabled={busy}
          />
          <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Notes (optional)</label>
          <input
            className="form-input form-input-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. reviewer requested, target branch, ticket link"
            disabled={busy}
          />
        </div>
      </div>
    </Modal>
  );
}
