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

  it('includes setup orchestration section with up-to-8 limit', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Setup orchestration (up to 8 safe Task Workbench-only actions):');
  });

  it('includes allowed auto-setup actions section', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Allowed auto-setup actions (no user input needed when the value is explicit):');
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

describe('buildAiWorkflowPrompt — task identity and MCP write rules', () => {
  it('includes "current task ID is the Task ID shown in this prompt"', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('current task ID is the Task ID shown in this prompt');
  });

  it('instructs AI not to ask the user for the task ID again', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Do not ask the user for the task ID again');
  });

  it('instructs AI not to ask the user what to do with a complete developer target', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Do not ask the user what to do with a complete developer target');
  });

  it('instructs AI to save complete target to current task using set_task_developer_target', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Save it to the current task using set_task_developer_target');
  });

  it('instructs AI to reload get_task_full_context after saving target and continue', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('reload get_task_full_context');
  });

  it('task identity section appears in both setup and implementation prompts', () => {
    const setupPrompt = buildAiWorkflowPrompt(makeTask());
    const implPrompt  = buildAiWorkflowPrompt(makeReadyTask());
    expect(setupPrompt).toContain('current task ID is the Task ID shown in this prompt');
    expect(implPrompt).toContain('current task ID is the Task ID shown in this prompt');
  });

  it('setup loop items include create-new-script file name derivation instruction', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('for create-new-script tasks');
    expect(prompt).toContain('<fullEntityLogicalName>_events.js');
  });
});

