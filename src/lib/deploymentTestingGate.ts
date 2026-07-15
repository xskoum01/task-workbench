/**
 * deploymentTestingGate
 *
 * Single TypeScript port of the hard-gate logic for the Deployment & Testing phase — the stage
 * between Implementation Verification and Commit & Push. Mirrors, function-for-function, the JS
 * MCP fallback (mcp/task-workbench-mcp.mjs: deriveManualDeploymentStatus, deriveDeploymentTestStatus,
 * computeDeploymentTestingGate, computeCodeReviewReadinessGate) and the Rust bridge
 * (src-tauri/src/lib.rs: task_mcp_derive_manual_deployment_status, task_mcp_derive_deployment_test_status,
 * task_mcp_compute_deployment_testing_gate, task_mcp_compute_code_review_readiness_gate) so the UI,
 * the MCP-facing workflow, and the Rust bridge always agree on when commit/push and PR/Code Review
 * are allowed.
 *
 * Canonical workflow order this file enforces:
 *   Implementation Verification passed -> Deployment & Testing -> Commit & Push ->
 *   Pull Request created/recorded -> Code Review (waiting for colleague review) -> Done
 *
 * Deliberately does NOT read implementationVerification.localTest or the legacy
 * consultantTestRecord field — those predate the artifact ever being deployed and must never
 * satisfy the deployed browser/application test gate below.
 */

import type { Task, ManualDeploymentStatus, DeploymentTestStatus } from '../types';

// ---------------------------------------------------------------------------
// Manual deployment / deployment test status derivation
// ---------------------------------------------------------------------------

/** Raw manual deployment status. 'not-run' when nothing has been recorded yet. */
export function deriveManualDeploymentStatus(task: Task): ManualDeploymentStatus {
  return task.deploymentTesting?.deployment?.status ?? 'not-run';
}

/** Raw deployment test status. 'not-run' when nothing has been recorded yet. */
export function deriveDeploymentTestStatus(task: Task): DeploymentTestStatus {
  return task.deploymentTesting?.test?.status ?? 'not-run';
}

// ---------------------------------------------------------------------------
// Deployment & Testing gate — gates "Prepare Commit & Push"
// ---------------------------------------------------------------------------

export type DeploymentTestingNextAction =
  | 'wait_for_manual_deployment'
  | 'wait_for_deployment_test'
  | 'fix_code_or_redeploy'
  | 'prepare_commit';

export interface DeploymentTestingBlockingCheck {
  check: 'deployment' | 'test';
  status: string;
  reason: string;
}

export interface DeploymentTestingGateResult {
  canProceedToCommit: boolean;
  deploymentStatus: ManualDeploymentStatus;
  testStatus: DeploymentTestStatus;
  blockingChecks: DeploymentTestingBlockingCheck[];
  nextRecommendedAction: DeploymentTestingNextAction;
}

/**
 * Single source of truth for "can this task proceed to Commit & Push". A failed deployment test
 * blocks commit preparation entirely; deployment must be resolved (deployed or explicitly
 * not-needed) before the test can be considered. Mirrors task_mcp_compute_deployment_testing_gate
 * in src-tauri/src/lib.rs and computeDeploymentTestingGate in mcp/task-workbench-mcp.mjs. Pure —
 * no I/O.
 */
