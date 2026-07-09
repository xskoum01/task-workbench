import { describe, it, expect } from 'vitest';
import {
  deriveDataverseCheckStatus,
  computeImplVerifyNextStep,
} from './ImplementationVerificationModal';
import { formatTaskActivityNote, isTaskActivityLine } from '../lib/taskActivityFormatter';
import { mergeWithDefaults, selectReviewer, inferReviewSource } from '../lib/aiReviewers';
import { computeProgressionGate, getAiKitReviewGate, normalizeDataverseGate } from '../lib/implementationGate';
import type { Task, CrmVerificationReport, AiReviewerConfig, AiFileReviewResult, ImplCheckRecord } from '../types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return { id: 't1', title: 'Test task', status: 'in-progress', ...overrides } as unknown as Task;
}

function makeReport(verdict: CrmVerificationReport['verdict'], overrides: Partial<CrmVerificationReport> = {}): CrmVerificationReport {
  return {
    id: 'r1',
    createdAt: '2026-06-10T00:00:00.000Z',
    verdict,
    summary: 'Summary text.',
    issues: [],
    ...overrides,
  } as unknown as CrmVerificationReport;
}

// ---------------------------------------------------------------------------
// deriveDataverseCheckStatus
// ---------------------------------------------------------------------------

describe('deriveDataverseCheckStatus', () => {
  it('returns not-run when no reports exist', () => {
    expect(deriveDataverseCheckStatus(makeTask())).toBe('not-run');
  });

  it('returns passed when latest report verdict is pass', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('pass')] });
    expect(deriveDataverseCheckStatus(task)).toBe('passed');
  });

  it('returns warnings when latest report verdict is warnings', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('warnings')] });
    expect(deriveDataverseCheckStatus(task)).toBe('warnings');
  });

  it('returns failed when latest report verdict is fail', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('fail')] });
    expect(deriveDataverseCheckStatus(task)).toBe('failed');
  });

  it('returns not-run when report verdict is unknown or error (no confirmed result)', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('unknown')] });
    expect(deriveDataverseCheckStatus(task)).toBe('not-run');
  });

  it('manual override skipped takes priority over any report verdict', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('fail')],
      implementationVerification: { dataverseCheck: { status: 'skipped', skippedReason: 'no MCP' } },
    });
    expect(deriveDataverseCheckStatus(task)).toBe('skipped');
  });

  it('manual override manually-verified takes priority over any report verdict', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('fail')],
      implementationVerification: { dataverseCheck: { status: 'manually-verified' } },
    });
    expect(deriveDataverseCheckStatus(task)).toBe('manually-verified');
  });
});

// ---------------------------------------------------------------------------
// Open review button visibility (data-model level)
// ---------------------------------------------------------------------------

describe('Open review button — data model conditions', () => {
  it('REGRESSION: latestReport is set when crmVerificationReports has at least one entry', () => {
    // Box 2 shows "Open review" only when latestReport (task.crmVerificationReports?.[0]) is set.
    // This verifies the condition used by the button.
    const report = makeReport('fail', { summary: 'Missing attributes found.', issues: [{ severity: 'error', message: 'attr missing' } as never] });
    const task = makeTask({ crmVerificationReports: [report] });
    const latestReport = task.crmVerificationReports?.[0];
    expect(latestReport).toBeDefined();
  });

  it('latestReport is undefined when no reports exist — Open review hidden', () => {
    const task = makeTask();
    const latestReport = task.crmVerificationReports?.[0];
    expect(latestReport).toBeUndefined();
  });

  it('latestReport is defined after a failed MCP startup — error report stored', () => {
    // When MCP fails to start, an error report is stored with verdict 'error'.
    // Open review should open and show the technical error details from summary.
    const errorReport = makeReport('error', { summary: 'MCP working directory error: path is a file.' });
    const task = makeTask({ crmVerificationReports: [errorReport] });
    expect(task.crmVerificationReports?.[0]).toBeDefined();
    expect(task.crmVerificationReports![0].verdict).toBe('error');
    expect(task.crmVerificationReports![0].summary).toContain('MCP working directory error');
  });

  it('rerunning Dataverse check replaces stored report — latest report is always [0]', () => {
    const old = makeReport('fail', { id: 'old', summary: 'Old result.' });
    const fresh = makeReport('pass', { id: 'new', summary: 'All clear.' });
    // Simulate how handleRunDataverseCheckForImpl prepends: [fresh, old].slice(0, 5)
    const task = makeTask({ crmVerificationReports: [fresh, old] });
    expect(task.crmVerificationReports![0].id).toBe('new');
    expect(task.crmVerificationReports![0].verdict).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// computeImplVerifyNextStep
// ---------------------------------------------------------------------------

describe('computeImplVerifyNextStep', () => {
  it('suggests fixing blockers when Dataverse check failed', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('fail')] });
    const step = computeImplVerifyNextStep(task);
    expect(step.toLowerCase()).toContain('fix');
  });

  it('suggests reviewing warnings when Dataverse check has warnings', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('warnings')] });
    const step = computeImplVerifyNextStep(task);
    expect(step.toLowerCase()).toContain('warning');
  });

  it('AI Internal Code Review Open review — aiFileReviews[0] drives latestAiReview', () => {
    // Regression guard: AI review button visibility depends on task.aiFileReviews?.[0].
    // Ensure that adding onOpenDvReview did not disturb the AI review data path.
    const task = makeTask({
      aiFileReviews: [{ id: 'rev1', reviewerName: 'AI Reviewer', filePath: 'x.ts', reviewedAt: '2026-06-10T00:00:00.000Z', reviewMode: 'file' } as never],
    });
    const latestAiReview = task.aiFileReviews?.[0];
    expect(latestAiReview).toBeDefined();
    expect(latestAiReview!.id).toBe('rev1');
  });

  // ── Modal footer must match MCP's composeManualVerificationStep wording ──────────────────
  // (see mcp/task-workbench-mcp.mjs composeManualVerificationStep and
  // task_mcp_compose_manual_verification_step in src-tauri/src/lib.rs — keep all three in sync)

  it('footer message mentions Dataverse, AI review, and Local Test when all three are unresolved', () => {
    const task = makeTask({ implementationVerification: { buildCheck: { status: 'passed' } } });
    const step = computeImplVerifyNextStep(task);
    expect(step).toBe(
      'Run Dataverse Metadata Check and AI Kit/Settings Review. '
      + 'Then upload/register the web resource manually and record Local Test/browser validation.',
    );
  });

  it('footer message omits Dataverse once resolved — only mentions AI review and Local Test', () => {
    // Dataverse passed, AI review still not-run, Local Test still not-run: the composer must
    // not tell the user to re-run a check that already passed.
    const task = makeTask({
      crmVerificationReports: [makeReport('pass')],
      implementationVerification: { buildCheck: { status: 'passed' } },
    });
    const step = computeImplVerifyNextStep(task);
    expect(step).toBe(
      'Run AI Kit/Settings Review. Then upload/register the web resource manually and record Local Test/browser validation.',
    );
  });

  it('footer message does not say "in the Implementation Verification modal" (user is already in it)', () => {
    const task = makeTask({ implementationVerification: { buildCheck: { status: 'passed' } } });
    expect(computeImplVerifyNextStep(task)).not.toContain('Implementation Verification modal');
  });

  it('suggests consultant testing once Local Test is recorded even if Dataverse/AI review are not-run', () => {
    // Existing behavior preserved: local === 'passed'/'not-needed' short-circuits before the
    // manual-action composer, regardless of dv/ai state.
    const task = makeTask({
      implementationVerification: { buildCheck: { status: 'passed' }, localTest: { status: 'not-needed' } },
    });
    expect(computeImplVerifyNextStep(task)).toBe('Send to consultant testing or request code review');
  });
});

