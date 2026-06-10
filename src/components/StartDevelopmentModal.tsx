/**
 * StartDevelopmentModal — shown when the user clicks "Start Development"
 * from the Analyzed phase.
 *
 * Guides the user through a plugin/script development setup:
 *   • Shows current setup (customer, work kind, project, repository, template).
 *   • Shows readiness checklist (setup confirmed, tech plan, CRM metadata, project exists).
 *   • Offers inline project creation from the configured template — no extra form.
 *   • "Create + Generate Draft": creates project if missing, auto-generates tech plan if
 *     missing, generates draft, shows preview. No file is written before confirmation.
 *   • "Create + Save Draft + Open": same as above, then after preview confirmation saves
 *     files, opens Visual Studio, advances task to Development, and sets next step.
 *   • Moves the task to Development only on explicit "Start Development" confirmation.
 *
 * Safety gates:
 *   – Project is created ONLY when the user clicks a create button.
 *   – Draft generation shows a preview/diff (SkeletonPreviewModal) before any file write.
 *   – No AI-generated code is written to disk without explicit user confirmation in the preview.
 */

import { useState, useEffect } from 'react';
import type { Task, Customer } from '../types';
import type { TaskWorkflowPlan } from '../lib/workflowPlan';
import Modal from './Modal';
import Icon from './Icon';
import * as tauriApi from '../lib/tauriCommands';

interface Props {
  task: Task;
  customer: Customer | undefined;
  plan: TaskWorkflowPlan;
  pluginsDir: string | undefined;
  selectedPluginProject: string;
  repoRoot: string | undefined;
  scriptOpenPath: string | undefined;
  /** Path to the configured plugin template folder (settings.pluginTemplateFolder). */
  templateDir?: string;
  /** Verdict from the latest CRM verification report. */
  verificationVerdict?: string;
  /** Opens the existing plugin project in Visual Studio. */
  onOpenPlugin: () => Promise<void>;
  /** Triggers the Generate Draft flow (shows SkeletonPreviewModal). Caller responsible for closing. */
  onGenerateDraft: () => void;
  /**
   * Guided draft generation for "Create + Generate Draft": bypasses plan-approval gate,
   * auto-generates technical plan if missing. Returns a Promise that resolves when the
   * skeleton preview modal is open. The modal closes itself on success.
   */
  onGenerateDraftGuided: () => Promise<void>;
  /**
   * Same as onGenerateDraftGuided but arms a post-save callback:
   * after the user confirms save in SkeletonPreviewModal, VS is opened, the task moves
   * to in-progress, a note is appended, and the next step is set.
   */
  onGenerateDraftAndOpen: () => Promise<void>;
  /** Opens the full Create Plugin Project form (for name customisation / advanced options). */
  onCreatePlugin: () => void;
  /**
   * Called after a direct (no-form) project creation succeeds.
   * The caller should update task.selectedPluginProject and workflowSetup.pluginProject.
   */
  onProjectCreated: (projectName: string) => void;
  /** Moves task to in-progress + appends audit note. */
  onStartDevelopment: () => Promise<void>;
  onClose: () => void;
  /** Absolute path to the AI Kit repo from settings — when set, shows AI Kit section. */
  aiKitPath?: string;
  /** Called when user clicks "Implement with AI Kit" in this modal. */
  onImplementWithAiKit?: () => void;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', lineHeight: 1.5 }}>
      <span style={{ minWidth: 90, color: 'var(--text-muted)', flexShrink: 0, fontSize: 12 }}>{label}</span>
      <span style={{
        color: 'var(--text-secondary)', fontSize: 12,
        fontFamily: mono ? 'var(--font-mono, Consolas, monospace)' : undefined,
        wordBreak: 'break-all',
      }}>{value}</span>
    </div>
  );
}

