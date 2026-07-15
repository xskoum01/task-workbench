import { describe, it, expect } from 'vitest';
import {
  normalizeDataverseGate,
  deriveDataverseRawStatus,
  dataverseWarningsAccepted,
  getAiKitReviewGate,
  hasAiReviewDetail,
  computeProgressionGate,
} from './implementationGate';
import type { Task, CrmVerificationReport, ImplCheckRecord } from '../types';

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
// normalizeDataverseGate
// ---------------------------------------------------------------------------

describe('normalizeDataverseGate', () => {
  it('passed/skipped/manually-verified normalize to passed', () => {
    expect(normalizeDataverseGate('passed', false)).toBe('passed');
    expect(normalizeDataverseGate('skipped', false)).toBe('passed');
    expect(normalizeDataverseGate('manually-verified', false)).toBe('passed');
  });

  it('warnings normalizes to warnings_unaccepted until explicitly accepted', () => {
    expect(normalizeDataverseGate('warnings', false)).toBe('warnings_unaccepted');
  });

  it('warnings normalizes to passed once accepted', () => {
    expect(normalizeDataverseGate('warnings', true)).toBe('passed');
  });

  it('failed normalizes to failed', () => {
    expect(normalizeDataverseGate('failed', false)).toBe('failed');
  });

  it('needs_configuration normalizes to needs_configuration', () => {
    expect(normalizeDataverseGate('needs_configuration', false)).toBe('needs_configuration');
  });

  it('unknown/not-run normalizes to not_run', () => {
    expect(normalizeDataverseGate('not-run', false)).toBe('not_run');
    expect(normalizeDataverseGate('', false)).toBe('not_run');
  });
});

// ---------------------------------------------------------------------------
// deriveDataverseRawStatus
// ---------------------------------------------------------------------------

describe('deriveDataverseRawStatus', () => {
  it('returns not-run when no reports exist', () => {
    expect(deriveDataverseRawStatus(makeTask())).toBe('not-run');
  });

  it('maps report verdicts to raw status', () => {
    expect(deriveDataverseRawStatus(makeTask({ crmVerificationReports: [makeReport('pass')] }))).toBe('passed');
    expect(deriveDataverseRawStatus(makeTask({ crmVerificationReports: [makeReport('warnings')] }))).toBe('warnings');
    expect(deriveDataverseRawStatus(makeTask({ crmVerificationReports: [makeReport('fail')] }))).toBe('failed');
    expect(deriveDataverseRawStatus(makeTask({ crmVerificationReports: [makeReport('not_configured')] }))).toBe('warnings');
  });

  it('manual override skipped/manually-verified/needs_configuration wins over report verdict', () => {
    const skipped = makeTask({
      crmVerificationReports: [makeReport('fail')],
      implementationVerification: { dataverseCheck: { status: 'skipped', skippedReason: 'no MCP' } },
    });
    expect(deriveDataverseRawStatus(skipped)).toBe('skipped');

    const verified = makeTask({
      crmVerificationReports: [makeReport('fail')],
      implementationVerification: { dataverseCheck: { status: 'manually-verified' } },
    });
    expect(deriveDataverseRawStatus(verified)).toBe('manually-verified');

    const needsConfig = makeTask({
      crmVerificationReports: [makeReport('pass')],
      implementationVerification: { dataverseCheck: { status: 'needs_configuration' as never } },
    });
    expect(deriveDataverseRawStatus(needsConfig)).toBe('needs_configuration');
  });
});

// ---------------------------------------------------------------------------
// getAiKitReviewGate
// ---------------------------------------------------------------------------

function fullReview(overrides: Partial<ImplCheckRecord> = {}): ImplCheckRecord {
  return {
    status: 'passed',
    reviewedFiles: ['Scripts/foo.js'],
    rulesFiles: ['rules.md'],
    checklistFiles: ['checklist.md'],
    knownPrReviewFiles: ['pr-comments.md'],
    ...overrides,
  };
}

describe('getAiKitReviewGate', () => {
  it('not an object or missing/empty status -> not_run', () => {
    expect(getAiKitReviewGate(undefined)).toEqual({ status: 'not_run', missing: [] });
    expect(getAiKitReviewGate(null)).toEqual({ status: 'not_run', missing: [] });
    expect(getAiKitReviewGate({ status: '' } as unknown as ImplCheckRecord)).toEqual({ status: 'not_run', missing: [] });
  });

  it('passed with full details -> passed', () => {
    expect(getAiKitReviewGate(fullReview())).toEqual({ status: 'passed', missing: [] });
  });

  it('passed without details -> incomplete, not passed (never silently treated as passed)', () => {
    const result = getAiKitReviewGate({ status: 'passed' });
    expect(result.status).toBe('incomplete');
    expect(result.missing).toContain('reviewedFiles is empty');
    expect(result.missing).toContain('rulesFiles is empty');
    expect(result.missing).toContain('checklistFiles is empty');
    expect(result.missing).toContain('knownPrReviewFiles is empty');
  });

  it('fixableFindings non-empty blocks even when status is passed', () => {
    const result = getAiKitReviewGate(fullReview({ fixableFindings: [{ id: 'f1', description: 'Fix null check' }] }));
    expect(result.status).toBe('failed');
    expect(result.missing).toContain('fixableFindings is non-empty');
  });

  it('status failed -> failed', () => {
    expect(getAiKitReviewGate(fullReview({ status: 'failed' })).status).toBe('failed');
  });

  it('status warnings -> pending', () => {
    expect(getAiKitReviewGate(fullReview({ status: 'warnings' })).status).toBe('pending');
  });

  it('manually-verified is an explicit manual override -> passed, without requiring detail arrays', () => {
    expect(getAiKitReviewGate({ status: 'manually-verified' })).toEqual({ status: 'passed', missing: [] });
  });

  it('skipped is an explicit manual override -> passed, without requiring detail arrays', () => {
    expect(getAiKitReviewGate({ status: 'skipped' })).toEqual({ status: 'passed', missing: [] });
  });

  it('unrecognized status -> not_run', () => {
    expect(getAiKitReviewGate(fullReview({ status: 'not-run' })).status).toBe('not_run');
  });
});

