/**
 * Path utility helpers — pure string operations, no Tauri dependency.
 * Kept separate so they can be imported in test environments without
 * pulling in @tauri-apps/api/core.
 */

/**
 * Boundary-aware path containment check (normalised, case-insensitive).
 *
 * A plain startsWith is not enough: C:/repo-extra/file.cs would incorrectly
 * match C:/repo.  This function requires the matched prefix to end at a
 * directory separator boundary.
 */
export function isPathInsideDir(filePath: string, dirPath: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const normFile = norm(filePath);
  const normDir  = norm(dirPath);
  return normFile === normDir || normFile.startsWith(normDir + '/');
}
