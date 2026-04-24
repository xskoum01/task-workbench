/**
 * ConfirmSetupModal — shown when the user clicks Analyze on a New task.
 *
 * All fields are pre-filled by inferWorkflowSetupDefaults(). If the task
 * already has a confirmed workflowSetup, those values take priority and new
 * inference does not override them.
 */
import { useState } from 'react';
import type { Task, Customer, WorkflowSetup, AiReviewerConfig } from '../types';
import type { DevTarget } from '../lib/resolveTaskDevTarget';
import Modal from './Modal';
import { mergeWithDefaults } from '../lib/aiReviewers';
import { inferWorkflowSetupDefaults } from '../lib/inferWorkflowSetup';

interface ConfirmSetupModalProps {
  task: Task;
  customers: Customer[];
  customer: Customer | undefined;
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
  customer,
  devTarget,
  pluginsDir,
  scriptFolder,
  reviewerConfigs,
  onConfirm,
  onCancel,
}: ConfirmSetupModalProps) {
  // Run inference once on mount — workflowSetup values win over guesses inside the helper.
  const { defaults, hints } = inferWorkflowSetupDefaults({
    task,
    customer,
    customers,
    devTarget,
    pluginsDir,
    scriptFolder,
    reviewerConfigs,
  });

  // --- Form state pre-filled from inference ---
  const [workIntent, setWorkIntent] = useState<WorkflowSetup['workIntent']>(defaults.workIntent);
  const [devKind, setDevKind]       = useState<'plugin' | 'script' | 'repo'>(defaults.devTargetKind);
  const [customerId, setCustomerId] = useState<string>(defaults.customerId);
  const [pluginProject, setPluginProject] = useState<string>(defaults.pluginProject);
  const [scriptPath, setScriptPath]       = useState<string>(defaults.scriptPath);
  const [reviewerId, setReviewerId]       = useState<string>(defaults.reviewerId);

  const allReviewers = reviewerConfigs
    ? mergeWithDefaults(reviewerConfigs).filter((r) => r.enabled)
    : [];

  // Compute a human-readable repo path hint for the selected customer.
  const selectedCustomer = customers.find((c) => c.id === customerId);
  const repoHint =
    selectedCustomer?.resolvedRepositoryPath ??
    selectedCustomer?.repositoryRoot ??
    selectedCustomer?.folderName ??
    '';

  // When target kind changes, update the reviewer to the best match for the new kind.
  function handleKindChange(kind: typeof devKind) {
    setDevKind(kind);
    // Only auto-update reviewer when user hasn't manually locked one.
    if (!task.workflowSetup?.reviewerId) {
      const match = kind === 'repo' ? undefined : allReviewers.find(
        (r) => r.appliesTo.devTargetKinds?.includes(kind as 'plugin' | 'script'),
      );
      setReviewerId(match?.id ?? '');
    }
  }

  function handleConfirm() {
    const setup: WorkflowSetup = {
      workIntent,
      devTargetKind:  devKind,
      customerId:     customerId || undefined,
      repositoryRoot: repoHint   || undefined,
      pluginProject:  devKind === 'plugin' ? (pluginProject.trim() || undefined) : undefined,
      scriptPath:     devKind === 'script' ? (scriptPath.trim()    || undefined) : undefined,
      reviewerId:     reviewerId || undefined,
      confirmedAt:    new Date().toISOString(),
    };
    onConfirm(setup);
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
            {(['update', 'create', 'fix', 'review'] as const).map((intent) => (
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
          {hints.workIntent && (
            <div className="confirm-setup-inferred">{hints.workIntent}</div>
          )}
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
          {hints.devTargetKind && (
            <div className="confirm-setup-inferred">{hints.devTargetKind}</div>
          )}
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
              placeholder={
                workIntent === 'create'
                  ? 'New plugin project name (will be created)'
                  : pluginsDir ? `Existing subfolder inside ${pluginsDir}` : 'Existing plugin project folder name'
              }
              onChange={(e) => setPluginProject(e.target.value)}
            />
            {hints.pluginProject && (
              <div className="confirm-setup-inferred">{hints.pluginProject}</div>
            )}
            {workIntent !== 'create' && pluginsDir && (
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
            {hints.scriptPath && (
              <div className="confirm-setup-inferred">{hints.scriptPath}</div>
            )}
          </div>
        )}

        {/* Reviewer — only for plugin/script tasks (not repo/general) */}
        {devKind !== 'repo' && allReviewers.length > 0 && (
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
            {hints.reviewerId && (
              <div className="confirm-setup-inferred">{hints.reviewerId}</div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
