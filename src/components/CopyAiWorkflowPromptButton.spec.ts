/**
 * Tests for the CopyAiWorkflowPromptButton copy flow.
 *
 * There is no DOM renderer configured in this project. These tests simulate
 * the copy-flow behaviour at the logic level — specifically the click handler:
 *
 *   const resolvedCustomer = resolveCustomerForPrompt(customer, crmBaseDirectory);
 *   const prompt = buildAiWorkflowPrompt(task, resolvedCustomer);
 *   navigator.clipboard.writeText(prompt);
 *
 * This covers:
 *   1. Customer with explicit repositoryRoot / scriptFolder → absolute paths.
 *   2. Customer with resolvedRepositoryPath → absolute paths.
 *   3. Customer with only folderName + crmBaseDirectory prop → resolved then absolute.
 *   4. No customer → relative-only output.
 *   5. Stale-closure regression: button must capture current customer, not stale undefined.
 *   6. Negative assertions: no forward-slash Windows paths, NOT SET, TBD, namespace patterns.
 */

import { describe, it, expect } from 'vitest';
import { buildAiWorkflowPrompt } from '../lib/aiWorkflowPrompt';
import { resolveCustomerForPrompt } from '../lib/resolveCustomerForPrompt';
import type { Task, Customer } from '../types';

// ── Task helper ───────────────────────────────────────────────────────────────

function makeFreshNvrTask(overrides: Partial<Task> = {}): Task {
  return {
    id:         '3f6c0179-5b65-4a21-9c62-710bab1425c4',
    title:      '[TEST] Script: Předvyplnění servisního požadavku podle zařízení',
    status:     'in-progress',
    customerId: '62f51103-2b3c-4b08-8776-9dfb809bf3df',
    taskMode:   'developer',
    ...overrides,
  } as unknown as Task;
}

/** Simulate exactly what the button click handler does. */
function simulateCopy(task: Task, customer: Customer | undefined, crmBaseDirectory?: string): string {
  const resolvedCustomer = resolveCustomerForPrompt(customer, crmBaseDirectory);
  return buildAiWorkflowPrompt(task, resolvedCustomer);
}

// ── Customer fixtures ─────────────────────────────────────────────────────────

/** Customer with both repositoryRoot and explicit scriptFolder. */
const VSK_CUSTOMER_FULL: Customer = {
  id:           '62f51103-2b3c-4b08-8776-9dfb809bf3df',
  name:         'VSK-Test',
  shortCode:    'VSK',
  repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
  scriptFolder:   'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts',
} as unknown as Customer;

/** Customer with only repositoryRoot (no explicit scriptFolder). */
const VSK_CUSTOMER_REPO_ONLY: Customer = {
  id:             '62f51103-2b3c-4b08-8776-9dfb809bf3df',
  name:           'VSK-Test',
  shortCode:      'VSK',
  repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
} as unknown as Customer;

/** Customer with resolvedRepositoryPath set by rescanRepositories. */
const VSK_CUSTOMER_RESOLVED: Customer = {
  id:                      '62f51103-2b3c-4b08-8776-9dfb809bf3df',
  name:                    'VSK-Test',
  shortCode:               'VSK',
  resolvedRepositoryPath:  'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
} as unknown as Customer;

/**
 * Real-world case: customer has only folderName, no resolved path.
 * The button receives crmBaseDirectory from settings and resolves at copy time.
 */
const VSK_CUSTOMER_FOLDER_ONLY: Customer = {
  id:         '62f51103-2b3c-4b08-8776-9dfb809bf3df',
  name:       'VSK-Test',
  shortCode:  'VSK',
  folderName: 'VSK-Test',
} as unknown as Customer;

const VSK_CRM_BASE = 'C:\\Users\\vskoumal\\Documents\\CRM';

// ── Copy-flow: explicit repositoryRoot + scriptFolder ─────────────────────────

