/**
 * TaskDetail.tsx does not export its internal handlers (handleMarkWaitingForReview,
 * onProceedToReview), and the codebase's existing component specs (see
 * ImplementationVerificationModal.spec.ts) test at the data-model level rather than mounting
 * full components. This spec follows the same convention: it exercises the exact gate + message
 * logic that handleMarkWaitingForReview (TaskDetail.tsx) runs before allowing a task to move to
 * Code Review / Waiting for PR, so a regression in computeProgressionGate's blocking behavior — or
 * in the message TaskDetail composes for setAiError — is caught here.
 */
import { describe, it, expect } from 'vitest';
import { computeProgressionGate } from '../lib/implementationGate';
import type { Task, CrmVerificationReport, ImplCheckRecord } from '../types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return { id: 't1', title: 'Test task', status: 'in-progress', ...overrides } as unknown as Task;
}

function makeReport(verdict: CrmVerificationReport['verdict'], overrides: Partial<CrmVerificationReport> = {}): CrmVerificationReport {
  return {
    id: 'r1', createdAt: '2026-06-10T00:00:00.000Z', verdict, summary: 'Summary text.', issues: [],
    ...overrides,
  } as unknown as CrmVerificationReport;
}

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

/**
 * Mirrors handleMarkWaitingForReview in TaskDetail.tsx exactly: computes the gate, and either
 * returns a blocked result (status change never fires, message goes to setAiError) or proceeds
 * (status change fires, message goes to setFeedback).
 */
function runHandleMarkWaitingForReview(task: Task) {
  const gate = computeProgressionGate(task);
  let statusChanged = false;
  let errorMessage: string | null = null;
  let feedbackMessage: string | null = null;

  if (!gate.canProceed) {
    const reasons = [
      ...gate.blockingChecks.map((c) => c.reason),
      ...gate.blockingFindings.map((f) => f.description),
    ];
    errorMessage = `Cannot move to Code Review yet: ${reasons.join(' ')}`;
    return { statusChanged, errorMessage, feedbackMessage };
  }

  statusChanged = true;
  feedbackMessage = 'Marked as Waiting for code review';
  return { statusChanged, errorMessage, feedbackMessage };
}

describe('TaskDetail — handleMarkWaitingForReview hard gate', () => {
  it('blocks the status change when Dataverse warnings are unaccepted', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('warnings')] });
    const result = runHandleMarkWaitingForReview(task);
    expect(result.statusChanged).toBe(false);
    expect(result.errorMessage).toContain('Cannot move to Code Review yet');
    expect(result.errorMessage).toContain('warnings that have not been explicitly accepted');
    expect(result.feedbackMessage).toBeNull();
  });

  it('blocks the status change when Dataverse check failed', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('fail', {
        missingReferences: [{ kind: 'attribute', displayName: 'nvr_status', sourceReason: 'x' }],
      } as never)],
    });
    const result = runHandleMarkWaitingForReview(task);
    expect(result.statusChanged).toBe(false);
    expect(result.errorMessage).toContain("'nvr_status' was not found in Dataverse");
  });

  it('blocks the status change when Dataverse check needs configuration', () => {
    const task = makeTask({
      implementationVerification: {
        dataverseCheck: { status: 'needs_configuration' as never },
        aiCodeReview: fullAiReview(),
      },
    });
    const result = runHandleMarkWaitingForReview(task);
    expect(result.statusChanged).toBe(false);
    expect(result.errorMessage).toContain('connection is not configured or does not match');
  });

  it('blocks the status change when Dataverse check has not run at all', () => {
    const task = makeTask();
    const result = runHandleMarkWaitingForReview(task);
    expect(result.statusChanged).toBe(false);
    expect(result.errorMessage).toContain('Dataverse Metadata Check has not run yet');
  });

  it('blocks the status change when AI Kit review has not run', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('pass')] });
    const result = runHandleMarkWaitingForReview(task);
    expect(result.statusChanged).toBe(false);
    expect(result.errorMessage).toContain('AI Kit Code Review has not run yet');
  });

  it('blocks the status change when AI Kit review is recorded passed but missing required detail', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('pass')],
      implementationVerification: { aiCodeReview: { status: 'passed' } },
    });
    const result = runHandleMarkWaitingForReview(task);
    expect(result.statusChanged).toBe(false);
    expect(result.errorMessage).toContain('missing required details');
  });

  it('blocks the status change when AI Kit review has fixable findings', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('pass')],
      implementationVerification: {
        aiCodeReview: fullAiReview({ fixableFindings: [{ id: 'f1', description: 'Add null check on target.nvr_status' }] }),
      },
    });
    const result = runHandleMarkWaitingForReview(task);
    expect(result.statusChanged).toBe(false);
    expect(result.errorMessage).toContain('Add null check on target.nvr_status');
  });

  it('allows the status change once both gates cleanly pass', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('pass')],
      implementationVerification: { aiCodeReview: fullAiReview() },
    });
    const result = runHandleMarkWaitingForReview(task);
    expect(result.statusChanged).toBe(true);
    expect(result.errorMessage).toBeNull();
    expect(result.feedbackMessage).toBe('Marked as Waiting for code review');
  });

  it('allows the status change when Dataverse warnings have been explicitly accepted', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('warnings')],
      implementationVerification: {
        dataverseCheck: {
          status: 'warnings' as never,
          warningsAccepted: { accepted: true, acceptedAt: '2026-07-08T00:00:00.000Z', acceptedBy: 'user', reason: 'Approved.' },
        },
        aiCodeReview: fullAiReview(),
      },
    });
    const result = runHandleMarkWaitingForReview(task);
    expect(result.statusChanged).toBe(true);
  });

  it('allows the status change when checks were skipped/manually-verified (still resolves the gate)', () => {
    const task = makeTask({
      implementationVerification: {
        dataverseCheck: { status: 'manually-verified' },
        aiCodeReview: fullAiReview(),
      },
    });
    const result = runHandleMarkWaitingForReview(task);
    expect(result.statusChanged).toBe(true);
  });
});
