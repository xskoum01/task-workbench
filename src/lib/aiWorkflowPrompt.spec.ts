import { describe, it, expect } from 'vitest';
import { buildAiWorkflowPrompt } from './aiWorkflowPrompt';
import type { Task, Customer, CrmVerificationReport } from '../types';

// Minimal task — no developer mode set → produces setup prompt
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    title: '[TEST] Goal: Extend the existing account form script.',
    status: 'in-progress',
    customerId: 'customer-acme',
    ...overrides,
  } as unknown as Task;
}

// Developer mode task with plugin kind but missing most setup → produces setup prompt
function makeDevTask(overrides: Partial<Task> = {}): Task {
  return makeTask({
    taskMode: 'developer',
    workflowSetup: { devTargetKind: 'plugin' },
    ...overrides,
  });
}

// Fully ready developer script task → produces implementation prompt with Script target context
function makeReadyScriptTask(overrides: Partial<Task> = {}): Task {
  return makeTask({
    taskMode: 'developer',
    workflowSetup: {
      devTargetKind: 'script',
      repositoryRoot: 'C:/repos/CrmScripts',
      scriptPath: 'C:/repos/CrmScripts/src/scripts/account_form.js',
      primaryEntityLogicalName: 'account',
      confirmedAt: '2026-06-01T10:00:00.000Z',
      actionType: 'update-existing-script',
      conventionsSource: 'C:/repos/CrmScripts/src/scripts/contact_form.js',
      relatedExistingFiles: ['nvr_contact_form.js'],
    },
    crmDeveloperWorkflow: {
      detectedWorkKind: 'script',
      currentStep: 'code-generation',
      technicalPlan: {
        generatedAt: '2026-06-01T10:00:00.000Z',
        workKind: 'script',
        summary: 'Extend account form script.',
        target: {
          entityLogicalName: 'account',
          scriptPath: 'C:/repos/CrmScripts/src/scripts/account_form.js',
          webResourceName: 'nvr_account_form',
          formName: 'Account Main Form',
          eventName: 'OnLoad',
          eventFieldName: 'new_status',
          functionName: 'onAccountLoad',
        },
        implementationSteps: ['Step 1'],
        dataverseFindings: [],
        risks: [],
        testChecklist: [],
      },
    },
    crmVerificationReports: [{ verdict: 'pass', summary: 'All clear.' }] as CrmVerificationReport[],
    ...overrides,
  });
}

// Fully ready developer plugin task → produces implementation prompt
function makeReadyTask(overrides: Partial<Task> = {}): Task {
  return makeTask({
    taskMode: 'developer',
    workflowSetup: {
      devTargetKind: 'plugin',
      repositoryRoot: 'C:/repos/CrmPlugins',
      pluginProject: 'Acme.Plugins',
      primaryEntityLogicalName: 'account',
      confirmedAt: '2026-06-01T10:00:00.000Z',
    },
    crmDeveloperWorkflow: {
      detectedWorkKind: 'plugin',
      currentStep: 'code-generation',
      technicalPlan: {
        generatedAt: '2026-06-01T10:00:00.000Z',
        workKind: 'plugin',
        summary: 'Implement account create plugin.',
        target: {
          entityLogicalName: 'account',
          message: 'Create',
          stage: 'PreOperation',
          mode: 'Sync',
          pluginProject: 'Acme.Plugins',
        },
        implementationSteps: ['Step 1'],
        dataverseFindings: [],
        risks: [],
        testChecklist: [],
      },
    },
    crmVerificationReports: [{ verdict: 'pass', summary: 'All clear.' }] as CrmVerificationReport[],
    ...overrides,
  });
}