// ---------------------------------------------------------------------------
// hasAiReviewDetail
// ---------------------------------------------------------------------------

describe('hasAiReviewDetail', () => {
  it('undefined/null -> false', () => {
    expect(hasAiReviewDetail(undefined)).toBe(false);
    expect(hasAiReviewDetail(null)).toBe(false);
  });

  it('status only, no detail fields -> false (genuinely missing details)', () => {
    expect(hasAiReviewDetail({ status: 'failed' })).toBe(false);
  });

  it('passed review recorded via record_ai_kit_review_result with full detail -> true', () => {
    // Regression: an AI-Kit-recorded review has no task.aiFileReviews entry (that array is only
    // written by the legacy/Settings-reviewer path), so a check keyed off aiFileReviews wrongly
    // reports "no details" even though reviewedFiles/rulesFiles/etc. are all present and already
    // rendered inline in the modal.
    expect(hasAiReviewDetail(fullReview())).toBe(true);
  });

  it('any single non-empty detail field is enough — does not require all four like getAiKitReviewGate', () => {
    expect(hasAiReviewDetail({ status: 'passed', reviewedFiles: ['Scripts/foo.js'] })).toBe(true);
    expect(hasAiReviewDetail({ status: 'passed', checkedItems: ['No Xrm.Page usage'] })).toBe(true);
    expect(hasAiReviewDetail({ status: 'passed', summary: 'Reviewed against AI Kit rules.' })).toBe(true);
  });

  it('empty arrays and empty summary -> false', () => {
    expect(hasAiReviewDetail({
      status: 'passed',
      reviewedFiles: [], rulesFiles: [], checklistFiles: [], knownPrReviewFiles: [], checkedItems: [], summary: '',
    })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeProgressionGate
// ---------------------------------------------------------------------------

describe('computeProgressionGate', () => {
  it('dataverse warnings block progression until accepted, then pass once accepted', () => {
    const task = makeTask({ crmVerificationReports: [makeReport('warnings')] });
    const blocked = computeProgressionGate(task);
    expect(blocked.canProceed).toBe(false);
    expect(blocked.dataverseGateStatus).toBe('warnings_unaccepted');
    expect(blocked.blockingChecks.some((c) => c.check === 'dataverseCheck')).toBe(true);

    const accepted = makeTask({
      crmVerificationReports: [makeReport('warnings')],
      implementationVerification: {
        dataverseCheck: {
          status: 'warnings' as never,
          warningsAccepted: { accepted: true, acceptedAt: '2026-07-01T00:00:00.000Z', acceptedBy: 'user', reason: 'Acceptable risk.' },
        },
        aiCodeReview: fullReview(),
      },
    });
    const gate = computeProgressionGate(accepted);
    expect(gate.dataverseGateStatus).toBe('passed');
    expect(gate.canProceed).toBe(true);
  });

  it('dataverse failed blocks with findings from missingReferences', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('fail', {
        missingReferences: [{ kind: 'attribute', displayName: 'nvr_status', sourceReason: 'referenced in script' }],
      } as never)],
    });
    const gate = computeProgressionGate(task);
    expect(gate.canProceed).toBe(false);
    expect(gate.dataverseGateStatus).toBe('failed');
    expect(gate.blockingFindings).toEqual([{ check: 'dataverseCheck', description: "'nvr_status' was not found in Dataverse." }]);
    expect(gate.nextRecommendedAction).toBe('fix_code');
  });

  it('needs_configuration blocks and sets requiresUserAction (AI review already clean)', () => {
    const task = makeTask({
      implementationVerification: {
        dataverseCheck: { status: 'needs_configuration' as never },
        aiCodeReview: fullReview(),
      },
    });
    const gate = computeProgressionGate(task);
    expect(gate.canProceed).toBe(false);
    expect(gate.dataverseGateStatus).toBe('needs_configuration');
    expect(gate.requiresUserAction).toBe(true);
    expect(gate.nextRecommendedAction).toBe('needs_configuration');
  });

  it('AI review passed-without-details is incomplete, not passed, and blocks progression', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('pass')],
      implementationVerification: { aiCodeReview: { status: 'passed' } },
    });
    const gate = computeProgressionGate(task);
    expect(gate.aiReviewGateStatus).toBe('incomplete');
    expect(gate.canProceed).toBe(false);
    expect(gate.nextRecommendedAction).toBe('run_ai_kit_review');
  });

  it('AI review fixableFindings blocks even if status is passed', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('pass')],
      implementationVerification: {
        aiCodeReview: fullReview({ fixableFindings: [{ id: 'f1', description: 'Missing null check on target.nvr_status' }] }),
      },
    });
    const gate = computeProgressionGate(task);
    expect(gate.aiReviewGateStatus).toBe('failed');
    expect(gate.canProceed).toBe(false);
    expect(gate.blockingFindings).toEqual([{ check: 'aiCodeReview', description: 'Missing null check on target.nvr_status' }]);
    expect(gate.nextRecommendedAction).toBe('fix_code');
  });

  // Mirrors the Rust test progression_gate_prioritizes_agent_actionable_ai_review_over_needs_configuration.
  it('AI review takes priority over needs_configuration in nextRecommendedAction', () => {
    const task = makeTask({
      implementationVerification: {
        dataverseCheck: { status: 'needs_configuration' as never },
        aiCodeReview: { status: 'passed' }, // incomplete: no detail arrays
      },
    });
    const gate = computeProgressionGate(task);
    expect(gate.canProceed).toBe(false);
    expect(gate.dataverseGateStatus).toBe('needs_configuration');
    expect(gate.aiReviewGateStatus).toBe('incomplete');
    // AI review is agent-actionable (run_ai_kit_review) — must win over needs_configuration.
    expect(gate.nextRecommendedAction).toBe('run_ai_kit_review');
  });

  it('fully clean both gates -> canProceed true, nextRecommendedAction continue_workflow', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('pass')],
      implementationVerification: { aiCodeReview: fullReview() },
    });
    const gate = computeProgressionGate(task);
    expect(gate.canProceed).toBe(true);
    expect(gate.blockingChecks).toEqual([]);
    expect(gate.blockingFindings).toEqual([]);
    expect(gate.nextRecommendedAction).toBe('continue_workflow');
  });

  it('AI review failed remains blocking without an explicit manual override', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('pass')],
      implementationVerification: { aiCodeReview: fullReview({ status: 'failed' }) },
    });
    const gate = computeProgressionGate(task);
    expect(gate.aiReviewGateStatus).toBe('failed');
    expect(gate.canProceed).toBe(false);
  });

  it('AI review warnings remains blocking without an explicit manual override', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('pass')],
      implementationVerification: { aiCodeReview: fullReview({ status: 'warnings' }) },
    });
    const gate = computeProgressionGate(task);
    expect(gate.aiReviewGateStatus).toBe('pending');
    expect(gate.canProceed).toBe(false);
  });

  it('a manual override can resolve a previously-reviewed result while preserving its stored details', () => {
    const task = makeTask({
      crmVerificationReports: [makeReport('pass')],
      implementationVerification: {
        aiCodeReview: {
          ...fullReview({ status: 'failed' }),
          summary: 'Found a null-check issue.',
          manuallyVerifiedAt: '2026-07-10T00:00:00.000Z',
          status: 'manually-verified',
        },
      },
    });
    const gate = computeProgressionGate(task);
    expect(gate.aiReviewGateStatus).toBe('passed');
    expect(gate.canProceed).toBe(true);
    expect(task.implementationVerification?.aiCodeReview?.summary).toBe('Found a null-check issue.');
    expect(task.implementationVerification?.aiCodeReview?.reviewedFiles).toEqual(['Scripts/foo.js']);
  });

  it('reported modal state (Dataverse skipped, AI manually-verified, Local Test passed) -> canProceed true', () => {
    const task = makeTask({
      implementationVerification: {
        dataverseCheck: { status: 'skipped' },
        aiCodeReview: { status: 'manually-verified' },
        localTest: { status: 'passed' },
      },
    });
    const gate = computeProgressionGate(task);
    expect(gate.canProceed).toBe(true);
    expect(gate.dataverseGateStatus).toBe('passed');
    expect(gate.aiReviewGateStatus).toBe('passed');
  });

  it('the same state with AI Code Review skipped instead of manually-verified also allows progression', () => {
    const task = makeTask({
      implementationVerification: {
        dataverseCheck: { status: 'skipped' },
        aiCodeReview: { status: 'skipped' },
        localTest: { status: 'passed' },
      },
    });
    const gate = computeProgressionGate(task);
    expect(gate.canProceed).toBe(true);
  });

  it('dataverseWarningsAccepted reads the persisted acceptance flag', () => {
    expect(dataverseWarningsAccepted(makeTask())).toBe(false);
    expect(dataverseWarningsAccepted(makeTask({
      implementationVerification: { dataverseCheck: { status: 'warnings' as never, warningsAccepted: { accepted: true } } },
    }))).toBe(true);
  });
});
