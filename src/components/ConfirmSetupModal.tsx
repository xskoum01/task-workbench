/**
 * ConfirmSetupModal — shown when the user clicks Analyze on a New task.
 *
 * Prefills from task.workflowSetup (if already confirmed) or from heuristic
 * resolver results. Saving calls onConfirm with the finalized WorkflowSetup.
 */
import { useState } from 'react';
import type { Task, Customer, WorkflowSetup, AiReviewerConfig } from '../types';
import type { DevTarget } from '../lib/resolveTaskDevTarget';
import Modal from './Modal';
import { mergeWithDefaults } from '../lib/aiReviewers';

interface ConfirmSetupModalProps {
  task: Task;
  customers: Customer[];
  devTarget: DevTarget;
  /** Resolved plugin project directory (e.g. <repo>/Plugins). */
  pluginsDir: string | undefined;
  /** Heuristic default script folder for pre-fill. */
  scriptFolder: string | undefined;
  /** AI reviewer configs from settings. */
  reviewerConfigs?: AiReviewerConfig[];
  /** Called when the user clicks Confirm & Analyze. */
  onConfirm: (setup: WorkflowSetup) => void;
  onCancel: () => void;
}

export default function ConfirmSetupModal({
  task,
  customers,
  devTarget,
  pluginsDir,
  scriptFolder,
  reviewerConfigs,
  onConfirm,
  onCancel,
}: ConfirmSetupModalProps) {
  const existing = task.workflowSetup;

  // --- Form state — prefill from confirmed setup or heuristics ---
  const [workIntent, setWorkIntent] = useState<WorkflowSetup['workIntent']>(
    existing?.workIntent ?? 'update',
  );
  const [devKind, setDevKind] = useState<'plugin' | 'script' | 'repo'>(
    existing?.devTargetKind ?? devTarget.kind,
  );
  const [customerId, setCustomerId] = useState<string>(
    existing?.customerId ?? task.customerId ?? '',
  );
  const [pluginProject, setPluginProject] = useState<string>(
    existing?.pluginProject ?? task.selectedPluginProject ?? task.workflowSetup?.pluginProject ?? '',
  );
  const [scriptPath, setScriptPath] = useState<string>(
    existing?.scriptPath ?? scriptFolder ?? '',
  );
  const [reviewerId, setReviewerId] = useState<string>(
    existing?.reviewerId ?? '',
  );

  const allReviewers = reviewerConfigs
    ? mergeWithDefaults(reviewerConfigs).filter((r) => r.enabled)
    : [];

  // Compute a human-readable path hint based on current customer selection
  const selectedCustomer = customers.find((c) => c.id === customerId);
  const repoHint =
    selectedCustomer?.resolvedRepositoryPath ??
    selectedCustomer?.repositoryRoot ??
    selectedCustomer?.folderName ??
    '';

  function handleConfirm() {
    const setup: WorkflowSetup = {
      workIntent,
      devTargetKind: devKind,
      customerId:    customerId || undefined,
      repositoryRoot: repoHint || undefined,
      pluginProject: devKind === 'plugin' ? (pluginProject.trim() || undefined) : undefined,
      scriptPath:    devKind === 'script' ? (scriptPath.trim() || undefined)   : undefined,
      reviewerId:    reviewerId || undefined,
      confirmedAt:   new Date().toISOString(),
    };
    onConfirm(setup);
  }

  // Change kind and clear irrelevant sub-fields
  function handleKindChange(kind: typeof devKind) {
    setDevKind(kind);
    // Keep scriptPath / pluginProject; they'll be ignored if kind doesn't match.
  }

  return (
    <Modal
      title="Confirm task setup"
      size="md"
      onClose={onCancel}
      footer={
        <div className="confirm-setup-footer">
          <button className="btn btn-secondary btn-sm" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleConfirm} type="button">
            Confirm &amp; Analyze
          </button>
        </div>
      }
    >
      <div className="confirm-setup-body">

        {/* Work intent */}
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Work intent</label>
          <div className="confirm-setup-kind-group">
            {([ 'update', 'create', 'fix', 'review'] as const).map((intent) => (
              <button
                key={intent}
                type="button"
                className={`btn btn-sm${workIntent === intent ? ' btn-primary' : ' btn-secondary'}`}
                onClick={() => setWorkIntent(intent)}
              >
                {intent.charAt(0).toUpperCase() + intent.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Target kind */}
        <div className="confirm-setup-row">
          <label className="form-label confirm-setup-label">Target kind</label>
          <div className="confirm-setup-kind-group">
            {(['plugin', 'script', 'repo'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={`btn btn-sm${devKind === kind ? ' btn-primary' : ' btn-secondary'}`}
                onClick={() => handleKindChange(kind)}
              >
                {kind.charAt(0).toUpperCase() + kind.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Customer */}
        {customers.length > 1 && (
          <div className="confirm-setup-row">
            <label className="form-label confirm-setup-label">Customer</label>
            <select
              className="form-select"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
            >
              <option value="">— none —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {repoHint && (
              <div className="confirm-setup-hint">{repoHint}</div>
            )}
          </div>
        )}

        {/* Plugin project — only when kind = plugin */}
        {devKind === 'plugin' && (
          <div className="confirm-setup-row">
            <label className="form-label confirm-setup-label">Plugin project</label>
            <input
              className="form-input"
              type="text"
              value={pluginProject}
              placeholder={pluginsDir ? `Subfolder inside ${pluginsDir}` : 'Plugin project folder name'}
              onChange={(e) => setPluginProject(e.target.value)}
            />
            {pluginsDir && (
              <div className="confirm-setup-hint">Inside: {pluginsDir}</div>
            )}
          </div>
        )}

        {/* Script path — only when kind = script */}
        {devKind === 'script' && (
          <div className="confirm-setup-row">
            <label className="form-label confirm-setup-label">Script folder / file</label>
            <input
              className="form-input"
              type="text"
              value={scriptPath}
              placeholder="Absolute path to script or folder"
              onChange={(e) => setScriptPath(e.target.value)}
            />
          </div>
        )}

        {/* Reviewer — only when reviewer configs are available */}
        {allReviewers.length > 0 && (
          <div className="confirm-setup-row">
            <label className="form-label confirm-setup-label">AI reviewer</label>
            <select
              className="form-select"
              value={reviewerId}
              onChange={(e) => setReviewerId(e.target.value)}
            >
              <option value="">— auto-select —</option>
              {allReviewers.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>
    </Modal>
  );
}