describe('buildAiWorkflowPrompt — common header', () => {
  it('includes the task ID', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('task-001');
  });

  it('includes the task title', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('[TEST] Goal: Extend the existing account form script.');
  });

  it('instructs AI to use Task Workbench MCP tools', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Task Workbench MCP');
  });

  it('instructs AI to load context using get_task_full_context', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('get_task_full_context');
  });

  it('includes the task ID in the get_task_full_context instruction', () => {
    expect(buildAiWorkflowPrompt(makeTask({ id: 'abc-123' }))).toContain('"abc-123"');
  });

  it('includes the task status', () => {
    expect(buildAiWorkflowPrompt(makeTask({ status: 'analyzed' }))).toContain('Status: analyzed');
  });

  it('includes CRM workflow step when available', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({
      crmDeveloperWorkflow: { currentStep: 'technical-plan' },
    }));
    expect(prompt).toContain('Phase: technical-plan');
  });

  it('omits Phase line when no CRM workflow step is set', () => {
    expect(buildAiWorkflowPrompt(makeTask({ crmDeveloperWorkflow: undefined }))).not.toContain('Phase:');
  });

  it('includes task mode when set', () => {
    expect(buildAiWorkflowPrompt(makeTask({ taskMode: 'developer' }))).toContain('Mode: developer');
  });

  it('omits Mode line when taskMode is not set', () => {
    expect(buildAiWorkflowPrompt(makeTask({ taskMode: undefined }))).not.toContain('Mode:');
  });

  it('includes work classification when detected', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({
      crmDeveloperWorkflow: { detectedWorkKind: 'plugin' },
    }));
    expect(prompt).toContain('Work classification: plugin');
  });

  it('includes customer/environment when customerId is set', () => {
    expect(buildAiWorkflowPrompt(makeTask({ customerId: 'cust-navertica' }))).toContain('Customer/environment: cust-navertica');
  });

  it('falls back to workflowSetup.customerId when task.customerId is missing', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({
      customerId: undefined,
      workflowSetup: { customerId: 'setup-customer' },
    }));
    expect(prompt).toContain('Customer/environment: setup-customer');
  });

  it('includes customer developer defaults section when customer has repositoryRoot', () => {
    const customer = { id: 'c1', name: 'VSK-Test', shortCode: 'VSK', repositoryRoot: 'C:/repos/VSK' } as Customer;
    const prompt = buildAiWorkflowPrompt(makeTask(), customer);
    expect(prompt).toContain('Customer developer defaults (VSK-Test):');
    expect(prompt).toContain('Default repository root: C:/repos/VSK');
  });

  it('prefers resolvedRepositoryPath over repositoryRoot in customer defaults', () => {
    const customer = { id: 'c1', name: 'VSK-Test', shortCode: 'VSK', repositoryRoot: 'C:/repos/raw', resolvedRepositoryPath: 'C:/repos/resolved' } as Customer;
    const prompt = buildAiWorkflowPrompt(makeTask(), customer);
    expect(prompt).toContain('Default repository root: C:/repos/resolved');
    expect(prompt).not.toContain('C:/repos/raw');
  });

  it('includes scriptFolder and pluginFolder in customer defaults when set', () => {
    const customer = { id: 'c1', name: 'Acme', shortCode: 'ACM', repositoryRoot: 'C:/repos/Acme', scriptFolder: 'C:/repos/Acme/scripts', pluginFolder: 'C:/repos/Acme/plugins' } as Customer;
    const prompt = buildAiWorkflowPrompt(makeTask(), customer);
    expect(prompt).toContain('Default script directory: C:/repos/Acme/scripts');
    expect(prompt).toContain('Default plugin project path: C:/repos/Acme/plugins');
  });

  it('includes jsConventionsSource and pluginConventionsSource in customer defaults when set', () => {
    const customer = { id: 'c1', name: 'Acme', shortCode: 'ACM', repositoryRoot: 'C:/repos/Acme', jsConventionsSource: 'C:/repos/Acme/scripts/contact.js', pluginConventionsSource: 'C:/repos/Acme/plugins/ContactPlugin.cs' } as Customer;
    const prompt = buildAiWorkflowPrompt(makeTask(), customer);
    expect(prompt).toContain('JS conventions reference: C:/repos/Acme/scripts/contact.js');
    expect(prompt).toContain('Plugin conventions reference: C:/repos/Acme/plugins/ContactPlugin.cs');
  });

  it('omits customer defaults section when customer has no relevant fields', () => {
    const customer = { id: 'c1', name: 'Acme', shortCode: 'ACM' } as Customer;
    const prompt = buildAiWorkflowPrompt(makeTask(), customer);
    expect(prompt).not.toContain('Customer developer defaults');
  });

  it('omits customer defaults section when no customer is provided', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).not.toContain('Customer developer defaults');
  });
});

