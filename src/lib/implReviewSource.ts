/**
 * Pure helper: selects the AI review source for Implementation Verification.
 *
 * Priority:
 *  1. Selected artifact file → file-specific diff         (mode: 'file-diff')
 *  2. Selected artifact file, no diff → full file content (mode: 'file-content')
 *  3. No artifact → whole-branch diff fallback             (mode: 'branch-diff')
 *  4. Nothing usable available                             (mode: 'none')
 *
 * This function is pure: all async Tauri calls happen in the caller (TaskDetail),
 * which passes pre-fetched data here for the mode-selection decision.
 */

import type { GitFileReviewContext, GitReviewContext } from './tauriCommands';

export type ImplReviewMode = 'file-diff' | 'file-content' | 'branch-diff' | 'none';

/** Subset of GitFileReviewContext needed for mode selection. */
export type FileGitInfo = Pick<
  GitFileReviewContext,
  'diff' | 'fileRelPath' | 'currentBranch' | 'baseBranch' | 'hasCommitted' | 'hasStaged' | 'hasUnstaged' | 'isUntracked'
>;

export interface ImplReviewSourceResult {
  mode: ImplReviewMode;
  /** Populated for 'file-diff': the file-specific diff content. */
  diff?: string;
  /** Populated for 'file-content': the full file text to review. */
  fileContent?: string;
  /** Populated for 'branch-diff': the full branch diff context. */
  branchContext?: GitReviewContext;
  /** Repo-relative file path (file-diff / file-content modes). */
  fileRelPath?: string;
  currentBranch?: string;
  baseBranch?: string;
  isUntracked?: boolean;
  hasCommitted?: boolean;
  hasStaged?: boolean;
  hasUnstaged?: boolean;
  /**
   * Set when artifact was selected but the repo contains additional unrelated files.
   * The review still uses only the selected file — this is informational only.
   */
  warning?: string;
}

/**
 * Decides which review source to use based on pre-fetched context data.
 *
 * @param artifactPath  Resolved artifact/script/plugin file path, or null if unknown.
 * @param fileGitCtx    File-specific git context (committed+staged+unstaged diff for the
 *                      artifact file only). Null when not in a git repo or command failed.
 * @param fileContent   Raw file text (used when diff is empty — new/untracked/unchanged).
 *                      Null when file is not readable.
 * @param branchContext Full branch diff context — provided only when no artifact exists,
 *                      used as fallback.
 */
export function selectImplReviewSource(
  artifactPath: string | null,
  fileGitCtx: FileGitInfo | null,
  fileContent: string | null,
  branchContext: GitReviewContext | null,
): ImplReviewSourceResult {
  // ── Priority 1 & 2: artifact selected ─────────────────────────────────────
  if (artifactPath) {
    if (fileGitCtx && fileGitCtx.diff.trim()) {
      // File has diff (committed / staged / unstaged changes) — use it.
      return {
        mode: 'file-diff',
        diff: fileGitCtx.diff,
        fileRelPath: fileGitCtx.fileRelPath,
        currentBranch: fileGitCtx.currentBranch,
        baseBranch: fileGitCtx.baseBranch,
        isUntracked: fileGitCtx.isUntracked,
        hasCommitted: fileGitCtx.hasCommitted,
        hasStaged: fileGitCtx.hasStaged,
        hasUnstaged: fileGitCtx.hasUnstaged,
      };
    }

    // No diff (file is clean, new, or untracked) → review full file content.
    if (fileContent && fileContent.trim()) {
      return {
        mode: 'file-content',
        fileContent,
        fileRelPath: fileGitCtx?.fileRelPath
          ?? artifactPath.replace(/\\/g, '/').split('/').pop(),
        currentBranch: fileGitCtx?.currentBranch,
        baseBranch: fileGitCtx?.baseBranch,
        isUntracked: fileGitCtx?.isUntracked ?? true,
      };
    }

    // Artifact path set but neither diff nor content is available.
    // Return 'none' so the caller can surface a clear error message.
    return { mode: 'none' };
  }

  // ── Priority 3: no artifact — branch diff fallback ────────────────────────
  if (
    branchContext &&
    (branchContext.diff.trim() || (branchContext.changedFiles ?? []).length > 0)
  ) {
    return {
      mode: 'branch-diff',
      branchContext,
      currentBranch: branchContext.currentBranch,
      baseBranch: branchContext.baseBranch,
    };
  }

  return { mode: 'none' };
}