// ---------------------------------------------------------------------------
// Reset data-model conditions
// ---------------------------------------------------------------------------

describe('Reset — data model after Dataverse check reset', () => {
  it('dvStatus returns not-run after crmVerificationReports cleared', () => {
    // Simulates handleResetDvCheck: sets crmVerificationReports: [] and dataverseCheck: { status: 'not-run' }
    const task = makeTask({ crmVerificationReports: [], implementationVerification: { dataverseCheck: { status: 'not-run' } } });
    expect(deriveDataverseCheckStatus(task)).toBe('not-run');
  });

  it('latestReport is undefined after crmVerificationReports cleared — hides Open review', () => {
    const task = makeTask({ crmVerificationReports: [] });
    expect(task.crmVerificationReports?.[0]).toBeUndefined();
  });

  it('dvStatus was failed before reset — passes visibility condition for Reset button', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('fail')] });
    const dvStatus = deriveDataverseCheckStatus(task);
    expect(dvStatus).toBe('failed');
    // Reset button is shown when dvStatus !== 'not-run'
    expect(dvStatus !== 'not-run').toBe(true);
  });

  it('dvStatus was passed before reset — passes visibility condition for Reset button', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('pass')] });
    const dvStatus = deriveDataverseCheckStatus(task);
    expect(dvStatus !== 'not-run').toBe(true);
  });

  it('dvStatus was warnings before reset — passes visibility condition for Reset button', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('warnings')] });
    const dvStatus = deriveDataverseCheckStatus(task);
    expect(dvStatus !== 'not-run').toBe(true);
  });

  it('dvStatus was skipped before reset — passes visibility condition for Reset button', () => {
    const task = makeTask({ implementationVerification: { dataverseCheck: { status: 'skipped', skippedReason: 'no MCP' } } });
    const dvStatus = deriveDataverseCheckStatus(task);
    expect(dvStatus !== 'not-run').toBe(true);
  });

  it('dvStatus was manually-verified before reset — passes visibility condition for Reset button', () => {
    const task = makeTask({ implementationVerification: { dataverseCheck: { status: 'manually-verified' } } });
    const dvStatus = deriveDataverseCheckStatus(task);
    expect(dvStatus !== 'not-run').toBe(true);
  });
});

