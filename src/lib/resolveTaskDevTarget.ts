/**
 * Smart VS Code target resolver for plugin vs script vs repo tasks.
 *
 * Detection is heuristic (ADO context + keyword matching).
 * resolveTaskDevTarget() is synchronous and cheap — use it to drive the UI label.
 * resolveBestPluginPath() is async and does a filesystem scan for .sln / .csproj.
 *
 * DEV LOGGING: console.log lines prefixed with [devTarget] are intentional for
 * manual testing — remove them once the feature is stable.
 */
import type { Task, Customer } from '../types';
import { listDirectoryFiles, checkPathExists } from './tauriCommands';

export type DevTargetKind = 'plugin' | 'script' | 'repo';

export interface DevTarget {
  kind: DevTargetKind;
  /** Best statically-resolved path (may be undefined if no customer paths are set). */
  path: string | undefined;
  label: string;
}

// ---------------------------------------------------------------------------
// Plugin detection
// ---------------------------------------------------------------------------

const PLUGIN_KEYWORDS = [
  'plugin', 'iplugin', 'preoperation', 'postoperation',
  'dataverse plugin', 'crm plugin', '.cs',
];

function hasPluginKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return PLUGIN_KEYWORDS.some(k => lower.includes(k));
}

function isPluginTask(task: Task, customer: Customer | undefined): boolean {
  // ADO PR comment on a .cs file — strongest signal
  if (task.adoContext?.commentedFile?.toLowerCase().endsWith('.cs')) {
    return true;
  }

  const corpus = [
    task.title,
    task.originalMessage,
    task.analysisResult?.summary ?? '',
    task.analysisResult?.summaryEn ?? '',
    task.classificationLabel ?? '',
  ].join(' ');

  if (hasPluginKeyword(corpus)) return true;

  // ADO context of any kind + customer has a plugin folder → plugin-related
  if (task.adoContext && customer?.pluginFolder) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Script detection
// ---------------------------------------------------------------------------

const SCRIPT_KEYWORDS = [
  '.js', 'onload', 'onsave', 'onchange', 'ribbon',
  'webresource', 'web resource', 'script',
];

function isScriptTask(task: Task, customer: Customer | undefined): boolean {
  // Existing script analysis is the strongest signal
  if (task.scriptAnalysis) return true;

  const corpus = [
    task.title,
    task.originalMessage,
    task.analysisResult?.summary ?? '',
  ].join(' ').toLowerCase();

  if (SCRIPT_KEYWORDS.some(k => corpus.includes(k))) return true;

  // Customer has a script folder but no plugin folder → lean script
  if (customer?.scriptFolder && !customer?.pluginFolder) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Exact file hint resolution
// ---------------------------------------------------------------------------

/**
 * Returns an absolute file path when we can pin-point the exact file from the
 * ADO context (e.g. a commented .cs file on a PR review).
 *
 * Returns undefined when the hint is missing or cannot be resolved.
 */
function resolveExactPluginFile(task: Task, customer: Customer | undefined): string | undefined {
  const commented = task.adoContext?.commentedFile;
  if (!commented) return undefined;

  // Already an absolute Windows or POSIX path
  if (/^[A-Za-z]:[/\\]/.test(commented) || commented.startsWith('/')) {
    return commented.replace(/\\/g, '/');
  }

  // Relative path — anchor it to pluginFolder or repositoryRoot
  const base = customer?.pluginFolder ?? customer?.repositoryRoot;
  if (base) {
    return `${base.replace(/\\/g, '/')}/${commented.replace(/\\/g, '/')}`;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public sync resolver
// ---------------------------------------------------------------------------

/**
 * Synchronous resolver — returns kind, label, and best static path instantly.
 *
 * For plugin tasks the path will be the exact file (if derivable) or the
 * plugin folder. Call `resolveBestPluginPath` for a filesystem-backed search
 * that prefers .sln > .csproj > folder.
 *
 * @param crmFolderFallback  Optional resolved CRM base-dir path to use when no
 *                           customer-specific path exists.
 */
export function resolveTaskDevTarget(
  task: Task,
  customer: Customer | undefined,
  crmFolderFallback?: string,
): DevTarget {
  if (isPluginTask(task, customer)) {
    const exactFile = resolveExactPluginFile(task, customer);
    const path = exactFile ?? customer?.pluginFolder ?? customer?.repositoryRoot ?? crmFolderFallback;
    console.log('[devTarget] detected kind: plugin', {
      taskId: task.id,
      commentedFile: task.adoContext?.commentedFile,
      exactFile,
      staticPath: path,
    });
    return { kind: 'plugin', path, label: 'Open Plugin in VS Code' };
  }

  if (isScriptTask(task, customer)) {
    // Mirror resolveCustomerScriptFolder: explicit scriptFolder, else <repo>/Scripts subfolder.
    const repoRoot = customer?.resolvedRepositoryPath ?? customer?.repositoryRoot ?? crmFolderFallback;
    const path = customer?.scriptFolder ?? (repoRoot ? `${repoRoot}/Scripts` : undefined) ?? crmFolderFallback;
    console.log('[devTarget] detected kind: script', { taskId: task.id, path });
    return { kind: 'script', path, label: 'Open Script in VS Code' };
  }

  const path = customer?.repositoryRoot ?? crmFolderFallback;
  console.log('[devTarget] detected kind: repo', { taskId: task.id, path });
  return { kind: 'repo', path, label: 'Open Repository in VS Code' };
}

// ---------------------------------------------------------------------------
// Async path refinement for plugin tasks
// ---------------------------------------------------------------------------

/**
 * Async refinement: for plugin tasks, try to open the most useful target.
 *
 * Priority:
 *   1. Exact file from ADO context (commentedFile resolved under pluginFolder)
 *   2. First .sln found directly inside pluginFolder
 *   3. First .csproj found directly inside pluginFolder
 *   4. pluginFolder itself
 *   5. repositoryRoot (ultimate fallback)
 *
 * Returns undefined when no path is available.
 */
export async function resolveBestPluginPath(
  task: Task,
  customer: Customer | undefined,
): Promise<string | undefined> {
  const tag = '[devTarget:plugin]';

  // 1. Exact file from ADO commentedFile
  const exactFile = resolveExactPluginFile(task, customer);
  if (exactFile) {
    let exists = false;
    try { exists = await checkPathExists(exactFile); } catch { /* ignore */ }
    if (exists) {
      console.log(tag, 'chosen: exact file', exactFile);
      return exactFile;
    }
    console.log(tag, 'exact file not found on disk, falling back', exactFile);
  }

  const pluginFolder = customer?.pluginFolder;
  if (!pluginFolder) {
    console.log(tag, 'no pluginFolder, falling back to repositoryRoot', customer?.repositoryRoot);
    return customer?.repositoryRoot;
  }

  try {
    // 2. .sln at the root of pluginFolder
    const slnFiles = await listDirectoryFiles(pluginFolder, 'sln');
    if (slnFiles.length > 0) {
      const chosen = `${pluginFolder}/${slnFiles[0]}`.replace(/\\/g, '/');
      console.log(tag, 'chosen: .sln', chosen);
      return chosen;
    }

    // 3. .csproj at the root of pluginFolder
    const csprojFiles = await listDirectoryFiles(pluginFolder, 'csproj');
    if (csprojFiles.length > 0) {
      const chosen = `${pluginFolder}/${csprojFiles[0]}`.replace(/\\/g, '/');
      console.log(tag, 'chosen: .csproj', chosen);
      return chosen;
    }
  } catch (err) {
    console.warn(tag, 'filesystem scan failed, using pluginFolder', err);
  }

  // 4. pluginFolder itself
  console.log(tag, 'chosen: pluginFolder (no .sln/.csproj found)', pluginFolder);
  return pluginFolder;
}

// ---------------------------------------------------------------------------
// Helpers for the manual dev-mode switcher (used by TaskDetail)
// ---------------------------------------------------------------------------

/**
 * Returns the directory that contains plugin project subfolders.
 *
 * Priority:
 *   1. customer.pluginFolder  (assumed to be the Plugins container)
 *   2. customer.repositoryRoot + "/Plugins"
 *   3. crmFolderFallback + "/Plugins"
 */
export function getPluginsDir(
  customer: Customer | undefined,
  crmFolderFallback?: string,
): string | undefined {
  if (customer?.pluginFolder) return customer.pluginFolder.replace(/\\/g, '/');
  const root = customer?.repositoryRoot ?? crmFolderFallback;
  if (root) return `${root.replace(/\\/g, '/')}/Plugins`;
  return undefined;
}

/**
 * Guesses the plugin project folder name from the task's ADO context.
 *
 * Looks at commentedFile and the `path` param of prUrl, both in the form
 *   /Plugins/<ProjectFolder>/Something.cs
 * Returns the <ProjectFolder> segment, or undefined when nothing can be inferred.
 */
export function hintedPluginProject(task: Task): string | undefined {
  function extractProject(rawPath: string): string | undefined {
    const segments = rawPath.replace(/\\/g, '/').replace(/^\//, '').split('/');
    if (segments[0]?.toLowerCase() === 'plugins' && segments[1]) return segments[1];
    return undefined;
  }

  const commented = task.adoContext?.commentedFile;
  if (commented) {
    const p = extractProject(commented);
    if (p) return p;
  }

  const prUrl = task.adoContext?.prUrl;
  if (prUrl) {
    try {
      const raw = new URL(prUrl).searchParams.get('path');
      if (raw) {
        const p = extractProject(decodeURIComponent(raw));
        if (p) return p;
      }
    } catch { /* invalid URL */ }
  }

  return undefined;
}
