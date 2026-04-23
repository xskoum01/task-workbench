import { useState, useEffect, useRef } from 'react';
import type { Task, TaskStatus, PlanningBucket, SkeletonPreview, AiReviewResult } from '../types';
import TaskEmailContent from './TaskEmailContent';
import TaskDevModePanel from './TaskDevModePanel';
import { useApp } from '../context/AppContext';
import { TypeBadge, SourceBadge, STATUS_LABELS } from './StatusBadge';
import ReplyModal from './ReplyModal';
import SkeletonPreviewModal from './SkeletonPreviewModal';
import ScriptAssistantPanel, { type ScriptAssistantPanelHandle } from './ScriptAssistantPanel';
import TaskForm from './TaskForm';
import CreatePluginProjectModal, { inferPluginSuggestions, sanitize } from './CreatePluginProjectModal';
import Icon from './Icon';
import * as tauriApi from '../lib/tauriCommands';
import { resolveTaskDevTarget, resolveBestPluginPath, getPluginsDir, hintedPluginProject } from '../lib/resolveTaskDevTarget';
import { BUCKET_META, BUCKET_ORDER, computePlanning, effectiveBucket } from '../lib/planning';
import { isOverdue, formatRelativeDate } from '../lib/dates';

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
}

type AiAction = 'analyze' | 'reply' | 'draft' | 'review';

/**
 * Returns true only when the task clearly requests creating a brand-new plugin
 * and there is no concrete existing plugin project already associated with it.
 *
 * Hiding criteria (returns false):
 *   - A plugin project is already selected on the task
 *   - ADO context yields a hinted existing project
 *   - Title or body contains typical edit/review/fix verbs
 *   - Task is not a feature type AND has no create-new signal
 */
function isNewPluginTask(task: Task): boolean {
  // Already linked to an existing project
  if (task.selectedPluginProject) return false;
  if (hintedPluginProject(task)) return false;

  const text = `${task.title} ${task.originalMessage ?? ''}`.toLowerCase();

  // Explicit edit / fix / review signals
  const editPattern = /\b(fix|bug|review|update|modify|change|refactor|adjust|extend|edit|oprav|uprav|změ|kontrola|review)\b/;
  if (editPattern.test(text)) return false;

  // Must have at least one create-new signal
  const createPattern = /\b(create|new|scaffold|nový|nová|nové|vytvořit|vytvořte|založ|nový plugin|new plugin)\b/;
  return createPattern.test(text) || task.taskType === 'feature';
}

// All statuses in the progression order shown in the selector
const STATUS_OPTIONS: TaskStatus[] = [
  'new',
  'analyzed',
  'in-progress',
  'ready-for-review',
  'done',
  'blocked',
];

