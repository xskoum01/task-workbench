import { describe, it, expect } from 'vitest';
import { buildAiCodeReviewReport } from './aiCodeReviewReport';
import type { Task } from '../types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return { id: 't1', title: 'Test task', status: 'in-progress', ...overrides } as unknown as Task;
}

// ---------------------------------------------------------------------------
// Native Task Workbench review (aiFileReviews entry + reviewId)
// ---------------------------------------------------------------------------

describe('buildAiCodeReviewReport — native Task Workbench review', () => {
  it('shows a report and links the native aiFileReviews entry via reviewId', () => {
    const task = makeTask({
      aiFileReviews: [
        {
          id: 'rev1',
          reviewerName: 'Script AI Kit Review',
          reviewSource: 'ai-kit',
          filePath: 'Scripts/foo.js',
          reviewMode: 'file',
          reviewedAt: '2026-06-10T00:00:00.000Z',
          structured: {
            reviewerName: 'Script AI Kit Review',
            filePath: 'Scripts/foo.js',
            fileName: 'foo.js',
            verdict: 'pass',
            summary: 'Looks fine.',
            comments: [{ severity: 'minor', title: 'Nit', problem: 'p', recommendation: 'r', lineStart: 3 }],
            generalSuggestions: ['Consider adding a comment.'],
          },
        },
      ],
      implementationVerification: {
        aiCodeReview: { status: 'passed', reviewId: 'rev1', runAt: '2026-06-10T00:00:00.000Z', summary: 'Looks fine.' },
      },
    });

    const report = buildAiCodeReviewReport(task);
    expect(report).not.toBeNull();
    expect(report!.native).toBeDefined();
    expect(report!.native!.id).toBe('rev1');
    expect(report!.source).toBe('ai-kit');
    expect(report!.sourceLabel).toBe('Task Workbench AI Kit Review');
  });

  it('preserves native structured comments and line references', () => {
    const task = makeTask({
      aiFileReviews: [
        {
          id: 'rev1',
          reviewerName: 'C# Plugin CRM Reviewer',
          reviewSource: 'settings',
          filePath: 'Plugins/MyPlugin.cs',
          reviewMode: 'file',
          structured: {
            reviewerName: 'C# Plugin CRM Reviewer',
            filePath: 'Plugins/MyPlugin.cs',
            fileName: 'MyPlugin.cs',
            verdict: 'needs_changes',
            summary: 'Some issues.',
            comments: [{ severity: 'critical', title: 'Null check', problem: 'p', recommendation: 'r', lineStart: 10, lineEnd: 12 }],
            generalSuggestions: [],
          },
        },
      ],
      implementationVerification: {
        aiCodeReview: { status: 'failed', reviewId: 'rev1' },
      },
    });

    const report = buildAiCodeReviewReport(task);
    expect(report!.native!.structured!.comments).toHaveLength(1);
    expect(report!.native!.structured!.comments[0].lineStart).toBe(10);
    expect(report!.native!.structured!.comments[0].lineEnd).toBe(12);
    expect(report!.sourceLabel).toBe('C# Plugin CRM Reviewer');
  });

  it('falls back to aiFileReviews[0] when no reviewId is present (legacy record)', () => {
    const task = makeTask({
      aiFileReviews: [{ id: 'rev-old', reviewerName: 'Plugin Internal Check', filePath: 'x.cs' }],
      implementationVerification: { aiCodeReview: { status: 'warnings' } },
    });
    const report = buildAiCodeReviewReport(task);
    expect(report!.native!.id).toBe('rev-old');
  });
});

// ---------------------------------------------------------------------------
// Claude/MCP review (canonical detail only, no aiFileReviews / reviewId)
// ---------------------------------------------------------------------------

