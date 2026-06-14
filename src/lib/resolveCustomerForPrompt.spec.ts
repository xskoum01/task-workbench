import { describe, it, expect } from 'vitest';
import { resolveCustomerForPrompt } from './resolveCustomerForPrompt';
import type { Customer } from '../types';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id:        'cust-vsk',
    name:      'VSK-Test',
    shortCode: 'VSK',
    ...overrides,
  } as Customer;
}

// ── No customer ──────────────────────────────────────────────────────────────

describe('resolveCustomerForPrompt — no customer', () => {
  it('returns undefined when customer is undefined', () => {
    expect(resolveCustomerForPrompt(undefined)).toBeUndefined();
  });

  it('returns undefined when customer is undefined even with crmBaseDirectory', () => {
    expect(resolveCustomerForPrompt(undefined, 'C:\\CRM')).toBeUndefined();
  });
});

// ── repositoryRootOverride — explicit override always wins ────────────────────

describe('resolveCustomerForPrompt — repositoryRootOverride', () => {
  it('returns customer unchanged when repositoryRootOverride is set', () => {
    const c = makeCustomer({ repositoryRootOverride: 'C:\\Override\\Path' });
    const result = resolveCustomerForPrompt(c, 'C:\\CRM');
    expect(result).toBe(c); // same reference
    expect(result?.repositoryRootOverride).toBe('C:\\Override\\Path');
  });
});

// ── resolvedRepositoryPath — already computed ────────────────────────────────