describe('buildAiWorkflowPrompt — setup prompt (not ready)', () => {
  it('instructs AI not to implement code or modify files', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Do not implement code or modify files');
  });

  it('instructs AI not to perform external writes during setup/readiness run', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Do not perform external writes');
    expect(prompt).toContain('during this setup/readiness run');
    // Must not imply a permanent ban — approved future workflow actions must still be possible
    expect(prompt).not.toContain('at any stage');
    expect(prompt).toContain('External writes are allowed only later through explicit approved workflow actions');
  });

  it('references technical plan in setup rules', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('technical plan');
  });

  it('references Primarch for Dataverse verification step', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Primarch');
  });

  it('stops AI if MCP fails', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('stop immediately');
    expect(prompt).toContain('Do not continue outside Task Workbench workflow');
  });

  it('mentions prompt regeneration only as fallback when MCP refresh fails', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('regenerate this prompt');
    // Must be conditional — only when MCP cannot be reloaded
    expect(prompt).toContain('Only ask the user to regenerate this prompt if MCP context cannot be reloaded');
    // Must NOT unconditionally demand regeneration after each update
    expect(prompt).not.toContain('ask the user to re-generate this prompt');
  });

  it('includes safe auto-setup loop instructions', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Safe auto-setup loop:');
    expect(prompt).toContain('up to 8 safe Task Workbench-only setup updates');
  });

  it('includes auto-setup orchestration loop description', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Auto-setup orchestration loop:');
    expect(prompt).toContain('up to 8 safe Task Workbench-only setup actions');
  });

  it('instructs AI to reload context and continue after safe work classification update', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    expect(prompt).toContain('reload `get_task_full_context`, and continue');
  });

  it('does not tell AI to stop after work classification save', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    // Rule 3 should say reload+continue, not stop
    expect(prompt).not.toMatch(/set_task_work_classification[^.]*and stop/);
  });

  it('lists safe auto-setup examples including mode and classification', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('setting task mode to Developer');
    expect(prompt).toContain('setting work classification to script/plugin');
  });

  it('lists mode blocker for non-developer task', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Task mode is not set to Developer.');
  });

  it('lists multiple blockers for developer plugin task missing setup', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    expect(prompt).toContain('Repository root is not set.');
    expect(prompt).toContain('Developer setup has not been confirmed.');
    expect(prompt).toContain('Technical implementation plan is missing.');
    expect(prompt).toContain('Dataverse metadata verification has not been completed or explicitly skipped.');
    expect(prompt).toContain('Plugin project is not selected.');
  });

  it('includes recommended next step', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    expect(prompt).toContain('Recommended next step:');
  });

  it('does NOT contain implementation-only sections', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).not.toContain('Implementation rules');
    expect(prompt).not.toContain('Record local test results');
  });

  it('separates blockers by category in setup prompt', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    // Mode missing = auto-resolvable → appears under auto-resolvable section
    expect(prompt).toContain('Auto-resolvable');
  });

  it('shows Dataverse check as read-only workflow action (not hard blocker)', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    expect(prompt).toContain('Read-only workflow actions');
    expect(prompt).toContain('run_dataverse_check_for_task');
  });

  it('shows technical plan as proposal action (not hard blocker)', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    expect(prompt).toContain('Proposal/draft actions');
    expect(prompt).toContain('save_technical_plan');
  });

  it('includes retry behavior instructions', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Retry required MCP read calls up to 3 times');
  });

  it('mode blocker section mentions set_task_mode', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('set_task_mode');
  });
});