describe('buildAiCodeReviewReport — Claude/MCP review', () => {
  function mcpReview() {
    return makeTask({
      aiFileReviews: undefined,
      implementationVerification: {
        aiCodeReview: {
          status: 'passed',
          reviewSource: 'claude-ai-kit',
          reviewedAt: '2026-07-10T00:00:00.000Z',
          summary: 'AI Kit review passed. No blocking issues found.',
          reviewedFiles: ['Scripts/nvr_labservicecase_events.js'],
          rulesFiles: ['ai-kit/rules/client-api.md'],
          checklistFiles: ['ai-kit/checklist.md'],
          knownPrReviewFiles: ['ai-kit/known-pr-comments.md'],
          checkedItems: ['No Xrm.Page usage', 'No autosave'],
          skippedItems: [{ item: 'Ribbon rules', reason: 'Not applicable to this file' }],
          findings: [],
          fixableFindings: [],
          nonFixableWarnings: ['Consider adding a unit test.'],
        },
      },
    });
  }

  it('shows a report without any aiFileReviews entry or reviewId', () => {
    const task = mcpReview();
    expect(task.aiFileReviews).toBeUndefined();
    expect(task.implementationVerification?.aiCodeReview?.reviewId).toBeUndefined();

    const report = buildAiCodeReviewReport(task);
    expect(report).not.toBeNull();
    expect(report!.native).toBeUndefined();
  });

  it('renders all canonical detail arrays and the correct source label', () => {
    const report = buildAiCodeReviewReport(mcpReview())!;
    expect(report.source).toBe('claude-ai-kit');
    expect(report.sourceLabel).toBe('Claude AI Kit Review');
    expect(report.status).toBe('passed');
    expect(report.reviewedAt).toBe('2026-07-10T00:00:00.000Z');
    expect(report.summary).toBe('AI Kit review passed. No blocking issues found.');
    expect(report.reviewedFiles).toEqual(['Scripts/nvr_labservicecase_events.js']);
    expect(report.rulesFiles).toEqual(['ai-kit/rules/client-api.md']);
    expect(report.checklistFiles).toEqual(['ai-kit/checklist.md']);
    expect(report.knownPrReviewFiles).toEqual(['ai-kit/known-pr-comments.md']);
    expect(report.checkedItems).toEqual(['No Xrm.Page usage', 'No autosave']);
    expect(report.skippedItems).toEqual([{ item: 'Ribbon rules', reason: 'Not applicable to this file' }]);
    expect(report.nonFixableWarnings).toEqual(['Consider adding a unit test.']);
  });

  it('renders fixableFindings and a failed status', () => {
    const task = makeTask({
      implementationVerification: {
        aiCodeReview: {
          status: 'failed',
          reviewSource: 'claude-ai-kit',
          reviewedFiles: ['Scripts/foo.js'],
          rulesFiles: ['rules.md'],
          checklistFiles: ['checklist.md'],
          knownPrReviewFiles: ['pr.md'],
          fixableFindings: [{ id: 'f1', description: 'Missing null check on formContext.' }],
        },
      },
    });
    const report = buildAiCodeReviewReport(task)!;
    expect(report.status).toBe('failed');
    expect(report.fixableFindings).toEqual([{ id: 'f1', description: 'Missing null check on formContext.' }]);
  });
});

// ---------------------------------------------------------------------------
// not-run after reset — report hidden even with historical aiFileReviews
// ---------------------------------------------------------------------------

describe('buildAiCodeReviewReport — reset to not-run', () => {
  it('returns null after a real review reset, even when historical aiFileReviews remain', () => {
    const task = makeTask({
      aiFileReviews: [{ id: 'rev1', reviewerName: 'Script AI Kit Review', filePath: 'x.js' }],
      implementationVerification: { aiCodeReview: { status: 'not-run' } },
    });
    expect(buildAiCodeReviewReport(task)).toBeNull();
  });

  it('returns null when implementationVerification.aiCodeReview is entirely absent', () => {
    expect(buildAiCodeReviewReport(makeTask())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manual overrides — manually-verified / skipped
// ---------------------------------------------------------------------------

describe('buildAiCodeReviewReport — manual overrides', () => {
  it('keeps a preserved review accessible after manually-verified', () => {
    const task = makeTask({
      aiFileReviews: [{ id: 'rev1', reviewerName: 'Plugin Internal Check', filePath: 'x.cs' }],
      implementationVerification: {
        aiCodeReview: {
          status: 'manually-verified',
          reviewId: 'rev1',
          manuallyVerifiedAt: '2026-06-11T00:00:00.000Z',
          summary: 'Previously reviewed, verified manually.',
        },
      },
    });
    const report = buildAiCodeReviewReport(task);
    expect(report).not.toBeNull();
    expect(report!.native!.id).toBe('rev1');
    expect(report!.status).toBe('manually-verified');
  });

  it('keeps a preserved review accessible after skipped', () => {
    const task = makeTask({
      implementationVerification: {
        aiCodeReview: {
          status: 'skipped',
          skippedReason: 'No MCP available',
          reviewedFiles: ['Scripts/foo.js'],
          summary: 'Prior run before skip.',
        },
      },
    });
    const report = buildAiCodeReviewReport(task);
    expect(report).not.toBeNull();
    expect(report!.status).toBe('skipped');
    expect(report!.reviewedFiles).toEqual(['Scripts/foo.js']);
  });

  it('does not show an empty report for a manual override with no underlying detail', () => {
    const task = makeTask({
      implementationVerification: { aiCodeReview: { status: 'manually-verified', manuallyVerifiedAt: '2026-06-11T00:00:00.000Z' } },
    });
    expect(buildAiCodeReviewReport(task)).toBeNull();
  });

  it('does not show an empty report for a skip with no underlying detail', () => {
    const task = makeTask({
      implementationVerification: { aiCodeReview: { status: 'skipped', skippedReason: 'n/a' } },
    });
    expect(buildAiCodeReviewReport(task)).toBeNull();
  });
});
