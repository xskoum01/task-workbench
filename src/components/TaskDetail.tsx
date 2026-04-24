import { useState, useEffect, useRef } from 'react';
import type { Task, TaskStatus, PlanningBucket, SkeletonPreview, WorkflowSetup, AiFileReviewResult } from '../types';
import TaskEmailContent from './TaskEmailContent';
import TaskDevModePanel, { type TaskDevModePanelHandle } from './TaskDevModePanel';
import { useApp } from '../context/AppContext';
import { TypeBadge, SourceBadge } from './StatusBadge';
import ReplyModal from './ReplyModal';
import SkeletonPreviewModal from './SkeletonPreviewModal';
import ScriptAssistantPanel, { type ScriptAssistantPanelHandle } from './ScriptAssistantPanel';
import TaskForm from './TaskForm';
import CreatePluginProjectModal, { inferPluginSuggestions, sanitize } from './CreatePluginProjectModal';
import ConfirmSetupModal from './ConfirmSetupModal';
import Icon from './Icon';
import Modal from './Modal';
import AiReviewResultView from './AiReviewResultView';
import * as tauriApi from '../lib/tauriCommands';
import { WorkflowStepper } from './WorkflowStepper';
import { buildTaskWorkflowPlan } from '../lib/workflowPlan';
import { resolveTaskDevTarget, getPluginsDir } from '../lib/resolveTaskDevTarget';
import TaskModeSwitch from './TaskModeSwitch';
import { inferTaskMode } from '../lib/taskMode';
import { BUCKET_META, BUCKET_ORDER, computePlanning, effectiveBucket } from '../lib/planning';
import { isOverdue, formatRelativeDate } from '../lib/dates';

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
}

type AiAction = 'analyze' | 'reply' | 'draft';

function formatEffort(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours === 1) return '1h';
  return `${hours}h`;
}

// Bilingual analysis block
// ---------------------------------------------------------------------------

interface AnalysisLangBlockProps {
  lang: 'CZ' | 'EN';
  summary?: string;
  problems?: string[];
  actions?: string[];
  nextStep?: string;
  labelProblem: string;
  labelAction: string;
  labelNext: string;
}