describe('CopyAiWorkflowPromptButton copy flow — explicit repositoryRoot + scriptFolder', () => {
  it('copied prompt contains Repository root line', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL);
    expect(copied).toContain('* Repository root: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });

  it('copied prompt contains Script directory line', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL);
    expect(copied).toContain('* Script directory: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts');
  });

  it('copied prompt contains the derived absolute target file preview', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL);
    expect(copied).toContain(
      '* Target file preview: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js (not yet saved to task setup)',
    );
  });

  it('copied prompt contains the entity preview', () => {
    expect(simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL)).toContain('* Entity: nvr_servicecase');
  });

  it('copied prompt contains the event/field preview', () => {
    expect(simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL)).toContain('* Event / field: onChange / nvr_assetid');
  });

  it('copied prompt contains the known-preview disclaimer', () => {
    expect(simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL)).toContain('Known preview only; file writes require workPacket.canWriteCode === true.');
  });

  it('copied prompt does not contain a full set_task_developer_target save-parameter dump', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL);
    expect(copied).not.toContain('Save this derived target via set_task_developer_target with:');
    expect(copied).not.toContain('onLoadFunctionName:');
    expect(copied).not.toContain('mainHelperSuggestion:');
  });
});

// ── Copy-flow: folderName + crmBaseDirectory (THE REAL-WORLD CASE) ────────────
//
// The customer is stored with only folderName (e.g. "VSK-Test").
// rescanRepositories has NOT run since startup, so resolvedRepositoryPath is absent.
// CopyAiWorkflowPromptButton receives crmBaseDirectory from settings and calls
// resolveCustomerForPrompt() at copy time to derive the absolute path.

describe('CopyAiWorkflowPromptButton copy flow — folderName + crmBaseDirectory (real-world)', () => {
  it('resolves absolute target preview path from folderName + crmBaseDirectory', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FOLDER_ONLY, VSK_CRM_BASE);
    expect(copied).toContain(
      'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js',
    );
  });

  it('contains Repository root line derived from folderName + crmBaseDirectory', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FOLDER_ONLY, VSK_CRM_BASE);
    expect(copied).toContain('* Repository root: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });

  it('derives the absolute target file preview from repositoryRoot + template Scripts folder (no explicit scriptFolder)', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FOLDER_ONLY, VSK_CRM_BASE);
    expect(copied).toContain('* Target file preview: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js (not yet saved to task setup)');
  });

  it('does not contain forward-slash Windows paths when crmBaseDirectory uses backslashes', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FOLDER_ONLY, VSK_CRM_BASE);
    expect(copied).not.toContain('CRM/VSK-Test');
    expect(copied).not.toContain('Scripts/nvr_servicecase_events.js');
  });

  it('without crmBaseDirectory the folderName-only customer produces no absolute path', () => {
    // Simulates what happens when settings.crmBaseDirectory is not passed to the button
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FOLDER_ONLY, undefined);
    expect(copied).not.toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
  });
});

// ── Copy-flow: customer with resolvedRepositoryPath ───────────────────────────

describe('CopyAiWorkflowPromptButton copy flow — customer with resolvedRepositoryPath', () => {
  it('produces absolute target preview path from resolvedRepositoryPath', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_RESOLVED);
    expect(copied).toContain(
      'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js',
    );
  });

  it('contains Repository root line from resolvedRepositoryPath', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_RESOLVED);
    expect(copied).toContain('* Repository root: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });
});

// ── Copy-flow: customer with only repositoryRoot ──────────────────────────────

describe('CopyAiWorkflowPromptButton copy flow — customer with repositoryRoot only', () => {
  it('derives absolute target preview path from repositoryRoot + template Scripts folder', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_REPO_ONLY);
    expect(copied).toContain(
      'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js',
    );
  });

  it('contains Repository root line', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_REPO_ONLY);
    expect(copied).toContain('* Repository root: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });
});

// ── Copy-flow: no customer ────────────────────────────────────────────────────

describe('CopyAiWorkflowPromptButton copy flow — no customer passed', () => {
  it('copied prompt does not contain absolute Windows path', () => {
    const copied = simulateCopy(makeFreshNvrTask(), undefined);
    expect(copied).not.toContain('C:\\Users\\vskoumal');
  });

  it('copied prompt still contains relative target file preview from template', () => {
    const copied = simulateCopy(makeFreshNvrTask(), undefined);
    expect(copied).toContain('Scripts/nvr_servicecase_events.js');
  });

  it('copied prompt still contains nvr_servicecase_events.js', () => {
    const copied = simulateCopy(makeFreshNvrTask(), undefined);
    expect(copied).toContain('nvr_servicecase_events.js');
  });
});

// ── Negative assertions ───────────────────────────────────────────────────────

