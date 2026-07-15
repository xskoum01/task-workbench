import { describe, it, expect } from 'vitest';
import {
  deriveManualDeploymentStatus,
  deriveDeploymentTestStatus,
  computeDeploymentTestingGate,
  computeCodeReviewReadinessGate,
} from './deploymentTestingGate';
import type { Task } from '../types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return { id: 't1', title: 'Test task', status: 'in-progress', ...overrides } as unknown as Task;
}

describe('deriveManualDeploymentStatus / deriveDeploymentTestStatus', () => {
  it('returns not-run when deploymentTesting is absent', () => {
    const task = makeTask();
    expect(deriveManualDeploymentStatus(task)).toBe('not-run');
    expect(deriveDeploymentTestStatus(task)).toBe('not-run');
  });

  it('reads deployment/test status from deploymentTesting only', () => {
    const task = makeTask({
      deploymentTesting: {
        deployment: { status: 'deployed', notes: 'Solution imported, published.' },
        test: { status: 'passed', notes: 'Verified onChange fires in browser.' },
      },
    });
    expect(deriveManualDeploymentStatus(task)).toBe('deployed');
    expect(deriveDeploymentTestStatus(task)).toBe('passed');
  });

  it('REGRESSION: does not read implementationVerification.localTest as deployment test evidence', () => {
    const task = makeTask({
      implementationVerification: { localTest: { status: 'not-needed', notes: 'AI-managed, no browser test performed.' } },
    });
    expect(deriveDeploymentTestStatus(task)).toBe('not-run');
  });

  it('REGRESSION: does not read legacy consultantTestRecord as deployment test evidence', () => {
    const task = makeTask({ consultantTestRecord: { status: 'confirmed', updatedAt: '2026-01-01T00:00:00.000Z' } });
    expect(deriveDeploymentTestStatus(task)).toBe('not-run');
  });
});

describe('computeDeploymentTestingGate', () => {
  it('blocks with wait_for_manual_deployment when nothing recorded', () => {
    const gate = computeDeploymentTestingGate(makeTask());
    expect(gate.canProceedToCommit).toBe(false);
    expect(gate.nextRecommendedAction).toBe('wait_for_manual_deployment');
    expect(gate.blockingChecks.some((c) => c.check === 'deployment')).toBe(true);
  });

  it('blocks with wait_for_manual_deployment when deployment failed', () => {
    const task = makeTask({ deploymentTesting: { deployment: { status: 'failed', notes: 'Import failed with a solution error.' } } });
    const gate = computeDeploymentTestingGate(task);
    expect(gate.canProceedToCommit).toBe(false);
    expect(gate.nextRecommendedAction).toBe('wait_for_manual_deployment');
  });

  it('REGRESSION: deployment must be recorded before browser testing can complete, unless explicitly not needed', () => {
    // Test recorded as passed but deployment never recorded — must still block on deployment.
    const task = makeTask({ deploymentTesting: { test: { status: 'passed', notes: 'Tested.' } } });
    const gate = computeDeploymentTestingGate(task);
    expect(gate.canProceedToCommit).toBe(false);
    expect(gate.blockingChecks.some((c) => c.check === 'deployment')).toBe(true);
  });

  it('blocks with wait_for_deployment_test once deployment resolved but test not run', () => {
    const task = makeTask({ deploymentTesting: { deployment: { status: 'deployed', notes: 'Deployed to dev.' } } });
    const gate = computeDeploymentTestingGate(task);
    expect(gate.canProceedToCommit).toBe(false);
    expect(gate.nextRecommendedAction).toBe('wait_for_deployment_test');
  });

  it('REGRESSION: failed browser test blocks commit even when deployment passed', () => {
    const task = makeTask({
      deploymentTesting: {
        deployment: { status: 'deployed', notes: 'Deployed to dev.' },
        test: { status: 'failed', notes: 'onChange did not fire.' },
      },
    });
    const gate = computeDeploymentTestingGate(task);
    expect(gate.canProceedToCommit).toBe(false);
    expect(gate.nextRecommendedAction).toBe('fix_code_or_redeploy');
  });

  it('enables commit preparation once deployment and test both pass', () => {
    const task = makeTask({
      deploymentTesting: {
        deployment: { status: 'deployed', notes: 'Deployed to dev.' },
        test: { status: 'passed', notes: 'Verified in browser.' },
      },
    });
    const gate = computeDeploymentTestingGate(task);
    expect(gate.canProceedToCommit).toBe(true);
    expect(gate.nextRecommendedAction).toBe('prepare_commit');
    expect(gate.blockingChecks).toHaveLength(0);
  });

  it('deployment not-needed + test not-needed also resolves the gate', () => {
    const task = makeTask({
      deploymentTesting: {
        deployment: { status: 'not-needed', notes: 'No CRM-side deployment required for this docs-only task.' },
        test: { status: 'not-needed', notes: 'Nothing to test in the browser.' },
      },
    });
    expect(computeDeploymentTestingGate(task).canProceedToCommit).toBe(true);
  });
});

