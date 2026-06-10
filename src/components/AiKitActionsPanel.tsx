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

import { useState, forwardRef, useImperativeHandle } from 'react';
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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AiKitActionsPanelProps {
  task: Task;
  customer: Customer | undefined;
  /** Absolute path to the AI Kit repository (from settings). */
  aiKitPath: string | undefined;
  /** Repository root used for git diff. */
  repoRootForGit: string | undefined;
  /** Resolved artifact path (explicit > inferred). */
  artifactPath: string | undefined;
  /** Called after a successful action so the parent can persist task updates. */
  onTaskUpdate: (updates: Partial<Task>) => Promise<void>;
  /** Called to surface errors to the parent component. */
  onError: (msg: string) => void;
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

type ActionPhase =
  | 'idle'
  | 'loading-context'
  | 'preview'       // show preview modal before AI call
  | 'running-ai'
  | 'result'        // show proposed content / diff
  | 'writing-file'
  | 'done';

type ActiveAction = 'implement' | 'reviewDiff' | 'applyFixes';

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
};

/** Imperative handle exposed via ref so workflow actions can trigger AI Kit flows. */
export interface AiKitActionsPanelHandle {
  startImplement(): void;
  startReviewDiff(): void;
  startApplyFixes(): void;
}

const AiKitActionsPanel = forwardRef<AiKitActionsPanelHandle, AiKitActionsPanelProps>(function AiKitActionsPanel({
  task,
  customer,
  aiKitPath,
  repoRootForGit,
  artifactPath,
  onTaskUpdate,
  onError,
}: AiKitActionsPanelProps, ref) {
  const [state, setState] = useState<ActionState>(INITIAL_STATE);

  const kitConfigured = !!(aiKitPath?.trim());

  function reset() {
    setState(INITIAL_STATE);
  }

  function setError(error: string) {
    setState((s) => ({ ...s, phase: 'idle', error }));
    onError?.(error);
  }

  // ── Latest AI Kit review (for Apply Fixes) ────────────────────────────────
  const latestAiKitReview = task.aiFileReviews?.find(
    (r) => r.reviewerName?.startsWith('AI Kit'),
  );
  const aiKitReviewVerdict = latestAiKitReview?.structured?.verdict;
  const canApplyFixes = !!latestAiKitReview && aiKitReviewVerdict !== 'pass';

  // ── Guards ────────────────────────────────────────────────────────────────

  function checkArtifactPath(): string | null {
    const p = artifactPath?.trim();
    if (!p) return null;
    const repoRoot = repoRootForGit ?? customer?.resolvedRepositoryPath ?? customer?.repositoryRoot;
    if (repoRoot) {
      const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
      if (!norm(p).startsWith(norm(repoRoot))) {
        throw new Error(`Target file is outside the repository root.\nFile: ${p}\nRepo: ${repoRoot}`);
      }
    }
    return p;
  }

  // ── Implement with AI Kit ─────────────────────────────────────────────────

  async function startImplement() {
    if (!kitConfigured) return;
    setState({ ...INITIAL_STATE, phase: 'loading-context', action: 'implement', error: null });
    try {
      const artPath = checkArtifactPath();
      if (!artPath) throw new Error('No artifact file path is configured. Set scriptPath or artifactPath in task setup.');

      const validation = await validateAiKitPath(aiKitPath!);
      if (!validation.valid) throw new Error(validation.statusMessage);

      const taskKind = detectTaskKindFromTask(task);
      const kitContext = await loadAiKitContext(aiKitPath!, taskKind, false, true);
      const artifactContent = await tauriApi.readFileContent(artPath);

      setState((s) => ({
        ...s,
        phase: 'preview',
        taskKind,
        kitContext,
        artifactContent,
      }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function runImplement() {
    if (!state.kitContext || !state.artifactContent || !state.taskKind) return;
    setState((s) => ({ ...s, phase: 'running-ai' }));
    try {
      const instructions = buildImplementInstructions(state.kitContext);
      const taskContext = buildTaskContextString(task, customer, state.taskKind);
      const result = await tauriApi.runAiKitImplementation(
        state.artifactContent,
        taskContext,
        instructions,
        '',
        0.2,
      );
      if (!result.ok || !result.result?.proposedContent) {
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
      }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function applyImplementation() {
    if (!state.proposedContent || !artifactPath) return;
    setState((s) => ({ ...s, phase: 'writing-file' }));
    try {
      await tauriApi.saveGeneratedFile(artifactPath, state.proposedContent);
      const now = new Date().toISOString();
      const note = `[${now}] UI: ai-kit-implementation-generated`;
      const existing = task.notes ?? '';
      await onTaskUpdate({
        notes: existing ? `${existing}\n${note}` : note,
      });
      setState((s) => ({ ...s, phase: 'done' }));
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Review Diff with AI Kit ───────────────────────────────────────────────

  async function startReviewDiff() {
    if (!kitConfigured) return;
    const repoRoot = repoRootForGit ?? customer?.resolvedRepositoryPath ?? customer?.repositoryRoot;
    if (!repoRoot) {
      setError('No repository root configured. Set up the customer repository first.');
      return;
    }

    setState({ ...INITIAL_STATE, phase: 'loading-context', action: 'reviewDiff', error: null });
    try {
      const validation = await validateAiKitPath(aiKitPath!);
      if (!validation.valid) throw new Error(validation.statusMessage);

      const taskKind = detectTaskKindFromTask(task);
      const kitContext = await loadAiKitContext(aiKitPath!, taskKind, true, true);

      let diff = '';
      try {
        const gitCtx = await tauriApi.collectGitReviewContext(repoRoot);
        diff = gitCtx.diff;
      } catch (e) {
        throw new Error(`Could not collect git diff: ${String(e)}`);
      }

      if (!diff.trim()) {
        setError('No changes to review. Make some local changes first.');
        return;
      }

      setState((s) => ({ ...s, phase: 'running-ai', taskKind, kitContext, diff }));

      const reviewerName = `AI Kit ${taskKind === 'plugin' ? 'Plugin' : taskKind === 'script' ? 'Script' : 'Ribbon'} Review`;
      const instructions = buildDiffReviewInstructions(kitContext);
      const taskContext = `Task: ${task.title}${task.analysisResult?.summaryCz ? `\nAnalysis: ${task.analysisResult.summaryCz.slice(0, 300)}` : ''}`;
      const fileName = artifactPath ? artifactPath.split(/[\\/]/).pop() ?? 'diff' : 'diff';

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
        filePath: artifactPath ?? repoRoot,
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
    const artPath = artifactPath?.trim();
    if (!artPath) {
      setError('No artifact file path configured. Set scriptPath or artifactPath in task setup.');
      return;
    }

    setState({ ...INITIAL_STATE, phase: 'loading-context', action: 'applyFixes', error: null });
    try {
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
      }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function runApplyFixes() {
    if (!state.kitContext || !state.artifactContent || !state.taskKind || !latestAiKitReview) return;
    setState((s) => ({ ...s, phase: 'running-ai' }));
    try {
      const reviewText = formatReviewForApplyFixes(latestAiKitReview);
      const instructions = buildApplyFixesInstructions(state.kitContext, reviewText);
      const taskContext = buildTaskContextString(task, customer, state.taskKind);
      const result = await tauriApi.runAiKitImplementation(
        state.artifactContent,
        taskContext,
        instructions,
        '',
        0.2,
      );
      if (!result.ok || !result.result?.proposedContent) {
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
      }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function applyFixes() {
    if (!state.proposedContent || !artifactPath) return;
    setState((s) => ({ ...s, phase: 'writing-file' }));
    try {
      await tauriApi.saveGeneratedFile(artifactPath, state.proposedContent);
      const now = new Date().toISOString();
      const note = `[${now}] UI: ai-kit-review-fixes-applied`;
      const existing = task.notes ?? '';
      await onTaskUpdate({
        notes: existing ? `${existing}\n${note}` : note,
      });
      setState((s) => ({ ...s, phase: 'done' }));
    } catch (e) {
      setError(String(e));
    }
  }

  // ── Determine if the kit is properly configured for the current task ───────

  const effectiveArtifact = artifactPath?.trim();
  const canImplement = kitConfigured && !!effectiveArtifact;
  const canReviewDiff = kitConfigured && !!(repoRootForGit ?? customer?.resolvedRepositoryPath ?? customer?.repositoryRoot);

  const isRunning = state.phase === 'loading-context' || state.phase === 'running-ai' || state.phase === 'writing-file';

  // Expose trigger methods so the workflow stepper can invoke these actions.
  useImperativeHandle(ref, () => ({
    startImplement,
    startReviewDiff,
    startApplyFixes,
  }));

  // ── Modals ────────────────────────────────────────────────────────────────

  const showPreviewModal = state.phase === 'preview';
  const showResultModal = state.phase === 'result' || state.phase === 'writing-file' || state.phase === 'done';

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
      {/* ── Buttons ──────────────────────────────────────────────────────── */}
      <div className="detail-action-grid">
        {/* Implement with AI Kit */}
        <button
          className="btn btn-secondary btn-sm"
          onClick={startImplement}
          disabled={isRunning || !canImplement}
          title={
            !kitConfigured
              ? 'Configure Power Platform AI Kit path in Settings → AI Kit first.'
              : !effectiveArtifact
              ? 'Set scriptPath or artifactPath in task setup before implementing.'
              : 'Implement task changes using AI Kit rules'
          }
        >
          {state.phase === 'loading-context' && state.action === 'implement'
            ? <><span className="btn-spinner" /> Loading context…</>
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
              : !canReviewDiff
              ? 'Configure repository root to enable diff review.'
              : 'Review current git diff against AI Kit rules'
          }
        >
          {(state.phase === 'loading-context' || state.phase === 'running-ai') && state.action === 'reviewDiff'
            ? <><span className="btn-spinner" /> Reviewing…</>
            : <><Icon name="search" size={13} /> Review Diff with AI Kit</>}
        </button>

        {/* Apply AI Review Fixes */}
        <button
          className="btn btn-secondary btn-sm"
          onClick={startApplyFixes}
          disabled={isRunning || !canApplyFixes || !kitConfigured || !effectiveArtifact}
          title={
            !kitConfigured
              ? 'Configure Power Platform AI Kit path in Settings → AI Kit first.'
              : !effectiveArtifact
              ? 'Set scriptPath or artifactPath in task setup.'
              : !latestAiKitReview
              ? 'Run AI Kit diff review first.'
              : aiKitReviewVerdict === 'pass'
              ? 'No fixes needed — last AI Kit review passed.'
              : 'Apply fixes for blockers/warnings from the last AI Kit review'
          }
        >
          {state.phase === 'loading-context' && state.action === 'applyFixes'
            ? <><span className="btn-spinner" /> Loading…</>
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

      {/* Review done inline message */}
      {state.phase === 'result' && state.action === 'reviewDiff' && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
          <Icon name="check" size={12} /> Review stored — see AI Reviews below.
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={reset}>Dismiss</button>
        </div>
      )}

      {/* ── Preview modal (before AI call) ───────────────────────────────── */}
      {showPreviewModal && (
        <Modal title={previewTitle} onClose={reset}>
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            {state.kitContext && (
              <>
                <div style={{ marginBottom: 8 }}>
                  <strong>Task kind:</strong> {state.taskKind}
                </div>
                <div style={{ marginBottom: 8 }}>
                  <strong>Artifact:</strong>{' '}
                  <code style={{ fontSize: 11 }}>{artifactPath ?? '(not set)'}</code>
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
              >
                {confirmRunLabel}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={reset}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Result modal ─────────────────────────────────────────────────── */}
      {showResultModal && state.action !== 'reviewDiff' && (
        <Modal title={resultTitle} onClose={reset} size="lg">
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            {state.phase === 'running-ai' ? (
              <div style={{ color: 'var(--text-muted)' }}><span className="btn-spinner" /> Running AI…</div>
            ) : state.phase === 'done' ? (
              <div style={{ color: 'var(--color-done, #3fb950)' }}>
                <Icon name="check" size={14} /> File written successfully.
                {state.resultSummary && <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>{state.resultSummary}</div>}
                <div style={{ marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={reset}>Close</button>
                </div>
              </div>
            ) : state.phase === 'writing-file' ? (
              <div style={{ color: 'var(--text-muted)' }}><span className="btn-spinner" /> Writing file…</div>
            ) : (
              <>
                {state.rawText ? (
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
                  {state.proposedContent && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={state.action === 'implement' ? applyImplementation : applyFixes}
                    >
                      <Icon name="check" size={13} /> Apply to File
                    </button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={reset}>Discard</button>
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