describe('buildAiWorkflowPrompt — script target TBD prevention', () => {
  it('does not contain TBD in script target context when no target is set for create-new-script', () => {
    const task = makeTask({
      taskMode: 'developer',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:/repos/Scripts',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
      },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    expect(buildAiWorkflowPrompt(task)).not.toContain('TBD');
  });

  it('create-new-script without target shows derive-from-convention message not do-not-guess', () => {
    const task = makeTask({
      taskMode: 'developer',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:/repos/Scripts',
        actionType: 'create-new-script',
      },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    const prompt = buildAiWorkflowPrompt(task);
    expect(prompt).toContain('derive from entity name and naming convention below');
    expect(prompt).not.toContain('do not guess or create a file path');
  });

  it('update-existing-script without target still shows do-not-guess message', () => {
    const task = makeTask({
      taskMode: 'developer',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:/repos/Scripts',
        actionType: 'update-existing-script',
      },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    const prompt = buildAiWorkflowPrompt(task);
    expect(prompt).toContain('do not guess or create a file path');
  });

  it('prompt does not contain dot-notation namespace patterns in naming conventions', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', actionType: 'create-new-script' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    }));
    expect(prompt).not.toContain('NVR.ServiceCase');
    expect(prompt).not.toContain('AssetPrefill');
  });
});

describe('buildAiWorkflowPrompt — create-new-script naming conventions', () => {
  it('includes CRM JS script naming conventions section for create-new-script tasks', () => {
    const task = makeTask({
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', actionType: 'create-new-script' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    expect(buildAiWorkflowPrompt(task)).toContain('CRM JS script naming conventions');
  });

  it('naming conventions include entityLogicalName_events.js file format', () => {
    const task = makeTask({
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', actionType: 'create-new-script' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    expect(buildAiWorkflowPrompt(task)).toContain('<entityLogicalName>_events.js');
  });

  it('naming conventions include OnLoad and OnChange handler formats', () => {
    const task = makeTask({
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', actionType: 'create-new-script' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    const prompt = buildAiWorkflowPrompt(task);
    expect(prompt).toContain('<entityLogicalName>_OnLoad');
    expect(prompt).toContain('<fieldLogicalName>_OnChange');
  });

  it('naming conventions specify camelCase helper functions without namespace prefixes', () => {
    const task = makeTask({
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', actionType: 'create-new-script' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    const prompt = buildAiWorkflowPrompt(task);
    expect(prompt).toContain('camelCase');
    expect(prompt).toContain('without namespace prefixes');
  });

  it('for entity nvr_servicecase derives convention hint nvr_servicecase_events.js', () => {
    const task = makeTask({
      taskMode: 'developer',
      workflowSetup: {
        devTargetKind: 'script',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
      },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    const prompt = buildAiWorkflowPrompt(task);
    expect(prompt).toContain('nvr_servicecase_events.js');
    expect(prompt).toContain('nvr_servicecase_OnLoad');
  });

  it('naming conventions section is absent for create-new-script when target file is already set', () => {
    const task = makeReadyScriptTask({
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:/repos',
        scriptPath: 'C:/repos/Scripts/nvr_servicecase_events.js',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
    });
    expect(buildAiWorkflowPrompt(task)).not.toContain('CRM JS script naming conventions');
  });

  it('naming conventions section is absent for update-existing-script tasks', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).not.toContain('CRM JS script naming conventions');
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

// ── Concrete script naming contract ──────────────────────────────────────────

function makeNvrScriptTask(setupOverrides = {}, customerOverride?: Partial<{ scriptFolder: string; repositoryRoot: string }>) {
  return {
    task: makeTask({
      taskMode: 'developer',
      workflowSetup: {
        devTargetKind: 'script',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        eventFieldName: 'nvr_assetid',
        ...setupOverrides,
      },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    }),
    customer: customerOverride
      ? ({ id: 'cust-vsk', name: 'VSK-Test', ...customerOverride } as unknown as import('../types').Customer)
      : undefined,
  };
}

describe('buildAiWorkflowPrompt — concrete script naming contract', () => {
  it('shows CRM script naming contract when entity and customer scriptFolder are known', () => {
    const { task, customer } = makeNvrScriptTask({}, {
      scriptFolder: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts',
      repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
    });
    expect(buildAiWorkflowPrompt(task, customer)).toContain('CRM script naming contract');
  });

  it('prompt contains absolute script folder when customer scriptFolder is configured', () => {
    const { task, customer } = makeNvrScriptTask({}, {
      scriptFolder: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts',
      repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
    });
    expect(buildAiWorkflowPrompt(task, customer)).toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts');
  });

  it('prompt contains derived relative target file Scripts\\nvr_servicecase_events.js', () => {
    const { task, customer } = makeNvrScriptTask({}, {
      scriptFolder: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts',
      repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
    });
    expect(buildAiWorkflowPrompt(task, customer)).toContain('Scripts\\nvr_servicecase_events.js');
  });

  it('prompt contains derived absolute target file with full Windows path', () => {
    const { task, customer } = makeNvrScriptTask({}, {
      scriptFolder: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts',
      repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
    });
    expect(buildAiWorkflowPrompt(task, customer)).toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
  });

  it('prompt contains OnLoad handler nvr_servicecase_OnLoad', () => {
    const { task, customer } = makeNvrScriptTask({}, {
      scriptFolder: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts',
      repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
    });
    expect(buildAiWorkflowPrompt(task, customer)).toContain('nvr_servicecase_OnLoad');
  });

  it('prompt contains OnChange handler nvr_assetid_OnChange', () => {
    const { task, customer } = makeNvrScriptTask({}, {
      scriptFolder: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts',
      repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
    });
    expect(buildAiWorkflowPrompt(task, customer)).toContain('nvr_assetid_OnChange');
  });

  it('prompt says helpers are descriptive camelCase with no nvr_ prefix by default', () => {
    const { task, customer } = makeNvrScriptTask({}, {
      scriptFolder: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts',
      repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
    });
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('descriptive camelCase');
    expect(prompt).toContain('no nvr_ prefix by default');
  });

  it('naming contract instructs to save via set_task_developer_target', () => {
    const { task, customer } = makeNvrScriptTask({}, {
      scriptFolder: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts',
      repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
    });
    expect(buildAiWorkflowPrompt(task, customer)).toContain('Save this derived target via set_task_developer_target with:');
  });

  it('naming contract shown even without customer when entity is known (partial contract)', () => {
    const { task } = makeNvrScriptTask();
    const prompt = buildAiWorkflowPrompt(task);
    expect(prompt).toContain('CRM script naming contract');
    expect(prompt).toContain('nvr_servicecase_events.js');
    expect(prompt).toContain('nvr_servicecase_OnLoad');
  });

  it('does not show CRM JS script naming conventions when entity is known', () => {
    const { task } = makeNvrScriptTask();
    expect(buildAiWorkflowPrompt(task)).not.toContain('CRM JS script naming conventions');
  });

  it('does not suggest save_technical_plan as primary for target entity in setup rule 10', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    // Rule 10 must use set_task_developer_target, not save_technical_plan, for entity logical name
    const rule10 = prompt.split('\n').find(l => l.startsWith('10.'));
    expect(rule10).toBeDefined();
    expect(rule10).toContain('set_task_developer_target');
    expect(rule10).not.toMatch(/save_technical_plan.*entity/i);
  });

  it('create-new-script setup rule mentions Scripts_Naming and double-prefix prevention', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Scripts_Naming');
    expect(prompt).toContain('do not double the nvr_ prefix');
  });
});

// ── Template-preview contract (no persisted entity) ──────────────────────────

function makeFreshNvrTask(customerOverride?: Partial<{ scriptFolder: string; repositoryRoot: string }>) {
  return {
    task: makeTask({
      taskMode: 'developer',
      title: '[TEST] Script: Předvyplnění servisního požadavku podle zařízení',
    }),
    customer: customerOverride
      ? ({ id: 'cust-vsk', name: 'VSK-Test', ...customerOverride } as unknown as import('../types').Customer)
      : undefined,
  };
}

describe('buildAiWorkflowPrompt — template-preview contract (no persisted entity)', () => {
  const vskCustomer = {
    scriptFolder: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts',
    repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
  };

  it('fresh NVR script task with matching title shows CRM script naming contract', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    expect(buildAiWorkflowPrompt(task, customer)).toContain('CRM script naming contract');
  });

  it('fresh NVR script task prompt contains nvr_servicecase_events.js from template', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    expect(buildAiWorkflowPrompt(task, customer)).toContain('nvr_servicecase_events.js');
  });

  it('fresh NVR script task prompt contains derived relative path Scripts\\nvr_servicecase_events.js', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    expect(buildAiWorkflowPrompt(task, customer)).toContain('Scripts\\nvr_servicecase_events.js');
  });

  it('fresh NVR script task prompt contains full Windows absolute path', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    expect(buildAiWorkflowPrompt(task, customer)).toContain(
      'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js',
    );
  });

  it('fresh NVR script task prompt contains nvr_servicecase_OnLoad', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    expect(buildAiWorkflowPrompt(task, customer)).toContain('nvr_servicecase_OnLoad');
  });

  it('fresh NVR script task prompt contains nvr_assetid_OnChange', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    expect(buildAiWorkflowPrompt(task, customer)).toContain('nvr_assetid_OnChange');
  });

  it('fresh NVR script task prompt contains prefillServiceCaseFromAsset helper suggestion', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    expect(buildAiWorkflowPrompt(task, customer)).toContain('prefillServiceCaseFromAsset');
  });

  it('fresh NVR script task prompt does not contain TBD', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    expect(buildAiWorkflowPrompt(task, customer)).not.toContain('TBD');
  });

  it('fresh NVR script task naming contract derived file name entry is correct', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* Derived file name: nvr_servicecase_events.js');
  });

  it('fresh NVR script task prompt does not expose servicecase_events.js without nvr_ prefix', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).not.toMatch(/\bservicecase_events\.js/);
  });

  it('fresh NVR script task prompt does not contain NVR.ServiceCase namespace', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).not.toContain('NVR.ServiceCase');
    expect(prompt).not.toContain('AssetPrefill');
  });

  it('fresh NVR script task still instructs AI to call get_task_templates', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    expect(buildAiWorkflowPrompt(task, customer)).toContain('get_task_templates');
  });

  it('fresh NVR script task without customer shows partial contract with relative path', () => {
    const { task } = makeFreshNvrTask();
    const prompt = buildAiWorkflowPrompt(task);
    expect(prompt).toContain('CRM script naming contract');
    expect(prompt).toContain('nvr_servicecase_events.js');
    expect(prompt).not.toContain('C:\\Users\\vskoumal');
  });

  it('fresh NVR script task with customer shows Target file preview line', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* Target file preview: Scripts\\nvr_servicecase_events.js');
  });

  it('fresh NVR script task with customer does NOT say Target file: NOT SET', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).not.toContain('Target file: NOT SET');
  });

  it('fresh NVR script task with customer shows Persistence state line', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* Persistence state: not yet saved to task setup');
  });

  it('fresh NVR script task with customer shows Required action line', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* Required action: save this target via set_task_developer_target');
  });

  it('fresh NVR script task without customer still shows Target file preview via relative path from template', () => {
    const { task } = makeFreshNvrTask();
    const prompt = buildAiWorkflowPrompt(task);
    // Relative path is derivable from the template even without a customer (sep defaults to /)
    expect(prompt).toContain('* Target file preview: Scripts/nvr_servicecase_events.js');
    expect(prompt).not.toContain('Target file: NOT SET');
  });

  it('fresh NVR script task with customer shows Repository root line in naming contract', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* Repository root: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });

  it('fresh NVR script task with customer shows Scripts folder absolute path in naming contract', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* Scripts folder: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts');
  });

  it('fresh NVR script task with customer shows Derived absolute target file in naming contract', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* Derived absolute target file: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
  });

  it('fresh NVR script task concrete save instruction includes repositoryRoot', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* repositoryRoot: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
  });

  it('fresh NVR script task concrete save instruction includes artifactPath', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* artifactPath: Scripts\\nvr_servicecase_events.js');
  });

  it('fresh NVR script task concrete save instruction includes absoluteScriptPath', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* absoluteScriptPath: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
  });

  it('fresh NVR script task concrete save instruction includes actionType', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* actionType: create-new-script');
  });

  it('fresh NVR script task concrete save instruction includes eventFieldName', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* eventFieldName: nvr_assetid');
  });

  it('fresh NVR script task with customer does not render forward-slash Windows paths in naming contract', () => {
    const { task, customer } = makeFreshNvrTask(vskCustomer);
    const prompt = buildAiWorkflowPrompt(task, customer);
    // With a Windows customer (backslash paths), no forward-slash paths should appear in the naming contract
    expect(prompt).not.toContain('Scripts/nvr_servicecase_events.js');
    expect(prompt).not.toContain('CRM/VSK-Test/Scripts');
  });

  it('customer with only repositoryRoot (no scriptFolder) derives absolute script path in naming contract', () => {
    const { task, customer } = makeFreshNvrTask({ repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test' });
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
  });

  it('customer with resolvedRepositoryPath (computed from folderName + crmBaseDirectory) derives full absolute target', () => {
    // resolvedRepositoryPath is the computed path set by the app at startup (crmBaseDirectory + folderName)
    const { task } = makeFreshNvrTask();
    const customer = {
      id: 'cust-vsk',
      name: 'VSK-Test',
      resolvedRepositoryPath: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
    } as unknown as import('../types').Customer;
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('* Repository root: C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test');
    expect(prompt).toContain('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
  });
});