describe('computeCodeReviewReadinessGate', () => {
  it('blocks and recommends commit_and_push when no commit is recorded', () => {
    const gate = computeCodeReviewReadinessGate(makeTask());
    expect(gate.canEnterCodeReview).toBe(false);
    expect(gate.commitVerified).toBe(false);
    expect(gate.nextRecommendedAction).toBe('commit_and_push');
  });

  it('blocks and recommends commit_and_push when commit exists but push does not', () => {
    const task = makeTask({ gitWorkflow: { lastCommitHash: 'abc123', lastCommitBranch: 'feature/x' } });
    const gate = computeCodeReviewReadinessGate(task);
    expect(gate.commitVerified).toBe(true);
    expect(gate.pushVerified).toBe(false);
    expect(gate.canEnterCodeReview).toBe(false);
    expect(gate.nextRecommendedAction).toBe('commit_and_push');
  });

  it('blocks and recommends prepare_pull_request once push is verified but no PR is recorded', () => {
    const task = makeTask({
      gitWorkflow: {
        lastCommitHash: 'abc123', lastCommitBranch: 'feature/x',
        lastPushedBranch: 'feature/x', lastPushedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const gate = computeCodeReviewReadinessGate(task);
    expect(gate.pushVerified).toBe(true);
    expect(gate.prRecorded).toBe(false);
    expect(gate.canEnterCodeReview).toBe(false);
    expect(gate.nextRecommendedAction).toBe('prepare_pull_request');
  });

  it('REGRESSION: PR creation/recording is required before entering Code Review even with verified push', () => {
    const task = makeTask({
      gitWorkflow: {
        lastCommitHash: 'abc123', lastCommitBranch: 'feature/x',
        lastPushedBranch: 'feature/x', lastPushedAt: '2026-01-01T00:00:00.000Z',
      },
      crmDeveloperWorkflow: {},
    });
    expect(computeCodeReviewReadinessGate(task).canEnterCodeReview).toBe(false);
  });

  it('allows entering Code Review once commit, push, and PR are all verified', () => {
    const task = makeTask({
      gitWorkflow: {
        lastCommitHash: 'abc123', lastCommitBranch: 'feature/x',
        lastPushedBranch: 'feature/x', lastPushedAt: '2026-01-01T00:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        pullRequestTracking: { createdManually: true, createdAt: '2026-01-01T00:00:00.000Z', prUrl: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/123' },
      },
    });
    const gate = computeCodeReviewReadinessGate(task);
    expect(gate.canEnterCodeReview).toBe(true);
    expect(gate.nextRecommendedAction).toBe('wait_for_colleague_code_review');
  });

  it('REGRESSION: AI Kit review never counts as colleague PR review — gate ignores aiCodeReview entirely', () => {
    const task = makeTask({
      implementationVerification: { aiCodeReview: { status: 'passed', reviewedFiles: ['a.js'], rulesFiles: ['r.md'], checklistFiles: ['c.md'], knownPrReviewFiles: ['p.md'] } },
      gitWorkflow: { lastCommitHash: 'abc123', lastCommitBranch: 'feature/x', lastPushedBranch: 'feature/x', lastPushedAt: '2026-01-01T00:00:00.000Z' },
    });
    // Full AI Kit review detail present, commit+push verified, but no PR recorded — still blocked.
    expect(computeCodeReviewReadinessGate(task).canEnterCodeReview).toBe(false);
  });

  it('an invalidated PR tracking entry does not count as recorded', () => {
    const task = makeTask({
      gitWorkflow: { lastCommitHash: 'abc123', lastCommitBranch: 'feature/x', lastPushedBranch: 'feature/x', lastPushedAt: '2026-01-01T00:00:00.000Z' },
      crmDeveloperWorkflow: {
        pullRequestTracking: { createdManually: true, prUrl: 'https://example.com/pr/1', invalidatedAt: '2026-01-02T00:00:00.000Z' },
      },
    });
    expect(computeCodeReviewReadinessGate(task).prRecorded).toBe(false);
  });

  it('a stale push (different branch than last commit) does not count as verified', () => {
    const task = makeTask({
      gitWorkflow: {
        lastCommitHash: 'def456', lastCommitBranch: 'feature/y',
        lastPushedBranch: 'feature/x', lastPushedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(computeCodeReviewReadinessGate(task).pushVerified).toBe(false);
  });
});
