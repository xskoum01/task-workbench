/**
 * In-memory session cache for developer task panel data.
 *
 * Avoids re-loading plugin project folders and git branch info on every task
 * open. Entries are keyed by directory/repository path and live for the
 * duration of the app session (cleared on reload).
 *
 * Cache invalidation:
 *   - Explicit user refresh (refresh button) → call invalidate* before reloading.
 *   - Branch switch → invalidate plugin projects for the pluginsDir (folders can
 *     differ per branch) and update the branch info entry for the repo root.
 */

export interface CachedPluginProjects {
  folders: string[];
}

export interface CachedBranchInfo {
  currentBranch: string;
  branches: string[];
  dirty: boolean;
}

// Keyed by normalized pluginsDir path.
const pluginProjectsCache = new Map<string, CachedPluginProjects>();

// Keyed by normalized repository root path.
const branchInfoCache = new Map<string, CachedBranchInfo>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a path for use as a cache key (trailing slashes removed, lowercase). */
function normalize(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Plugin projects
// ---------------------------------------------------------------------------

export function getCachedPluginProjects(pluginsDir: string): CachedPluginProjects | undefined {
  return pluginProjectsCache.get(normalize(pluginsDir));
}

export function setCachedPluginProjects(pluginsDir: string, folders: string[]): void {
  pluginProjectsCache.set(normalize(pluginsDir), { folders });
}

/** Remove the cached folder listing so the next access fetches fresh data. */
export function invalidatePluginProjects(pluginsDir: string): void {
  pluginProjectsCache.delete(normalize(pluginsDir));
}

// ---------------------------------------------------------------------------
// Branch info
// ---------------------------------------------------------------------------

export function getCachedBranchInfo(repoRoot: string): CachedBranchInfo | undefined {
  return branchInfoCache.get(normalize(repoRoot));
}

export function setCachedBranchInfo(repoRoot: string, info: CachedBranchInfo): void {
  branchInfoCache.set(normalize(repoRoot), info);
}

/** Remove the cached branch data so the next access fetches fresh data from git. */
export function invalidateBranchInfo(repoRoot: string): void {
  branchInfoCache.delete(normalize(repoRoot));
}
