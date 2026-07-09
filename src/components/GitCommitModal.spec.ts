import { describe, it, expect } from 'vitest';
import {
  proposedBranchStatusLabel,
  resolveConfirmBranchName,
  buildForceAddFiles,
  type GitIgnoredFileDecision,
} from './GitCommitModal';

// ---------------------------------------------------------------------------
// proposedBranchStatusLabel — must never imply the branch was created.
// get_git_commit_preview / prepare_commit_for_task is read-only: proposedBranchName and
// branchExists are informational only. Only create_or_checkout_task_branch creates/checks out.
// ---------------------------------------------------------------------------

describe('proposedBranchStatusLabel', () => {
  it('reports an existing branch', () => {
    expect(proposedBranchStatusLabel(true)).toBe('already exists locally');
  });

  it('reports a missing branch', () => {
    expect(proposedBranchStatusLabel(false)).toBe('does not exist yet');
  });

  it('REGRESSION: never uses wording that implies the preview created the branch', () => {
    expect(proposedBranchStatusLabel(true)).not.toMatch(/creat/i);
    expect(proposedBranchStatusLabel(false)).not.toMatch(/creat/i);
    expect(proposedBranchStatusLabel(true)).not.toMatch(/checked out/i);
    expect(proposedBranchStatusLabel(false)).not.toMatch(/checked out/i);
  });
});

// ---------------------------------------------------------------------------
// resolveConfirmBranchName — the name actually submitted to createOrCheckoutTaskBranch
// ---------------------------------------------------------------------------

describe('resolveConfirmBranchName', () => {
  it('uses the user-edited input when non-empty', () => {
    expect(resolveConfirmBranchName('feature/edited-name', 'feature/proposed-name')).toBe('feature/edited-name');
  });

  it('falls back to the backend-proposed name when input is blank', () => {
    expect(resolveConfirmBranchName('   ', 'feature/proposed-name')).toBe('feature/proposed-name');
  });

  it('trims whitespace from the edited input', () => {
    expect(resolveConfirmBranchName('  feature/x  ', 'feature/proposed-name')).toBe('feature/x');
  });

  it('returns empty string when both input and proposal are empty/absent', () => {
    expect(resolveConfirmBranchName('', undefined)).toBe('');
    expect(resolveConfirmBranchName('', null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildForceAddFiles — feeds the commitTaskChanges/commitAndPushTaskChanges forceAddFiles arg
// ---------------------------------------------------------------------------

describe('buildForceAddFiles', () => {
  it('returns only the paths the user chose to force-add', () => {
    const decisions: Record<string, GitIgnoredFileDecision> = {
      'Scripts/secrets.local.js': 'force-add',
      'Scripts/env.local.js': 'leave-untracked',
      'Plugins/Generated.cs': 'force-add',
    };
    expect(buildForceAddFiles(decisions)).toEqual(['Scripts/secrets.local.js', 'Plugins/Generated.cs']);
  });

  it('excludes files left untracked', () => {
    expect(buildForceAddFiles({ 'a.js': 'leave-untracked' })).toEqual([]);
  });

  it('returns an empty array when there are no decisions yet', () => {
    expect(buildForceAddFiles({})).toEqual([]);
  });
});
