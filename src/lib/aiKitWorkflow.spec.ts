import { describe, expect, it } from 'vitest';
import { getAiKitWorkflowState } from './aiKitWorkflow';
import type { Task } from '../types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-1',
    title: 'Add account script',
    status: 'in-progress',
    ...overrides,
  } as unknown as Task;
}

const AI_KIT_PATH = 'C:/ai-kit';
const ARTIFACT_PATH = 'C:/repo/Scripts/nvr_account.js';

describe('getAiKitWorkflowState', () => {
  it('returns implement-with-ai-kit when not yet started (no activity notes)', () => {
    const task = makeTask();
    const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
    expect(state.recommendedAction).toBe('implement-with-ai-kit');
  });

  it('implement-with-ai-kit is an assistant-tool recommendation, not a primary step', () => {
    // The recommended action should be 'implement-with-ai-kit' when there is no activity.
    // TaskDetail.tsx effectiveWorkflowAction excludes this from being the main workflow button.
    const task = makeTask();
    const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
    expect(state.recommendedAction).toBe('implement-with-ai-kit');
    // Verify it IS a real recommendation (it should remain available as assistant tool)
    expect(state.isConfigured).toBe(true);
    expect(state.hasArtifactPath).toBe(true);
  });

  it('returns review-diff-with-ai-kit after implementation activity', () => {
    const task = makeTask({
      notes: '[2026-06-01T10:00:00.000Z] UI: ai-kit-implementation-generated',
    });
    const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
    expect(state.recommendedAction).toBe('review-diff-with-ai-kit');
  });

  it('returns verify-implementation after AI Kit review passes', () => {
    const task = makeTask({
      notes: '[2026-06-01T10:00:00.000Z] UI: ai-kit-diff-reviewed -> PASS',
      aiFileReviews: [
        {
          id: 'r1',
          reviewerId: 'ai-kit-diff-review',
          reviewerName: 'AI Kit Script Review',
          filePath: ARTIFACT_PATH,
          reviewedAt: '2026-06-01T10:00:00.000Z',
          reviewMode: 'change',
          structured: { verdict: 'pass', comments: [], generalSuggestions: [] },
        },
      ] as unknown as Task['aiFileReviews'],
    });
    const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
    expect(state.recommendedAction).toBe('verify-implementation');
  });

  it('returns null when AI Kit is not configured', () => {
    const task = makeTask();
    const state = getAiKitWorkflowState(task, undefined, ARTIFACT_PATH);
    expect(state.recommendedAction).toBeNull();
    expect(state.isConfigured).toBe(false);
  });

  it('script-file-created note does not count as implementation activity', () => {
    // Creating a scaffold file is not the same as AI-generated implementation.
    const task = makeTask({
      notes: '[2026-06-01T10:00:00.000Z] UI: script-file-created',
    });
    const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
    // No implementation activity → recommended action is still implement-with-ai-kit
    expect(state.hasImplementationActivity).toBe(false);
    expect(state.recommendedAction).toBe('implement-with-ai-kit');
  });

  it('returns apply-ai-review-fixes when review verdict is needs_changes', () => {
    const task = makeTask({
      notes: '[2026-06-01T10:00:00.000Z] UI: ai-kit-diff-reviewed -> FAIL',
      aiFileReviews: [
        {
          id: 'r1',
          reviewerId: 'ai-kit-diff-review',
          reviewerName: 'AI Kit Script Review',
          filePath: ARTIFACT_PATH,
          reviewedAt: '2026-06-01T10:00:00.000Z',
          reviewMode: 'change',
          structured: { verdict: 'needs_changes', comments: [], generalSuggestions: [] },
        },
      ] as unknown as Task['aiFileReviews'],
    });
    const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
    expect(state.recommendedAction).toBe('apply-ai-review-fixes');
    expect(state.latestReviewVerdict).toBe('needs_changes');
  });

  it('returns apply-ai-review-fixes when review verdict is comment', () => {
    const task = makeTask({
      notes: '[2026-06-01T10:00:00.000Z] UI: ai-kit-diff-reviewed -> WARN',
      aiFileReviews: [
        {
          id: 'r1',
          reviewerId: 'ai-kit-diff-review',
          reviewerName: 'AI Kit Script Review',
          filePath: ARTIFACT_PATH,
          reviewedAt: '2026-06-01T10:00:00.000Z',
          reviewMode: 'change',
          structured: { verdict: 'comment', comments: [], generalSuggestions: [] },
        },
      ] as unknown as Task['aiFileReviews'],
    });
    const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
    expect(state.recommendedAction).toBe('apply-ai-review-fixes');
    expect(state.latestReviewVerdict).toBe('comment');
  });

  it('REGRESSION: apply-ai-review-fixes is an assistant recommendation, not a primary workflow action', () => {
    // Root cause of the "trapped" UX: TaskDetail was using recommendedAction === 'apply-ai-review-fixes'
    // as effectiveWorkflowAction, replacing the yellow Verify Implementation button.
    // This test documents that apply-ai-review-fixes and review-diff-with-ai-kit are assistant-tool
    // recommendations. The primary workflow action (yellow button) must always remain plan.currentAction
    // (verify-implementation for script/plugin tasks in Development).
    const task = makeTask({
      notes: '[2026-06-01T10:00:00.000Z] UI: ai-kit-diff-reviewed -> FAIL',
      aiFileReviews: [
        {
          id: 'r1',
          reviewerId: 'ai-kit-diff-review',
          reviewerName: 'AI Kit Script Review',
          filePath: ARTIFACT_PATH,
          reviewedAt: '2026-06-01T10:00:00.000Z',
          reviewMode: 'change',
          structured: { verdict: 'needs_changes', comments: [], generalSuggestions: [] },
        },
      ] as unknown as Task['aiFileReviews'],
    });
    const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
    // The recommendation is apply-ai-review-fixes, but this must NOT replace
    // the plan's primary action (verify-implementation).
    expect(state.recommendedAction).toBe('apply-ai-review-fixes');
    // The advisory is non-blocking: isConfigured=true so the UI shows the recommendation,
    // but Verify Implementation (plan.currentAction) must still be the primary button.
    expect(state.isConfigured).toBe(true);
  });

  it('review-diff-with-ai-kit recommendation does not replace primary workflow action', () => {
    // After implementation activity but before any review, AI Kit recommends review-diff.
    // This is an assistant-tool recommendation — the primary yellow button stays on plan.currentAction.
    const task = makeTask({
      notes: '[2026-06-01T10:00:00.000Z] UI: ai-kit-implementation-generated',
    });
    const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
    expect(state.recommendedAction).toBe('review-diff-with-ai-kit');
    // Again — this is advisory, not primary.
    expect(state.isConfigured).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // MCP/Claude-driven tasks — canonical fields, no native notes/aiFileReviews
  // ---------------------------------------------------------------------------

  describe('MCP/Claude-driven implementation (no native UI note markers or aiFileReviews)', () => {
    it('REGRESSION: recognizes crmDeveloperWorkflow.lastAiImplementation.completedAt as implementation activity', () => {
      // record_ai_implementation_completed never writes the "UI: ai-kit-*" note markers this
      // module used to require — without the fallback, hasImplementationActivity stays false
      // forever for an MCP-driven task, even after implementation is fully done.
      const task = makeTask({
        crmDeveloperWorkflow: { lastAiImplementation: { completedAt: '2026-06-01T10:00:00.000Z', filesChanged: ['a.js'], summary: 'Done.' } },
      });
      const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
      expect(state.hasImplementationActivity).toBe(true);
    });

    it('REGRESSION: a passed canonical AI Kit review (record_ai_kit_review_result) is recognized without an aiFileReviews entry', () => {
      // Claude/MCP's record_ai_kit_review_result only ever writes implementationVerification.
      // aiCodeReview — it never creates an aiFileReviews entry. Before the fix, statusText fell
      // back to "AI Kit implementation is available." (as if nothing had happened) instead of
      // reflecting the passed review.
      const task = makeTask({
        crmDeveloperWorkflow: { lastAiImplementation: { completedAt: '2026-06-01T10:00:00.000Z', filesChanged: ['a.js'], summary: 'Done.' } },
        implementationVerification: {
          aiCodeReview: {
            status: 'passed', reviewSource: 'claude-ai-kit',
            reviewedFiles: ['a.js'], rulesFiles: ['r.md'], checklistFiles: ['c.md'], knownPrReviewFiles: ['p.md'],
          },
        },
      });
      const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
      expect(state.latestReviewIsAiKit).toBe(true);
      expect(state.latestReviewVerdict).toBe('pass');
      expect(state.recommendedAction).toBe('verify-implementation');
      expect(state.statusText.toLowerCase()).not.toContain('implementation is available');
    });

    it('a failed canonical AI Kit review maps to needs_changes / apply-ai-review-fixes', () => {
      const task = makeTask({
        crmDeveloperWorkflow: { lastAiImplementation: { completedAt: '2026-06-01T10:00:00.000Z', filesChanged: ['a.js'], summary: 'Done.' } },
        implementationVerification: {
          aiCodeReview: { status: 'failed', reviewSource: 'claude-ai-kit', fixableFindings: [{ id: 'f1', description: 'Fix this.' }] },
        },
      });
      const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
      expect(state.latestReviewVerdict).toBe('needs_changes');
      expect(state.recommendedAction).toBe('apply-ai-review-fixes');
    });

    it('a warnings canonical AI Kit review maps to comment / apply-ai-review-fixes', () => {
      const task = makeTask({
        crmDeveloperWorkflow: { lastAiImplementation: { completedAt: '2026-06-01T10:00:00.000Z', filesChanged: ['a.js'], summary: 'Done.' } },
        implementationVerification: { aiCodeReview: { status: 'warnings', reviewSource: 'claude-ai-kit' } },
      });
      const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
      expect(state.latestReviewVerdict).toBe('comment');
      expect(state.recommendedAction).toBe('apply-ai-review-fixes');
    });

    it('a not-run canonical AI Kit review does not count as a resolved review', () => {
      const task = makeTask({
        crmDeveloperWorkflow: { lastAiImplementation: { completedAt: '2026-06-01T10:00:00.000Z', filesChanged: ['a.js'], summary: 'Done.' } },
        implementationVerification: { aiCodeReview: { status: 'not-run' } },
      });
      const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
      expect(state.latestReviewIsAiKit).toBe(false);
      expect(state.recommendedAction).toBe('review-diff-with-ai-kit');
    });

    it('a native aiFileReviews AI Kit entry still wins over the canonical field when both exist', () => {
      const task = makeTask({
        notes: '[2026-06-01T10:00:00.000Z] UI: ai-kit-diff-reviewed -> PASS',
        aiFileReviews: [
          {
            id: 'r1', reviewerId: 'ai-kit-diff-review', reviewerName: 'AI Kit Script Review',
            filePath: ARTIFACT_PATH, reviewedAt: '2026-06-01T10:00:00.000Z', reviewMode: 'change',
            structured: { verdict: 'pass', comments: [], generalSuggestions: [] },
          },
        ] as unknown as Task['aiFileReviews'],
        implementationVerification: { aiCodeReview: { status: 'failed', reviewSource: 'claude-ai-kit' } },
      });
      const state = getAiKitWorkflowState(task, AI_KIT_PATH, ARTIFACT_PATH);
      // Native entry (pass) wins over the canonical field (failed) — native review is authoritative.
      expect(state.latestReviewVerdict).toBe('pass');
    });
  });
});