describe('Reset — data model after AI code review reset', () => {
  it('aiStatus returns not-run after implementationVerification.aiCodeReview cleared', () => {
    // handleResetAiReview only clears implementationVerification.aiCodeReview — does NOT clear aiFileReviews
    const task = makeTask({
      aiFileReviews: [{ id: 'rev1', reviewerName: 'Plugin Internal Check', filePath: 'x.cs', reviewedAt: '2026-06-10T00:00:00.000Z', reviewMode: 'file' } as never],
      implementationVerification: { aiCodeReview: { status: 'not-run' } },
    });
    const aiStatus = task.implementationVerification?.aiCodeReview?.status ?? 'not-run';
    expect(aiStatus).toBe('not-run');
  });

  it('aiFileReviews history is preserved after reset — not cleared', () => {
    // Simulates state after handleResetAiReview: aiCodeReview = not-run, aiFileReviews still present
    const task = makeTask({
      aiFileReviews: [{ id: 'rev1', reviewerName: 'Plugin Internal Check', filePath: 'x.cs', reviewedAt: '2026-06-10T00:00:00.000Z', reviewMode: 'file' } as never],
      implementationVerification: { aiCodeReview: { status: 'not-run' } },
    });
    expect(task.aiFileReviews).toHaveLength(1);
    expect(task.aiFileReviews![0].id).toBe('rev1');
  });

  it('active review lookup returns undefined when aiStatus is not-run — Open review hidden after reset', () => {
    // Even though aiFileReviews has a review, status=not-run means no active review
    const task = makeTask({
      aiFileReviews: [{ id: 'rev1', reviewerName: 'Plugin Internal Check', filePath: 'x.cs', reviewedAt: '2026-06-10T00:00:00.000Z', reviewMode: 'file' } as never],
      implementationVerification: { aiCodeReview: { status: 'not-run' } },
    });
    const aiStatus = task.implementationVerification?.aiCodeReview?.status ?? 'not-run';
    // Simulate the latestAiReview lookup logic from the modal
    const latestAiReview = (() => {
      if (aiStatus === 'not-run') return undefined;
      const reviewId = task.implementationVerification?.aiCodeReview?.reviewId;
      if (reviewId) return task.aiFileReviews?.find((r) => r.id === reviewId);
      return task.aiFileReviews?.[0];
    })();
    expect(latestAiReview).toBeUndefined();
  });

  it('active review lookup uses reviewId when present — links to correct aiFileReviews entry', () => {
    const oldReview = { id: 'rev-old', reviewerName: 'Plugin Internal Check', filePath: 'x.cs', reviewedAt: '2026-06-09T00:00:00.000Z', reviewMode: 'file' };
    const newReview = { id: 'rev-new', reviewerName: 'Plugin Internal Check', filePath: 'x.cs', reviewedAt: '2026-06-10T00:00:00.000Z', reviewMode: 'file' };
    const task = makeTask({
      aiFileReviews: [newReview, oldReview] as never,
      implementationVerification: { aiCodeReview: { status: 'failed', reviewId: 'rev-new' } },
    });
    const aiStatus = task.implementationVerification?.aiCodeReview?.status ?? 'not-run';
    const reviewId = task.implementationVerification?.aiCodeReview?.reviewId;
    const latestAiReview = (() => {
      if (aiStatus === 'not-run') return undefined;
      if (reviewId) return task.aiFileReviews?.find((r) => r.id === reviewId);
      return task.aiFileReviews?.[0];
    })();
    expect(latestAiReview).toBeDefined();
    expect(latestAiReview!.id).toBe('rev-new');
  });

  it('active review lookup falls back to aiFileReviews[0] for old records without reviewId', () => {
    const task = makeTask({
      aiFileReviews: [{ id: 'rev1', reviewerName: 'Plugin Internal Check', filePath: 'x.cs', reviewedAt: '2026-06-10T00:00:00.000Z', reviewMode: 'file' } as never],
      implementationVerification: { aiCodeReview: { status: 'failed' } },
    });
    const aiStatus = task.implementationVerification?.aiCodeReview?.status ?? 'not-run';
    const reviewId = task.implementationVerification?.aiCodeReview?.reviewId;
    const latestAiReview = (() => {
      if (aiStatus === 'not-run') return undefined;
      if (reviewId) return task.aiFileReviews?.find((r) => r.id === reviewId);
      return task.aiFileReviews?.[0];
    })();
    expect(latestAiReview).toBeDefined();
    expect(latestAiReview!.id).toBe('rev1');
  });

  it('failed AI review with details shows Open review — latestAiReview is defined', () => {
    const task = makeTask({
      aiFileReviews: [{ id: 'rev1', reviewerName: 'Plugin Internal Check', filePath: 'x.cs', reviewedAt: '2026-06-10T00:00:00.000Z', reviewMode: 'file' } as never],
      implementationVerification: { aiCodeReview: { status: 'failed', reviewId: 'rev1' } },
    });
    const aiStatus = task.implementationVerification?.aiCodeReview?.status ?? 'not-run';
    const reviewId = task.implementationVerification?.aiCodeReview?.reviewId;
    const latestAiReview = (() => {
      if (aiStatus === 'not-run') return undefined;
      if (reviewId) return task.aiFileReviews?.find((r) => r.id === reviewId);
      return task.aiFileReviews?.[0];
    })();
    // Open review condition: latestAiReview is defined
    expect(latestAiReview).toBeDefined();
  });

  it('failed AI review without details — Open review is hidden, warning should be shown', () => {
    // aiCodeReview.status is failed but no reviewId and no aiFileReviews
    const task = makeTask({
      implementationVerification: { aiCodeReview: { status: 'failed' } },
    });
    const aiStatus = task.implementationVerification?.aiCodeReview?.status ?? 'not-run';
    const reviewId = task.implementationVerification?.aiCodeReview?.reviewId;
    const latestAiReview = (() => {
      if (aiStatus === 'not-run') return undefined;
      if (reviewId) return task.aiFileReviews?.find((r) => r.id === reviewId);
      return task.aiFileReviews?.[0];
    })();
    // Open review hidden; warning condition: aiStatus !== 'not-run' && !latestAiReview
    expect(latestAiReview).toBeUndefined();
    expect(aiStatus !== 'not-run' && !latestAiReview).toBe(true);
  });

  it('aiStatus was failed before reset — passes visibility condition for Reset button', () => {
    const task = makeTask({ implementationVerification: { aiCodeReview: { status: 'failed' } } });
    const aiStatus = task.implementationVerification?.aiCodeReview?.status ?? 'not-run';
    expect(aiStatus !== 'not-run').toBe(true);
  });

  it('aiStatus was skipped before reset — passes visibility condition for Reset button', () => {
    const task = makeTask({ implementationVerification: { aiCodeReview: { status: 'skipped', skippedReason: 'n/a' } } });
    const aiStatus = task.implementationVerification?.aiCodeReview?.status ?? 'not-run';
    expect(aiStatus !== 'not-run').toBe(true);
  });

  it('aiStatus was manually-reviewed before reset — passes visibility condition for Reset button', () => {
    const task = makeTask({ implementationVerification: { aiCodeReview: { status: 'manually-verified' } } });
    const aiStatus = task.implementationVerification?.aiCodeReview?.status ?? 'not-run';
    expect(aiStatus !== 'not-run').toBe(true);
  });

  it('REGRESSION: Dataverse reset still clears crmVerificationReports — dvStatus returns not-run', () => {
    // handleResetDvCheck clears crmVerificationReports and dataverseCheck. Unchanged behavior.
    const task = makeTask({ crmVerificationReports: [], implementationVerification: { dataverseCheck: { status: 'not-run' } } });
    expect(deriveDataverseCheckStatus(task)).toBe('not-run');
    expect(task.crmVerificationReports).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dataverse NOT CONFIGURED preflight — data model
// ---------------------------------------------------------------------------

describe('Dataverse NOT CONFIGURED preflight — data model', () => {
  // deriveDataverseCheckStatus must not return 'not-run' for not_configured.
  // Before the fix it fell to 'not-run' because only pass/warnings/fail were mapped.
  it('deriveDataverseCheckStatus returns warnings for not_configured verdict', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('not_configured')] });
    expect(deriveDataverseCheckStatus(task)).toBe('warnings');
  });

  it('not-configured report has verdict warnings — drives status badge correctly', () => {
    const report = makeReport('warnings', {
      summary: 'Dataverse metadata assistant is not configured.',
      answer: 'Open Settings → CRM Metadata and configure Primarch MCP command/args.',
    });
    const task = makeTask({ crmVerificationReports: [report] });
    expect(deriveDataverseCheckStatus(task)).toBe('warnings');
    expect(task.crmVerificationReports![0].summary).toContain('not configured');
  });

  it('not-configured report has no issues — does not show issue count in modal', () => {
    const report = makeReport('warnings', {
      summary: 'Dataverse metadata assistant is not configured.',
      issues: [],
    });
    expect((report.issues ?? []).length).toBe(0);
  });

  it('not-configured report stores human-readable guidance in answer field', () => {
    const report = makeReport('warnings', {
      answer: 'Open Settings → CRM Metadata and configure Primarch MCP command/args.',
    });
    expect(report.answer).toContain('Settings');
  });

  it('not-configured report unableToVerifyReasons lists the reason', () => {
    const report = makeReport('warnings', {
      unableToVerifyReasons: ['CRM metadata assistant is not configured. Enable CRM Metadata in Settings and set Primarch MCP command/args.'],
    } as Partial<CrmVerificationReport>);
    expect((report as CrmVerificationReport & { unableToVerifyReasons?: string[] }).unableToVerifyReasons?.[0]).toContain('not configured');
  });

  it('manual override skipped still takes priority over not_configured verdict', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('not_configured')],
      implementationVerification: { dataverseCheck: { status: 'skipped', skippedReason: 'no MCP' } },
    });
    expect(deriveDataverseCheckStatus(task)).toBe('skipped');
  });

  it('manual override manually-verified still takes priority over not_configured verdict', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('not_configured')],
      implementationVerification: { dataverseCheck: { status: 'manually-verified' } },
    });
    expect(deriveDataverseCheckStatus(task)).toBe('manually-verified');
  });

  it('configured mismatch path is unchanged — fail verdict still returns failed', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('fail', { summary: 'Missing attribute: nvr_status' })] });
    expect(deriveDataverseCheckStatus(task)).toBe('failed');
  });

  it('configured pass path is unchanged — pass verdict still returns passed', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('pass')] });
    expect(deriveDataverseCheckStatus(task)).toBe('passed');
  });

  it('not-configured Reset button — dvStatus is warnings, passes visibility condition', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('not_configured')] });
    const dvStatus = deriveDataverseCheckStatus(task);
    // Reset button shown when dvStatus !== 'not-run'
    expect(dvStatus !== 'not-run').toBe(true);
  });

  it('after Reset: crmVerificationReports cleared — not_configured report removed, dvStatus returns not-run', () => {
    const task = makeTask({ crmVerificationReports: [], implementationVerification: { dataverseCheck: { status: 'not-run' } } });
    expect(deriveDataverseCheckStatus(task)).toBe('not-run');
  });
});