describe('buildAiWorkflowPrompt — script context block', () => {
  it('includes Script target context section for script tasks', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyScriptTask());
    expect(prompt).toContain('Script target context:');
  });

  it('includes action type in script context', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).toContain('Action type: update-existing-script');
  });

  it('includes target file in script context', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).toContain('Target file: C:/repos/CrmScripts/src/scripts/account_form.js');
  });

  it('includes table logical name in script context', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).toContain('Table (logical name): account');
  });

  it('includes web resource name in script context', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).toContain('Web resource name: nvr_account_form');
  });

  it('includes form name in script context', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).toContain('Form name: Account Main Form');
  });

  it('includes event name in script context', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).toContain('Event: OnLoad');
  });

  it('includes eventFieldName in script context', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).toContain('Event field (onChange): new_status');
  });

  it('includes function name in script context', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).toContain('Function name: onAccountLoad');
  });

  it('falls back to workflowSetup.eventName when target.eventName is absent', () => {
    const task = makeReadyScriptTask({
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:/repos/CrmScripts',
        scriptPath: 'C:/repos/CrmScripts/src/scripts/account_form.js',
        primaryEntityLogicalName: 'account',
        confirmedAt: '2026-06-01T10:00:00.000Z',
        actionType: 'update-existing-script',
        eventName: 'OnSave',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          generatedAt: '2026-06-01T10:00:00.000Z',
          workKind: 'script',
          summary: 'Extend account form script.',
          target: {
            entityLogicalName: 'account',
            scriptPath: 'C:/repos/CrmScripts/src/scripts/account_form.js',
          },
          implementationSteps: [],
          dataverseFindings: [],
          risks: [],
          testChecklist: [],
        },
      },
    });
    expect(buildAiWorkflowPrompt(task)).toContain('Event: OnSave');
  });

  it('falls back to workflowSetup.eventFieldName when target.eventFieldName is absent', () => {
    const task = makeReadyScriptTask({
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:/repos/CrmScripts',
        scriptPath: 'C:/repos/CrmScripts/src/scripts/account_form.js',
        primaryEntityLogicalName: 'account',
        confirmedAt: '2026-06-01T10:00:00.000Z',
        actionType: 'update-existing-script',
        eventFieldName: 'nvr_assetid',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          generatedAt: '2026-06-01T10:00:00.000Z',
          workKind: 'script',
          summary: 'Extend account form script.',
          target: {
            entityLogicalName: 'account',
            scriptPath: 'C:/repos/CrmScripts/src/scripts/account_form.js',
          },
          implementationSteps: [],
          dataverseFindings: [],
          risks: [],
          testChecklist: [],
        },
      },
    });
    expect(buildAiWorkflowPrompt(task)).toContain('Event field (onChange): nvr_assetid');
  });

  it('prefers target.eventName over workflowSetup.eventName', () => {
    const task = makeReadyScriptTask({
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:/repos/CrmScripts',
        scriptPath: 'C:/repos/CrmScripts/src/scripts/account_form.js',
        primaryEntityLogicalName: 'account',
        confirmedAt: '2026-06-01T10:00:00.000Z',
        actionType: 'update-existing-script',
        eventName: 'OnSave',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          generatedAt: '2026-06-01T10:00:00.000Z',
          workKind: 'script',
          summary: 'Extend.',
          target: { entityLogicalName: 'account', scriptPath: 'C:/repos/CrmScripts/src/scripts/account_form.js', eventName: 'OnLoad' },
          implementationSteps: [],
          dataverseFindings: [],
          risks: [],
          testChecklist: [],
        },
      },
    });
    const prompt = buildAiWorkflowPrompt(task);
    expect(prompt).toContain('Event: OnLoad');
    expect(prompt).not.toContain('Event: OnSave');
  });

  it('includes conventions reference in script context', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).toContain('Conventions reference: C:/repos/CrmScripts/src/scripts/contact_form.js');
  });

  it('includes related files in script context', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).toContain('Related files: nvr_contact_form.js');
  });

  it('shows NOT SET when target file is missing in not-ready script task', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyScriptTask({
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:/repos',
        confirmedAt: '2026-06-01T10:00:00.000Z',
        primaryEntityLogicalName: 'account',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          generatedAt: '2026-06-01T10:00:00.000Z',
          workKind: 'script',
          summary: 'Test.',
          target: { entityLogicalName: 'account', formName: 'Main Form', eventName: 'OnLoad', functionName: 'fn' },
          implementationSteps: [],
          dataverseFindings: [],
          risks: [],
          testChecklist: [],
        },
      },
    }));
    expect(prompt).toContain('NOT SET');
  });

  it('does not include Script target context for plugin tasks', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('Script target context:');
  });

  it('rule 5 mentions script target context for not-guessing', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('script tasks use only the target file shown in Script target context');
  });

  it('rule 8 references conventionsSource', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('conventionsSource');
  });
});

