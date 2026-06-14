import type { Customer } from '../types';

/**
 * Returns a customer object with `resolvedRepositoryPath` guaranteed to be set,
 * when it can be derived from `customer.folderName + crmBaseDirectory`.
 *
 * Resolution priority (mirrors what TaskDetail and ConfirmSetupModal do):
 *   1. customer.repositoryRootOverride   — explicit override always wins
 *   2. customer.resolvedRepositoryPath  — set by rescanRepositories (base-dir + folderName)
 *   3. customer.repositoryRoot          — explicit raw field
 *   4. crmBaseDirectory + folderName    — runtime fallback when rescan hasn't run yet
 *
 * When the path is already available through 1-3 the customer object is returned
 * unchanged.  When we fall through to 4, a shallow copy is returned with
 * `resolvedRepositoryPath` set so that `getCustomerDefaultRepoRoot` picks it up.
 *
 * Path separators: the computed path inherits the separator style of
 * `crmBaseDirectory`.  If crmBaseDirectory contains backslashes (Windows) the
 * result uses backslashes; otherwise forward slashes.
 */
export function resolveCustomerForPrompt(
  customer: Customer | undefined,
  crmBaseDirectory?: string,
): Customer | undefined {
  if (!customer) return undefined;

  // Already has an authoritative path — no enrichment needed.
  if (
    customer.repositoryRootOverride ||
    customer.resolvedRepositoryPath   ||
    customer.repositoryRoot
  ) {
    return customer;
  }

  // Derive from folderName + crmBaseDirectory.
  if (customer.folderName && crmBaseDirectory) {
    const base = crmBaseDirectory.replace(/[\\/]+$/, '');
    const sep  = base.includes('\\') ? '\\' : '/';
    const resolvedRepositoryPath = `${base}${sep}${customer.folderName}`;
    return { ...customer, resolvedRepositoryPath };
  }

  return customer;
}