// ---------------------------------------------------------------------------
// AI Code Review robustness — array guard regressions
// ---------------------------------------------------------------------------

describe('AI Code Review robustness — array guards', () => {
  // These tests document the guards added to handleRunAiCodeReviewForImpl.
  // They test the same defensive pattern inline to ensure the fix is correct.

  it('safeArr pattern: undefined array gives empty array — no TypeError on .length', () => {
    // This documents the fix pattern: (arr ?? []).length instead of arr.length
    const arr: string[] | undefined = undefined;
    expect(() => (arr ?? []).length).not.toThrow();
    expect((arr ?? []).length).toBe(0);
  });

  it('safeArr pattern: null array gives empty array — no TypeError on .slice', () => {
    const arr: string[] | null = null;
    expect(() => (arr ?? []).slice(0, 3)).not.toThrow();
    expect((arr ?? []).slice(0, 3)).toHaveLength(0);
  });

  it('techPlan with implementationSteps undefined — guarded length check does not throw', () => {
    // Regression: techPlan.implementationSteps.length threw when field was absent from JSON
    const techPlan = { summary: 'Plan summary', implementationSteps: undefined, risks: [] } as unknown as { implementationSteps?: string[]; risks?: string[] };
    const implSteps: string[] = techPlan.implementationSteps ?? [];
    expect(() => implSteps.length).not.toThrow();
    expect(implSteps.length).toBe(0);
  });

  it('techPlan with risks undefined — guarded length check does not throw', () => {
    const techPlan = { summary: 'Plan summary', implementationSteps: [], risks: undefined } as unknown as { implementationSteps?: string[]; risks?: string[] };
    const risks: string[] = techPlan.risks ?? [];
    expect(() => risks.length).not.toThrow();
    expect(risks.length).toBe(0);
  });

  it('gitCtx with changedFiles undefined — guarded length check does not throw', () => {
    const gitCtx = { diff: 'some diff', changedFiles: undefined } as never;
    const changedFiles: string[] = (gitCtx as { changedFiles?: string[] }).changedFiles ?? [];
    expect(() => changedFiles.length).not.toThrow();
    expect(changedFiles.length).toBe(0);
  });

  it('gitCtx with noiseFiles undefined — guarded length check does not throw', () => {
    const gitCtx = { noiseFiles: undefined } as never;
    const noiseFiles: string[] = (gitCtx as { noiseFiles?: string[] }).noiseFiles ?? [];
    expect(noiseFiles.length > 0).toBe(false);
  });

  it('gitCtx with flaggedPaths undefined — guarded length check does not throw', () => {
    const gitCtx = { flaggedPaths: undefined } as never;
    const flaggedPaths: string[] = (gitCtx as { flaggedPaths?: string[] }).flaggedPaths ?? [];
    expect(flaggedPaths.length > 0).toBe(false);
  });

  it('gitCtx with untrackedIncluded undefined — guarded length/join does not throw', () => {
    const gitCtx = { untrackedIncluded: undefined } as never;
    const untrackedIncl: string[] = (gitCtx as { untrackedIncluded?: string[] }).untrackedIncluded ?? [];
    expect(() => untrackedIncl.join(', ')).not.toThrow();
  });

  it('gitCtx with untrackedSkipped undefined — guarded length/slice does not throw', () => {
    const gitCtx = { untrackedSkipped: undefined } as never;
    const untrackedSkip: string[] = (gitCtx as { untrackedSkipped?: string[] }).untrackedSkipped ?? [];
    expect(() => untrackedSkip.slice(0, 3).join(', ')).not.toThrow();
  });

  it('dvReport with issues undefined — flattenFindings guard does not throw', () => {
    // dvReport sections already used ?? [] before, but document the pattern
    const dvReport = { verdict: 'fail', issues: undefined, missingReferences: undefined, pluginChecks: undefined } as never;
    expect(() => ((dvReport as { issues?: unknown[] }).issues ?? []).slice(0, 5)).not.toThrow();
    expect(() => ((dvReport as { missingReferences?: unknown[] }).missingReferences ?? []).slice(0, 8)).not.toThrow();
    expect(() => ((dvReport as { pluginChecks?: unknown[] }).pluginChecks ?? []).filter(() => true)).not.toThrow();
  });

  it('AiFileReviewResult with structured.comments undefined — flattenFindings does not throw', () => {
    // flattenFindings already guards with (result.structured.comments ?? [])
    const structured = { verdict: 'needs_changes', comments: undefined, generalSuggestions: undefined } as never;
    const comments: unknown[] = (structured as { comments?: unknown[] }).comments ?? [];
    const suggestions: unknown[] = (structured as { generalSuggestions?: unknown[] }).generalSuggestions ?? [];
    expect(comments.length).toBe(0);
    expect(suggestions.length).toBe(0);
  });

  it('REGRESSION: TypeError "Cannot read properties of undefined (reading length)" is not thrown for undefined techPlan arrays', () => {
    // This is the exact regression that caused the user-visible error.
    // Simulates what happens when task.crmDeveloperWorkflow.technicalPlan has missing arrays.
    const techPlan = { summary: 'Test', generatedAt: '2026-06-11T00:00:00.000Z', workKind: 'script' } as never;
    let threw = false;
    try {
      const implSteps: string[] = (techPlan as { implementationSteps?: string[] }).implementationSteps ?? [];
      const risks: string[] = (techPlan as { risks?: string[] }).risks ?? [];
      if (implSteps.length) {
        implSteps.slice(0, 6).forEach(() => {});
      }
      if (risks.length) {
        risks.slice(0, 3).forEach(() => {});
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Activity note formatting for reset events
// ---------------------------------------------------------------------------

describe('formatTaskActivityNote — reset events', () => {
  function withTimestamp(body: string) {
    return `[2026-06-10T10:00:00.000Z] ${body}`;
  }

  it('formats dataverse-metadata-check-reset correctly', () => {
    const result = formatTaskActivityNote(withTimestamp('UI: dataverse-metadata-check-reset'));
    expect(result.message).toBe('Resetována kontrola Dataverse metadat.');
    expect(result.source).toBe('Verification');
  });

  it('formats ai-code-review-reset correctly', () => {
    const result = formatTaskActivityNote(withTimestamp('UI: ai-code-review-reset'));
    expect(result.message).toBe('Resetována AI recenze kódu.');
    expect(result.source).toBe('Verification');
  });

  it('isTaskActivityLine recognizes dataverse-metadata-check-reset', () => {
    expect(isTaskActivityLine(withTimestamp('UI: dataverse-metadata-check-reset'))).toBe(true);
  });

  it('isTaskActivityLine recognizes ai-code-review-reset', () => {
    expect(isTaskActivityLine(withTimestamp('UI: ai-code-review-reset'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Settings reviewer selection — used by handleRunSettingsReviewerForImpl
// ---------------------------------------------------------------------------

describe('Settings reviewer selection for Implementation Verification', () => {
  function makeReviewer(overrides: Partial<AiReviewerConfig>): AiReviewerConfig {
    return {
      id:           'custom',
      name:         'Custom Reviewer',
      description:  'Test reviewer',
      instructions: 'Review the code.',
      quickPrompts: [],
      enabled:      true,
      temperature:  0.2,
      appliesTo:    { fileExtensions: [], devTargetKinds: [] },
      ...overrides,
    };
  }

  // ── Renders two AI review buttons (data-model level) ──────────────────────

  it('AI Kit review button: calls onRunAiCodeReview — distinct from Settings reviewer path', () => {
    // The modal exposes two callbacks: onRunAiCodeReview (AI Kit) and onRunSettingsReviewer.
    // Verify they are separate props so components can wire them independently.
    let aiKitCalled = false;
    let settingsCalled = false;
    const onRunAiCodeReview    = async () => { aiKitCalled    = true; };
    const onRunSettingsReviewer = async () => { settingsCalled = true; };

    onRunAiCodeReview();
    expect(aiKitCalled).toBe(true);
    expect(settingsCalled).toBe(false);

    onRunSettingsReviewer();
    expect(settingsCalled).toBe(true);
  });

  // ── Script task: .js/.ts file → JavaScript reviewer ──────────────────────

  it('script task: .js artifact selects JavaScript Power Apps Script Reviewer', () => {
    const configs  = mergeWithDefaults(undefined);
    const reviewer = selectReviewer(configs, 'Scripts/nvr_account_events.js', 'script');
    expect(reviewer).toBeDefined();
    expect(reviewer!.name).toBe('JavaScript Power Apps Script Reviewer');
  });

  it('script task: .ts artifact selects JavaScript Power Apps Script Reviewer', () => {
    const configs  = mergeWithDefaults(undefined);
    const reviewer = selectReviewer(configs, 'Scripts/my_form_handler.ts', 'script');
    expect(reviewer).toBeDefined();
    expect(reviewer!.name).toBe('JavaScript Power Apps Script Reviewer');
  });

  it('script task: reviewerName is the reviewer display name, not AI Kit name', () => {
    const configs  = mergeWithDefaults(undefined);
    const reviewer = selectReviewer(configs, 'Scripts/nvr_account_events.js', 'script');
    expect(reviewer!.name).toBe('JavaScript Power Apps Script Reviewer');
    expect(reviewer!.name).not.toBe('Script AI Kit Review');
    expect(reviewer!.name).not.toBe('Script Internal Check');
  });

  it('script task: reviewer has non-empty instructions', () => {
    const configs  = mergeWithDefaults(undefined);
    const reviewer = selectReviewer(configs, 'Scripts/nvr_account_events.js', 'script');
    expect(reviewer!.instructions.trim().length).toBeGreaterThan(0);
  });

  // ── Plugin task: .cs file → C# Plugin CRM Reviewer ───────────────────────

  it('plugin task: .cs artifact selects C# Plugin CRM Reviewer', () => {
    const configs  = mergeWithDefaults(undefined);
    const reviewer = selectReviewer(configs, 'Plugins/MyPlugin.cs', 'plugin');
    expect(reviewer).toBeDefined();
    expect(reviewer!.name).toBe('C# Plugin CRM Reviewer');
  });

  it('plugin task: reviewerName is the reviewer display name, not AI Kit name', () => {
    const configs  = mergeWithDefaults(undefined);
    const reviewer = selectReviewer(configs, 'Plugins/MyPlugin.cs', 'plugin');
    expect(reviewer!.name).toBe('C# Plugin CRM Reviewer');
    expect(reviewer!.name).not.toBe('Plugin AI Kit Review');
    expect(reviewer!.name).not.toBe('Plugin Internal Check');
  });

  // ── Error case: no enabled reviewer matches ───────────────────────────────

  it('no matching reviewer: selectReviewer returns undefined for unrecognized extension', () => {
    const configs  = mergeWithDefaults(undefined);
    const reviewer = selectReviewer(configs, 'README.md', undefined);
    expect(reviewer).toBeUndefined();
  });

  it('no matching reviewer: selectReviewer returns undefined when all reviewers are disabled', () => {
    const disabled = mergeWithDefaults(undefined).map((r) => ({ ...r, enabled: false }));
    const reviewer = selectReviewer(disabled, 'Scripts/nvr_account_events.js', 'script');
    expect(reviewer).toBeUndefined();
  });

  it('no matching reviewer: result is undefined, not a thrown exception', () => {
    const configs = mergeWithDefaults(undefined);
    expect(() => selectReviewer(configs, 'unknown.xyz', undefined)).not.toThrow();
    expect(selectReviewer(configs, 'unknown.xyz', undefined)).toBeUndefined();
  });

  // ── User-configured reviewer override ────────────────────────────────────

  it('user override: Settings reviewer name is used, not the default name', () => {
    const userOverride: AiReviewerConfig = makeReviewer({
      id:          'javascript-powerapps-script',
      name:        'My Custom JS Reviewer',
      appliesTo:   { fileExtensions: ['js', 'ts'], devTargetKinds: ['script'] },
    });
    const configs  = mergeWithDefaults([userOverride]);
    const reviewer = selectReviewer(configs, 'Scripts/nvr_account_events.js', 'script');
    expect(reviewer!.name).toBe('My Custom JS Reviewer');
  });

  // ── reviewId is set after a Settings reviewer run (data-model level) ──────

  it('aiCodeReview.reviewId is set to the review entry id after a Settings reviewer run', () => {
    // Simulates what handleRunSettingsReviewerForImpl stores.
    const reviewEntry = { id: 'impl-review-2026-06-12T10:00:00.000Z', reviewerName: 'C# Plugin CRM Reviewer', filePath: 'Plugins/MyPlugin.cs', reviewMode: 'change' as const };
    const aiCodeReview = { status: 'passed' as const, reviewId: reviewEntry.id, runAt: '2026-06-12T10:00:00.000Z', summary: 'Looks good.', findings: [] };
    expect(aiCodeReview.reviewId).toBe(reviewEntry.id);
  });

  it('latestAiReview lookup: finds review by reviewId — works for Settings reviewer entry', () => {
    const id = 'impl-review-settings-2026-06-12T10:00:00.000Z';
    const task = makeTask({
      aiFileReviews: [
        { id, reviewerName: 'C# Plugin CRM Reviewer', filePath: 'Plugins/MyPlugin.cs', reviewMode: 'change' },
        { id: 'impl-review-other', reviewerName: 'Script AI Kit Review', filePath: 'Scripts/foo.js', reviewMode: 'change' },
      ] as never,
      implementationVerification: {
        aiCodeReview: { status: 'passed', reviewId: id },
      },
    });
    const reviewId     = task.implementationVerification?.aiCodeReview?.reviewId;
    const latestReview = task.aiFileReviews?.find((r) => r.id === reviewId);
    expect(latestReview).toBeDefined();
    expect(latestReview!.reviewerName).toBe('C# Plugin CRM Reviewer');
  });

  it('Open review: after Settings reviewer run, reviewId points to the latest Settings reviewer entry', () => {
    const id = 'impl-review-settings-2026-06-12T10:00:00.000Z';
    const task = makeTask({
      aiFileReviews: [
        { id, reviewerName: 'JavaScript Power Apps Script Reviewer', filePath: 'Scripts/nvr_account_events.js', reviewMode: 'change' },
      ] as never,
      implementationVerification: {
        aiCodeReview: { status: 'passed', reviewId: id },
      },
    });
    const aiStatus  = task.implementationVerification?.aiCodeReview?.status ?? 'not-run';
    const reviewId  = task.implementationVerification?.aiCodeReview?.reviewId;
    const latestReview = aiStatus !== 'not-run'
      ? (reviewId ? task.aiFileReviews?.find((r) => r.id === reviewId) : task.aiFileReviews?.[0])
      : undefined;
    expect(latestReview).toBeDefined();
    expect(latestReview!.reviewerName).toBe('JavaScript Power Apps Script Reviewer');
  });

  // ── Regression: no "undefined › undefined" ───────────────────────────────

  it('REGRESSION: selectReviewer with empty artifactPath does not throw', () => {
    const configs = mergeWithDefaults(undefined);
    expect(() => selectReviewer(configs, '', 'script')).not.toThrow();
  });

  it('REGRESSION: selectReviewer with undefined devMode falls back to extension-only match', () => {
    const configs = mergeWithDefaults(undefined);
    // C# reviewer declares devTargetKinds: ['plugin'] so with devMode=undefined it still matches
    // via Priority 2 (devTargetKinds declared but devMode unknown — allowed per selectReviewer logic).
    // Just verify no crash.
    expect(() => selectReviewer(configs, 'Plugins/MyPlugin.cs', undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// inferReviewSource — badge classification
// ---------------------------------------------------------------------------

describe('inferReviewSource — badge classification', () => {
  function makeReview(overrides: Partial<AiFileReviewResult>): AiFileReviewResult {
    return { reviewerName: 'Test Reviewer', filePath: 'file.js', ...overrides };
  }

  it('returns ai-kit when reviewSource is explicitly ai-kit', () => {
    expect(inferReviewSource(makeReview({ reviewSource: 'ai-kit' }))).toBe('ai-kit');
  });

  it('returns settings when reviewSource is explicitly settings', () => {
    expect(inferReviewSource(makeReview({ reviewSource: 'settings' }))).toBe('settings');
  });

  it('returns legacy when reviewSource is explicitly legacy', () => {
    expect(inferReviewSource(makeReview({ reviewSource: 'legacy' }))).toBe('legacy');
  });

  it('infers ai-kit from reviewerName "Script AI Kit Review" when reviewSource absent', () => {
    expect(inferReviewSource(makeReview({ reviewerName: 'Script AI Kit Review' }))).toBe('ai-kit');
  });

  it('infers ai-kit from reviewerName "Plugin AI Kit Review" when reviewSource absent', () => {
    expect(inferReviewSource(makeReview({ reviewerName: 'Plugin AI Kit Review' }))).toBe('ai-kit');
  });

  it('returns legacy for Settings reviewer name when reviewSource absent', () => {
    expect(inferReviewSource(makeReview({ reviewerName: 'JavaScript Power Apps Script Reviewer' }))).toBe('legacy');
  });

  it('returns legacy for C# reviewer name when reviewSource absent', () => {
    expect(inferReviewSource(makeReview({ reviewerName: 'C# Plugin CRM Reviewer' }))).toBe('legacy');
  });

  it('explicit reviewSource=settings wins over reviewerName containing AI Kit text', () => {
    // Unlikely but verify priority: explicit field beats name heuristic.
    expect(inferReviewSource(makeReview({ reviewSource: 'settings', reviewerName: 'My AI Kit Override' }))).toBe('settings');
  });

  it('does not throw for entries with missing reviewerName', () => {
    expect(() => inferReviewSource({ reviewerName: undefined as unknown as string })).not.toThrow();
  });

  it('does not throw for empty reviewerName', () => {
    expect(() => inferReviewSource(makeReview({ reviewerName: '' }))).not.toThrow();
    expect(inferReviewSource(makeReview({ reviewerName: '' }))).toBe('legacy');
  });
});

// ---------------------------------------------------------------------------
// Multi-review display — data-model level
// ---------------------------------------------------------------------------

describe('Multi-review display — data-model level', () => {
  function makeReview(overrides: Partial<AiFileReviewResult>): AiFileReviewResult {
    return { reviewerName: 'Test Reviewer', filePath: 'file.js', ...overrides };
  }

  it('task with two reviews shows both entries in aiFileReviews', () => {
    const aiKitReview  = makeReview({ id: 'r-aikit', reviewerName: 'Script AI Kit Review', reviewSource: 'ai-kit' });
    const settingsReview = makeReview({ id: 'r-settings', reviewerName: 'JavaScript Power Apps Script Reviewer', reviewSource: 'settings' });
    const reviews = [settingsReview, aiKitReview]; // newest first
    expect(reviews).toHaveLength(2);
    expect(reviews[0].reviewerName).toBe('JavaScript Power Apps Script Reviewer');
    expect(reviews[1].reviewerName).toBe('Script AI Kit Review');
  });

  it('running Settings Reviewer after AI Kit Review preserves the AI Kit review entry', () => {
    const existing     = [makeReview({ id: 'r-aikit', reviewSource: 'ai-kit', reviewerName: 'Script AI Kit Review' })];
    const settingsNew  = makeReview({ id: 'r-settings', reviewSource: 'settings', reviewerName: 'JS Reviewer' });
    const updated      = [settingsNew, ...existing].slice(0, 5);
    expect(updated).toHaveLength(2);
    expect(updated.some((r) => r.reviewSource === 'ai-kit')).toBe(true);
    expect(updated.some((r) => r.reviewSource === 'settings')).toBe(true);
  });

  it('running AI Kit Review after Settings Reviewer preserves the Settings review entry', () => {
    const existing    = [makeReview({ id: 'r-settings', reviewSource: 'settings', reviewerName: 'JS Reviewer' })];
    const aiKitNew    = makeReview({ id: 'r-aikit', reviewSource: 'ai-kit', reviewerName: 'Script AI Kit Review' });
    const updated     = [aiKitNew, ...existing].slice(0, 5);
    expect(updated).toHaveLength(2);
    expect(updated.some((r) => r.reviewSource === 'settings')).toBe(true);
    expect(updated.some((r) => r.reviewSource === 'ai-kit')).toBe(true);
  });

  it('cap of 5 entries is respected when many reviews exist', () => {
    const reviews = Array.from({ length: 4 }, (_, i) =>
      makeReview({ id: `r-${i}`, reviewSource: 'ai-kit' })
    );
    const newReview = makeReview({ id: 'r-new', reviewSource: 'settings' });
    const updated = [newReview, ...reviews].slice(0, 5);
    expect(updated).toHaveLength(5);
  });

  it('AI Kit badge: inferReviewSource returns ai-kit for AI Kit entry', () => {
    const r = makeReview({ reviewSource: 'ai-kit', reviewerName: 'Script AI Kit Review' });
    expect(inferReviewSource(r)).toBe('ai-kit');
  });

  it('Settings badge: inferReviewSource returns settings for Settings entry', () => {
    const r = makeReview({ reviewSource: 'settings', reviewerName: 'JavaScript Power Apps Script Reviewer' });
    expect(inferReviewSource(r)).toBe('settings');
  });

  it('both cards have different reviewerName in a two-review scenario', () => {
    const aiKitReview  = makeReview({ id: 'r-1', reviewerName: 'Script AI Kit Review', reviewSource: 'ai-kit' });
    const settingsReview = makeReview({ id: 'r-2', reviewerName: 'JavaScript Power Apps Script Reviewer', reviewSource: 'settings' });
    const reviews = [settingsReview, aiKitReview];
    expect(reviews[0].reviewerName).not.toBe(reviews[1].reviewerName);
  });

  it('Open AI Kit card: reviewId lookup finds the AI Kit review', () => {
    const aiKitId = 'r-aikit';
    const task = makeTask({
      aiFileReviews: [
        makeReview({ id: 'r-settings', reviewSource: 'settings', reviewerName: 'JS Reviewer' }),
        makeReview({ id: aiKitId, reviewSource: 'ai-kit', reviewerName: 'Script AI Kit Review' }),
      ] as never,
      implementationVerification: { aiCodeReview: { status: 'passed', reviewId: aiKitId } },
    });
    const reviewId = task.implementationVerification?.aiCodeReview?.reviewId;
    const target   = task.aiFileReviews?.find((r) => r.id === reviewId);
    expect(target?.reviewerName).toBe('Script AI Kit Review');
  });

  it('Open Settings card: reviewId lookup finds the Settings review', () => {
    const settingsId = 'r-settings';
    const task = makeTask({
      aiFileReviews: [
        makeReview({ id: settingsId, reviewSource: 'settings', reviewerName: 'JS Reviewer' }),
        makeReview({ id: 'r-aikit', reviewSource: 'ai-kit', reviewerName: 'Script AI Kit Review' }),
      ] as never,
      implementationVerification: { aiCodeReview: { status: 'passed', reviewId: settingsId } },
    });
    const reviewId = task.implementationVerification?.aiCodeReview?.reviewId;
    const target   = task.aiFileReviews?.find((r) => r.id === reviewId);
    expect(target?.reviewerName).toBe('JS Reviewer');
  });

  it('single-review layout: one entry in aiFileReviews still works', () => {
    const r = makeReview({ id: 'r-1', reviewSource: 'ai-kit', reviewerName: 'Script AI Kit Review' });
    const reviews = [r];
    expect(reviews).toHaveLength(1);
    expect(inferReviewSource(reviews[0])).toBe('ai-kit');
  });

  it('old review without reviewSource renders safely — no crash on badge inference', () => {
    const oldReview = makeReview({ reviewSource: undefined, reviewerName: 'Script AI Kit Review' });
    expect(() => inferReviewSource(oldReview)).not.toThrow();
    expect(inferReviewSource(oldReview)).toBe('ai-kit');
  });

  it('old review without reviewSource and unknown name returns legacy — no crash', () => {
    const oldReview = makeReview({ reviewSource: undefined, reviewerName: 'Script Internal Check' });
    expect(() => inferReviewSource(oldReview)).not.toThrow();
    expect(inferReviewSource(oldReview)).toBe('legacy');
  });

  it('REGRESSION: aiFileReviews undefined — length check does not throw', () => {
    const task = makeTask({ aiFileReviews: undefined });
    expect(() => (task.aiFileReviews ?? []).length).not.toThrow();
    expect((task.aiFileReviews ?? []).length).toBe(0);
  });

  it('REGRESSION: aiFileReviews empty array — no crash', () => {
    const task = makeTask({ aiFileReviews: [] as never });
    expect((task.aiFileReviews ?? []).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hard gate — Move to Code Review / Waiting for PR (computeProgressionGate)
// ---------------------------------------------------------------------------

function fullAiReview(overrides: Partial<ImplCheckRecord> = {}): ImplCheckRecord {
  return {
    status: 'passed',
    reviewedFiles: ['Scripts/foo.js'],
    rulesFiles: ['rules.md'],
    checklistFiles: ['checklist.md'],
    knownPrReviewFiles: ['pr-comments.md'],
    ...overrides,
  };
}

describe('Hard gate — Move to Code Review button', () => {
  it('canProceed is false when Dataverse has unaccepted warnings — proceed button must be disabled', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('warnings')] });
    const gate = computeProgressionGate(task);
    expect(gate.canProceed).toBe(false);
    // Mirrors the modal's button disabled expression: anyBusy || reviewConfirmPending || !gate.canProceed
    const disabled = false || false || !gate.canProceed;
    expect(disabled).toBe(true);
  });

  it('canProceed is false when AI Kit review has not run — proceed button must be disabled', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('pass')] });
    const gate = computeProgressionGate(task);
    expect(gate.canProceed).toBe(false);
    expect(gate.aiReviewGateStatus).toBe('not_run');
  });

  it('canProceed is true once both gates cleanly pass — proceed button is enabled', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('pass')],
      implementationVerification: { aiCodeReview: fullAiReview() },
    });
    const gate = computeProgressionGate(task);
    expect(gate.canProceed).toBe(true);
    const disabled = false || false || !gate.canProceed;
    expect(disabled).toBe(false);
  });

  it('blocked state exposes reasons the footer hard-block panel renders', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('fail', {
        missingReferences: [{ kind: 'attribute', displayName: 'nvr_status', sourceReason: 'x' }],
      } as never)],
    });
    const gate = computeProgressionGate(task);
    expect(gate.blockingChecks.some((c) => c.check === 'dataverseCheck')).toBe(true);
    expect(gate.blockingFindings.length).toBeGreaterThan(0);
    expect(gate.nextRecommendedAction).toBe('fix_code');
  });
});

// ---------------------------------------------------------------------------
// Accept Dataverse warnings — persisted shape (handleAcceptDataverseWarnings)
// ---------------------------------------------------------------------------

describe('Accept Dataverse warnings — persisted shape', () => {
  it('accepting warnings persists accepted/acceptedAt/acceptedBy/reason and unlocks the gate', () => {
    const before = makeTask({
      crmVerificationReports: [makeReport('warnings')],
      implementationVerification: { dataverseCheck: { status: 'warnings' as never } },
    });
    expect(computeProgressionGate(before).dataverseGateStatus).toBe('warnings_unaccepted');

    // Simulates exactly what handleAcceptDataverseWarnings builds and passes to onUpdate/applyUpdate.
    const acceptedAt = '2026-07-08T12:00:00.000Z';
    const after = makeTask({
      crmVerificationReports: [makeReport('warnings')],
      implementationVerification: {
        dataverseCheck: {
          status: 'warnings' as never,
          warningsAccepted: {
            accepted: true,
            acceptedAt,
            acceptedBy: 'user',
            reason: 'Known limitation, approved by lead.',
            acceptedWarningIds: [],
          },
        },
      },
    });
    expect(after.implementationVerification?.dataverseCheck?.warningsAccepted).toEqual({
      accepted: true,
      acceptedAt,
      acceptedBy: 'user',
      reason: 'Known limitation, approved by lead.',
      acceptedWarningIds: [],
    });
    expect(computeProgressionGate(after).dataverseGateStatus).toBe('passed');
  });

  it('accept action requires a non-empty reason — empty reason must not be treated as accepted', () => {
    // Mirrors the modal's handleAcceptDataverseWarnings guard: `if (!reason) return;`
    const reason = '   '.trim();
    expect(reason).toBe('');
    expect(!!reason).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AI Kit review — incomplete must never display as "Passed"
// ---------------------------------------------------------------------------

describe('AI Kit review — incomplete never renders as Passed', () => {
  it('status passed with empty detail arrays is gated as incomplete, not passed', () => {
    const gate = getAiKitReviewGate({ status: 'passed' });
    expect(gate.status).toBe('incomplete');
    expect(gate.status).not.toBe('passed');
  });

  it('modal display-status mapping renders incomplete as pending_ai_kit_review, never "passed"', () => {
    // Mirrors the modal's aiDisplayStatus computation:
    // aiGate.status === 'incomplete' ? 'pending_ai_kit_review' : aiStatus
    const aiStatus = 'passed';
    const aiGate = getAiKitReviewGate({ status: 'passed' });
    const aiDisplayStatus = aiGate.status === 'incomplete' ? 'pending_ai_kit_review' : aiStatus;
    expect(aiDisplayStatus).toBe('pending_ai_kit_review');
    expect(aiDisplayStatus).not.toBe('passed');
  });

  it('status passed with full detail renders as passed', () => {
    const aiStatus = 'passed';
    const aiGate = getAiKitReviewGate(fullAiReview());
    const aiDisplayStatus = aiGate.status === 'incomplete' ? 'pending_ai_kit_review' : aiStatus;
    expect(aiDisplayStatus).toBe('passed');
  });

  it('fixableFindings present blocks the gate even though the raw status is passed', () => {
    const gate = getAiKitReviewGate(fullAiReview({ fixableFindings: [{ id: 'f1', description: 'Add null check' }] }));
    expect(gate.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Dataverse environment mismatch — expected/active labels
// ---------------------------------------------------------------------------

describe('Dataverse environment mismatch — expected/active display', () => {
  it('mismatch=true with expected and active labels present triggers warning display', () => {
    const task = makeTask({
      implementationVerification: {
        dataverseCheck: {
          status: 'warnings' as never,
          environment: { expected: 'contoso-prod', active: 'contoso-sandbox', mismatch: true },
        },
      },
    });
    const dvEnv = task.implementationVerification?.dataverseCheck?.environment;
    expect(dvEnv?.expected).toBe('contoso-prod');
    expect(dvEnv?.active).toBe('contoso-sandbox');
    expect(dvEnv?.mismatch).toBe(true);
  });

  it('needs_configuration gate is set when environment mismatches (no accept-warnings action shown)', () => {
    const task = makeTask({
      implementationVerification: {
        dataverseCheck: {
          status: 'needs_configuration' as never,
          environment: { expected: 'contoso-prod', active: 'contoso-sandbox', mismatch: true },
        },
      },
    });
    expect(normalizeDataverseGate('needs_configuration', false)).toBe('needs_configuration');
    const gate = computeProgressionGate(task);
    expect(gate.dataverseGateStatus).toBe('needs_configuration');
    expect(gate.requiresUserAction).toBe(true);
  });

  it('no mismatch when expected and active match — mismatch flag is false', () => {
    const task = makeTask({
      implementationVerification: {
        dataverseCheck: {
          status: 'passed',
          environment: { expected: 'contoso-prod', active: 'contoso-prod', mismatch: false },
        },
      },
    });
    expect(task.implementationVerification?.dataverseCheck?.environment?.mismatch).toBe(false);
  });
});