describe('resolveCustomerForPrompt — resolvedRepositoryPath present', () => {
  it('returns customer unchanged when resolvedRepositoryPath is set', () => {
    const c = makeCustomer({ resolvedRepositoryPath: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test' });
    const result = resolveCustomerForPrompt(c);
    expect(result).toBe(c);
    expect(result?.resolvedRepositoryPath).toBe('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });

  it('returns customer unchanged when resolvedRepositoryPath is set even with different crmBaseDirectory', () => {
    const c = makeCustomer({ resolvedRepositoryPath: 'C:\\CRM\\VSK-Test' });
    const result = resolveCustomerForPrompt(c, 'D:\\Other');
    expect(result).toBe(c);
  });
});

// ── repositoryRoot — direct field ────────────────────────────────────────────

describe('resolveCustomerForPrompt — repositoryRoot present', () => {
  it('returns customer unchanged when repositoryRoot is set', () => {
    const c = makeCustomer({ repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test' });
    const result = resolveCustomerForPrompt(c);
    expect(result).toBe(c);
    expect(result?.repositoryRoot).toBe('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });
});

// ── folderName + crmBaseDirectory — runtime fallback ─────────────────────────

describe('resolveCustomerForPrompt — folderName + crmBaseDirectory fallback', () => {
  it('computes resolvedRepositoryPath from Windows crmBaseDirectory + folderName (backslash)', () => {
    const c = makeCustomer({ folderName: 'VSK-Test' });
    const result = resolveCustomerForPrompt(c, 'C:\\Users\\vskoumal\\Documents\\CRM');
    expect(result?.resolvedRepositoryPath).toBe('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });

  it('computes resolvedRepositoryPath from Unix crmBaseDirectory + folderName (forward slash)', () => {
    const c = makeCustomer({ folderName: 'VSK-Test' });
    const result = resolveCustomerForPrompt(c, '/home/user/crm');
    expect(result?.resolvedRepositoryPath).toBe('/home/user/crm/VSK-Test');
  });

  it('strips trailing backslash from crmBaseDirectory before joining', () => {
    const c = makeCustomer({ folderName: 'VSK-Test' });
    const result = resolveCustomerForPrompt(c, 'C:\\CRM\\');
    expect(result?.resolvedRepositoryPath).toBe('C:\\CRM\\VSK-Test');
  });

  it('strips trailing forward slash from crmBaseDirectory before joining', () => {
    const c = makeCustomer({ folderName: 'VSK-Test' });
    const result = resolveCustomerForPrompt(c, '/home/crm/');
    expect(result?.resolvedRepositoryPath).toBe('/home/crm/VSK-Test');
  });

  it('returns a shallow copy, not the same reference', () => {
    const c = makeCustomer({ folderName: 'VSK-Test' });
    const result = resolveCustomerForPrompt(c, 'C:\\CRM');
    expect(result).not.toBe(c);
  });

  it('preserves all other customer fields on the shallow copy', () => {
    const c = makeCustomer({ folderName: 'VSK-Test', name: 'VSK-Test', scriptFolder: 'C:\\CRM\\VSK-Test\\Scripts' });
    const result = resolveCustomerForPrompt(c, 'C:\\CRM');
    expect(result?.name).toBe('VSK-Test');
    expect(result?.scriptFolder).toBe('C:\\CRM\\VSK-Test\\Scripts');
    expect(result?.folderName).toBe('VSK-Test');
  });

  it('handles mixed slashes in crmBaseDirectory by using the dominant separator', () => {
    // crmBaseDirectory with backslash → result uses backslash
    const c = makeCustomer({ folderName: 'VSK-Test' });
    const result = resolveCustomerForPrompt(c, 'C:\\Users\\vskoumal\\Documents\\CRM');
    expect(result?.resolvedRepositoryPath).not.toContain('/');
  });

  it('produces the exact VSK-Test path for the real-world case', () => {
    const c = makeCustomer({
      folderName: 'VSK-Test',
      // no repositoryRoot, no resolvedRepositoryPath
    });
    const result = resolveCustomerForPrompt(c, 'C:\\Users\\vskoumal\\Documents\\CRM');
    expect(result?.resolvedRepositoryPath).toBe('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });
});

// ── No fallback available ─────────────────────────────────────────────────────

describe('resolveCustomerForPrompt — no path available', () => {
  it('returns customer unchanged when no folderName and no crmBaseDirectory', () => {
    const c = makeCustomer();
    const result = resolveCustomerForPrompt(c);
    expect(result).toBe(c);
    expect(result?.resolvedRepositoryPath).toBeUndefined();
  });

  it('returns customer unchanged when folderName is set but crmBaseDirectory is empty string', () => {
    const c = makeCustomer({ folderName: 'VSK-Test' });
    const result = resolveCustomerForPrompt(c, '');
    expect(result?.resolvedRepositoryPath).toBeUndefined();
  });

  it('returns customer unchanged when folderName is set but crmBaseDirectory is undefined', () => {
    const c = makeCustomer({ folderName: 'VSK-Test' });
    const result = resolveCustomerForPrompt(c, undefined);
    expect(result?.resolvedRepositoryPath).toBeUndefined();
  });

  it('returns customer unchanged when crmBaseDirectory is set but folderName is absent', () => {
    const c = makeCustomer(); // no folderName
    const result = resolveCustomerForPrompt(c, 'C:\\CRM');
    expect(result?.resolvedRepositoryPath).toBeUndefined();
  });
});

// ── Integration: resolved customer feeds into buildAiWorkflowPrompt ───────────
//
// These tests verify the full data path:
//   resolveCustomerForPrompt → enriched customer → buildAiWorkflowPrompt → absolute paths

import { buildAiWorkflowPrompt } from './aiWorkflowPrompt';
import type { Task } from '../types';

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

describe('resolveCustomerForPrompt + buildAiWorkflowPrompt integration', () => {
  it('enriched customer from folderName+crmBaseDirectory produces Repository root line in prompt', () => {
    const rawCustomer = makeCustomer({ folderName: 'VSK-Test' });
    const enriched    = resolveCustomerForPrompt(rawCustomer, 'C:\\Users\\vskoumal\\Documents\\CRM');

    const prompt = buildAiWorkflowPrompt(makeFreshNvrTask(), enriched);
    expect(prompt).toContain('* Repository root: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });

  it('enriched customer from folderName+crmBaseDirectory produces absolute script path in prompt', () => {
    const rawCustomer = makeCustomer({ folderName: 'VSK-Test' });
    const enriched    = resolveCustomerForPrompt(rawCustomer, 'C:\\Users\\vskoumal\\Documents\\CRM');

    const prompt = buildAiWorkflowPrompt(makeFreshNvrTask(), enriched);
    expect(prompt).toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
  });

  it('enriched customer produces absoluteScriptPath in save block', () => {
    const rawCustomer = makeCustomer({ folderName: 'VSK-Test' });
    const enriched    = resolveCustomerForPrompt(rawCustomer, 'C:\\Users\\vskoumal\\Documents\\CRM');

    const prompt = buildAiWorkflowPrompt(makeFreshNvrTask(), enriched);
    expect(prompt).toContain('* absoluteScriptPath: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
  });

  it('enriched customer produces repositoryRoot in save block', () => {
    const rawCustomer = makeCustomer({ folderName: 'VSK-Test' });
    const enriched    = resolveCustomerForPrompt(rawCustomer, 'C:\\Users\\vskoumal\\Documents\\CRM');

    const prompt = buildAiWorkflowPrompt(makeFreshNvrTask(), enriched);
    expect(prompt).toContain('* repositoryRoot: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });

  it('raw customer without resolvedRepositoryPath does NOT produce absolute path', () => {
    const rawCustomer = makeCustomer({ folderName: 'VSK-Test' }); // no resolution
    const prompt = buildAiWorkflowPrompt(makeFreshNvrTask(), rawCustomer);
    expect(prompt).not.toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });
});