export function computeDeploymentTestingGate(task: Task): DeploymentTestingGateResult {
  const deploymentStatus = deriveManualDeploymentStatus(task);
  const testStatus = deriveDeploymentTestStatus(task);

  const blockingChecks: DeploymentTestingBlockingCheck[] = [];

  const deploymentResolved = deploymentStatus === 'deployed' || deploymentStatus === 'not-needed';
  if (!deploymentResolved) {
    blockingChecks.push({
      check: 'deployment',
      status: deploymentStatus,
      reason: deploymentStatus === 'failed'
        ? 'Manual deployment was recorded as failed. Redeploy and record the result before testing.'
        : 'Manual deployment has not been recorded yet.',
    });
  }

  if (deploymentResolved) {
    if (testStatus === 'failed') {
      blockingChecks.push({
        check: 'test',
        status: testStatus,
        reason: 'Deployment test failed. Fix the code or redeploy, then record a new test result.',
      });
    } else if (testStatus === 'not-run') {
      blockingChecks.push({
        check: 'test',
        status: testStatus,
        reason: 'Browser/model-driven app test has not been recorded yet.',
      });
    }
  }

  const canProceedToCommit = blockingChecks.length === 0;

  let nextRecommendedAction: DeploymentTestingNextAction;
  if (canProceedToCommit) {
    nextRecommendedAction = 'prepare_commit';
  } else if (!deploymentResolved) {
    nextRecommendedAction = 'wait_for_manual_deployment';
  } else if (testStatus === 'failed') {
    nextRecommendedAction = 'fix_code_or_redeploy';
  } else {
    nextRecommendedAction = 'wait_for_deployment_test';
  }

  return { canProceedToCommit, deploymentStatus, testStatus, blockingChecks, nextRecommendedAction };
}

// ---------------------------------------------------------------------------
// Code Review readiness gate — gates entering the Code Review / colleague-review stage
// ---------------------------------------------------------------------------

export type CodeReviewReadinessNextAction =
  | 'prepare_commit'
  | 'commit_and_push'
  | 'prepare_pull_request'
  | 'wait_for_colleague_code_review';

export interface CodeReviewReadinessResult {
  canEnterCodeReview: boolean;
  commitVerified: boolean;
  pushVerified: boolean;
  prRecorded: boolean;
  blockingReasons: string[];
  nextRecommendedAction: CodeReviewReadinessNextAction;
}

/**
 * Single source of truth for "can this task enter Code Review / waiting for colleague review".
 * Requires a verified local commit, a verified push of that same branch, and an explicitly
 * created/recorded pull request (task.crmDeveloperWorkflow.pullRequestTracking) — never satisfied
 * by an AI/Claude code review alone. Mirrors task_mcp_compute_code_review_readiness_gate in
 * src-tauri/src/lib.rs and computeCodeReviewReadinessGate in mcp/task-workbench-mcp.mjs.
 */
export function computeCodeReviewReadinessGate(task: Task): CodeReviewReadinessResult {
  const gw = task.gitWorkflow;
  const commitVerified = !!gw?.lastCommitHash;
  const pushVerified = !!gw?.lastPushedBranch && !!gw?.lastPushedAt
    && (!gw?.lastCommitBranch || gw.lastPushedBranch === gw.lastCommitBranch);

  const prTracking = task.crmDeveloperWorkflow?.pullRequestTracking;
  const prRecorded = !!(prTracking?.createdManually && prTracking.prUrl && !prTracking.invalidatedAt);

  const blockingReasons: string[] = [];
  if (!commitVerified) blockingReasons.push('No verified commit is recorded for this task yet.');
  if (commitVerified && !pushVerified) blockingReasons.push('Commit is not yet verified as pushed to the remote branch.');
  if (pushVerified && !prRecorded) blockingReasons.push('No pull request has been created or recorded for this task yet.');

  const canEnterCodeReview = commitVerified && pushVerified && prRecorded;

  let nextRecommendedAction: CodeReviewReadinessNextAction;
  if (canEnterCodeReview) {
    nextRecommendedAction = 'wait_for_colleague_code_review';
  } else if (!commitVerified) {
    nextRecommendedAction = 'commit_and_push';
  } else if (!pushVerified) {
    nextRecommendedAction = 'commit_and_push';
  } else {
    nextRecommendedAction = 'prepare_pull_request';
  }

  return { canEnterCodeReview, commitVerified, pushVerified, prRecorded, blockingReasons, nextRecommendedAction };
}