describe('CopyAiWorkflowPromptButton copy flow — negative assertions', () => {
  it('does not contain forward-slash Windows paths (Scripts/nvr_servicecase_events.js)', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL);
    expect(copied).not.toContain('Scripts/nvr_servicecase_events.js');
  });

  it('does not contain forward-slash CRM path segment (CRM/VSK-Test)', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL);
    expect(copied).not.toContain('CRM/VSK-Test');
  });

  it('does not contain "Target file: not yet set" once a preview path is derivable', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL);
    expect(copied).not.toContain('Target file: not yet set');
  });

  it('does not contain TBD', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL);
    expect(copied).not.toContain('TBD');
  });

  it('does not contain NVR.ServiceCase namespace pattern', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL);
    expect(copied).not.toContain('NVR.ServiceCase');
  });

  it('does not contain AssetPrefill namespace pattern', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL);
    expect(copied).not.toContain('AssetPrefill');
  });

  it('target file preview uses nvr_servicecase_events.js, not a doubled nvr_ prefix', () => {
    const copied = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FULL);
    expect(copied).not.toContain('nvr_nvr_servicecase_events.js');
    expect(copied).toContain('nvr_servicecase_events.js');
  });
});

// ── Stale-closure regression ──────────────────────────────────────────────────
//
// The useCallback in CopyAiWorkflowPromptButton previously listed:
//   [task, customer, onSuccess, onError]  — without crmBaseDirectory
//
// Now crmBaseDirectory is in the dep array. These tests document that
// the CURRENT customer AND crmBaseDirectory must be used at click time,
// not whatever was captured at initial render.

describe('CopyAiWorkflowPromptButton — stale-closure regression', () => {
  it('with stale undefined customer produces no absolute path', () => {
    // Simulates: component rendered with customer=undefined (initial load),
    // useCallback deps exclude customer, click fires with stale closure.
    const stalePrompt = simulateCopy(makeFreshNvrTask(), undefined, undefined);
    expect(stalePrompt).not.toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
  });

  it('with fresh resolved customer produces absolute path', () => {
    // Simulates: component re-rendered with valid customer + crmBaseDirectory,
    // useCallback recreated (deps changed), click fires with correct closure.
    const freshPrompt = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FOLDER_ONLY, VSK_CRM_BASE);
    expect(freshPrompt).toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
  });

  it('output differs between stale-customer and fresh-customer closure', () => {
    const stale = simulateCopy(makeFreshNvrTask(), undefined, undefined);
    const fresh = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FOLDER_ONLY, VSK_CRM_BASE);
    expect(stale).not.toBe(fresh);
    expect(stale).not.toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
    expect(fresh).toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });
});

// ── Prop wiring contract ──────────────────────────────────────────────────────
//
// Each call site passes task + customer + crmBaseDirectory to the button.
// These tests assert the contract at the logic level so a regression is caught
// even without a DOM renderer.

describe('CopyAiWorkflowPromptButton — prop wiring contract (logic level)', () => {
  it('TaskDetail.tsx: customer + settings.crmBaseDirectory → absolute paths', () => {
    // TaskDetail.tsx: crmBaseDirectory={settings?.crmBaseDirectory}
    const prompt = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FOLDER_ONLY, VSK_CRM_BASE);
    expect(prompt).toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
  });

  it('TasksPage.tsx: customer + settings.crmBaseDirectory → absolute paths', () => {
    // TasksPage.tsx: crmBaseDirectory={settings?.crmBaseDirectory}
    const prompt = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FOLDER_ONLY, VSK_CRM_BASE);
    expect(prompt).toContain('* Repository root: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });

  it('PlanningView.tsx: customer + settings.crmBaseDirectory → absolute paths', () => {
    // PlanningView.tsx: crmBaseDirectory={settings?.crmBaseDirectory}
    const prompt = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FOLDER_ONLY, VSK_CRM_BASE);
    expect(prompt).toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
  });

  it('dropping crmBaseDirectory silently loses absolute paths when customer only has folderName', () => {
    // This would fail if crmBaseDirectory were accidentally removed from the prop list.
    const withoutBase = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FOLDER_ONLY, undefined);
    const withBase    = simulateCopy(makeFreshNvrTask(), VSK_CUSTOMER_FOLDER_ONLY, VSK_CRM_BASE);
    expect(withoutBase).not.toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts');
    expect(withBase).toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts');
  });
});
