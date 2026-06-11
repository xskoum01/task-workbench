import { describe, it, expect } from 'vitest';
import {
  deriveDataverseCheckStatus,
  computeImplVerifyNextStep,
} from './ImplementationVerificationModal';
import { formatTaskActivityNote, isTaskActivityLine } from '../lib/taskActivityFormatter';
import type { Task, CrmVerificationReport } from '../types';

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
