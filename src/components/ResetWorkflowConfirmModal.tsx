import Modal from './Modal';

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

/**
 * Confirms the destructive "reset task workflow to NEW" action (src/lib/taskWorkflowReset.ts)
 * before it is applied. Shared by every phase selector that can target NEW (TaskForm.tsx,
 * InlineTaskPanel.tsx) so the wording and behavior stay identical everywhere. Cancel performs no
 * update — the task is left completely unchanged.
 */
export default function ResetWorkflowConfirmModal({ onConfirm, onCancel, busy }: Props) {
  return (
    <Modal title="Reset task to NEW?" onClose={onCancel} footer={
      <>
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>
          {busy ? 'Resetting…' : 'Reset workflow'}
        </button>
      </>
    }>
      <p style={{ marginTop: 0 }}>
        This clears saved analysis, developer setup, technical plans and approvals, implementation
        verification, AI reviews, test/checklist results, next-step state, and local Git workflow
        tracking for this task.
      </p>
      <p style={{ marginBottom: 0 }}>
        The original assignment, customer, notes, tracking links, and repository files will not be
        changed. This does not touch Git or any external system.
      </p>
    </Modal>
  );
}
