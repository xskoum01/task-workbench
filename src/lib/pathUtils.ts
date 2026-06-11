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

/**
 * Returns true when the path is absolute.
 *
 * Recognised absolute forms:
 *   - Windows drive letter:  C:\ or C:/
 *   - UNC:                   \\ or //
 *   - Unix / POSIX:          /
 *
 * Any other string (e.g. "VSK-Test", "relative/path") is considered relative.
 */
export function isAbsolutePath(path: string): boolean {
  const p = path.trim();
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true; // Windows: C:\ or C:/
  if (p.startsWith('\\\\') || p.startsWith('//')) return true; // UNC
  if (p.startsWith('/')) return true; // Unix / POSIX
  return false;
}
