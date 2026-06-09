import type { Task } from '../types';

/**
 * Removes common diacritics from a string.
 * Covers Czech and other Central European characters frequently encountered
 * in this project's task titles.
 */
function removeDiacritics(s: string): string {
  // NFD decomposes accented chars into base + combining mark; then strip marks.
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Sanitizes an arbitrary string into a valid Git branch name segment.
 * - Lowercases
 * - Removes diacritics
 * - Replaces anything that is not alphanumeric or hyphen with a hyphen
 * - Collapses consecutive hyphens
 * - Trims leading/trailing hyphens
 * - Trims trailing dots (disallowed by Git)
 */
export function sanitizeBranchSegment(raw: string): string {
  return removeDiacritics(raw.toLowerCase())
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.+$/, '');
}

/**
 * Generates a deterministic suggested branch name from a task.
 *
 * Examples:
 *   devopsTaskUrl contains work item 10277, title "[TEST] VSK-Test: Plugin na Account"
 *   => "feature/10277-vsk-test-plugin-na-account"
 *
 *   No work item ID, title "Test account"
 *   => "feature/test-account"
 */
export function generateBranchName(task: Task): string {
  const devopsUrl = task.devopsTaskUrl ?? '';
  const titleRaw  = task.title ?? '';

  // Extract numeric work-item ID from /_workitems/edit/<N>/
  const MARKER = '/_workitems/edit/';
  let workItemId = '';
  const markerIdx = devopsUrl.indexOf(MARKER);
  if (markerIdx !== -1) {
    const after = devopsUrl.slice(markerIdx + MARKER.length);
    const endIdx = after.search(/[^0-9]/);
    workItemId = endIdx === -1 ? after : after.slice(0, endIdx);
  }

  // Strip leading bracketed prefix like [TEST], [FEATURE]
  const titleStripped = titleRaw.replace(/^\[[^\]]*\]\s*/, '').trim();

  const titleSegment = sanitizeBranchSegment(titleStripped);

  const MAX_TITLE_LEN = workItemId ? 72 : 73; // leave room for "feature/" (8) + id + "-"
  const truncated = titleSegment.length > MAX_TITLE_LEN
    ? titleSegment.slice(0, MAX_TITLE_LEN).replace(/-+$/, '')
    : titleSegment;

  const body = workItemId
    ? `${workItemId}-${truncated}`
    : truncated;

  const full = `feature/${body}`;

  // Hard cap at 80 chars total
  if (full.length > 80) {
    const maxBody = 80 - 'feature/'.length;
    const capped = body.slice(0, maxBody).replace(/-+$/, '');
    return `feature/${capped}`;
  }

  return full;
}

const UNSAFE_CHARS = /[\\~^:?*\[ ]/;
const DEFAULT_BRANCHES = new Set(['main', 'master']);

/**
 * Validates a full branch name (including the "feature/" prefix).
 * Returns an error message string, or null if the name is valid.
 */
export function validateBranchName(name: string): string | null {
  const trimmed = name.trim();

  if (!trimmed)                              return 'Branch name cannot be empty.';
  if (trimmed.includes('..'))                return 'Branch name must not contain "..".';
  if (trimmed.startsWith('-'))               return 'Branch name must not start with "-".';
  if (trimmed.endsWith('.'))                 return 'Branch name must not end with ".".';
  if (/\s/.test(trimmed))                    return 'Branch name must not contain spaces.';
  if (UNSAFE_CHARS.test(trimmed))            return 'Branch name contains an unsafe character (\\ ~ ^ : ? * [ or space).';
  if (DEFAULT_BRANCHES.has(trimmed))         return `"${trimmed}" is a default branch — use a feature branch name.`;
  if (trimmed.startsWith('refs/'))           return 'Branch name must not start with "refs/".';

  // Validate the part after "feature/" if present
  const suffix = trimmed.startsWith('feature/') ? trimmed.slice('feature/'.length) : trimmed;
  if (!suffix || suffix === '-' || suffix.startsWith('-')) {
    return 'Branch name suffix is invalid.';
  }

  return null;
}