function AnalysisLangBlock({
  lang, summary, problems, actions, nextStep,
  labelProblem, labelAction, labelNext,
}: AnalysisLangBlockProps) {
  const isCz       = lang === 'CZ';
  const hasProblems = problems && problems.length > 0;
  const hasActions  = actions  && actions.length  > 0;
  if (!summary && !hasProblems && !hasActions && !nextStep) return null;

  return (
    <div className="analysis-lang-block">
      <div className="analysis-lang-header">
        <span className={`detail-analysis-lang-badge${isCz ? ' detail-analysis-lang-badge--cz' : ''}`}>
          {lang}
        </span>
        {summary && <p className="detail-analysis-summary">{summary}</p>}
      </div>

      {hasProblems && (
        <div className="analysis-subsection">
          <span className="analysis-subsection-label">{labelProblem}</span>
          <ul className="detail-analysis-points">
            {problems!.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      {hasActions && (
        <div className="analysis-subsection">
          <span className="analysis-subsection-label">{labelAction}</span>
          <ul className="detail-analysis-points">
            {actions!.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </div>
      )}

      {nextStep && (
        <div className="detail-analysis-next">
          <span className="detail-analysis-next-label">{labelNext}:</span>
          {nextStep}
        </div>
      )}
    </div>
  );
}

/** Detects whether a TaskAnalysis has real Czech bilingual data (not just legacy English). */
function hasCzBilingualData(ar: NonNullable<Task['analysisResult']>): boolean {
  return !!(
    ar.summaryCz ||
    (ar.problemPointsCz && ar.problemPointsCz.length > 0) ||
    (ar.actionPointsCz  && ar.actionPointsCz.length  > 0) ||
    ar.nextStepCz
  );
}

/** Detects whether a TaskAnalysis has real English bilingual data. */
function hasEnBilingualData(ar: NonNullable<Task['analysisResult']>): boolean {
  return !!(
    ar.summaryEn ||
    (ar.problemPointsEn && ar.problemPointsEn.length > 0) ||
    (ar.actionPointsEn  && ar.actionPointsEn.length  > 0) ||
    ar.nextStepEn
  );
}

/**
 * Renders the AI analysis block in one of three modes:
 *   - Bilingual: CZ block + EN block (when fresh analysis is present)
 *   - Partial:   only the language block that has data
 *   - Legacy:    one English-only block + re-run hint (old stored tasks)
 */
function AnalysisBlock({ result }: { result: NonNullable<Task['analysisResult']> }) {
  const hasCz = hasCzBilingualData(result);
  const hasEn = hasEnBilingualData(result);
  const hasBilingual = hasCz || hasEn;

  if (hasBilingual) {
    return (
      <div className="detail-analysis-block">
        {hasCz && (
          <AnalysisLangBlock
            lang="CZ"
            summary={result.summaryCz}
            problems={result.problemPointsCz}
            actions={result.actionPointsCz}
            nextStep={result.nextStepCz}
            labelProblem="Problém"
            labelAction="Co udělat"
            labelNext="Další krok"
          />
        )}
        {hasCz && hasEn && <div className="detail-analysis-divider" />}
        {hasEn && (
          <AnalysisLangBlock
            lang="EN"
            summary={result.summaryEn}
            problems={result.problemPointsEn}
            actions={result.actionPointsEn}
            nextStep={result.nextStepEn}
            labelProblem="Problem"
            labelAction="What to do"
            labelNext="Next step"
          />
        )}
      </div>
    );
  }

  // Legacy mode — old task with English-only analysis
  return (
    <div className="detail-analysis-block">
      <div className="analysis-legacy-block">
        {result.summary && <p className="detail-analysis-summary">{result.summary}</p>}
        {result.problemPoints && result.problemPoints.length > 0 && (
          <div className="analysis-subsection">
            <span className="analysis-subsection-label">Problem</span>
            <ul className="detail-analysis-points">
              {result.problemPoints.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          </div>
        )}
        {result.nextStep && (
          <div className="detail-analysis-next">
            <span className="detail-analysis-next-label">Next step:</span>
            {result.nextStep}
          </div>
        )}
      </div>
      <p className="analysis-rerun-hint">
        Click Analyze to generate a new analysis.
      </p>
    </div>
  );
}

interface PlanningSectionProps {
  task: Task;
}

function PlanningSection({ task }: PlanningSectionProps) {
  const computed  = computePlanning(task);
  const score     = task.priorityScore  ?? computed.priorityScore;
  const reason    = task.priorityReason ?? computed.priorityReason;
  const bucket    = effectiveBucket(task);
  const suggested = task.suggestedPlanningBucket ?? computed.suggestedPlanningBucket;

  // Whether the user manually overrode the suggestion
  const isManual   = !!task.isPlanningLocked;
  // Whether the manual choice differs from the current suggestion
  const isMismatch = isManual && task.planningBucket && task.planningBucket !== suggested;
  // Overdue check
  const taskOverdue = task.dueAt ? isOverdue(task.dueAt, task.status) : false;

  const scoreClass = score >= 80
    ? 'planning-score--high'
    : score >= 50
      ? 'planning-score--mid'
      : 'planning-score--low';

  return (
    <div className="detail-section detail-planning-section">
      <span className="detail-section-label">Planning</span>

      {/* Due date + effort row */}
      {(task.dueAt || task.estimatedEffort !== undefined) && (
        <div className="detail-planning-meta">
          {task.dueAt && (
            <div className={`detail-planning-meta-item${taskOverdue ? ' detail-planning-meta-item--overdue' : ''}`}>
              <Icon name="due" size={12} className="detail-planning-meta-icon" />
              <span className="detail-planning-meta-label">Due</span>
              <span className="detail-planning-meta-value">
                {formatRelativeDate(task.dueAt, task.status)}
                {taskOverdue && <span className="overdue-badge overdue-badge--inline">overdue</span>}
              </span>
            </div>
          )}
          {task.estimatedEffort !== undefined && (
            <div className="detail-planning-meta-item">
              <Icon name="effort" size={12} className="detail-planning-meta-icon" />
              <span className="detail-planning-meta-label">Effort</span>
              <span className="detail-planning-meta-value">{formatEffort(task.estimatedEffort)}</span>
            </div>
          )}
        </div>
      )}

      {/* Effective bucket + lock / suggestion indicators */}
      <div className="detail-planning-bucket-row">
        <span className={`planning-bucket-pill planning-bucket-pill--${bucket}`}>
          <Icon name={BUCKET_META[bucket].icon} size={11} />
          {BUCKET_META[bucket].label}
        </span>
        {isManual ? (
          <span className="detail-planning-locked" title="Planning manually locked">
            <Icon name="pin" size={11} /> manual
          </span>
        ) : (
          <span className="detail-planning-auto" title="Auto-suggested by rule engine">
            <Icon name="bolt" size={11} /> auto
          </span>
        )}
        {isMismatch && suggested && (
          <span className="detail-planning-suggestion" title="Auto-suggestion differs from manual choice">
            â†’ suggested: {BUCKET_META[suggested].label}
          </span>
        )}
      </div>

      {/* Priority score */}
      <div className="detail-planning-score-row">
        <span className="detail-planning-score-label">Priority</span>
        <div className="detail-planning-score-bar-wrap">
          <div className={`detail-planning-score-bar ${scoreClass}`} style={{ width: `${score}%` }} />
        </div>
        <span className={`detail-planning-score-num ${scoreClass}`}>{score}</span>
      </div>
      {reason && (
        <span className="detail-planning-reason">{reason}</span>
      )}
    </div>
  );
}

export default function TaskDetail({ task, onClose }: TaskDetailProps) {
  const { updateTask, deleteTask, getCustomerById, customers, settings, crmFolders, resolveOrCreateCustomerByFolder } = useApp();
  const customer = getCustomerById(task.customerId);

  // Effective VS Code path: prefer explicit paths, fall back to crmBaseDirectory + folderName.
  const crmFolderPath = (settings?.crmBaseDirectory && customer?.folderName)
    ? `${settings.crmBaseDirectory}/${customer.folderName}`
    : undefined;

  // Smart resolver — picks plugin / script / repo based on task heuristics.
  // When the user has confirmed a setup, devTargetKind overrides the heuristic.
  const heuristicDevTarget = resolveTaskDevTarget(task, customer, crmFolderPath);
  const devTarget = task.workflowSetup?.devTargetKind
    ? { ...heuristicDevTarget, kind: task.workflowSetup.devTargetKind as typeof heuristicDevTarget.kind }
    : heuristicDevTarget;
  const effectiveVscodePath = devTarget.path;

  // Resolved script folder: prefer confirmed scriptPath, then explicit scriptFolder, then fallback.
  // Must be consistent with resolveCustomerScriptFolder in scriptAssistant.ts.
  const repoFallback = customer?.resolvedRepositoryPath ?? customer?.repositoryRoot;
  const effectiveScriptFolder =
    (devTarget.kind === 'script' ? task.workflowSetup?.scriptPath : undefined) ??
    customer?.scriptFolder ??
    (repoFallback ? `${repoFallback}/Scripts` : undefined) ??
    (devTarget.kind !== 'plugin' ? effectiveVscodePath : undefined);

  // Container directory for plugin project subfolders.
  const pluginsDir = getPluginsDir(customer, crmFolderPath);
  // Root used for git operations (branch switching).
  const repoRootForGit = customer?.resolvedRepositoryPath ?? customer?.repositoryRoot;

  // Inline feedback message (e.g. "Analysis recorded")
  const [feedback, setFeedback] = useState<string | null>(null);
  // Filesystem error message
  const [fsError, setFsError]   = useState<string | null>(null);
  // AI error message
  const [aiError, setAiError]   = useState<string | null>(null);
  // Which AI action is currently running
  const [aiLoading, setAiLoading] = useState<AiAction | null>(null);
  // Confirm setup modal (shown for New tasks before Analyze)
  const [showSetupModal, setShowSetupModal] = useState(false);
  // Reply modal
  const [showReply, setShowReply]         = useState(false);
  const [generatedReply, setGeneratedReply] = useState<string | null>(null);
  // Draft (plugin skeleton or script preview)
  const [showSkeleton, setShowSkeleton]       = useState(false);
  const [skeletonPreview, setSkeletonPreview] = useState<SkeletonPreview | null>(null);
  // Create Plugin Project modal
  const [showCreatePlugin, setShowCreatePlugin] = useState(false);
  // Plugin project folder names loaded when the Create Plugin Project modal opens.
  // Used to improve naming-convention auto-suggestions inside the modal.
  const [pluginProjectsForModal, setPluginProjectsForModal] = useState<string[]>([]);
  // Script Assistant imperative ref + draft-ready flag
  const scriptPanelRef = useRef<ScriptAssistantPanelHandle>(null);
  const devModePanelRef  = useRef<TaskDevModePanelHandle>(null);
  const [scriptHasDraft, setScriptHasDraft] = useState(false);
  // Refresh counter for the Dev panel — increment after creating a new plugin project.
  const [devPanelRefreshTick, setDevPanelRefreshTick] = useState(0);
  // Edit task form
  const [showEditForm, setShowEditForm] = useState(false);
  // Delete confirmation step
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Notes — local state, saved on blur
  const [notes, setNotes] = useState(task.notes ?? '');
  // Keep notes in sync when task changes (e.g. different task selected)
  useEffect(() => { setNotes(task.notes ?? ''); }, [task.id, task.notes]);
  // Reset script draft flag when switching tasks
  useEffect(() => { setScriptHasDraft(false); }, [task.id]);
  // AI Code Review — modal state for viewing a saved review
  const [showSavedReviewModal, setShowSavedReviewModal] = useState(false);
  const latestReview = task.aiFileReviews?.[0];

  // Persists a new AI review result on the task (newest first, capped at 5).
  async function handleReviewSaved(review: AiFileReviewResult) {
    const existing = task.aiFileReviews ?? [];
    const updated = [review, ...existing].slice(0, 5);
    await updateTask(task.id, { aiFileReviews: updated });
  }

  // Centralized workflow plan — drives BPF stages, action labels, feature flags.
  // Pass the heuristic devTarget kind so tasks without confirmed setup still work.
  const plan = buildTaskWorkflowPlan(task, heuristicDevTarget.kind);
  const { mode: effectiveMode } = inferTaskMode(task);

  async function handleSetMode(mode: 'developer' | 'general') {
    await updateTask(task.id, { taskMode: mode });
  }

  // Selected plugin project: prefer confirmed setup, then persisted task field.
  const selectedPluginProject = task.workflowSetup?.pluginProject ?? task.selectedPluginProject ?? '';
  function handleSelectedPluginChange(plugin: string) {
    updateTask(task.id, { selectedPluginProject: plugin || undefined }).catch(() => {});
  }

  /**
   * Called by TaskDevModePanel when a refresh reveals the persisted plugin project
   * folder no longer exists on disk.
   * Preserves the project name as desiredPluginProject so the Create Plugin Project
   * modal can be prefilled, and resets the workflow back to "Create Plugin Project".
   */
  async function handlePluginProjectMissing(projectName: string) {
    const currentArtifact = task.workflowSetup?.artifactPath;
    const artifactInsideProject = currentArtifact &&
      (currentArtifact.replace(/\\/g, '/').includes(`/${projectName}/`));
    await updateTask(task.id, {
      selectedPluginProject: undefined,
      workflowSetup: {
        ...task.workflowSetup,
        pluginProject:        undefined,
        desiredPluginProject: task.workflowSetup?.desiredPluginProject ?? projectName,
        artifactPath:         artifactInsideProject ? undefined : currentArtifact,
      },
    });
    setFeedback(`Plugin project '${projectName}' not found on disk — reset to Create state.`);
  }


  // --- Status change ---

  async function handleStatusChange(status: TaskStatus) {
    await updateTask(task.id, { status });
  }

  // --- Delete ---

  async function handleDelete() {
    await deleteTask(task.id);
    setConfirmDelete(false);
  }

  // --- Notes ---

  async function handleNotesSave() {
    await updateTask(task.id, { notes });
  }

  // --- Helpers ---

  function formatDate(iso: string | undefined): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  // --- Workflow actions ---

  async function handleAnalyze() {
    await handleAnalyzeWithSetup(undefined);
  }

  /**
   * Runs AI analysis and persists the result in a single updateTask call.
   * When `extraSetup` is provided (e.g. from Confirm Setup), it is merged into
   * the same update so that workflowSetup and status are never split across two
   * updateTask calls (which would lose the setup due to React stale closures).
   */
  async function handleAnalyzeWithSetup(extraSetup: import('../types').WorkflowSetup | undefined) {
    setAiLoading('analyze');
    setAiError(null);
    try {
      const result = await tauriApi.analyzeTask(task, customer ?? null);
      await updateTask(task.id, {
        ...(extraSetup !== undefined ? { workflowSetup: extraSetup } : {}),
        status:         'analyzed',
        analysisResult: result,
        confidence:     result.confidence,
      });
      setFeedback('AI analysis complete — status set to Analyzed');
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiLoading(null);
    }
  }

  async function handleGenerateDraft() {
    if (devTarget.kind === 'plugin') {
      // For Create+Plugin: verify the project folder exists before generating.
      // This prevents draft generation from silently targeting a missing project.
      if (plan.requiresPluginCreate === false && selectedPluginProject && pluginsDir) {
        const projectPath = `${pluginsDir}/${selectedPluginProject}`;
        const exists = await tauriApi.checkPathExists(projectPath).catch(() => false);
        if (!exists) {
          // Project folder was deleted — reset workflow back to Create Plugin Project.
          await handlePluginProjectMissing(selectedPluginProject);
          setAiError(`Plugin project '${selectedPluginProject}' no longer exists. Create it again first.`);
          return;
        }
      }
      // Plugin: call AI to generate a C# skeleton, then open preview modal.
      setAiLoading('draft');
      setAiError(null);
      try {
        const preview = await tauriApi.generateSkeletonPreview(task, customer ?? null);
        setSkeletonPreview(preview);
        setShowSkeleton(true);
        await updateTask(task.id, { status: 'in-progress' });
        setFeedback('Draft generated — status set to In Progress');
      } catch (e) {
        setAiError(String(e));
      } finally {
        setAiLoading(null);
      }
    } else {
      // Script: delegate to the Script Assistant panel (runs full Analyze→Plan→Skeleton→Preview chain).
      if (!scriptPanelRef.current) {
        setAiError('Script Assistant panel is not available for this task.');
        return;
      }
      setAiLoading('draft');
      setAiError(null);
      try {
        await scriptPanelRef.current.generateDraft();
        await updateTask(task.id, { status: 'in-progress' });
        setFeedback('Draft generated — status set to In Progress');
        // setScriptHasDraft is driven by onDraftChange callback from the panel.
      } catch (e) {
        setAiError(String(e));
      } finally {
        setAiLoading(null);
      }
    }
  }

  async function handleApplyDraft() {
    if (devTarget.kind === 'plugin') {
      // Plugin: write the skeleton preview to disk then complete the workflow.
      if (!skeletonPreview) {
        setFeedback('Generate a draft first before applying.');
        return;
      }
      if (!pluginsDir) {
        setFsError('No plugin folder configured for this customer.');
        return;
      }
      if (!selectedPluginProject) {
        setFsError('Select a plugin project in the Dev panel before applying the draft.');
        return;
      }
      // The VS solution layout is always:
      //   <pluginsDir>/<selectedProject>/          ← solution root
      //   <pluginsDir>/<selectedProject>/<selectedProject>/  ← C# project folder (where .cs lives)
      // Ignore AI-supplied targetPath for the subfolder — it is unreliable.
      const subPath = `${pluginsDir}/${selectedPluginProject}/${selectedPluginProject}/${skeletonPreview.fileName}`;
      try {
        await tauriApi.saveGeneratedFile(subPath, skeletonPreview.content);
      } catch (e) {
        setFsError(String(e));
        return; // file write failed — do not advance state
      }
      // File saved — complete the rest of the workflow.
      await completePluginDraft(selectedPluginProject, subPath);
    } else {
      // Script: delegate to the Script Assistant panel apply step.
      if (!scriptPanelRef.current) return;
      setAiLoading('draft');
      setAiError(null);
      try {
        const writtenPath = await scriptPanelRef.current.applyDraft();
        // Persist the created file path so subsequent Open/AI Review can use it directly.
        if (writtenPath) {
          await updateTask(task.id, {
            workflowSetup: { ...task.workflowSetup, artifactPath: writtenPath },
          });
        }
        setFeedback('Script draft applied.');
      } catch (e) {
        setAiError(String(e));
      } finally {
        setAiLoading(null);
      }
    }
  }

  /**
   * Tries to open the plugin project in Visual Studio (.sln) or VS Code (.csproj / folder).
   * Resolves without throwing — call-sites handle open errors via the returned message.
   */
  async function openPluginProject(projectName: string): Promise<string | null> {
    if (!pluginsDir) return 'No plugin folder configured.';
    const solutionRoot = `${pluginsDir}/${projectName}`;
    try {
      const slns = await tauriApi.listDirectoryFiles(solutionRoot, 'sln').catch(() => [] as string[]);
      if (slns.length > 0) {
        await tauriApi.openWithShell(`${solutionRoot}/${slns[0]}`);
        return null;
      }
      const projDir  = `${solutionRoot}/${projectName}`;
      const csprojs  = await tauriApi.listDirectoryFiles(projDir, 'csproj').catch(() => [] as string[]);
      if (csprojs.length > 0) {
        await tauriApi.openWithShell(`${projDir}/${csprojs[0]}`);
        return null;
      }
      // No .sln or .csproj — open the solution root folder with the OS default (Explorer).
      await tauriApi.openWithShell(solutionRoot);
      return null;
    } catch (e) {
      return String(e);
    }
  }

  /**
   * Completes the plugin draft apply workflow after the .cs file has been written.
   * Updates task state, closes the skeleton modal, refreshes the dev panel, and
   * opens the plugin project in Visual Studio or VS Code.
   */
  async function completePluginDraft(projectName: string, writtenFilePath: string) {
    // Persist everything in one atomic update so React closures are never stale.
    await updateTask(task.id, {
      status: 'in-progress',
      selectedPluginProject: projectName,
      workflowSetup: {
        ...task.workflowSetup,
        devTargetKind:        'plugin',
        pluginProject:        projectName,
        desiredPluginProject: undefined,
        artifactPath:         writtenFilePath,
      },
    });
    // Close the skeleton modal and clear preview state.
    setSkeletonPreview(null);
    setShowSkeleton(false);
    // Refresh the dev panel so the dropdown picks up the project.
    setDevPanelRefreshTick((t) => t + 1);
    // Try to open the project — failure is non-fatal: file and state are already saved.
    const openError = await openPluginProject(projectName);
    if (openError) {
      setFeedback(`Draft saved, opening failed: ${openError}`);
    } else {
      setFeedback(`Draft saved and plugin opened: ${projectName}`);
    }
  }

  // --- Communication ---

  async function handleSendForReview() {
    // Run the AI file review via the dev panel's imperative handle.
    // Status advances only if the review succeeds.
    if (!devModePanelRef.current) {
      // Dev panel not mounted (e.g. no repo path configured) — fall back to direct status change.
      await handleStatusChange('ready-for-review');
      setFeedback('Status set to Ready for Review');
      return;
    }
    const ok = await devModePanelRef.current.runReview();
    if (ok) {
      await handleStatusChange('ready-for-review');
      setFeedback('AI review complete — status set to Ready for Review');
    }
    // On failure, reviewError is shown inside the dev panel — status unchanged.
  }

  async function handleMarkDone() {
    await handleStatusChange('done');
    setFeedback('Task marked as Done');
  }

  /**
   * Opens the code artifact for the task and advances to In Progress.
   * Used for Update / Fix scenarios where the task works on an existing file.
   */
  async function handleStartWork() {
    const artifact = task.workflowSetup?.artifactPath;
    try {
      if (artifact) {
        // A file was already created by Apply Draft — open it directly.
        await tauriApi.openInVscode(artifact);
      } else if (devTarget.kind === 'plugin' && pluginsDir && selectedPluginProject) {        const pluginPath = `${pluginsDir}/${selectedPluginProject}`;
        // Prefer .sln for Visual Studio, fall back to .csproj / folder.
        const slns = await tauriApi.listDirectoryFiles(pluginPath, 'sln').catch(() => [] as string[]);
        if (slns.length > 0) {
          await tauriApi.openWithShell(`${pluginPath}/${slns[0]}`);
        } else {
          await tauriApi.openInVscode(pluginPath);
        }
      } else if (devTarget.kind === 'script' && effectiveScriptFolder) {
        await tauriApi.openInVscode(effectiveScriptFolder);
      } else if (effectiveVscodePath) {
        await tauriApi.openInVscode(effectiveVscodePath);
      }
    } catch (e) {
      setFsError(String(e));
    }
    // Advance status regardless — user may have already opened the file manually.
    await handleStatusChange('in-progress');
    setFeedback('Status set to In Progress — start working in the opened project');
  }

  /**
   * Single dispatcher for all stage-advancing actions.
   * Called by the BPF stepper and by right-panel buttons.
   * Uses the centralized workflow plan so the action matches the stage.
   */
  function runCurrentStageAction() {
    switch (plan.currentAction) {
      case 'analyze':
        // Developer-awaiting-setup tasks never reach this branch (they use 'confirm-setup').
        // For general tasks and re-opened developer tasks: open setup modal on first run,
        // then analyze directly on subsequent runs.
        if (!task.workflowSetup?.confirmedAt) {
          setShowSetupModal(true);
        } else {
          handleAnalyze();
        }
        break;
      case 'confirm-setup':          setShowSetupModal(true);  break;
      case 'create-plugin-project':  {
        // Open CreatePluginProjectModal — first load existing folders for naming suggestions.
        tauriApi.listSubfolders(pluginsDir ?? '').catch(() => [] as string[]).then((folders) => {
          setPluginProjectsForModal(folders);
          setShowCreatePlugin(true);
        });
        break;
      }
      case 'generate-draft':         handleGenerateDraft();     break;
      case 'start-work':     handleStartWork();         break;
      case 'run-review':     handleSendForReview();     break;
      case 'mark-done':      handleMarkDone();          break;
      default: break;
    }
  }

  /** Called when the user clicks Confirm & Analyze in the setup modal. */
  async function handleConfirmSetup(setup: WorkflowSetup) {
    setShowSetupModal(false);

    // When the modal provides an artifactPath (Update/Fix/Review — user chose an existing
    // file), that selection wins unconditionally over any stale existing artifact.
    // For Create workflows the modal sends artifactPath=undefined and we fall back to
    // preserving the previously created file if the setup is still compatible.
    let artifactPath: string | undefined = setup.artifactPath;

    if (artifactPath === undefined) {
      const existingArtifact = task.workflowSetup?.artifactPath;
      if (existingArtifact) {
        const newKind    = setup.devTargetKind;
        const newIntent  = setup.workIntent;
        const prevIntent = task.workflowSetup?.workIntent;

        const lower = existingArtifact.toLowerCase();
        const matchesScript = lower.endsWith('.js') || lower.endsWith('.ts');
        const matchesPlugin = lower.endsWith('.cs');
        const isNowCreate   = newIntent === 'create';
        const intentChanged = newIntent !== prevIntent;

        const extensionMismatch =
          (newKind === 'script' && !matchesScript) ||
          (newKind === 'plugin' && !matchesPlugin);

        const kindChanged = newKind !== task.workflowSetup?.devTargetKind;

        // Keep existing artifact only when kind/extension still match and we are
        // staying in Create intent (the artifact was produced by Apply Draft).
        if (!kindChanged && !extensionMismatch && !(intentChanged && !isNowCreate)) {
          artifactPath = existingArtifact;
        }
      }
    }

    const mergedSetup: WorkflowSetup = { ...setup, artifactPath };
    // Persist the confirmed setup AND analysis result in one atomic updateTask call.
    await handleAnalyzeWithSetup(mergedSetup);
  }

      // Determine whether the artifact extension matches the new target kind.
  async function handleGenerateReply() {
    setAiLoading('reply');
    setAiError(null);
    try {
      const draft = await tauriApi.generateReply(task, customer ?? null);
      await updateTask(task.id, { generatedReply: draft });
      setGeneratedReply(draft);
    } catch (e) {
      // Fall back to local template — open modal anyway
      setGeneratedReply(null);
      setAiError(String(e));
    } finally {
      setAiLoading(null);
      setShowReply(true);
    }
  }

  // --- Planning actions ---

  async function handleSetBucket(bucket: PlanningBucket) {
    const planning = computePlanning(task);
    await updateTask(task.id, {
      planningBucket:          bucket,
      suggestedPlanningBucket: planning.suggestedPlanningBucket,
      priorityScore:           planning.priorityScore,
      priorityReason:          planning.priorityReason,
      isPlanningLocked:        true,
    });
    setFeedback(`Planned for: ${BUCKET_META[bucket].label}`);
  }

  async function handleToggleLock() {
    const next = !task.isPlanningLocked;
    await updateTask(task.id, { isPlanningLocked: next });
    setFeedback(next ? 'Planning locked to manual choice' : 'Planning unlocked — auto-suggest active');
  }

  // --- URL actions ---

  function handleOpenUrl(url: string | undefined) {
    if (!url) return;
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    tauriApi.openUrl(href).catch((err) => {
      console.warn('openUrl failed, falling back to window.open:', err);
      window.open(href, '_blank', 'noopener,noreferrer');
    });
  }

  // --- Filesystem actions ---

  async function handleOpenPath(path: string | undefined, label: string) {
    if (!path) {
      setFsError(`No ${label} configured for this customer.`);
      return;
    }
    try {
      await tauriApi.openPath(path);
    } catch (e) {
      setFsError(String(e));
    }
  }

  // Determine which filesystem buttons are relevant
  const hasRepo    = !!customer?.repositoryRoot;
  const hasPlugin  = !!customer?.pluginFolder;
  const hasScript  = !!customer?.scriptFolder;
  // Show VS Code button whenever any path is resolvable (including CRM folder)
  const hasVscodePath = !!effectiveVscodePath;
  const hasAnyPath = hasRepo || hasPlugin || hasScript || hasVscodePath;

  return (
    <>
      <aside className="detail-panel">

        {/* ---- Header ---- */}
        <div className="detail-panel-header">
          <button
            className="detail-panel-back"
            onClick={onClose}
            title="Back to list"
          >
            <Icon name="arrow-left" size={14} /> Back
          </button>

          <div className="detail-panel-header-content">
            <div className="detail-panel-title">{task.title}</div>
            <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
              <TypeBadge type={task.taskType} />
              {task.analysisResult && (
                <span className="detail-ai-badge">AI</span>
              )}
            </div>
          </div>

          <button
            className="detail-panel-edit"
            onClick={() => setShowEditForm(true)}
            title="Edit task"
          >
            <Icon name="pencil" size={14} />
          </button>
          {confirmDelete ? (
            <>
              <button
                className="btn btn-danger btn-sm"
                onClick={handleDelete}
                title="Confirm delete"
              >
                Delete
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmDelete(false)}
                title="Cancel delete"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="detail-panel-delete"
              onClick={() => setConfirmDelete(true)}
              title="Delete task"
            >
              <Icon name="trash-2" size={14} />
            </button>
          )}
        </div>

        {/* ---- Workflow BPF strip (always visible, never scrolls) ---- */}
        <WorkflowStepper
          status={task.status}
          stages={plan.stages}
          onRunCurrentAction={runCurrentStageAction}
          isRunning={!!aiLoading}
        />

        {/* ---- Two-column inner layout ---- */}
        <div className="detail-panel-inner">

        {/* ---- Body ---- */}
        <div className="detail-panel-body">

          {/* Meta grid */}
          <div className="detail-meta-grid">
            <div className="detail-section">
              <span className="detail-section-label">Source</span>
              <SourceBadge source={task.source} />
            </div>

            <div className="detail-section">
              <span className="detail-section-label">Received</span>
              <span className="detail-section-value">
                {formatDate(task.receivedAt)}
              </span>
            </div>

            <div className="detail-section">
              <span className="detail-section-label">Customer</span>
              {customer ? (
                <span className="detail-section-value">{customer.name}</span>
              ) : (
                <div className="detail-customer-unresolved">
                  <span className="detail-customer-missing">No customer assigned</span>
                  {(customers.length > 0 || crmFolders.length > 0) && (
                    <select
                      className="detail-customer-select"
                      value=""
                      title="Assign customer"
                      onChange={async (e) => {
                        const val = e.target.value;
                        if (!val) return;
                        let customerId: string;
                        if (val.startsWith('crm:')) {
                          customerId = await resolveOrCreateCustomerByFolder(val.slice(4));
                        } else {
                          customerId = val;
                        }
                        await updateTask(task.id, { customerId });
                      }}
                    >
                      <option value="" disabled>Assign customer…</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                      {crmFolders
                        .filter((f) => !customers.some((c) => c.folderName?.toLowerCase() === f.toLowerCase()))
                        .map((f) => (
                          <option key={`crm:${f}`} value={`crm:${f}`}>{f}</option>
                        ))}
                    </select>
                  )}
                </div>
              )}
            </div>

            <div className="detail-section">
              <span className="detail-section-label">Task Type</span>
              <TypeBadge type={task.taskType} />
            </div>
          </div>

          {/* Customer repository info */}
          {customer && (hasRepo || hasPlugin || hasScript || customer.namespace) && (
            <div className="detail-section">
              <span className="detail-section-label">Repository</span>
              <div className="detail-repo-block">
                {customer.repositoryName && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">Name</span>
                    <span className="detail-repo-value">{customer.repositoryName}</span>
                  </div>
                )}
                {customer.namespace && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">NS</span>
                    <span className="detail-repo-value">{customer.namespace}</span>
                  </div>
                )}
                {customer.repositoryRoot && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">Root</span>
                    <span className="detail-repo-value">{customer.repositoryRoot}</span>
                  </div>
                )}
                {customer.pluginFolder && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">Plugin</span>
                    <span className="detail-repo-value">{customer.pluginFolder}</span>
                  </div>
                )}
                {customer.scriptFolder && (
                  <div className="detail-repo-row">
                    <span className="detail-repo-label">Scripts</span>
                    <span className="detail-repo-value">{customer.scriptFolder}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Original message */}
          <div className="detail-section">
            <span className="detail-section-label">Original Message</span>
            {task.originalMessage ? (
              task.source === 'email' ? (
                <TaskEmailContent task={task} />
              ) : (
                <div className="detail-message">
                  <div className="email-body" style={{ padding: 'var(--gap-md) var(--gap-lg)' }}>
                    {task.originalMessage}
                  </div>
                </div>
              )
            ) : (
              <span className="detail-empty-inline">No message provided</span>
            )}
          </div>

          {/* Notes */}
          <div className="detail-section">
            <span className="detail-section-label">Notes</span>
            <textarea
              className="detail-notes-textarea"
              value={notes}
              placeholder="Write notes, context, or reminders…"
              onChange={(e) => setNotes(e.target.value)}
              onBlur={handleNotesSave}
            />
          </div>

          {/* Azure DevOps context — shown for ADO-sourced tasks with parsed metadata */}
          {task.adoContext && task.adoContext.type !== 'other' && (
            <div className="detail-section detail-ado-section">
              <span className="detail-section-label">
                {task.adoContext.type === 'pr-comment' ? 'PR Review Context' : 'Work Item Context'}
              </span>
              <div className="detail-ado-block">
                {/* PR comment fields */}
                {task.adoContext.type === 'pr-comment' && (
                  <>
                    {task.adoContext.prNumber && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">PR</span>
                        <span className="detail-ado-value">#{task.adoContext.prNumber}</span>
                      </div>
                    )}
                    {task.adoContext.reviewerName && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Reviewer</span>
                        <span className="detail-ado-value">{task.adoContext.reviewerName}</span>
                      </div>
                    )}
                    {task.adoContext.commentedFile && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">File</span>
                        <span className="detail-ado-value detail-ado-value--code">{task.adoContext.commentedFile}</span>
                      </div>
                    )}
                    {task.adoContext.reviewComment && (
                      <div className="detail-ado-comment">
                        <span className="detail-ado-comment-label">Comment:</span>
                        <div className="detail-ado-comment-body">{task.adoContext.reviewComment}</div>
                      </div>
                    )}
                  </>
                )}
                {/* Work item fields */}
                {task.adoContext.type === 'work-item' && (
                  <>
                    {task.adoContext.workItemNumber && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">{task.adoContext.workItemType ?? 'Item'}</span>
                        <span className="detail-ado-value">#{task.adoContext.workItemNumber}</span>
                      </div>
                    )}
                    {task.adoContext.workItemState && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">State</span>
                        <span className="detail-ado-value">{task.adoContext.workItemState}</span>
                      </div>
                    )}
                    {task.adoContext.workItemAssignedTo && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Assigned</span>
                        <span className="detail-ado-value">{task.adoContext.workItemAssignedTo}</span>
                      </div>
                    )}
                    {task.adoContext.workItemPriority && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Priority</span>
                        <span className="detail-ado-value">{task.adoContext.workItemPriority}</span>
                      </div>
                    )}
                    {task.adoContext.workItemAreaPath && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Area</span>
                        <span className="detail-ado-value">{task.adoContext.workItemAreaPath}</span>
                      </div>
                    )}
                    {task.adoContext.workItemIterationPath && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">Iteration</span>
                        <span className="detail-ado-value">{task.adoContext.workItemIterationPath}</span>
                      </div>
                    )}
                    {task.adoContext.workItemDescription && (
                      <div className="detail-ado-comment">
                        <span className="detail-ado-comment-label">Description:</span>
                        <div className="detail-ado-comment-body">{task.adoContext.workItemDescription}</div>
                      </div>
                    )}
                    {task.adoContext.workItemUrl && (
                      <div className="detail-ado-row">
                        <span className="detail-ado-label">DevOps</span>
                        <button
                          className="detail-tracking-link"
                          onClick={() => handleOpenUrl(task.adoContext!.workItemUrl)}
                        >
                          Open in Azure DevOps â†—
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* AI Analysis result */}
          {task.analysisResult && (
            <div className="detail-section">
              <span className="detail-section-label detail-ai-label">AI analýza / analysis</span>
              <AnalysisBlock result={task.analysisResult} />
            </div>
          )}

          {/* AI Code Review — compact card showing the latest saved review */}
          {latestReview && (
            <div className="detail-section">
              <span className="detail-section-label detail-ai-label">AI recenze kódu</span>
              <div style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 4,
                background: 'var(--bg-overlay)',
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
              }}>
                {/* Top row: file name + verdict */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {latestReview.structured?.fileName ??
                      latestReview.filePath.replace(/\\/g, '/').split('/').pop() ?? latestReview.filePath}
                  </span>
                  {latestReview.structured?.verdict && (() => {
                    const VERDICT_COLOR: Record<string, string> = {
                      pass: '#3fb950', comment: '#388bfd', needs_changes: '#d29922',
                    };
                    const VERDICT_LABEL: Record<string, string> = {
                      pass: 'Bez zásadních připomínek',
                      comment: 'Komentář',
                      needs_changes: 'Vyžaduje úpravy',
                    };
                    const v = latestReview.structured!.verdict;
                    return (
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: '1px 6px',
                        borderRadius: 3, letterSpacing: '0.04em',
                        color: VERDICT_COLOR[v],
                        border: `1px solid ${VERDICT_COLOR[v]}`,
                        background: `color-mix(in srgb, ${VERDICT_COLOR[v]} 12%, var(--bg-surface))`,
                      }}>{VERDICT_LABEL[v]}</span>
                    );
                  })()}
                </div>
                {/* Meta row */}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span>Recenzent: {latestReview.reviewerName}</span>
                  {latestReview.structured?.comments?.length != null && (
                    <span>{latestReview.structured.comments.length} komentářů</span>
                  )}
                  {latestReview.reviewedAt && (
                    <span>{formatRelativeDate(latestReview.reviewedAt)}</span>
                  )}
                </div>
                {/* Summary preview */}
                {latestReview.structured?.summary && (
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--text-secondary)',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden' }}>
                    {latestReview.structured.summary}
                  </p>
                )}
                {/* Actions */}
                <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setShowSavedReviewModal(true)}
                    type="button"
                  >
                    <Icon name="search" size={11} /> Otevřít recenzi
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Legacy suggested steps — hidden when bilingual action bullets cover them */}
          {!(task.analysisResult?.actionPointsCz?.length) && !(task.analysisResult?.actionPointsEn?.length) &&
           (task.analysisResult?.suggestedActions ?? task.suggestedActions).length > 0 && (
            <div className="detail-section">
              <span className="detail-section-label">
                {task.analysisResult ? 'Navrhované kroky' : 'Suggested Steps'}
              </span>
              <div className="detail-suggestions">
                {(task.analysisResult?.suggestedActions ?? task.suggestedActions).map((sa, i) => (
                  <div key={sa.id} className="detail-suggestion-item">
                    <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>{i + 1}.</span>
                    {sa.label}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tracking section — only rendered when at least one field is set */}
          {(task.ticketUrl || task.devopsTaskUrl || task.budgetHours !== undefined || task.budgetNote) && (
            <div className="detail-section">
              <span className="detail-section-label">Tracking</span>
              <div className="detail-tracking-block">
                {task.ticketUrl && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">Ticket</span>
                    <button
                      className="detail-tracking-link"
                      onClick={() => handleOpenUrl(task.ticketUrl)}
                      title={task.ticketUrl}
                    >
                      Open Ticket â†—
                    </button>
                  </div>
                )}
                {task.devopsTaskUrl && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">DevOps</span>
                    <button
                      className="detail-tracking-link"
                      onClick={() => handleOpenUrl(task.devopsTaskUrl)}
                      title={task.devopsTaskUrl}
                    >
                      Open DevOps Task â†—
                    </button>
                  </div>
                )}
                {task.budgetHours !== undefined && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">Budget</span>
                    <span className="detail-tracking-value">
                      {task.budgetHours}h
                    </span>
                  </div>
                )}
                {task.budgetNote && (
                  <div className="detail-tracking-row">
                    <span className="detail-tracking-label">Note</span>
                    <span className="detail-tracking-value detail-tracking-note">
                      {task.budgetNote}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Planning section */}
          {task.status !== 'done' && (
            <PlanningSection task={task} />
          )}

        </div>

        {/* ---- Action footer ---- */}
        <div className="detail-action-groups">

          {/* Inline feedback message */}
          {feedback && (
            <div className="detail-feedback-ok">
              <Icon name="check" size={12} /> {feedback}
            </div>
          )}

          {/* AI error message */}
          {aiError && (
            <div className="detail-fs-error">! {aiError}</div>
          )}

          {/* WORKFLOW */}
          <div className="detail-action-group">
            <div className="detail-action-group-label">Workflow</div>
            <div className="detail-action-grid">
              <button
                className="btn btn-primary btn-sm"
                onClick={handleAnalyze}
                disabled={!!aiLoading}
                title="Analyse task with AI and set status to Analyzed"
              >
                {aiLoading === 'analyze'
                  ? <><span className="btn-spinner" /> Analysing…</>
                  : <><Icon name="search" size={13} /> Analyze</>}
              </button>

              {/* Start Work — update/fix scenarios: open existing artifact and advance */}
              {(plan.currentAction === 'start-work' || plan.workflowKind === 'dev-update' || plan.workflowKind === 'dev-fix') &&
               task.status === 'analyzed' && (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleStartWork}
                  disabled={!!aiLoading}
                  title={devTarget.kind === 'plugin'
                    ? 'Open plugin project and start working'
                    : 'Open script and start working'}
                >
                  <Icon name="terminal" size={13} />
                  {plan.workflowKind === 'dev-fix' ? 'Start Fixing' : 'Start Work'}
                </button>
              )}

              {/* Generate Draft — primary for create; optional helper for update/fix */}
              {plan.requiresDraftGeneration && (
                <button
                  className={`btn btn-sm ${plan.draftIsPrimaryAction ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={handleGenerateDraft}
                  disabled={
                    !!aiLoading ||
                    (devTarget.kind !== 'plugin' && !effectiveScriptFolder)
                  }
                  title={devTarget.kind === 'plugin'
                    ? plan.draftIsPrimaryAction
                      ? 'Generate C# plugin class draft (preview before writing)'
                      : 'Generate a draft patch or class skeleton (optional)'
                    : !effectiveScriptFolder
                      ? 'No script folder configured for this customer'
                      : plan.draftIsPrimaryAction
                        ? 'Generate a new script skeleton via Script Assistant'
                        : 'Generate a draft script snippet (optional helper)'}
                >
                  {aiLoading === 'draft'
                    ? <><span className="btn-spinner" /> Generating…</>
                    : <><Icon name="layers" size={13} /> {plan.draftIsPrimaryAction ? 'Generate Draft' : 'Draft Snippet'}</>}
                </button>
              )}

              {/* Apply Draft */}
              {plan.requiresDraftGeneration && (skeletonPreview || scriptHasDraft) && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleApplyDraft}
                  disabled={
                    !!aiLoading ||
                    (devTarget.kind === 'plugin' && !!skeletonPreview && !selectedPluginProject)
                  }
                  title={
                    devTarget.kind === 'plugin' && skeletonPreview && !selectedPluginProject
                      ? 'Select a plugin project in the Dev panel first'
                      : devTarget.kind === 'plugin' && skeletonPreview
                        ? `Write draft to disk: ${skeletonPreview.fileName}`
                        : 'Apply script draft to repository'
                  }
                >
                  <Icon name="check" size={13} /> Apply Draft
                </button>
              )}

              {/* Create Plugin Project — create + plugin only */}
              {devTarget.kind === 'plugin' && pluginsDir && plan.requiresPluginCreate && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => {
                    const folders = await tauriApi.listSubfolders(pluginsDir).catch(() => [] as string[]);
                    setPluginProjectsForModal(folders);
                    setShowCreatePlugin(true);
                  }}
                  disabled={!!aiLoading}
                  title="Create a new plugin project from a local template folder"
                >
                  <Icon name="folder" size={13} /> Create Plugin Project
                </button>
              )}
            </div>
          </div>

          {/* SCRIPT ASSISTANT — for all script dev tasks (create writes new file, update/fix patches existing). */}
          {customer && effectiveScriptFolder && devTarget.kind !== 'plugin' && plan.requiresDraftGeneration && (
            <ScriptAssistantPanel
              ref={scriptPanelRef}
              task={task}
              customer={customer}
              onDraftChange={setScriptHasDraft}
              scriptFolderOverride={effectiveScriptFolder}
            />
          )}

          {/* AZURE DEVOPS — shown for ADO PR comment/review tasks with an extracted deep link */}
          {(() => {
            const adoUrl =
              task.adoContext?.type === 'pr-comment'
                ? (task.adoContext.prUrl ?? task.adoContext.workItemUrl ?? null)
                : task.adoContext?.type === 'work-item'
                  ? (task.adoContext.workItemUrl ?? null)
                  : null;
            console.log(
              `[ado-link] TaskDetail render check`,
              `taskId=${task.id}`,
              `adoType=${task.adoContext?.type ?? 'none'}`,
              `prUrl=${task.adoContext?.prUrl ?? 'none'}`,
              `resolvedUrl=${adoUrl ?? 'none'}`,
            );
            if (!adoUrl) return null;
            return (
              <div className="detail-action-group">
                <div className="detail-action-group-label">Azure DevOps</div>
                <button
                  className="btn btn-secondary btn-sm btn-full"
                  onClick={() => handleOpenUrl(adoUrl)}
                  title={adoUrl}
                >
                  <Icon name="external-link" size={13} /> Open in DevOps
                </button>
              </div>
            );
          })()}

          {/* MODE SWITCH */}
          <div className="detail-action-group">
            <div className="detail-action-group-label">Mode</div>
            <TaskModeSwitch task={task} onSetMode={handleSetMode} />
          </div>

          {/* FILESYSTEM — only rendered when the customer has at least one path */}
          {hasAnyPath && (
            <div className="detail-action-group">
              <div className="detail-action-group-label">Filesystem</div>

              {hasRepo && (
                <button
                  className="btn btn-secondary btn-sm btn-full"
                  onClick={() => handleOpenPath(customer?.repositoryRoot, 'repository root')}
                >
                  <Icon name="folder" size={13} /> Open Repository
                </button>
              )}

              {hasPlugin && (
                <button
                  className="btn btn-secondary btn-sm btn-full"
                  onClick={() => handleOpenPath(customer?.pluginFolder, 'plugin folder')}
                >
                  <Icon name="plug" size={13} /> Open Plugin Folder
                </button>
              )}

              {hasScript && (
                <button
                  className="btn btn-secondary btn-sm btn-full"
                  onClick={() => handleOpenPath(customer?.scriptFolder, 'script folder')}
                >
                  <Icon name="file-text" size={13} /> Open Script Folder
                </button>
              )}

              {effectiveMode === 'developer' && plan.isDeveloperAwaitingSetup && (
                <div className="detail-dev-setup-prompt">
                  <span className="detail-dev-setup-text">Choose Plugin or Script target to enable developer tools.</span>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setShowSetupModal(true)}
                  >
                    Confirm developer setup
                  </button>
                </div>
              )}

              {effectiveMode === 'developer' && (hasRepo || hasVscodePath) && plan.requiresDevTools && (
                <TaskDevModePanel
                  ref={devModePanelRef}
                  task={task}
                  customer={customer}
                  pluginsDir={pluginsDir}
                  repoRootForGit={repoRootForGit}
                  defaultMode={devTarget.kind === 'plugin' ? 'plugin' : 'script'}
                  scriptOpenPath={task.workflowSetup?.scriptPath ?? customer?.scriptFolder ?? effectiveVscodePath}
                  onError={setFsError}
                  autoCollapsed={false}
                  selectedPluginProject={selectedPluginProject}
                  onSelectedPluginChange={handleSelectedPluginChange}
                  onPluginProjectMissing={handlePluginProjectMissing}
                  pluginRefreshTick={devPanelRefreshTick}
                  reviewerConfigs={plan.requiresAiFileReview ? settings.aiReviewers : undefined}
                  artifactPath={task.workflowSetup?.artifactPath}
                  initialReview={task.aiFileReviews?.[0]}
                  onReviewSaved={handleReviewSaved}
                />
              )}

              {/* Filesystem error strip */}
              {fsError && (
                <div className="detail-fs-error">! {fsError}</div>
              )}
            </div>
          )}

          {/* Show fs error even when no paths configured (e.g. from workflow actions) */}
          {!hasAnyPath && fsError && (
            <div className="detail-fs-error">! {fsError}</div>
          )}

          {/* COMMUNICATION */}
          <div className="detail-action-group">
            <div className="detail-action-group-label">Communication</div>
            <button
              className="btn btn-secondary btn-sm btn-full"
              onClick={handleGenerateReply}
              disabled={!!aiLoading}
            >
              {aiLoading === 'reply'
                ? <><span className="btn-spinner" /> Drafting…</>
                : <><Icon name="mail" size={13} /> Generate Reply</>}
            </button>
          </div>

          {/* PLANNING — quick bucket assignment */}
          {task.status !== 'done' && (
            <div className="detail-action-group">
              <div className="detail-action-group-label">
                Plan for
                {task.isPlanningLocked && (
                  <span className="planning-lock-badge">
                    <Icon name="pin" size={10} /> locked
                  </span>
                )}
              </div>
              <div className="detail-plan-grid">
                {BUCKET_ORDER.map((b) => {
                  const active = effectiveBucket(task) === b;
                  return (
                    <button
                      key={b}
                      className={`btn btn-sm${active ? ' btn-primary' : ' btn-secondary'} planning-bucket-btn`}
                      onClick={() => handleSetBucket(b)}
                      title={BUCKET_META[b].label}
                    >
                      <Icon name={BUCKET_META[b].icon} size={12} />
                      {BUCKET_META[b].label}
                    </button>
                  );
                })}
              </div>
              <button
                className="btn btn-ghost btn-sm planning-lock-toggle"
                onClick={handleToggleLock}
              >
                {task.isPlanningLocked
                  ? <><Icon name="unlock" size={12} /> Unlock (use auto-suggest)</>
                  : <><Icon name="lock" size={12} /> Lock manual choice</>}
              </button>
            </div>
          )}

        </div>
        </div>{/* end detail-panel-inner */}
      </aside>

      {/* Reply modal */}
      {showReply && (
        <ReplyModal
          task={task}
          customer={customer}
          onClose={() => { setShowReply(false); setGeneratedReply(null); }}
          initialText={generatedReply ?? task.generatedReply ?? undefined}
        />
      )}

      {/* Skeleton preview modal */}
      {showSkeleton && skeletonPreview && (
        <SkeletonPreviewModal
          preview={skeletonPreview}
          customer={customer}
          resolvedPluginBase={
            (pluginsDir && selectedPluginProject)
              ? `${pluginsDir}/${selectedPluginProject}`
              : undefined
          }
          onClose={() => { setShowSkeleton(false); }}
          onSaved={(filePath) => {
            // "Save to File" succeeded inside the modal — complete the full workflow.
            // selectedPluginProject is guaranteed non-empty when resolvedPluginBase is provided.
            if (selectedPluginProject) {
              completePluginDraft(selectedPluginProject, filePath);
            }
          }}
          onCreateAndApply={
            // Offer "Create Project & Apply" only when no plugin project is selected yet
            // and we have both a pluginsDir and a customer to derive naming from.
            (!selectedPluginProject && pluginsDir && customer)
              ? async () => {
                  const folders = await tauriApi.listSubfolders(pluginsDir).catch(() => [] as string[]);
                  const suggested = inferPluginSuggestions(task, customer, folders);
                  const projectName = sanitize(suggested.projectName);
                  if (!projectName) throw new Error('Could not infer a project name from this task.');

                  // Create the built-in scaffold (empty templateDir triggers the built-in path).
                  const solutionRoot = await tauriApi.createPluginProjectFromTemplate(
                    '', pluginsDir, projectName, suggested.namespace, false,
                  );

                  // Write the generated .cs into the nested project subfolder:
                  //   <solutionRoot>/<projectName>/<fileName>
                  const targetFile = `${solutionRoot}/${projectName}/${skeletonPreview.fileName}`;
                  await tauriApi.saveGeneratedFile(targetFile, skeletonPreview.content);

                  // Complete the workflow — persists state, closes modal, refreshes panel, opens project.
                  await completePluginDraft(projectName, targetFile);
                }
              : undefined
          }
        />
      )}

      {/* Confirm Setup modal — shown when user clicks Analyze on a New task */}
      {showSetupModal && (
        <ConfirmSetupModal
          task={task}
          customers={customers}
          customer={customer}
          devTarget={heuristicDevTarget}
          pluginsDir={pluginsDir}
          scriptFolder={effectiveScriptFolder}
          reviewerConfigs={settings.aiReviewers}
          effectiveMode={effectiveMode}
          onConfirm={handleConfirmSetup}
          onCancel={() => setShowSetupModal(false)}
        />
      )}

      {/* Create Plugin Project modal */}
      {showCreatePlugin && customer && pluginsDir && (
        <CreatePluginProjectModal
          task={task}
          customer={customer}
          pluginsDir={pluginsDir}
          existingPluginProjects={pluginProjectsForModal}
          onCreated={(path) => {
            setShowCreatePlugin(false);
            const projectName = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
            if (projectName) {
              // Persist both the task-level field and workflowSetup.pluginProject so the
              // derived selectedPluginProject and the Dev panel both pick it up after refresh.
              // Clear desiredPluginProject — the project now exists, the desired name fulfilled.
              updateTask(task.id, {
                selectedPluginProject: projectName,
                workflowSetup: {
                  ...task.workflowSetup,
                  pluginProject:        projectName,
                  desiredPluginProject: undefined,
                },
              }).catch(() => {});
            }
            setDevPanelRefreshTick((t) => t + 1);
            setFeedback(`Plugin project created: ${projectName || path}`);
          }}
          onClose={() => setShowCreatePlugin(false)}
        />
      )}

      {/* Edit task form */}
      {showEditForm && (
        <TaskForm
          initialTask={task}
          onClose={() => setShowEditForm(false)}
        />
      )}

      {/* AI Code Review — full PR-style view of the latest saved review */}
      {showSavedReviewModal && latestReview && (() => {
        // Determine whether this is a plugin review.
        // The reviewed file extension is the primary signal — it is stored on the
        // review result itself and cannot lie. devTargetKind is used only as a
        // tiebreaker when the extension is ambiguous (e.g. .ts could be either).
        const reviewFilePath = latestReview.filePath ?? latestReview.structured?.filePath ?? '';
        const lowerReviewPath = reviewFilePath.toLowerCase();
        const reviewKind: 'plugin' | 'script' = (() => {
          // Extension wins for unambiguous types.
          if (lowerReviewPath.endsWith('.cs')) return 'plugin';
          if (lowerReviewPath.endsWith('.js')) return 'script';
          // For .ts files, use devTargetKind as tiebreaker (plugins don't normally use .ts).
          const devKind = task.workflowSetup?.devTargetKind;
          if (devKind === 'plugin') return 'plugin';
          return 'script';
        })();

        const isPlugin = reviewKind === 'plugin';

        async function handleReviewOpen(fp: string) {
          try {
            if (isPlugin) {
              const target = await tauriApi.resolvePluginOpenTargetFromFile(fp);
              if (target) {
                if (target.kind === 'sln') {
                  await tauriApi.openWithShell(target.path);
                } else {
                  await tauriApi.openWithShell(target.path);
                }
              } else {
                // Fallback: open the file itself in VS Code
                await tauriApi.openInVscode(fp);
              }
            } else {
              await tauriApi.openInVscode(fp);
            }
          } catch { /* ignore */ }
        }

        return (
          <Modal
            title="AI recenze kódu"
            size="xl"
            onClose={() => setShowSavedReviewModal(false)}
            footer={
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setShowSavedReviewModal(false)}
                type="button"
              >
                Zavřít
              </button>
            }
          >
            <div className="ai-review-modal-body">
              <div className="ai-review-modal-result">
                <AiReviewResultView
                  structured={latestReview.structured}
                  markdown={latestReview.markdown}
                  onOpenFile={handleReviewOpen}
                  openLabel={isPlugin ? 'Otevřít projekt' : 'Otevřít soubor'}
                  openTitle={isPlugin ? 'Otevře .sln ve Visual Studiu, pokud existuje.' : undefined}
                />
              </div>
            </div>
          </Modal>
        );
      })()}
    </>
  );
}
