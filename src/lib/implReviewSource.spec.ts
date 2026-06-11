import { describe, expect, it } from 'vitest';
import { selectImplReviewSource } from './implReviewSource';
import type { GitReviewContext, GitFileReviewContext } from './tauriCommands';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ARTIFACT_SCRIPT = 'C:/repo/Scripts/nvr_account_events.js';
const FILE_REL = 'Scripts/nvr_account_events.js';

function makeFileGitCtx(overrides: Partial<GitFileReviewContext> = {}): GitFileReviewContext {
  return {
    repoRoot: 'C:/repo',
    currentBranch: 'VSM/10277',
    baseBranch: 'origin/main',
    fileRelPath: FILE_REL,
    diff: '--- a/Scripts/nvr_account_events.js\n+++ b/Scripts/nvr_account_events.js\n@@ -1 +1 @@\n-old\n+new',
    hasCommitted: true,
    hasStaged: false,
    hasUnstaged: false,
    isUntracked: false,
    ...overrides,
  };
}

function makeBranchCtx(overrides: Partial<GitReviewContext> = {}): GitReviewContext {
  return {
    repoRoot: 'C:/repo',
    currentBranch: 'VSM/10277',
    baseBranch: 'origin/main',
    changedFiles: [
      FILE_REL,
      'Plugins/AccountPlugin/AccountPlugin.cs',
      'Ribbons/account_ribbon.js',
      'Scripts/nvr_opportunity_events.js',
    ],
    diff: '--- a/Scripts/nvr_account_events.js\n+++ b/Scripts/nvr_account_events.js\n...',
    hasStaged: false,
    hasUnstaged: true,
    hasCommitted: true,
    hasUntracked: false,
    untrackedIncluded: [],
    untrackedSkipped: [],
    noiseFiles: [],
    flaggedPaths: [],
    summary: 'Branch: VSM/10277 → base: origin/main. Changed files: 4.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Artifact-first: file-diff mode
// ---------------------------------------------------------------------------

describe('selectImplReviewSource — file-diff mode', () => {
  it('uses file-diff when artifact has diff', () => {
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, makeFileGitCtx(), null, null);
    expect(result.mode).toBe('file-diff');
  });

  it('file-diff mode sends only the file-specific diff, not the whole branch', () => {
    const fileDiff = '--- a/Scripts/nvr_account_events.js\n+++ b/...\n@@ +1 @@\n+new line';
    const fileCtx = makeFileGitCtx({ diff: fileDiff });
    const branchCtx = makeBranchCtx(); // has 4 files including plugins/ribbons
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, fileCtx, null, branchCtx);
    expect(result.mode).toBe('file-diff');
    expect(result.diff).toBe(fileDiff);
    expect(result.diff).not.toContain('AccountPlugin');
    expect(result.diff).not.toContain('account_ribbon');
    expect(result.diff).not.toContain('nvr_opportunity');
  });

  it('file-diff mode sets fileRelPath from the file context', () => {
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, makeFileGitCtx(), null, null);
    expect(result.fileRelPath).toBe(FILE_REL);
  });

  it('file-diff mode populates branch labels from file context', () => {
    const result = selectImplReviewSource(
      ARTIFACT_SCRIPT,
      makeFileGitCtx({ currentBranch: 'VSM/10277', baseBranch: 'origin/main' }),
      null,
      null,
    );
    expect(result.currentBranch).toBe('VSM/10277');
    expect(result.baseBranch).toBe('origin/main');
  });

  it('branch labels are never undefined — no "undefined › undefined"', () => {
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, makeFileGitCtx(), null, null);
    const title = `${result.currentBranch} › ${result.baseBranch}`;
    expect(title).not.toContain('undefined');
  });

  it('uses file-diff even when branch context also has diff (artifact takes priority)', () => {
    const result = selectImplReviewSource(
      ARTIFACT_SCRIPT,
      makeFileGitCtx({ diff: '--- file diff ---' }),
      'full file content',
      makeBranchCtx(),
    );
    expect(result.mode).toBe('file-diff');
  });

  it('populates hasCommitted/hasStaged/hasUnstaged from file context', () => {
    const result = selectImplReviewSource(
      ARTIFACT_SCRIPT,
      makeFileGitCtx({ hasCommitted: true, hasStaged: false, hasUnstaged: true }),
      null,
      null,
    );
    expect(result.hasCommitted).toBe(true);
    expect(result.hasStaged).toBe(false);
    expect(result.hasUnstaged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// file-content mode (new/untracked/unchanged file)
// ---------------------------------------------------------------------------

describe('selectImplReviewSource — file-content mode', () => {
  it('uses file-content when artifact exists but diff is empty', () => {
    const fileCtx = makeFileGitCtx({ diff: '', hasCommitted: false, hasStaged: false, hasUnstaged: false });
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, fileCtx, 'function main() {}', null);
    expect(result.mode).toBe('file-content');
    expect(result.fileContent).toBe('function main() {}');
  });

  it('uses file-content for untracked/new file', () => {
    const fileCtx = makeFileGitCtx({ diff: '', isUntracked: true, hasCommitted: false, hasStaged: false, hasUnstaged: false });
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, fileCtx, 'var x = 1;', null);
    expect(result.mode).toBe('file-content');
    expect(result.isUntracked).toBe(true);
  });

  it('file-content: fileRelPath from file context', () => {
    const fileCtx = makeFileGitCtx({ diff: '', fileRelPath: FILE_REL });
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, fileCtx, 'code', null);
    expect(result.fileRelPath).toBe(FILE_REL);
  });

  it('file-content: fileRelPath falls back to artifact basename when no file context', () => {
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, null, 'code here', null);
    expect(result.mode).toBe('file-content');
    expect(result.fileRelPath).toBe('nvr_account_events.js');
  });

  it('file-content mode does not include branch diff in result', () => {
    const fileCtx = makeFileGitCtx({ diff: '' });
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, fileCtx, 'content', makeBranchCtx());
    expect(result.mode).toBe('file-content');
    expect(result.branchContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// branch-diff fallback (no artifact)
// ---------------------------------------------------------------------------

describe('selectImplReviewSource — branch-diff fallback', () => {
  it('falls back to branch-diff when no artifact is given', () => {
    const result = selectImplReviewSource(null, null, null, makeBranchCtx());
    expect(result.mode).toBe('branch-diff');
  });

  it('branch-diff carries the full branch context', () => {
    const branch = makeBranchCtx();
    const result = selectImplReviewSource(null, null, null, branch);
    expect(result.branchContext).toBe(branch);
  });

  it('branch-diff provides currentBranch and baseBranch from branch context', () => {
    const result = selectImplReviewSource(null, null, null, makeBranchCtx());
    expect(result.currentBranch).toBe('VSM/10277');
    expect(result.baseBranch).toBe('origin/main');
    const label = `${result.currentBranch} › ${result.baseBranch}`;
    expect(label).not.toContain('undefined');
  });

  it('branch-diff is NOT used when artifact path is given even if diff is empty', () => {
    // When artifact exists but has no diff, mode should be file-content (not branch-diff).
    const fileCtx = makeFileGitCtx({ diff: '' });
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, fileCtx, 'code', makeBranchCtx());
    expect(result.mode).not.toBe('branch-diff');
  });
});

// ---------------------------------------------------------------------------
// none mode
// ---------------------------------------------------------------------------

describe('selectImplReviewSource — none mode', () => {
  it('returns none when no artifact and no branch diff', () => {
    const result = selectImplReviewSource(null, null, null, null);
    expect(result.mode).toBe('none');
  });

  it('returns none when artifact given but file not accessible', () => {
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, null, null, null);
    expect(result.mode).toBe('none');
  });

  it('returns none when artifact given, diff empty, and content empty/whitespace', () => {
    const fileCtx = makeFileGitCtx({ diff: '' });
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, fileCtx, '   ', null);
    expect(result.mode).toBe('none');
  });

  it('returns none when branch context has empty diff and no changed files', () => {
    const emptyBranch = makeBranchCtx({ diff: '', changedFiles: [] });
    const result = selectImplReviewSource(null, null, null, emptyBranch);
    expect(result.mode).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Plugin task: same behavior as script
// ---------------------------------------------------------------------------

describe('selectImplReviewSource — plugin task artifact', () => {
  const PLUGIN_ARTIFACT = 'C:/repo/Plugins/AccountPlugin/AccountPlugin.cs';
  const PLUGIN_FILE_REL = 'Plugins/AccountPlugin/AccountPlugin.cs';

  it('uses file-diff for plugin artifact', () => {
    const fileCtx = makeFileGitCtx({
      fileRelPath: PLUGIN_FILE_REL,
      diff: '--- a/Plugins/AccountPlugin/AccountPlugin.cs\n+++ b/...',
    });
    const result = selectImplReviewSource(PLUGIN_ARTIFACT, fileCtx, null, null);
    expect(result.mode).toBe('file-diff');
    expect(result.fileRelPath).toBe(PLUGIN_FILE_REL);
  });

  it('plugin: file-diff does not include unrelated script files', () => {
    const fileCtx = makeFileGitCtx({ fileRelPath: PLUGIN_FILE_REL, diff: '--- plugin diff ---' });
    const result = selectImplReviewSource(PLUGIN_ARTIFACT, fileCtx, null, makeBranchCtx());
    expect(result.diff).toBe('--- plugin diff ---');
    expect(result.diff).not.toContain('nvr_account_events');
    expect(result.diff).not.toContain('nvr_opportunity');
  });

  it('plugin: falls back to file-content when diff is empty', () => {
    const fileCtx = makeFileGitCtx({ fileRelPath: PLUGIN_FILE_REL, diff: '' });
    const result = selectImplReviewSource(PLUGIN_ARTIFACT, fileCtx, 'public class AccountPlugin {}', null);
    expect(result.mode).toBe('file-content');
    expect(result.fileContent).toBe('public class AccountPlugin {}');
  });
});

// ---------------------------------------------------------------------------
// workflowSetup.scriptPath is treated equivalently to artifactPath
// (the actual fallback happens in resolveArtifactPath() via scriptPath ?? artifactPath,
//  but once the path is resolved, selectImplReviewSource receives it as artifactPath)
// ---------------------------------------------------------------------------

describe('selectImplReviewSource — scriptPath used as artifact', () => {
  it('script path treated same as artifact path once resolved', () => {
    const scriptPath = 'C:/repo/Scripts/nvr_account_events.js';
    const fileCtx = makeFileGitCtx({ diff: '--- diff ---' });
    const result = selectImplReviewSource(scriptPath, fileCtx, null, null);
    expect(result.mode).toBe('file-diff');
  });

  it('filePath in review entry is the selected script relative path', () => {
    const fileCtx = makeFileGitCtx({ fileRelPath: FILE_REL });
    const result = selectImplReviewSource(ARTIFACT_SCRIPT, fileCtx, null, null);
    expect(result.fileRelPath).toBe(FILE_REL);
  });
});
