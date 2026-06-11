import { describe, it, expect } from 'vitest';
import {
  isPhaseRunning,
  canDismissModal,
  shouldShowPreviewModal,
  shouldShowResultModal,
  validateRunState,
} from './aiKitPanelState';

describe('isPhaseRunning', () => {
  it('returns true for preparing, running, applying', () => {
    expect(isPhaseRunning('preparing')).toBe(true);
    expect(isPhaseRunning('running')).toBe(true);
    expect(isPhaseRunning('applying')).toBe(true);
  });

  it('returns false for idle, preview, result, done, error', () => {
    expect(isPhaseRunning('idle')).toBe(false);
    expect(isPhaseRunning('preview')).toBe(false);
    expect(isPhaseRunning('result')).toBe(false);
    expect(isPhaseRunning('done')).toBe(false);
    expect(isPhaseRunning('error')).toBe(false);
  });

  it('error state is not running — buttons are re-enabled after failure', () => {
    // Verifies: error state clears loading state and re-enables UI controls
    expect(isPhaseRunning('error')).toBe(false);
  });

  it('duplicate clicks prevented: preparing and running both return true', () => {
    // clicking "Create + Implement" or "Run Implementation" while already running is blocked
    expect(isPhaseRunning('preparing')).toBe(true);
    expect(isPhaseRunning('running')).toBe(true);
  });
});

describe('canDismissModal', () => {
  it('prevents dismiss during AI generation (running)', () => {
    // After "Run Implementation" click — modal is locked while AI runs
    expect(canDismissModal('running')).toBe(false);
  });

  it('prevents dismiss while writing file (applying)', () => {
    // After "Apply to File" click — modal is locked while file is written
    expect(canDismissModal('applying')).toBe(false);
  });

  it('allows dismiss during preview', () => {
    expect(canDismissModal('preview')).toBe(true);
  });

  it('allows dismiss when result is shown', () => {
    expect(canDismissModal('result')).toBe(true);
  });

  it('allows dismiss when done', () => {
    expect(canDismissModal('done')).toBe(true);
  });

  it('allows dismiss in error state', () => {
    expect(canDismissModal('error')).toBe(true);
  });
});

describe('shouldShowPreviewModal', () => {
  it('shows for implement in preview phase', () => {
    expect(shouldShowPreviewModal('preview', 'implement')).toBe(true);
  });

  it('stays visible during running — prevents modal flash on Run Implementation click', () => {
    // Core UX fix: clicking Run Implementation must not close the modal.
    // The modal stays open and transitions from preview content → loading state.
    expect(shouldShowPreviewModal('running', 'implement')).toBe(true);
  });

  it('shows for applyFixes during preview and running', () => {
    expect(shouldShowPreviewModal('preview', 'applyFixes')).toBe(true);
    expect(shouldShowPreviewModal('running', 'applyFixes')).toBe(true);
  });

  it('hides once AI completes and result is available', () => {
    // result modal takes over at this point
    expect(shouldShowPreviewModal('result', 'implement')).toBe(false);
  });

  it('never shows for reviewDiff (no preview modal for diff review)', () => {
    expect(shouldShowPreviewModal('preview', 'reviewDiff')).toBe(false);
    expect(shouldShowPreviewModal('running', 'reviewDiff')).toBe(false);
  });

  it('hides when action is null', () => {
    expect(shouldShowPreviewModal('preview', null)).toBe(false);
  });
});

describe('shouldShowResultModal', () => {
  it('shows for implement during result, applying, done', () => {
    expect(shouldShowResultModal('result', 'implement')).toBe(true);
    expect(shouldShowResultModal('applying', 'implement')).toBe(true);
    expect(shouldShowResultModal('done', 'implement')).toBe(true);
  });

  it('result modal stays open during applying — Apply to File does not close it', () => {
    // Core UX fix: clicking Apply to File must not close the modal.
    expect(shouldShowResultModal('applying', 'implement')).toBe(true);
  });

  it('hides during preview and running (preview modal is shown instead)', () => {
    expect(shouldShowResultModal('preview', 'implement')).toBe(false);
    expect(shouldShowResultModal('running', 'implement')).toBe(false);
  });

  it('never shows for reviewDiff', () => {
    expect(shouldShowResultModal('result', 'reviewDiff')).toBe(false);
    expect(shouldShowResultModal('done', 'reviewDiff')).toBe(false);
  });

  it('hides in idle, preparing, error states', () => {
    expect(shouldShowResultModal('idle', 'implement')).toBe(false);
    expect(shouldShowResultModal('preparing', 'implement')).toBe(false);
    expect(shouldShowResultModal('error', 'implement')).toBe(false);
  });
});

const KIT = { rules: [] };

describe('validateRunState — regression for Script Create run-implement no-op', () => {
  it('REGRESSION: empty string artifactContent is valid in create mode', () => {
    // Root cause of bug: !state.artifactContent was true for "" and silently exited.
    // Create mode intentionally passes currentContent="" because the file does not exist yet.
    expect(validateRunState({ kitContext: KIT, artifactContent: '', taskKind: 'script' })).toBeNull();
  });

  it('null artifactContent returns an error', () => {
    expect(validateRunState({ kitContext: KIT, artifactContent: null, taskKind: 'script' })).toMatch(/missing/i);
  });

  it('undefined artifactContent returns an error', () => {
    expect(validateRunState({ kitContext: KIT, artifactContent: undefined, taskKind: 'script' })).toMatch(/missing/i);
  });

  it('non-empty artifactContent is valid', () => {
    expect(validateRunState({ kitContext: KIT, artifactContent: '/** existing */', taskKind: 'script' })).toBeNull();
  });

  it('missing kitContext returns an error', () => {
    expect(validateRunState({ kitContext: null, artifactContent: '', taskKind: 'script' })).toMatch(/context/i);
  });

  it('missing taskKind returns an error', () => {
    expect(validateRunState({ kitContext: KIT, artifactContent: '', taskKind: null })).toMatch(/task kind/i);
  });

  it('requiresReview with no latestReview returns an error', () => {
    expect(validateRunState({ kitContext: KIT, artifactContent: 'x', taskKind: 'script', requiresReview: true, latestReview: null })).toMatch(/review/i);
  });

  it('requiresReview with latestReview present is valid', () => {
    expect(validateRunState({ kitContext: KIT, artifactContent: 'x', taskKind: 'script', requiresReview: true, latestReview: { id: '1' } })).toBeNull();
  });

  it('requiresReview=false with no review does not error', () => {
    expect(validateRunState({ kitContext: KIT, artifactContent: 'x', taskKind: 'script', requiresReview: false, latestReview: null })).toBeNull();
  });
});
