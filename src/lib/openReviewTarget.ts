/**
 * openReviewTarget — shared helper for opening an AI-reviewed file or its plugin project.
 *
 * For plugin reviews (.cs files):
 *   - Walks up from the reviewed file's directory through up to 4 parent folders.
 *   - Prefers .sln, then .csproj, then the directory itself.
 *   - Always opens via openWithShell() so Windows uses the Visual Studio file association.
 *
 * For script reviews (.js/.ts/.jsx/.tsx):
 *   - Opens the concrete file in VS Code via openInVscode().
 */
import * as tauriApi from './tauriCommands';

export type ReviewTargetKind = 'plugin' | 'script';

/** Infers the kind from file extension. Returns undefined when the extension is ambiguous. */
function inferKindFromExtension(filePath: string): ReviewTargetKind | undefined {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.cs')) return 'plugin';
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 'script';
  // .ts / .tsx are ambiguous — callers should pass an explicit kind.
  return undefined;
}

/**
 * Opens the best target for an AI-reviewed file:
 *   - plugin: nearest .sln → .csproj → folder, via openWithShell
 *   - script: the file itself, via openInVscode
 *
 * @param filePath  Absolute path to the reviewed file.
 * @param kind      Explicit kind override. When omitted, inferred from extension.
 * @returns         null on success, or an error message string.
 */
export async function openReviewTarget(
  filePath: string,
  kind?: ReviewTargetKind,
): Promise<string | null> {
  const resolved: ReviewTargetKind =
    kind ??
    inferKindFromExtension(filePath) ??
    'script'; // safe default when extension is ambiguous

  if (resolved === 'script') {
    try {
      await tauriApi.openInVscode(filePath);
      return null;
    } catch (e) {
      return String(e);
    }
  }

  // Plugin: walk up the directory tree looking for .sln, then .csproj.
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');

  // Build candidate directories: start from the file's directory, up to 4 levels.
  const candidateDirs: string[] = [];
  for (let depth = 1; depth <= 4 && parts.length - depth > 0; depth++) {
    candidateDirs.push(parts.slice(0, parts.length - depth).join('/'));
  }

  // Search each candidate dir for .sln first.
  for (const dir of candidateDirs) {
    try {
      const slns = await tauriApi.listDirectoryFiles(dir, 'sln');
      if (slns.length > 0) {
        await tauriApi.openWithShell(`${dir}/${slns[0]}`);
        return null;
      }
    } catch { /* ignore inaccessible dirs */ }
  }

  // Then search for .csproj.
  for (const dir of candidateDirs) {
    try {
      const csprojs = await tauriApi.listDirectoryFiles(dir, 'csproj');
      if (csprojs.length > 0) {
        await tauriApi.openWithShell(`${dir}/${csprojs[0]}`);
        return null;
      }
    } catch { /* ignore */ }
  }

  // Fall back to opening the immediate file directory as a folder.
  const fileDir = candidateDirs[0];
  if (fileDir) {
    try {
      await tauriApi.openWithShell(fileDir);
      return null;
    } catch (e) {
      return String(e);
    }
  }

  return 'Projekt se nepodařilo najít. Soubor existuje, ale nebyl nalezen .sln ani .csproj.';
}