function Check({ ok, warn, optional, done = 'OK', label, missing }: {
  ok: boolean; warn?: boolean; optional?: boolean;
  done?: string; label: string; missing: string;
}) {
  const icon  = ok ? '✓' : warn ? '!' : '·';
  const color = ok ? 'var(--color-done, #3fb950)' : warn ? 'var(--color-warning, #d29922)' : 'var(--text-muted)';
  return (
    <div style={{ display: 'flex', gap: 7, alignItems: 'baseline', fontSize: 12 }}>
      <span style={{ color, fontWeight: 700, minWidth: 12, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
      <span style={{ color: ok ? 'var(--text-muted)' : warn ? 'var(--color-warning, #d29922)' : 'var(--text-muted)', opacity: optional && !ok ? 0.6 : 1 }}>
        {ok ? `${label}: ${done}` : optional ? `${label}: ${missing} (optional)` : `${label}: ${missing}`}
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function StartDevelopmentModal({
  task, customer, plan,
  pluginsDir, selectedPluginProject,
  repoRoot, scriptOpenPath, templateDir, verificationVerdict,
  onOpenPlugin, onGenerateDraft, onGenerateDraftGuided, onGenerateDraftAndOpen,
  onCreatePlugin, onProjectCreated,
  onStartDevelopment, onClose,
  aiKitPath, onImplementWithAiKit,
}: Props) {
  const [pluginExists,        setPluginExists]        = useState<boolean | null>(null);
  const [starting,            setStarting]            = useState(false);
  const [opening,             setOpening]             = useState(false);
  const [creating,            setCreating]            = useState(false);
  const [creatingAndDraft,    setCreatingAndDraft]    = useState(false);
  const [creatingAndOpen,     setCreatingAndOpen]     = useState(false);
  const [creatingAndAiKit,    setCreatingAndAiKit]    = useState(false);
  const [progressMsg,         setProgressMsg]         = useState<string | null>(null);
  const [createMsg,           setCreateMsg]           = useState<{ ok: boolean; text: string } | null>(null);
  const [fsError,             setFsError]             = useState<string | null>(null);

  // Check whether the selected plugin project folder exists on disk.
  useEffect(() => {
    if (plan.targetKind !== 'plugin' || !pluginsDir || !selectedPluginProject) {
      setPluginExists(null);
      return;
    }
    const path = `${pluginsDir}/${selectedPluginProject}`;
    tauriApi.checkPathExists(path).then(setPluginExists).catch(() => setPluginExists(false));
  }, [plan.targetKind, pluginsDir, selectedPluginProject]);

  // Derived flags
  const isPlugin          = plan.targetKind === 'plugin';
  const isScript          = plan.targetKind === 'script';
  const isCreate          = task.workflowSetup?.workIntent === 'create';
  const setupConfirmed    = !!task.workflowSetup?.confirmedAt;
  const hasTechPlan       = !!task.crmDeveloperWorkflow?.technicalPlan;
  const verOk             = verificationVerdict === 'pass' || verificationVerdict === 'warnings';
  const verFail           = verificationVerdict === 'fail';
  const hasVer            = !!verificationVerdict && verificationVerdict !== 'none';
  const canOpenPlugin     = isPlugin && !!selectedPluginProject && pluginExists === true;
  const pluginNotFound    = isPlugin && !!selectedPluginProject && pluginExists === false;
  const noPluginSelected  = isPlugin && !selectedPluginProject;
  const canDirectCreate   = isPlugin && !!selectedPluginProject && !!pluginsDir && pluginExists !== true;
  const hasTemplate       = !!templateDir;

  // Display values
  const workKindLabel    = isPlugin ? 'Plugin' : isScript ? 'Script' : 'General';
  const workActionLabel  = isCreate ? 'Create' : (task.workflowSetup?.workIntent ?? 'Update');
  const targetLabel      = selectedPluginProject
    || (isScript ? task.workflowSetup?.scriptPath?.replace(/\\/g, '/').split('/').pop() ?? '' : '');

  // ── Direct project creation (no form) ────────────────────────────────────
  async function createProjectNow(): Promise<boolean> {
    if (!pluginsDir || !selectedPluginProject) return false;
    const ns = selectedPluginProject; // project name = default namespace
    try {
      await tauriApi.createPluginProjectFromTemplate(
        templateDir ?? '',
        pluginsDir,
        selectedPluginProject,
        ns,
        false,  // createInitialClass: false — Generate Draft creates the task-specific class
        true,   // legacyStyle: true (only matters when no custom template is configured)
      );
      onProjectCreated(selectedPluginProject);
      setPluginExists(true);
      return true;
    } catch (e) {
      setCreateMsg({ ok: false, text: String(e) });
      return false;
    }
  }

  async function handleCreateOnly() {
    setCreating(true);
    setCreateMsg(null);
    const ok = await createProjectNow();
    if (ok) setCreateMsg({ ok: true, text: `Project '${selectedPluginProject}' created successfully.` });
    setCreating(false);
  }

  // ── Create + Generate Draft ───────────────────────────────────────────────
  async function handleCreateAndDraft() {
    setCreatingAndDraft(true);
    setCreateMsg(null);
    setProgressMsg(null);
    try {
      if (pluginExists !== true) {
        setProgressMsg('Creating project...');
        const ok = await createProjectNow();
        if (!ok) return;
      }
      setProgressMsg('Generating draft...');
      await onGenerateDraftGuided();
      // Skeleton preview modal is now open in parent — close this modal.
      onClose();
    } catch (e) {
      setCreateMsg({ ok: false, text: String(e) });
    } finally {
      setCreatingAndDraft(false);
      setProgressMsg(null);
    }
  }

  // ── Create + Save Draft + Open ───────────────────────────────────────────
  async function handleCreateAndDraftAndOpen() {
    setCreatingAndOpen(true);
    setCreateMsg(null);
    setProgressMsg(null);
    try {
      if (pluginExists !== true) {
        setProgressMsg('Creating project...');
        const ok = await createProjectNow();
        if (!ok) return;
      }
      setProgressMsg('Generating draft...');
      await onGenerateDraftAndOpen();
      setProgressMsg('Waiting for preview confirmation...');
      // Skeleton preview modal is now open in parent — close this modal.
      onClose();
    } catch (e) {
      setCreateMsg({ ok: false, text: String(e) });
    } finally {
      setCreatingAndOpen(false);
      setProgressMsg(null);
    }
  }

  // ── Create + Implement with AI Kit ───────────────────────────────────────
  async function handleCreateAndImplementWithAiKit() {
    if (!onImplementWithAiKit) return;
    if (isPlugin && pluginExists !== true) {
      setCreatingAndAiKit(true);
      setCreateMsg(null);
      const ok = await createProjectNow();
      setCreatingAndAiKit(false);
      if (!ok) return;
    }
    onImplementWithAiKit();
    onClose();
  }

  // ── Existing action handlers ──────────────────────────────────────────────
  async function handleStartDev() {
    setStarting(true);
    try {
      await onStartDevelopment();
    } catch (e) {
      setFsError(String(e));
      setStarting(false);
    }
  }

  async function handleOpenPlugin() {
    setOpening(true);
    setFsError(null);
    try {
      await onOpenPlugin();
    } catch (e) {
      setFsError(String(e));
    } finally {
      setOpening(false);
    }
  }

  function handleGenerateDraftOnly() {
    onGenerateDraft();
    onClose();
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const anyBusy = creating || creatingAndDraft || creatingAndOpen || creatingAndAiKit || starting || opening;

  return (
    <Modal
      title="Start Development"
      size="md"
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
          {fsError && (
            <span style={{ fontSize: 11, color: 'var(--color-blocked, #e05555)', flex: 1, minWidth: 0 }}>
              {fsError}
            </span>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={anyBusy} type="button">Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleStartDev}
            disabled={anyBusy}
            title="Move task to Development phase (does not create project or generate code)"
            type="button"
          >
            {starting
              ? <><span className="btn-spinner" /> Starting…</>
              : <><Icon name="play" size={13} /> Start Development</>}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Setup summary ──────────────────────────────────────────── */}
        <section>
          <SectionLabel>Setup</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Row label="Customer"    value={customer?.name ?? 'Not assigned'} />
            <Row label="Work"        value={`${workKindLabel} · ${workActionLabel.charAt(0).toUpperCase() + workActionLabel.slice(1)}`} />
            {targetLabel && <Row label="Target"  value={targetLabel} />}
            {repoRoot   && <Row label="Repository" value={repoRoot.replace(/\\/g, '/')} mono />}
            {isPlugin && pluginsDir && <Row label="Plugins dir" value={pluginsDir.replace(/\\/g, '/')} mono />}
            {isPlugin && hasTemplate && <Row label="Template" value={templateDir!.replace(/\\/g, '/')} mono />}
            {isPlugin && !hasTemplate && (
              <Row label="Template" value="Built-in legacy CRM scaffold" />
            )}
          </div>
        </section>

        {/* ── Readiness ──────────────────────────────────────────────── */}
        <section>
          <SectionLabel>Readiness</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Check ok={setupConfirmed} label="Setup"          done="Confirmed"                missing="Not confirmed — use Confirm Setup first" />
            <Check ok={hasTechPlan}    label="Technical plan" done="Ready" optional           missing="None — will be auto-generated by draft actions" />
            {hasVer && (
              <Check ok={verOk} warn={verFail} label="CRM metadata"
                done={verificationVerdict === 'warnings' ? 'Verified with warnings' : 'Verified'}
                missing="Issues found" />
            )}
            {isPlugin && !!selectedPluginProject && (
              <Check ok={pluginExists === true} warn={pluginNotFound}
                label={`Plugin: ${selectedPluginProject}`} done="Found on disk" missing="Not found — create it below" />
            )}
            {isPlugin && !selectedPluginProject && (
              <Check ok={false} warn label="Plugin project" missing="No project selected — use Confirm Setup" />
            )}
          </div>
        </section>

        {/* ── Actions ────────────────────────────────────────────────── */}
        <section>
          <SectionLabel>Actions</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>

            {/* Plugin-specific action group */}
            {isPlugin && (
              <>
                {/* Create project inline (uses confirmed name — no extra form) */}
                {canDirectCreate && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleCreateOnly}
                    disabled={anyBusy}
                    title={`Create plugin project '${selectedPluginProject}' from ${hasTemplate ? 'configured template' : 'built-in legacy scaffold'}`}
                    type="button"
                  >
                    {creating
                      ? <><span className="btn-spinner" /> Creating project…</>
                      : <><Icon name="folder" size={13} /> Create Plugin Project</>}
                  </button>
                )}

                {/* Create + Generate Draft */}
                {plan.requiresDraftGeneration && !noPluginSelected && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleCreateAndDraft}
                    disabled={anyBusy || !setupConfirmed}
                    title={
                      !setupConfirmed ? 'Confirm setup before generating a draft'
                      : pluginExists !== true ? `Create project '${selectedPluginProject}' then generate draft (auto-generates technical plan if missing)`
                      : 'Generate plugin draft — auto-generates technical plan if missing, shows preview before writing any file'
                    }
                    type="button"
                  >
                    {creatingAndDraft
                      ? <><span className="btn-spinner" /> {progressMsg ?? 'Working…'}</>
                      : <><Icon name="layers" size={13} /> Create + Generate Draft</>}
                  </button>
                )}

                {/* Create + Save Draft + Open */}
                {plan.requiresDraftGeneration && !noPluginSelected && (
                  <button
                    className={`btn btn-sm ${setupConfirmed ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={handleCreateAndDraftAndOpen}
                    disabled={anyBusy || !setupConfirmed}
                    title={
                      !setupConfirmed ? 'Confirm setup before using this action'
                      : 'Create project if missing, generate draft, save after confirmation, open Visual Studio, move to Development'
                    }
                    type="button"
                  >
                    {creatingAndOpen
                      ? <><span className="btn-spinner" /> {progressMsg ?? 'Working…'}</>
                      : <><Icon name="play" size={13} /> Create + Save Draft + Open</>}
                  </button>
                )}

                {/* Create + Implement with AI Kit + Open */}
                {!!aiKitPath && !!onImplementWithAiKit && !noPluginSelected && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleCreateAndImplementWithAiKit}
                    disabled={anyBusy || !setupConfirmed}
                    title={
                      !setupConfirmed ? 'Confirm setup before using this action'
                      : pluginExists !== true
                        ? `Create project '${selectedPluginProject}', then implement using AI Kit rules`
                        : 'Implement using AI Kit rules — reads artifact, proposes changes, requires confirmation'
                    }
                    type="button"
                  >
                    {creatingAndAiKit
                      ? <><span className="btn-spinner" /> Creating project…</>
                      : <><Icon name="layers" size={13} /> Create + Implement with AI Kit + Open</>}
                  </button>
                )}

                {/* Open existing project in Visual Studio */}
                {canOpenPlugin && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleOpenPlugin}
                    disabled={anyBusy}
                    type="button"
                  >
                    <Icon name="terminal" size={13} /> {opening ? 'Opening…' : 'Open Plugin in Visual Studio'}
                  </button>
                )}

                {/* Inline feedback / progress */}
                {createMsg && (
                  <div style={{ fontSize: 11.5, color: createMsg.ok ? 'var(--color-done, #3fb950)' : 'var(--color-blocked, #e05555)', lineHeight: 1.5 }}>
                    {createMsg.ok ? '✓' : '!'} {createMsg.text}
                  </div>
                )}

                {/* Secondary: open full Create Project form for name customisation */}
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={onCreatePlugin}
                  disabled={anyBusy}
                  title="Open the Create Plugin Project form to customise the project name or options"
                  type="button"
                  style={{ fontSize: 11, alignSelf: 'flex-start' }}
                >
                  Customise project options…
                </button>
              </>
            )}

            {/* Script work */}
            {isScript && !!scriptOpenPath && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => tauriApi.openInVscode(scriptOpenPath).catch((e) => setFsError(String(e)))}
                disabled={anyBusy}
                type="button"
              >
                <Icon name="terminal" size={13} /> Open Script in VS Code
              </button>
            )}
            {isScript && !scriptOpenPath && (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
                No script target configured. Use Confirm Setup to select a script file.
              </p>
            )}

            {/* Script: Implement with AI Kit + Open */}
            {isScript && !!aiKitPath && !!onImplementWithAiKit && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => { onImplementWithAiKit(); onClose(); }}
                disabled={anyBusy}
                type="button"
                title="Implement using AI Kit rules — reads artifact, proposes changes, requires confirmation"
              >
                <Icon name="layers" size={13} /> Implement with AI Kit + Open
              </button>
            )}

            {/* Script-only draft generation (no project creation needed) */}
            {!isPlugin && plan.requiresDraftGeneration && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleGenerateDraftOnly}
                disabled={anyBusy || !setupConfirmed}
                title={!setupConfirmed ? 'Confirm setup before generating a draft' : 'Generate a draft using the technical plan as context'}
                type="button"
              >
                <Icon name="layers" size={13} /> Generate Draft
              </button>
            )}
          </div>
        </section>

      </div>
    </Modal>
  );
}
