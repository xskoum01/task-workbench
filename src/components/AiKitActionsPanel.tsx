/**
 * AiKitActionsPanel
 *
 * Three AI Kit developer actions:
 *   1. Implement with AI Kit  — reads artifact, runs AI, proposes file changes
 *   2. Review Diff with AI Kit — reads git diff, runs AI review with AI Kit rules
 *   3. Apply AI Review Fixes  — applies blockers/warnings from the latest AI Kit review
 *
 * Safety guarantees:
 *   - Files are written only after explicit user confirmation.
 *   - No git commits, pushes, or branch operations.
 *   - No Dataverse, GitHub, or Azure DevOps writes.
 *   - Target files must be inside the repository root (enforced by UI guard).
 */

import { useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import type { Task, Customer, AiFileReviewResult, ImplementationVerification } from '../types';
import Icon from './Icon';
import Modal from './Modal';
import * as tauriApi from '../lib/tauriCommands';
import {
  validateAiKitPath,
  detectTaskKindFromTask,
  loadAiKitContext,
  buildImplementInstructions,
  buildDiffReviewInstructions,
  buildApplyFixesInstructions,
  type AiKitTaskKind,
  type PowerPlatformAiKitContext,
} from '../lib/powerPlatformAiKit';
import { isPathInsideDir } from '../lib/pathUtils';
import { getAiKitWorkflowState, getAiKitActionLabel } from '../lib/aiKitWorkflow';
import { buildRepositoryContextForTask } from '../lib/repositoryContext';
import { getRepositoryRuntimeStatus, type RepositoryRuntimeStatus } from '../lib/repositoryRuntimeStatus';
import { prepareImplementInput } from '../lib/aiKitImplementMode';
import {
  type ActionPhase,
  type ActiveAction,
  isPhaseRunning,
  canDismissModal,
  shouldShowPreviewModal,
  shouldShowResultModal,
  validateRunState,
} from '../lib/aiKitPanelState';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AiKitActionsPanelProps {
  task: Task;
  customer: Customer | undefined;
  /** Absolute path to the AI Kit repository (from settings). */
  aiKitPath: string | undefined;
  /** Global CRM repositories base directory from app settings. */
  crmBaseDirectory?: string;
  /** Repository root used for git diff. */
  repoRootForGit: string | undefined;
  /** Called after a successful action so the parent can persist task updates. */
  onTaskUpdate: (updates: Partial<Task>) => Promise<void>;
  /** Called to surface errors to the parent component. */
  onError: (msg: string) => void;
  /** Called when context loading completes and the preview modal is about to open. */
  onPreviewReady?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTaskContextString(task: Task, customer: Customer | undefined, taskKind: AiKitTaskKind): string {
  const lines: string[] = [];
  const setup = task.workflowSetup;

  lines.push('## TASK');
  lines.push(`Title: ${task.title}`);
  if (task.originalMessage) lines.push(`Description:\n${task.originalMessage.slice(0, 1200)}`);
  const analysisText = task.analysisResult?.summaryCz || task.analysisResult?.summaryEn || task.analysisResult?.summary;
  if (analysisText) lines.push(`Analysis: ${analysisText.slice(0, 400)}`);
  lines.push('');

  lines.push('## PROJECT SETUP');
  lines.push(`Task kind: ${taskKind}`);
  if (customer?.name) lines.push(`Customer: ${customer.name}`);
  if (setup?.primaryEntityLogicalName) lines.push(`Primary entity: ${setup.primaryEntityLogicalName}`);
  if (setup?.workIntent) lines.push(`Work intent: ${setup.workIntent}`);
  if (setup?.pluginProject) lines.push(`Plugin project: ${setup.pluginProject}`);
  lines.push('');

  const techPlan = task.crmDeveloperWorkflow?.technicalPlan;
  if (techPlan) {
    lines.push('## TECHNICAL PLAN');
    if (techPlan.summary) lines.push(techPlan.summary.slice(0, 500));
    if (techPlan.implementationSteps.length) {
      lines.push('Steps:');
      techPlan.implementationSteps.slice(0, 6).forEach((s) => lines.push(`- ${s}`));
    }
    if (techPlan.risks.length) {
      lines.push('Risks:');
      techPlan.risks.slice(0, 3).forEach((r) => lines.push(`- ${r}`));
    }
    lines.push('');
  }

  const dvReport = task.crmVerificationReports?.[0];
  if (dvReport) {
    lines.push('## DATAVERSE VERIFICATION');
    lines.push(`Verdict: ${dvReport.verdict}`);
    if (dvReport.summary) lines.push(dvReport.summary.slice(0, 300));
    const missing = (dvReport.missingReferences ?? [])
      .map((r) => `${r.kind}: ${r.displayName}`)
      .slice(0, 5);
    if (missing.length) { lines.push('Missing references:'); missing.forEach((m) => lines.push(`- ${m}`)); }
    lines.push('');
  }

  return lines.join('\n');
}

function reviewResultToImplCheckStatus(result: AiFileReviewResult): 'passed' | 'warnings' | 'failed' {
  const v = result.structured?.verdict;
  if (v === 'pass') return 'passed';
  if (v === 'needs_changes') return 'failed';
  return 'warnings';
}

function formatReviewForApplyFixes(review: AiFileReviewResult): string {
  if (review.markdown) return review.markdown;
  if (!review.structured) return 'No review data available.';
  const s = review.structured;
  const lines: string[] = [];
  lines.push(`Reviewer: ${review.reviewerName}`);
  lines.push(`Verdict: ${s.verdict}`);
  if (s.summary) lines.push(`\nSummary: ${s.summary}`);
  if (s.comments?.length) {
    lines.push('\nFindings:');
    s.comments.forEach((c) => {
      const loc = c.lineStart ? ` (line ${c.lineStart})` : '';
      lines.push(`- [${c.severity}] ${c.title}${loc}: ${c.problem}`);
      lines.push(`  Fix: ${c.recommendation}`);
    });
  }
  if (s.generalSuggestions?.length) {
    lines.push('\nGeneral suggestions:');
    s.generalSuggestions.forEach((g) => lines.push(`- ${g}`));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

// ActionPhase and ActiveAction are imported from '../lib/aiKitPanelState'.

interface ActionState {
  phase: ActionPhase;
  action: ActiveAction | null;
  error: string | null;
  taskKind: AiKitTaskKind | null;
  kitContext: PowerPlatformAiKitContext | null;
  artifactContent: string | null;
  diff: string | null;
  proposedContent: string | null;
  resultSummary: string | null;
  resultRisks: string[];
  testScenarios: string[];
  rawText: string | null;
  reviewerName: string | null;
  /** Resolved artifact path carried through the state machine — set at start of each action. */
  resolvedArtifactPath: string | null;
  /** Set when the AI reports missing metadata/business logic instead of generating code. */
  clarificationNeeded: string | null;
  /** Git diff collected after a successful file write (non-blocking). */
  postApplyDiff: string | null;
  /** Non-fatal warning when post-apply diff collection fails. */
  postApplyDiffWarning: string | null;
  /** True when implement action runs in script-create mode with empty current content. */
  isCreateMode: boolean;
  /** True while git diff is being collected after a successful file write. */
  postApplyDiffLoading: boolean;
}

const INITIAL_STATE: ActionState = {
  phase: 'idle',
  action: null,
  error: null,
  taskKind: null,
  kitContext: null,
  artifactContent: null,
  diff: null,
  proposedContent: null,
  resultSummary: null,
  resultRisks: [],
  testScenarios: [],
  rawText: null,
  reviewerName: null,
  resolvedArtifactPath: null,
  clarificationNeeded: null,
  postApplyDiff: null,
  postApplyDiffWarning: null,
  isCreateMode: false,
  postApplyDiffLoading: false,
};

function tryExtractRequestedTargetPath(text: string | undefined): string | null {
  if (!text?.trim()) return null;
  const normalised = text.replace(/\\/g, '/');
  const pathMatch = normalised.match(/[A-Za-z]:\/[\w\-.\/]+\.(?:js|ts)/i)
    ?? normalised.match(/([\w\-.\/]+\.(?:js|ts))/i);
  return pathMatch?.[1]?.trim() ?? pathMatch?.[0]?.trim() ?? null;
}

/** Imperative handle exposed via ref so workflow actions can trigger AI Kit flows. */
export interface AiKitActionsPanelHandle {
  /**
   * Starts the Implement with AI Kit flow.
   * When `artifactPathOverride` is provided it is used directly, bypassing
    * the normal workflow setup lookup. Use this when the caller
   * has just created the artifact file and the React props have not yet updated.
   */
  startImplement(artifactPathOverride?: string): void;
  startReviewDiff(): void;
  startApplyFixes(): void;
}

const AiKitActionsPanel = forwardRef<AiKitActionsPanelHandle, AiKitActionsPanelProps>(function AiKitActionsPanel({
  task,
  customer,
  aiKitPath,
  crmBaseDirectory,
  repoRootForGit,
  onTaskUpdate,
  onError,
  onPreviewReady,
}: AiKitActionsPanelProps, ref) {
  const [state, setState] = useState<ActionState>(INITIAL_STATE);
  const [runtimeStatus, setRuntimeStatus] = useState<RepositoryRuntimeStatus | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);

  const kitConfigured = !!(aiKitPath?.trim());

  // Deterministic repository context — pure, synchronous, no Tauri calls.
  // repoRootForGit prop (from the dev-mode panel selection) takes priority for
  // git operations; the resolver covers all other sources.
  const repoCtx = buildRepositoryContextForTask(task, customer, {
    crmBaseDirectory,
    powerPlatformAiKitPath: aiKitPath,
  });
  const effectiveRepoRoot = repoRootForGit ?? repoCtx.repoRoot;
  const effectiveArtifact = repoCtx.artifactPath;
  const usesRepoOverride = !!effectiveRepoRoot && !!repoCtx.repoRoot && effectiveRepoRoot !== repoCtx.repoRoot;
  const requestedTargetPath = tryExtractRequestedTargetPath(task.originalMessage);
  const targetPathMismatchWarning = requestedTargetPath && effectiveArtifact
    ? (() => {
        const lhs = requestedTargetPath.replace(/\\/g, '/').toLowerCase();
        const rhs = effectiveArtifact.replace(/\\/g, '/').toLowerCase();
        if (lhs === rhs) return null;
        const lhsBase = lhs.split('/').pop();
        const rhsBase = rhs.split('/').pop();
        return lhsBase === rhsBase ? null : 'Requested target path differs from resolved artifact path.';
      })()
    : null;

  useEffect(() => {
    let cancelled = false;

    setRuntimeLoading(true);
    getRepositoryRuntimeStatus({
      repoRoot: effectiveRepoRoot,
      artifactPath: effectiveArtifact,
    }).then((status) => {
      if (!cancelled) {
        setRuntimeStatus(status);
        setRuntimeLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setRuntimeStatus(null);
        setRuntimeLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [effectiveRepoRoot, effectiveArtifact]);

  function reset() {
    setState(INITIAL_STATE);
  }

  function setError(error: string) {
    setState((s) => ({ ...s, phase: 'error', error }));
    onError?.(error);
  }

  // ── Latest AI Kit review (for Apply Fixes) ────────────────────────────────
  // Prefer the canonical reviewerId set by startReviewDiff; fall back to name match.
  const latestAiKitReview =
    task.aiFileReviews?.find((r) => r.reviewerId === 'ai-kit-diff-review') ??
    task.aiFileReviews?.find((r) => r.reviewerName?.includes('AI Kit'));
  const aiKitReviewVerdict = latestAiKitReview?.structured?.verdict;
  const canApplyFixes = !!latestAiKitReview && aiKitReviewVerdict !== 'pass';

  // ── Guards ────────────────────────────────────────────────────────────────

  function validateArtifactPath(p: string): void {
    // AI Kit is read-only — target must not be inside the AI Kit repo
    if (aiKitPath?.trim() && isPathInsideDir(p, aiKitPath.trim())) {
      throw new Error(
        'AI Kit is read-only. Target file must be inside the customer repository, not the AI Kit repo.\n' +
        `File: ${p}\nAI Kit: ${aiKitPath}`
      );
    }
    // Target must be inside the configured repository root
    if (effectiveRepoRoot && !isPathInsideDir(p, effectiveRepoRoot)) {
      throw new Error(`Target file is outside the repository root.\nFile: ${p}\nRepo: ${effectiveRepoRoot}`);
    }
  }

  function checkArtifactPath(): string | null {
    const p = effectiveArtifact?.trim();
    if (!p) return null;
    validateArtifactPath(p);
    return p;
  }

  // ── Implement with AI Kit ─────────────────────────────────────────────────

  async function startImplement(artifactPathOverride?: string) {
    if (!kitConfigured) return;
    setState({ ...INITIAL_STATE, phase: 'preparing', action: 'implement', error: null });
    try {
      let artPath: string;
      const trimmedOverride = artifactPathOverride?.trim();
      if (trimmedOverride) {
        validateArtifactPath(trimmedOverride);
        artPath = trimmedOverride;
      } else {
        const resolved = checkArtifactPath();
        if (!resolved) throw new Error('No artifact file path is configured. Set scriptPath or artifactPath in task setup.');
        artPath = resolved;
      }

      const validation = await validateAiKitPath(aiKitPath!);
      if (!validation.valid) throw new Error(validation.statusMessage);

      const taskKind = detectTaskKindFromTask(task);
      const kitContext = await loadAiKitContext(aiKitPath!, taskKind, false, true);
      const prepared = await prepareImplementInput(
        {
          taskKind,
          workIntent: task.workflowSetup?.workIntent,
          artifactPath: artPath,
          repoRoot: effectiveRepoRoot,
          aiKitPath,
        },
        {
          checkPathExists: tauriApi.checkPathExists,
          readFileContent: tauriApi.readFileContent,
        },
      );

      setState((s) => ({
        ...s,
        phase: 'preview',
        taskKind,
        kitContext,
        artifactContent: prepared.currentContent,
        resolvedArtifactPath: prepared.artifactPath,
        isCreateMode: prepared.isCreateMode,
      }));
      onPreviewReady?.();
    } catch (e) {
      setError(String(e));
    }
  }

  async function runImplement() {
    const runErr = validateRunState({ kitContext: state.kitContext, artifactContent: state.artifactContent, taskKind: state.taskKind });
    if (runErr) { setError(runErr); return; }
    setState((s) => ({ ...s, phase: 'running' }));
    try {
      const instructions = buildImplementInstructions(state.kitContext!, { createMode: state.isCreateMode });
      const taskContext = buildTaskContextString(task, customer, state.taskKind!);
      const result = await tauriApi.runAiKitImplementation(
        state.artifactContent!,
        taskContext,
        instructions,
        '',
        0.2,
      );
      if (!result.ok || !result.result?.proposedContent) {
        const clarification = result.result?.clarificationNeeded?.trim();
        if (clarification) {
          setState((s) => ({
            ...s,
            phase: 'result',
            proposedContent: null,
            clarificationNeeded: clarification,
            resultSummary: 'AI Kit requires clarification before implementing.',
            resultRisks: [],
            testScenarios: [],
            rawText: null,
          }));
          return;
        }
        setState((s) => ({
          ...s,
          phase: 'result',
          proposedContent: null,
          rawText: result.rawText ?? 'No proposed content returned.',
          resultSummary: result.rawText ? 'Model returned unstructured text.' : 'Implementation failed.',
          resultRisks: [],
          testScenarios: [],
        }));
        return;
      }
      setState((s) => ({
        ...s,
        phase: 'result',
        proposedContent: result.result!.proposedContent,
        resultSummary: result.result!.summary ?? '',
        resultRisks: result.result!.risks ?? [],
        testScenarios: result.result!.testScenarios ?? [],
        rawText: null,
        clarificationNeeded: null,
      }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function applyImplementation() {
    const targetPath = state.resolvedArtifactPath ?? effectiveArtifact;
    if (!state.proposedContent || !targetPath) return;
    setState((s) => ({ ...s, phase: 'applying' }));
    try {
      validateArtifactPath(targetPath);   // Re-validate immediately before every write
      await tauriApi.saveGeneratedFile(targetPath, state.proposedContent);
      const now = new Date().toISOString();
      const note = `[${now}] UI: ai-kit-implementation-generated`;
      const existing = task.notes ?? '';
      await onTaskUpdate({
        notes: existing ? `${existing}\n${note}` : note,
      });
      setState((s) => ({ ...s, phase: 'done', postApplyDiffLoading: !!effectiveRepoRoot }));
      // Non-blocking: collect post-apply diff for display
      if (effectiveRepoRoot) {
        tauriApi.collectGitReviewContext(effectiveRepoRoot).then((gitCtx) => {
          setState((s) => ({
            ...s,
            postApplyDiff: gitCtx.diff?.trim() || null,
            postApplyDiffLoading: false,
          }));
        }).catch(() => {
          setState((s) => ({ ...s, postApplyDiffWarning: 'git diff not available', postApplyDiffLoading: false }));
        });
      }
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Review Diff with AI Kit ───────────────────────────────────────────────

  async function startReviewDiff() {
    if (!kitConfigured) return;
    if (!effectiveRepoRoot) {
      setError('No repository root configured. Set up the customer repository first.');
      return;
    }

    setState({ ...INITIAL_STATE, phase: 'preparing', action: 'reviewDiff', error: null });
    try {
      const validation = await validateAiKitPath(aiKitPath!);
      if (!validation.valid) throw new Error(validation.statusMessage);

      const taskKind = detectTaskKindFromTask(task);
      const kitContext = await loadAiKitContext(aiKitPath!, taskKind, true, true);

      let diff = '';
      try {
        const gitCtx = await tauriApi.collectGitReviewContext(effectiveRepoRoot);
        diff = gitCtx.diff;
      } catch (e) {
        throw new Error(`Could not collect git diff: ${String(e)}`);
      }

      if (!diff.trim()) {
        setError('No changes to review. Make some local changes first.');
        return;
      }

      setState((s) => ({ ...s, phase: 'running', taskKind, kitContext, diff }));

      const reviewerName = `AI Kit ${taskKind === 'plugin' ? 'Plugin' : taskKind === 'script' ? 'Script' : 'Ribbon'} Review`;
      const instructions = buildDiffReviewInstructions(kitContext);
      const taskContext = `Task: ${task.title}${task.analysisResult?.summaryCz ? `\nAnalysis: ${task.analysisResult.summaryCz.slice(0, 300)}` : ''}`;
      const fileName = effectiveArtifact ? effectiveArtifact.split(/[\\/]/).pop() ?? 'diff' : 'diff';

      const result = await tauriApi.runAiChangeReview(
        diff,
        taskContext,
        fileName,
        reviewerName,
        instructions,
        '',
        0.2,
      );

      const reviewEntry: AiFileReviewResult = {
        ...result,
        id: `aikit-${Date.now()}`,
        reviewerId: 'ai-kit-diff-review',
        reviewerName,
        filePath: effectiveArtifact ?? effectiveRepoRoot ?? '',
        reviewedAt: new Date().toISOString(),
        reviewMode: 'change',
      };

      const implStatus = reviewResultToImplCheckStatus(reviewEntry);
      const verdictStr = implStatus === 'passed' ? 'PASS' : implStatus === 'failed' ? 'FAIL' : 'WARN';
      const now = new Date().toISOString();
      const note = `[${now}] UI: ai-kit-diff-reviewed -> ${verdictStr}`;
      const existing = task.notes ?? '';
      const existingReviews = task.aiFileReviews ?? [];

      const iv: ImplementationVerification = {
        ...task.implementationVerification,
        aiCodeReview: {
          status: implStatus,
          runAt: now,
          summary: result.structured?.summary ?? reviewerName,
          findings: result.structured?.comments?.map((c) => {
            const loc = c.lineStart ? ` (line ${c.lineStart})` : '';
            return `[${c.severity}] ${c.title}${loc}: ${(c.problem ?? '').split('\n')[0]}`.slice(0, 200);
          }) ?? [],
        },
        updatedAt: now,
      };

      await onTaskUpdate({
        notes: existing ? `${existing}\n${note}` : note,
        aiFileReviews: [reviewEntry, ...existingReviews].slice(0, 5),
        implementationVerification: iv,
      });

      setState((s) => ({
        ...s,
        phase: 'result',
        reviewerName,
        resultSummary: result.structured?.summary ?? verdictStr,
      }));
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Apply AI Review Fixes ─────────────────────────────────────────────────

  async function startApplyFixes() {
    if (!kitConfigured || !latestAiKitReview) return;
    const artPath = effectiveArtifact?.trim();
    if (!artPath) {
      setError('No artifact file path configured. Set scriptPath or artifactPath in task setup.');
      return;
    }

    setState({ ...INITIAL_STATE, phase: 'preparing', action: 'applyFixes', error: null });
    try {
      validateArtifactPath(artPath);

      const validation = await validateAiKitPath(aiKitPath!);
      if (!validation.valid) throw new Error(validation.statusMessage);

      const taskKind = detectTaskKindFromTask(task);
      const kitContext = await loadAiKitContext(aiKitPath!, taskKind, true, false);
      const artifactContent = await tauriApi.readFileContent(artPath);

      setState((s) => ({
        ...s,
        phase: 'preview',
        taskKind,
        kitContext,
        artifactContent,
        resolvedArtifactPath: artPath,
      }));
      onPreviewReady?.();
    } catch (e) {
      setError(String(e));
    }
  }

  async function runApplyFixes() {
    const runErr = validateRunState({ kitContext: state.kitContext, artifactContent: state.artifactContent, taskKind: state.taskKind, latestReview: latestAiKitReview, requiresReview: true });
    if (runErr) { setError(runErr); return; }
    setState((s) => ({ ...s, phase: 'running' }));
    try {
      const reviewText = formatReviewForApplyFixes(latestAiKitReview!);
      const instructions = buildApplyFixesInstructions(state.kitContext!, reviewText);
      const taskContext = buildTaskContextString(task, customer, state.taskKind!);
      const result = await tauriApi.runAiKitImplementation(
        state.artifactContent!,
        taskContext,
        instructions,
        '',
        0.2,
      );
      if (!result.ok || !result.result?.proposedContent) {
        const clarification = result.result?.clarificationNeeded?.trim();
        if (clarification) {
          setState((s) => ({
            ...s,
            phase: 'result',
            proposedContent: null,
            clarificationNeeded: clarification,
            resultSummary: 'AI Kit requires clarification before applying fixes.',
            resultRisks: [],
            testScenarios: [],
            rawText: null,
          }));
          return;
        }
        setState((s) => ({
          ...s,
          phase: 'result',
          proposedContent: null,
          rawText: result.rawText ?? 'No proposed content returned.',
          resultSummary: 'Fix generation failed or model returned unstructured text.',
          resultRisks: [],
          testScenarios: [],
        }));
        return;
      }
      setState((s) => ({
        ...s,
        phase: 'result',
        proposedContent: result.result!.proposedContent,
        resultSummary: result.result!.summary ?? '',
        resultRisks: result.result!.risks ?? [],
        testScenarios: result.result!.testScenarios ?? [],
        rawText: null,
        clarificationNeeded: null,
      }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function applyFixes() {
    const targetPath = state.resolvedArtifactPath ?? effectiveArtifact;
    if (!state.proposedContent || !targetPath) return;
    setState((s) => ({ ...s, phase: 'applying' }));
    try {
      validateArtifactPath(targetPath);   // Re-validate immediately before every write
      await tauriApi.saveGeneratedFile(targetPath, state.proposedContent);
      const now = new Date().toISOString();
      const note = `[${now}] UI: ai-kit-review-fixes-applied`;
      const existing = task.notes ?? '';
      await onTaskUpdate({
        notes: existing ? `${existing}\n${note}` : note,
      });
      setState((s) => ({ ...s, phase: 'done', postApplyDiffLoading: !!effectiveRepoRoot }));
      // Non-blocking: collect post-apply diff for display
      if (effectiveRepoRoot) {
        tauriApi.collectGitReviewContext(effectiveRepoRoot).then((gitCtx) => {
          setState((s) => ({
            ...s,
            postApplyDiff: gitCtx.diff?.trim() || null,
            postApplyDiffLoading: false,
          }));
        }).catch(() => {
          setState((s) => ({ ...s, postApplyDiffWarning: 'git diff not available', postApplyDiffLoading: false }));
        });
      }
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Derived capability flags ──────────────────────────────────────────────

  const resolverBlockerReason = repoCtx.blockers[0] ?? null;
  const runtimeWarningReason = runtimeStatus?.warnings[0] ?? null;
  const reviewDiffDisabledReason = !effectiveRepoRoot
    ? 'Repository root is not configured. Configure a repository path to enable diff review.'
    : runtimeStatus?.repoRootExists === false
    ? `Repository root does not exist on disk: ${effectiveRepoRoot}`
    : runtimeStatus?.gitDiffAvailable === false
    ? `Git diff is not available for repository root: ${effectiveRepoRoot}`
    : null;

  const canImplement  = kitConfigured && !resolverBlockerReason;
  const canReviewDiff = kitConfigured && !reviewDiffDisabledReason;

  // Workflow recommendation (used in context summary)
  const aiKitWorkflow = getAiKitWorkflowState(task, aiKitPath, effectiveArtifact ?? undefined);

  const isRunning = isPhaseRunning(state.phase);

  // Expose trigger methods so the workflow stepper can invoke these actions.
  useImperativeHandle(ref, () => ({
    startImplement,
    startReviewDiff,
    startApplyFixes,
  }));

  // ── Modals ────────────────────────────────────────────────────────────────

  const showPreviewModal = shouldShowPreviewModal(state.phase, state.action);
  const showResultModal = shouldShowResultModal(state.phase, state.action);

  const previewTitle = state.action === 'implement'
    ? 'Implement with AI Kit — Preview'
    : 'Apply AI Review Fixes — Preview';

  const resultTitle = state.action === 'implement'
    ? 'Implement with AI Kit — Result'
    : state.action === 'reviewDiff'
    ? 'Review Diff with AI Kit — Result'
    : 'Apply AI Review Fixes — Result';

  const confirmRunLabel = state.action === 'implement' ? 'Run Implementation' : 'Run Fix Generation';

  return (
    <>
      {/* ── Repo / AI Kit context summary ────────────────────────────────── */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 8 }}>
        {!kitConfigured && (
          <div style={{ color: 'var(--color-blocked, #e05555)' }}>AI Kit: not configured — Settings → AI Kit</div>
        )}
        <div>
          Repo:{' '}
          {effectiveRepoRoot
            ? <code style={{ fontSize: 10 }}>{effectiveRepoRoot.replace(/\\/g, '/').split('/').pop()}</code>
            : <span style={{ color: 'var(--color-warning, #d29922)' }}>(not configured)</span>
          }
          {repoCtx.repoRootSource === 'base-dir-computed' && (
            <span style={{ color: 'var(--color-warning, #d29922)', marginLeft: 6 }}>⚠ derived path</span>
          )}
          {usesRepoOverride && (
            <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>Git root uses dev-panel override.</span>
          )}
        </div>
        <div>
          Artifact:{' '}
          {effectiveArtifact
            ? <code style={{ fontSize: 10 }}>{effectiveArtifact.replace(/\\/g, '/').split('/').slice(-2).join('/')}</code>
            : <span style={{ color: 'var(--color-blocked, #e05555)' }}>(not configured)</span>
          }
          {repoCtx.insideAiKit === true && (
            <span style={{ color: 'var(--color-blocked, #e05555)', marginLeft: 6 }}>⊘ inside AI Kit</span>
          )}
          {repoCtx.insideRepo === false && repoCtx.hasRepo && (
            <span style={{ color: 'var(--color-blocked, #e05555)', marginLeft: 6 }}>⊘ outside repo</span>
          )}
        </div>
        <div>Task kind: {repoCtx.taskKind}</div>
        {runtimeStatus?.currentBranch && (
          <div>Branch: {runtimeStatus.currentBranch}</div>
        )}
        {aiKitWorkflow.recommendedAction && (
          <div>Next: {getAiKitActionLabel(aiKitWorkflow.recommendedAction)}</div>
        )}
        {targetPathMismatchWarning && (
          <div style={{ marginTop: 6, color: 'var(--color-warning, #d29922)' }}>
            {targetPathMismatchWarning}
          </div>
        )}
        {repoCtx.blockers.length > 0 && (
          <div style={{ marginTop: 6, color: 'var(--color-blocked, #e05555)' }}>
            <strong>Configured blockers:</strong>
            <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
              {repoCtx.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </div>
        )}
        {repoCtx.warnings.length > 0 && (
          <div style={{ marginTop: 6, color: 'var(--color-warning, #d29922)' }}>
            <strong>Configured warnings:</strong>
            <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
              {repoCtx.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
        {(runtimeLoading || (runtimeStatus?.warnings.length ?? 0) > 0) && (
          <div style={{ marginTop: 6, color: 'var(--color-warning, #d29922)' }}>
            <strong>Runtime warnings:</strong>
            {runtimeLoading ? (
              <div style={{ marginTop: 4 }}>Checking filesystem and git status…</div>
            ) : (
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                {runtimeStatus?.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* ── Buttons ──────────────────────────────────────────────────────── */}
      <div className="detail-action-grid">
        {/* Implement with AI Kit */}
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => startImplement()}
          disabled={isRunning || !canImplement}
          title={
            !kitConfigured
              ? 'Configure Power Platform AI Kit path in Settings → AI Kit first.'
              : resolverBlockerReason
              ? resolverBlockerReason
              : 'Implement task changes using AI Kit rules'
          }
        >
          {state.phase === 'preparing' && state.action === 'implement'
            ? <><span className="btn-spinner" /> Preparing AI Kit…</>
            : <><Icon name="layers" size={13} /> Implement with AI Kit</>}
        </button>

        {/* Review Diff with AI Kit */}
        <button
          className="btn btn-secondary btn-sm"
          onClick={startReviewDiff}
          disabled={isRunning || !canReviewDiff}
          title={
            !kitConfigured
              ? 'Configure Power Platform AI Kit path in Settings → AI Kit first.'
              : reviewDiffDisabledReason
              ? reviewDiffDisabledReason
              : runtimeWarningReason
              ? `${runtimeWarningReason} Review may fail until the runtime issue is fixed.`
              : 'Review current git diff against AI Kit rules'
          }
        >
          {(state.phase === 'preparing' || state.phase === 'running') && state.action === 'reviewDiff'
            ? <><span className="btn-spinner" /> Reviewing…</>
            : <><Icon name="search" size={13} /> Review Diff with AI Kit</>}
        </button>

        {/* Apply AI Review Fixes */}
        <button
          className="btn btn-secondary btn-sm"
          onClick={startApplyFixes}
          disabled={isRunning || !canApplyFixes || !kitConfigured || !!resolverBlockerReason}
          title={
            !kitConfigured
              ? 'Configure Power Platform AI Kit path in Settings → AI Kit first.'
              : resolverBlockerReason
              ? resolverBlockerReason
              : !latestAiKitReview
              ? 'Run AI Kit diff review first.'
              : aiKitReviewVerdict === 'pass'
              ? 'No fixes needed — last AI Kit review passed.'
              : 'Apply fixes for blockers/warnings from the last AI Kit review'
          }
        >
          {state.phase === 'preparing' && state.action === 'applyFixes'
            ? <><span className="btn-spinner" /> Preparing AI Kit…</>
            : <><Icon name="check" size={13} /> Apply AI Review Fixes</>}
        </button>
      </div>

      {/* Error inline */}
      {state.error && (
        <div className="settings-field-hint" style={{ color: 'var(--color-blocked, #e05555)', marginTop: 6 }}>
          {state.error}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={reset}>Dismiss</button>
        </div>
      )}

      {resolverBlockerReason && (
        <div className="settings-field-hint" style={{ color: 'var(--color-blocked, #e05555)', marginTop: 6 }}>
          AI Kit write actions are disabled: {resolverBlockerReason}
        </div>
      )}

      {!resolverBlockerReason && reviewDiffDisabledReason && (
        <div className="settings-field-hint" style={{ color: 'var(--color-warning, #d29922)', marginTop: 6 }}>
          Diff review unavailable: {reviewDiffDisabledReason}
        </div>
      )}

      {/* Review done inline message */}
      {state.phase === 'result' && state.action === 'reviewDiff' && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
          <Icon name="check" size={12} /> Review stored — see AI Reviews below.
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={reset}>Dismiss</button>
        </div>
      )}

      {/* ── Preview modal (before AI call) ───────────────────────────────── */}
      {showPreviewModal && (
        <Modal title={previewTitle} onClose={canDismissModal(state.phase) ? reset : () => {}}>
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            {state.phase === 'running' ? (
              <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
                <div style={{ marginBottom: 8 }}><span className="btn-spinner" /> Running AI implementation…</div>
                <div style={{ fontSize: 11 }}>This may take a moment.</div>
              </div>
            ) : (
              <>
                {state.kitContext && (
                  <>
                    <div style={{ marginBottom: 8 }}>
                      <strong>Task kind:</strong> {state.taskKind}
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <strong>Artifact:</strong>{' '}
                      <code style={{ fontSize: 11 }}>{state.resolvedArtifactPath ?? effectiveArtifact ?? '(not set)'}</code>
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <strong>Loaded AI Kit files:</strong>
                      <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                        {state.kitContext.loadedFiles.map((f) => (
                          <li key={f} style={{ fontSize: 11 }}>{f}</li>
                        ))}
                      </ul>
                    </div>
                    {state.action === 'applyFixes' && latestAiKitReview && (
                      <div style={{ marginBottom: 8 }}>
                        <strong>Review to fix ({latestAiKitReview.reviewerName}):</strong>
                        <div style={{ background: 'var(--bg-secondary)', padding: '6px 8px', borderRadius: 4, marginTop: 4, fontSize: 11, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                          {formatReviewForApplyFixes(latestAiKitReview).slice(0, 1200)}
                        </div>
                      </div>
                    )}
                    <div style={{ marginBottom: 12, color: 'var(--text-muted)', fontSize: 11 }}>
                      The AI will propose changes to the artifact file. You will review them before anything is written to disk.
                    </div>
                  </>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={state.action === 'implement' ? runImplement : runApplyFixes}
                    disabled={isRunning}
                  >
                    {confirmRunLabel}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={reset} disabled={isRunning}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {/* ── Result modal ─────────────────────────────────────────────────── */}
      {showResultModal && state.action !== 'reviewDiff' && (
        <Modal title={resultTitle} onClose={canDismissModal(state.phase) ? reset : () => {}} size="lg">
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            {state.phase === 'applying' ? (
              <div style={{ color: 'var(--text-muted)' }}><span className="btn-spinner" /> Applying…</div>
            ) : state.phase === 'done' ? (
              <div>
                <div style={{ color: 'var(--color-done, #3fb950)' }}>
                  <Icon name="check" size={14} /> File written successfully.
                </div>
                {state.resultSummary && <div style={{ marginTop: 4, color: 'var(--text-secondary)', fontSize: 12 }}>{state.resultSummary}</div>}
                {state.postApplyDiffLoading && (
                  <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 11 }}>
                    <span className="btn-spinner" /> Collecting git diff…
                  </div>
                )}
                {!state.postApplyDiffLoading && state.postApplyDiffWarning && (
                  <div style={{ marginTop: 6, color: 'var(--color-warning, #d29922)', fontSize: 11 }}>
                    {state.postApplyDiffWarning}
                  </div>
                )}
                {state.postApplyDiff && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>Post-apply diff:</div>
                    <pre style={{ background: 'var(--bg-secondary)', padding: 8, borderRadius: 4, fontSize: 11, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre', marginTop: 0 }}>
                      {state.postApplyDiff.slice(0, 4000)}
                      {state.postApplyDiff.length > 4000 ? '\n… [truncated]' : ''}
                    </pre>
                  </div>
                )}
                <div style={{ marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={reset}>Close</button>
                </div>
              </div>
            ) : (
              <>
                {state.clarificationNeeded ? (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ color: 'var(--color-warning, #d29922)', marginBottom: 6, fontWeight: 600 }}>
                      Clarification needed before implementation
                    </div>
                    <pre style={{ background: 'var(--bg-secondary)', padding: 8, borderRadius: 4, fontSize: 11, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                      {state.clarificationNeeded}
                    </pre>
                    <div style={{ color: 'var(--text-muted)', marginTop: 8, fontSize: 11 }}>
                      Update the task description or technical plan with the missing information, then re-run implementation.
                    </div>
                  </div>
                ) : state.rawText ? (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ color: 'var(--color-warning, #d29922)', marginBottom: 6 }}>
                      The model returned unstructured text (JSON parsing failed). Review below.
                    </div>
                    <pre style={{ background: 'var(--bg-secondary)', padding: 8, borderRadius: 4, fontSize: 11, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                      {state.rawText.slice(0, 3000)}
                    </pre>
                  </div>
                ) : (
                  <>
                    {state.resultSummary && (
                      <div style={{ marginBottom: 8 }}>
                        <strong>Summary:</strong> {state.resultSummary}
                      </div>
                    )}
                    {state.resultRisks.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <strong>Risks:</strong>
                        <ul style={{ margin: '2px 0 0 16px' }}>
                          {state.resultRisks.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      </div>
                    )}
                    {state.testScenarios.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <strong>Test scenarios:</strong>
                        <ul style={{ margin: '2px 0 0 16px' }}>
                          {state.testScenarios.map((t, i) => <li key={i}>{t}</li>)}
                        </ul>
                      </div>
                    )}
                    <div style={{ marginBottom: 8 }}>
                      <strong>Proposed content:</strong>
                      <pre style={{
                        background: 'var(--bg-secondary)',
                        padding: 8,
                        borderRadius: 4,
                        fontSize: 11,
                        maxHeight: 320,
                        overflow: 'auto',
                        whiteSpace: 'pre',
                        marginTop: 4,
                      }}>
                        {(state.proposedContent ?? '').slice(0, 8000)}
                        {(state.proposedContent?.length ?? 0) > 8000 && '\n… [truncated for display]'}
                      </pre>
                    </div>
                  </>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  {state.proposedContent && !state.clarificationNeeded && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={state.action === 'implement' ? applyImplementation : applyFixes}
                      disabled={isRunning}
                    >
                      <Icon name="check" size={13} /> Apply to File
                    </button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={reset} disabled={isRunning}>Discard</button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
});

export default AiKitActionsPanel;
