import { describe, expect, it } from 'vitest';
import type { Customer, Task } from '../types';
import { buildRepositoryContextForTask } from './repositoryContext';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Implement AI Kit change',
    source: 'manual',
    customerId: 'cust-1',
    taskType: 'feature',
    status: 'new',
    confidence: 100,
    originalMessage: 'Update target artifact',
    receivedAt: '2026-06-10T08:00:00.000Z',
    suggestedActions: [],
    workflowSetup: {},
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust-1',
    name: 'Contoso',
    shortCode: 'CON',
    ...overrides,
  };
}

describe('buildRepositoryContextForTask', () => {
  it('prioritizes workflowSetup.repositoryRoot over customer fallbacks', () => {
    const task = makeTask({
      workflowSetup: {
        repositoryRoot: 'C:/repos/from-setup',
      },
    });
    const customer = makeCustomer({
      resolvedRepositoryPath: 'C:/repos/from-customer-resolved',
      repositoryRoot: 'C:/repos/from-customer-direct',
    });

    const result = buildRepositoryContextForTask(task, customer, {});

    expect(result.repoRoot).toBe('C:/repos/from-setup');
    expect(result.repoRootSource).toBe('workflow-setup');
  });

  it('falls back to customer.resolvedRepositoryPath before customer.repositoryRoot', () => {
    const task = makeTask();
    const customer = makeCustomer({
      resolvedRepositoryPath: 'C:/repos/from-customer-resolved',
      repositoryRoot: 'C:/repos/from-customer-direct',
    });

    const result = buildRepositoryContextForTask(task, customer, {});

    expect(result.repoRoot).toBe('C:/repos/from-customer-resolved');
    expect(result.repoRootSource).toBe('customer-resolved');
  });

  it('falls back to customer.repositoryRoot when no resolvedRepositoryPath exists', () => {
    const task = makeTask();
    const customer = makeCustomer({
      repositoryRoot: 'C:/repos/from-customer-direct',
    });

    const result = buildRepositoryContextForTask(task, customer, {});

    expect(result.repoRoot).toBe('C:/repos/from-customer-direct');
    expect(result.repoRootSource).toBe('customer-direct');
  });

  it('computes repo root from crmBaseDirectory + customer.folderName and adds a warning', () => {
    const task = makeTask();
    const customer = makeCustomer({
      folderName: 'contoso-crm',
    });

    const result = buildRepositoryContextForTask(task, customer, {
      crmBaseDirectory: 'C:\\CRM\\Repos\\',
    });

    expect(result.repoRoot).toBe('C:/CRM/Repos/contoso-crm');
    expect(result.repoRootSource).toBe('base-dir-computed');
    expect(result.warnings).toContain(
      'Repository root derived from global base directory (C:/CRM/Repos) + customer folder (contoso-crm). Verify this path exists on disk.'
    );
  });

  it('prioritizes workflowSetup.artifactPath over scriptPath', () => {
    const task = makeTask({
      workflowSetup: {
        artifactPath: 'C:/repo/plugins/AccountPlugin.cs',
        scriptPath: 'C:/repo/scripts/account.js',
      },
    });

    const result = buildRepositoryContextForTask(task, makeCustomer(), {});

    expect(result.artifactPath).toBe('C:/repo/plugins/AccountPlugin.cs');
    expect(result.artifactPathSource).toBe('workflow-artifact');
  });

  it('uses workflowSetup.scriptPath only for .js/.ts files', () => {
    const task = makeTask({
      workflowSetup: {
        scriptPath: 'C:/repo/scripts/account.ts',
      },
    });

    const result = buildRepositoryContextForTask(task, makeCustomer(), {});

    expect(result.artifactPath).toBe('C:/repo/scripts/account.ts');
    expect(result.artifactPathSource).toBe('workflow-script');
    expect(result.blockers).toHaveLength(0);
  });

  it('warns when scriptPath is not a .js/.ts file and does not use it as artifact', () => {
    const task = makeTask({
      workflowSetup: {
        scriptPath: 'C:/repo/web/account.html',
      },
    });

    const result = buildRepositoryContextForTask(task, makeCustomer(), {});

    expect(result.artifactPath).toBeNull();
    expect(result.artifactPathSource).toBeNull();
    expect(result.warnings).toContain('scriptPath "account.html" is not a .js/.ts file — not used as artifact.');
  });

  it('adds a blocker when no artifact is configured', () => {
    const task = makeTask();

    const result = buildRepositoryContextForTask(task, makeCustomer(), {});

    expect(result.blockers).toContain(
      'No artifact file configured. Complete Confirm Setup or select a target file before running AI Kit actions.'
    );
  });

  it('adds a blocker when the artifact is inside the AI Kit repository', () => {
    const task = makeTask({
      workflowSetup: {
        repositoryRoot: 'C:/repos/customer',
        artifactPath: 'C:/repos/power-platform-ai-kit/src/rules/account.ts',
      },
    });

    const result = buildRepositoryContextForTask(task, makeCustomer(), {
      powerPlatformAiKitPath: 'C:/repos/power-platform-ai-kit',
    });

    expect(result.insideAiKit).toBe(true);
    expect(result.blockers).toContain(
      'Artifact is inside the AI Kit repository — all file writes are blocked. Target file must be inside the customer repository.'
    );
  });

  it('adds a blocker when the artifact is outside the repository root', () => {
    const task = makeTask({
      workflowSetup: {
        repositoryRoot: 'C:/repos/customer',
        artifactPath: 'C:/other/place/AccountPlugin.cs',
      },
    });

    const result = buildRepositoryContextForTask(task, makeCustomer(), {});

    expect(result.insideRepo).toBe(false);
    expect(result.blockers).toContain(
      'Artifact is outside the repository root.\nFile: C:/other/place/AccountPlugin.cs\nRepo: C:/repos/customer'
    );
  });

  // ── Relative-path rejection ────────────────────────────────────────────────

  it('ignores relative workflowSetup.repositoryRoot and adds a warning with the offending value', () => {
    const task = makeTask({
      workflowSetup: { repositoryRoot: 'VSK-Test' },
    });
    const customer = makeCustomer({
      resolvedRepositoryPath: 'C:/CRM/VSK-Test',
    });

    const result = buildRepositoryContextForTask(task, customer, {});

    // Relative value must be rejected
    expect(result.repoRoot).toBe('C:/CRM/VSK-Test');
    expect(result.repoRootSource).toBe('customer-resolved');
    expect(result.warnings.some((w) => w.includes('VSK-Test') && w.includes('relative'))).toBe(true);
  });

  it('falls back to customer.resolvedRepositoryPath when workflowSetup.repositoryRoot is relative', () => {
    const task = makeTask({
      workflowSetup: { repositoryRoot: 'VSK-Test' },
    });
    const customer = makeCustomer({
      resolvedRepositoryPath: 'C:/repos/customer-resolved',
    });

    const result = buildRepositoryContextForTask(task, customer, {});

    expect(result.repoRoot).toBe('C:/repos/customer-resolved');
    expect(result.repoRootSource).toBe('customer-resolved');
  });

  it('falls back to crmBaseDirectory + folderName when workflowSetup.repositoryRoot is relative', () => {
    const task = makeTask({
      workflowSetup: { repositoryRoot: 'VSK-Test' },
    });
    const customer = makeCustomer({ folderName: 'vsk-test' });

    const result = buildRepositoryContextForTask(task, customer, {
      crmBaseDirectory: 'C:/CRM',
    });

    expect(result.repoRoot).toBe('C:/CRM/vsk-test');
    expect(result.repoRootSource).toBe('base-dir-computed');
  });

  it('absolute workflowSetup.repositoryRoot takes priority over customer fallbacks', () => {
    const task = makeTask({
      workflowSetup: { repositoryRoot: 'C:/repos/from-setup-absolute' },
    });
    const customer = makeCustomer({
      resolvedRepositoryPath: 'C:/repos/from-customer',
    });

    const result = buildRepositoryContextForTask(task, customer, {});

    expect(result.repoRoot).toBe('C:/repos/from-setup-absolute');
    expect(result.repoRootSource).toBe('workflow-setup');
    expect(result.warnings.filter((w) => w.includes('relative'))).toHaveLength(0);
  });

  it('ignores relative customer.repositoryRoot and adds a warning', () => {
    const task = makeTask();
    const customer = makeCustomer({ repositoryRoot: 'relative-folder' });

    const result = buildRepositoryContextForTask(task, customer, {});

    expect(result.repoRoot).toBeNull();
    expect(result.warnings.some((w) => w.includes('relative-folder') && w.includes('relative'))).toBe(true);
  });

  it('artifact inside the absolute fallback repo root passes insideRepo', () => {
    const task = makeTask({
      workflowSetup: {
        repositoryRoot: 'relative-only',
        artifactPath: 'C:/repos/customer/Scripts/nvr_account.js',
      },
    });
    const customer = makeCustomer({ resolvedRepositoryPath: 'C:/repos/customer' });

    const result = buildRepositoryContextForTask(task, customer, {});

    expect(result.repoRoot).toBe('C:/repos/customer');
    expect(result.insideRepo).toBe(true);
    expect(result.blockers.filter((b) => b.includes('outside'))).toHaveLength(0);
  });

  it('artifact outside the absolute repo root still produces a blocker after relative-path fallback', () => {
    const task = makeTask({
      workflowSetup: {
        repositoryRoot: 'relative-only',
        artifactPath: 'C:/other/place/nvr_account.js',
      },
    });
    const customer = makeCustomer({ resolvedRepositoryPath: 'C:/repos/customer' });

    const result = buildRepositoryContextForTask(task, customer, {});

    expect(result.insideRepo).toBe(false);
    expect(result.blockers.some((b) => b.includes('outside'))).toBe(true);
  });

  it('warning text includes the ignored relative path for workflowSetup', () => {
    const task = makeTask({
      workflowSetup: { repositoryRoot: 'VSK-Test' },
    });

    const result = buildRepositoryContextForTask(task, makeCustomer(), {});

    const relativeWarning = result.warnings.find((w) => w.includes('VSK-Test'));
    expect(relativeWarning).toBeDefined();
    expect(relativeWarning).toContain('relative');
  });
});