describe('buildAiWorkflowPrompt — implementation prompt (ready task)', () => {
  it('does not include NOT implementation-ready warning', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('NOT implementation-ready');
  });

  it('contains Implementation rules section', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Implementation rules');
  });

  it('rule 2: no files without confirmed context', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Do not create or modify files unless all of these are confirmed');
  });

  it('rule 3: MCP unavailability stop', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('stop immediately');
    expect(prompt).toContain('Do not continue implementation outside Task Workbench workflow');
  });

  it('rule 7: Primarch Dataverse verification', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Primarch');
  });

  it('rule 8: script conventions', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('JavaScript/form script tasks');
  });

  it('rule 9: plugin conventions', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('plugin conventions');
  });

  it('rule 10: no external writes without approval', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Do not perform external writes');
  });

  it('rule 11: record results back into Task Workbench', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Record local test results');
  });

  it('rule 12: summarize at end', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('summarize what was done');
  });

  it('shows warnings inline when present but does not block', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask({
      crmVerificationReports: [{ verdict: 'warnings', summary: 'Some warnings.' }] as CrmVerificationReport[],
    }));
    expect(prompt).toContain('Implementation rules');
    expect(prompt).toContain('Warnings:');
    expect(prompt).toContain('Dataverse verification completed with warnings');
  });
});

describe('buildAiWorkflowPrompt — template lookup instruction', () => {
  it('instructs AI to call get_task_templates with the task ID in the opening sequence', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({ id: 'task-nvr-001' }));
    expect(prompt).toContain('get_task_templates');
    expect(prompt).toContain('"task-nvr-001"');
  });

  it('instructs AI to apply template values before evaluating missing metadata as blockers', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('apply its values');
    expect(prompt).toContain('BEFORE evaluating which metadata fields are missing');
  });

  it('includes get_task_templates as setup rule 2 with apply-before-evaluate instruction', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('apply its workKind, actionType, targetEntity');
    expect(prompt).toContain('BEFORE treating those fields as missing blockers');
  });

  it('setup rule 2 instructs reload after applying template values', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Reload `get_task_full_context` after applying template values');
  });

  it('get_task_templates call appears in both the opening sequence and the setup rules', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({ id: 'task-abc' }));
    const occurrences = (prompt.match(/get_task_templates/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe('buildAiWorkflowPrompt — setup prompt categorized sections', () => {
  it('non-developer task auto-resolvable section includes set_task_mode call', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Auto-resolvable');
    expect(prompt).toContain('set_task_mode');
  });

  it('setup prompt contains hard blocker section for missing repo root', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    expect(prompt).toContain('Hard blockers');
    expect(prompt).toContain('Repository root is not set.');
  });

  it('setup prompt shows approval gate for missing confirmedAt when no other hard blockers', () => {
    // Task with only confirmedAt missing (all other setup present)
    const prompt = buildAiWorkflowPrompt(makeReadyTask({
      workflowSetup: {
        devTargetKind: 'plugin',
        repositoryRoot: 'C:/repos/CrmPlugins',
        pluginProject: 'Acme.Plugins',
        primaryEntityLogicalName: 'account',
        confirmedAt: undefined,
      },
    }));
    expect(prompt).toContain('Approval gates');
    expect(prompt).toContain('Developer setup has not been confirmed.');
  });

  it('NVR script task title triggers auto-resolvable work kind blocker', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({
      taskMode: 'developer',
      title: '[TEST] Script: Předvyplnění servisního požadavku podle zařízení',
    }));
    expect(prompt).toContain('Auto-resolvable');
    expect(prompt).toContain('set_task_work_classification');
  });

  it('NVR plugin task title triggers auto-resolvable work kind blocker', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({
      taskMode: 'developer',
      title: '[TEST] Plugin: Výpočet částek na položce servisní zakázky',
    }));
    expect(prompt).toContain('Auto-resolvable');
    expect(prompt).toContain('set_task_work_classification');
  });
});