function confidenceClass(value: number): string {
  if (value >= 80) return '';
  if (value >= 60) return 'medium';
  return 'low';
}

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
  const devTarget = resolveTaskDevTarget(task, customer, crmFolderPath);
  const effectiveVscodePath = devTarget.path;

  // Resolved script folder: explicit scriptFolder first, then repo root + /Scripts subfolder.
  // This ensures scripts land in <repo>/Scripts/ rather than the repo root.
  // Must be consistent with resolveCustomerScriptFolder in scriptAssistant.ts.
  const repoFallback = customer?.resolvedRepositoryPath ?? customer?.repositoryRoot;
  const effectiveScriptFolder =
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
  // AI Review result
  const [aiReview, setAiReview] = useState<AiReviewResult | null>(null);
  // Script Assistant imperative ref + draft-ready flag
  const scriptPanelRef = useRef<ScriptAssistantPanelHandle>(null);
  const [scriptHasDraft, setScriptHasDraft] = useState(false);
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

  // Selected plugin project is persisted on the task model so it is shared
  // between InlineTaskPanel and TaskDetail without local-only state.
  const selectedPluginProject = task.selectedPluginProject ?? '';
  function handleSelectedPluginChange(plugin: string) {
    updateTask(task.id, { selectedPluginProject: plugin || undefined }).catch(() => {});
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
    setAiLoading('analyze');
    setAiError(null);
    try {
      const result = await tauriApi.analyzeTask(task, customer ?? null);
      await updateTask(task.id, {
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

  async function handleOpenWork() {
    // Open the correct development environment without generating code.
    // Plugin task: open .sln in Visual Studio (via shell), fall back to .csproj or folder.
    // Script task: open script target in VS Code.
    setFsError(null);
    await updateTask(task.id, { status: 'in-progress' });
    if (devTarget.kind === 'plugin') {
      const resolvedPath = await resolveBestPluginPath(task, customer);
      if (resolvedPath) {
        try {
          // If it's an .sln file, open with shell (Visual Studio).
          if (resolvedPath.endsWith('.sln')) {
            await tauriApi.openWithShell(resolvedPath);
          } else {
            await tauriApi.openInVscode(resolvedPath);
          }
        } catch (e) { setFsError(String(e)); }
      } else if (pluginsDir) {
        // No specific plugin resolved — open plugins folder so developer can orient
        try { await tauriApi.openInVscode(pluginsDir); } catch (e) { setFsError(String(e)); }
      } else {
        setFeedback('Status set to In Progress. No plugin path configured for this customer.');
      }
    } else {
      // Script / repo task
      const openPath = customer?.scriptFolder ?? effectiveVscodePath;
      if (openPath) {
        try { await tauriApi.openInVscode(openPath); } catch (e) { setFsError(String(e)); }
      } else {
        setFeedback('Status set to In Progress. Configure a script folder for this customer.');
      }
    }
  }

  async function handleGenerateDraft() {
    if (devTarget.kind === 'plugin') {
      // Plugin: call AI to generate a C# skeleton, then open preview modal.
      setAiLoading('draft');
      setAiError(null);
      try {
        const preview = await tauriApi.generateSkeletonPreview(task, customer ?? null);
        setSkeletonPreview(preview);
        setShowSkeleton(true);
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
      // Plugin: write the skeleton preview to disk.
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
        setFeedback(`Draft written: ${skeletonPreview.fileName}`);
        setSkeletonPreview(null);
      } catch (e) {
        setFsError(String(e));
      }
    } else {
      // Script: delegate to the Script Assistant panel apply step.
      if (!scriptPanelRef.current) return;
      setAiLoading('draft');
      setAiError(null);
      try {
        await scriptPanelRef.current.applyDraft();
        setFeedback('Script draft applied.');
      } catch (e) {
        setAiError(String(e));
      } finally {
        setAiLoading(null);
      }
    }
  }

  async function handleAiReview() {
    setAiLoading('review');
    setAiError(null);
    setAiReview(null);
    try {
      const draft = skeletonPreview?.content;
      const result = await tauriApi.aiReviewTask(task, customer ?? null, draft);
      setAiReview(result);
      if (result.passed) {
        await updateTask(task.id, { status: 'ready-for-review' });
        setFeedback('AI Review passed — status set to Ready for Review');
      } else {
        setFeedback('AI Review found issues — see review results below');
      }
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiLoading(null);
    }
  }

  // --- Communication ---

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

            <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Inline status selector — styled to match the badge palette */}
              <select
                className={`detail-status-select detail-status-${task.status}`}
                value={task.status}
                onChange={(e) => handleStatusChange(e.target.value as TaskStatus)}
                title="Change status"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>

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

          {/* Confidence */}
          <div className="detail-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="detail-section-label">Confidence</span>
              <span className="detail-confidence-value">{task.confidence}%</span>
            </div>
            <div className="detail-confidence-bar">
              <div
                className={`detail-confidence-fill ${confidenceClass(task.confidence)}`}
                style={{ width: `${task.confidence}%` }}
              />
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
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleOpenWork}
                disabled={!!aiLoading}
                title={devTarget.kind === 'plugin'
                  ? 'Open plugin project in Visual Studio or VS Code'
                  : 'Open script folder in VS Code'}
              >
                <Icon name="play" size={13} /> Open Work
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleGenerateDraft}
                disabled={!!aiLoading}
                title={devTarget.kind === 'plugin'
                  ? 'Generate C# plugin class draft (preview before writing)'
                  : 'Use Script Assistant below to generate a draft'}
              >
                {aiLoading === 'draft'
                  ? <><span className="btn-spinner" /> Generating…</>
                  : <><Icon name="layers" size={13} /> Generate Draft</>}
              </button>
              {/* Apply Draft — shown for plugin (skeletonPreview ready) or script (scriptHasDraft) */}
              {(skeletonPreview || scriptHasDraft) && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleApplyDraft}
                  disabled={!!aiLoading}
                  title={
                    devTarget.kind === 'plugin' && skeletonPreview
                      ? `Write draft to disk: ${skeletonPreview.fileName}`
                      : 'Apply script draft to repository'
                  }
                >
                  <Icon name="check" size={13} /> Apply Draft
                </button>
              )}
              {devTarget.kind === 'plugin' && pluginsDir && isNewPluginTask(task) && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => {
                    // Load existing plugin projects so the modal can use them for
                    // naming-convention auto-suggestions.
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
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleAiReview}
                disabled={!!aiLoading}
                title="Run AI review. Sets status to Ready for Review when the review passes."
              >
                {aiLoading === 'review'
                  ? <><span className="btn-spinner" /> Reviewing…</>
                  : <><Icon name="check" size={13} /> AI Review</>}
              </button>
            </div>

            {/* AI Review results */}
            {aiReview && (
              <div className={`detail-ai-review${aiReview.passed ? ' detail-ai-review--pass' : ' detail-ai-review--fail'}`}>
                <div className="detail-ai-review-summary">
                  <Icon name={aiReview.passed ? 'check' : 'alert-circle'} size={13} />
                  {aiReview.summary}
                </div>
                {aiReview.issues.length > 0 && (
                  <div className="detail-ai-review-section">
                    <div className="detail-ai-review-label">Issues</div>
                    <ul className="detail-ai-review-list">
                      {aiReview.issues.map((issue, i) => <li key={i}>{issue}</li>)}
                    </ul>
                  </div>
                )}
                {aiReview.suggestions.length > 0 && (
                  <div className="detail-ai-review-section">
                    <div className="detail-ai-review-label">Suggestions</div>
                    <ul className="detail-ai-review-list">
                      {aiReview.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                )}
                {!aiReview.passed && (
                  <div style={{ marginTop: 4 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setAiReview(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* SCRIPT ASSISTANT — shown when any script-capable path exists (customer fields or fallback repo path) */}
          {customer && effectiveScriptFolder && (
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

              {(hasRepo || hasVscodePath) && (
                <TaskDevModePanel
                  task={task}
                  customer={customer}
                  pluginsDir={pluginsDir}
                  repoRootForGit={repoRootForGit}
                  defaultMode={devTarget.kind === 'plugin' ? 'plugin' : 'script'}
                  scriptOpenPath={customer?.scriptFolder ?? effectiveVscodePath}
                  onError={setFsError}
                  autoCollapsed={devTarget.kind === 'repo'}
                  selectedPluginProject={task.selectedPluginProject}
                  onSelectedPluginChange={handleSelectedPluginChange}
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

                  // Open the project in Visual Studio: prefer .sln, fall back to .csproj, then folder.
                  const slns = await tauriApi.listDirectoryFiles(solutionRoot, 'sln').catch(() => [] as string[]);
                  if (slns.length > 0) {
                    await tauriApi.openWithShell(`${solutionRoot}/${slns[0]}`).catch(() => {});
                  } else {
                    const projDir = `${solutionRoot}/${projectName}`;
                    const csprojs = await tauriApi.listDirectoryFiles(projDir, 'csproj').catch(() => [] as string[]);
                    if (csprojs.length > 0) {
                      await tauriApi.openInVscode(`${projDir}/${csprojs[0]}`).catch(() => {});
                    } else {
                      await tauriApi.openInVscode(solutionRoot).catch(() => {});
                    }
                  }

                  // Persist the selection so future actions in this task use the new project.
                  await updateTask(task.id, { selectedPluginProject: projectName });

                  setShowSkeleton(false);
                  setSkeletonPreview(null);
                  setFeedback(`Plugin project created and draft applied: ${projectName}`);
                }
              : undefined
          }
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
            setFeedback(`Plugin project created: ${path}`);
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
    </>
  );
}
