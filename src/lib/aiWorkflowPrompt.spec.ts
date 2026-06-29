import { describe, it, expect } from 'vitest';
import { buildAiWorkflowPrompt } from './aiWorkflowPrompt';
import type { Task, Customer, CrmVerificationReport } from '../types';

// Minimal task â€” no developer mode set â†’ produces setup prompt
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    title: '[TEST] Goal: Extend the existing account form script.',
    status: 'in-progress',
    customerId: 'customer-acme',
    ...overrides,
  } as unknown as Task;
}

// Developer mode task with plugin kind but missing most setup â†’ produces setup prompt
function makeDevTask(overrides: Partial<Task> = {}): Task {
  return makeTask({
    taskMode: 'developer',
    workflowSetup: { devTargetKind: 'plugin' },
    ...overrides,
  });
}

// Fully ready developer script task â†’ produces implementation prompt with Script target context
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

// Fully ready developer plugin task â†’ produces implementation prompt
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

describe('buildAiWorkflowPrompt â€” common header', () => {
  it('includes the task ID', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('task-001');
  });

  it('includes the task title', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('[TEST] Goal: Extend the existing account form script.');
  });

  it('instructs AI to use Task Workbench MCP tools', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Task Workbench MCP');
  });

  it('instructs AI to start with get_developer_work_packet', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('First MCP call: `get_developer_work_packet`');
  });

  it('includes the task ID in the first setup/readiness MCP call instruction', () => {
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

describe('buildAiWorkflowPrompt â€” setup prompt (not ready)', () => {
  it('instructs AI not to implement code or modify files', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Do not implement code or modify files');
  });

  it('instructs AI not to perform external writes during setup/readiness run', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Do not perform external writes');
    expect(prompt).toContain('during this setup/readiness run');
    // Must not imply a permanent ban â€” approved future workflow actions must still be possible
    expect(prompt).not.toContain('at any stage');
    expect(prompt).toContain('External writes are allowed only later through explicit approved workflow actions');
  });

  it('references implementation guidance from the work packet in setup rules', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('writeTarget, implementation, conventions, and reviewTestCommit');
  });

  it('delegates setup/readiness decision to get_developer_work_packet', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('get_developer_work_packet');
    expect(prompt).toContain('canWriteCode decision');
  });

  it('stops AI if MCP fails', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('stop immediately');
    expect(prompt).toContain('Task Workbench MCP becomes unavailable');
  });

  it('does not ask for prompt regeneration during orchestration setup', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).not.toContain('regenerate this prompt');
    expect(prompt).not.toContain('ask the user to re-generate this prompt');
  });

  it('includes work packet flow section using get_developer_work_packet', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Work packet flow:');
    expect(prompt).toContain('get_developer_work_packet');
  });

  it('keeps prepare_developer_task as conditional setup fallback', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Use prepare_developer_task only when the work packet explicitly says setup is incomplete');
  });

  it('instructs AI to use returned work packet without mandatory reload', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    expect(prompt).toContain('Use the returned work packet as the source of truth');
    expect(prompt).toContain('Use get_task_full_context only as fallback');
  });

  it('does not tell AI to stop after work classification save', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    // Rule 3 should say reload+continue, not stop
    expect(prompt).not.toMatch(/set_task_work_classification[^.]*and stop/);
  });

  it('hides internal workflow state behind the work packet', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('hides Task Workbench internal workflow state');
    expect(prompt).toContain('do not reason over internal gates');
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
    // Mode missing = auto-resolvable â†’ appears under auto-resolvable section
    expect(prompt).toContain('Auto-resolvable');
  });

  it('shows Dataverse check as read-only workflow action (not hard blocker)', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    expect(prompt).toContain('Read-only workflow actions');
    expect(prompt).toContain('run_dataverse_check_for_task');
  });

  it('does not instruct JS script setup prompts to call run_dataverse_check_for_task before or after prepare_developer_task', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask({
      workflowSetup: { devTargetKind: 'script' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      crmVerificationReports: undefined,
      implementationVerification: undefined,
    }));
    expect(prompt).toContain('prepare_developer_task');
    expect(prompt).toContain('Dataverse metadata verification for JS/TS is not available through MCP');
    expect(prompt).not.toContain('â†’ call `run_dataverse_check_for_task`');
    expect(prompt).not.toContain('-> call `run_dataverse_check_for_task`');
    expect(prompt).not.toContain('do not call run_dataverse_check_for_task');
    expect(prompt).not.toContain('run run_dataverse_check_for_task');
  });

  it('shows technical plan as proposal action (not hard blocker)', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    expect(prompt).toContain('Proposal/draft actions');
    expect(prompt).toContain('save_technical_plan');
  });

  it('includes retry behavior instructions', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('fails after 3 retries');
  });

  it('mode blocker section mentions set_task_mode', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('set_task_mode');
  });
});

describe('buildAiWorkflowPrompt â€” script context block', () => {
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

  it('does not contain old rule 5 about guessing target file (removed - delegated to work packet)', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('script tasks use only the target file shown in Script target context');
  });

  it('does not contain conventionsSource (removed from rule text, delegated to work packet)', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('conventionsSource');
  });
});

describe('buildAiWorkflowPrompt â€” implementation prompt (ready task)', () => {
  it('does not include NOT implementation-ready warning', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('NOT implementation-ready');
  });

  it('contains Implementation rules section', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Implementation rules');
  });

  it('does not contain old rule 2 (removed – canWriteCode gate now in rule 1)', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('Do not create or modify files unless canWriteCode is true');
  });

  it('rule 3: MCP unavailability stop', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('stop immediately');
    expect(prompt).toContain('Do not continue implementation outside Task Workbench workflow');
  });

  it('rule 7: Primarch Dataverse verification', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Primarch');
  });

  it('rule 7: JS script implementation prompt uses in-app verification instead of run_dataverse_check_for_task', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyScriptTask({
      crmVerificationReports: undefined,
      implementationVerification: undefined,
    }));
    expect(prompt).toContain('Dataverse metadata verification for JS/TS is not available through MCP');
    expect(prompt).toContain('Verify Implementation modal');
    expect(prompt).not.toContain('run_dataverse_check_for_task');
    expect(prompt).not.toContain('run run_dataverse_check_for_task');
  });

  it('does not contain old rule 8 (JS conventions merged into work-packet rule 4)', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('JavaScript/form script tasks');
  });

  it('does not contain old rule 9 (plugin conventions merged into work-packet rule 4)', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('plugin conventions');
  });

  it('rule 10: no external writes without approval', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Do not perform external writes');
  });

  it('rule 11: record results back into Task Workbench', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Record local test results');
  });

  it('rule 9: summarize what was changed at end', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('summarize what was changed');
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

describe('buildAiWorkflowPrompt - developer work packet opening instruction', () => {
  it('instructs AI to call get_developer_work_packet first with the task ID', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({ id: 'task-nvr-001' }));
    expect(prompt).toContain('First MCP call: `get_developer_work_packet`');
    expect(prompt).toContain('task-nvr-001');
  });

  it('does not start setup/readiness prompts with get_task_full_context', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).not.toContain('Start by loading the full current context');
    expect(prompt).not.toContain('First MCP call: `get_task_full_context`');
  });

  it('uses get_developer_work_packet as the implementation-ready entrypoint', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('First MCP call: `get_developer_work_packet`');
    expect(prompt).not.toContain('Start by loading the full current context');
    expect(prompt).not.toContain('First MCP call: `get_task_full_context`');
  });

  it('does not contain contradictory full-context-first and prepare-first instructions', () => {
    const setupPrompt = buildAiWorkflowPrompt(makeTask());
    const readyPrompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(setupPrompt).not.toContain('Start by loading the full current context');
    expect(readyPrompt).not.toContain('Start by loading the full current context');
  });

  it('does not render mojibake markers in generated prompt text', () => {
    expect(buildAiWorkflowPrompt(makeTask())).not.toContain('Ă˘');
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('Ă˘');
  });

  it('treats template/default application as a conditional prepare_developer_task responsibility', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Use prepare_developer_task only when the work packet explicitly says setup is incomplete');
  });

  it('forbids low-level reads before get_developer_work_packet', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Do not call get_task_full_context, get_implementation_readiness, or get_task_templates before it');
  });
});

describe('buildAiWorkflowPrompt â€” task identity and MCP write rules', () => {
  it('includes "current task ID is the Task ID shown in this prompt"', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('current task ID is the Task ID shown in this prompt');
  });

  it('instructs AI not to ask the user for the task ID again', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Do not ask the user for the task ID again');
  });

  it('instructs AI to rely on the work packet for working fields', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('where to write, what to implement, conventions, verification, and review/test/commit guidance');
  });

  it('instructs AI to prefer get_developer_work_packet over low-level target writes', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('For AI work, prefer get_developer_work_packet');
  });

  it('instructs AI not to load get_task_full_context unless the work packet fails', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Use get_task_full_context only as fallback when get_developer_work_packet returns an error or missing context');
  });

  it('task identity section appears in both setup and implementation prompts', () => {
    const setupPrompt = buildAiWorkflowPrompt(makeTask());
    const implPrompt  = buildAiWorkflowPrompt(makeReadyTask());
    expect(setupPrompt).toContain('current task ID is the Task ID shown in this prompt');
    expect(implPrompt).toContain('current task ID is the Task ID shown in this prompt');
  });

  it('setup loop delegates script file name usage to the work packet', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('implement only the work described by writeTarget');
  });
});

describe('buildAiWorkflowPrompt â€” script target TBD prevention', () => {
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

describe('buildAiWorkflowPrompt â€” create-new-script naming conventions', () => {
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

describe('buildAiWorkflowPrompt â€” setup prompt categorized sections', () => {
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

// â”€â”€ Concrete script naming contract â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

describe('buildAiWorkflowPrompt â€” concrete script naming contract', () => {
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

  it('delegates target entity persistence to the work packet flow', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('prefer get_developer_work_packet');
    expect(prompt).toContain('writeTarget');
  });

  it('delegates create-new-script naming rules to the work packet', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('writeTarget');
  });
});

// â”€â”€ Template-preview contract (no persisted entity) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

describe('buildAiWorkflowPrompt â€” template-preview contract (no persisted entity)', () => {
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

// ---------------------------------------------------------------------------
// Implementation prompt new AI-facing rules (work packet as source of truth)
// ---------------------------------------------------------------------------

describe('buildAiWorkflowPrompt – implementation prompt AI-facing rules', () => {
  it('contains "Use the returned developer work packet as the only source of truth"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain(
      'Use the returned developer work packet as the only source of truth',
    );
  });

  it('contains "If workPacket.canWriteCode is false, stop"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('If workPacket.canWriteCode is false, stop');
  });

  it('contains "If workPacket.canWriteCode is true, implement only files listed in workPacket.writeTarget / targetFiles"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain(
      'If workPacket.canWriteCode is true, implement only files listed in workPacket.writeTarget / targetFiles',
    );
  });

  it('contains "Known target preview only, not write authorization"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain(
      'Known target preview only, not write authorization',
    );
  });

  it('does not contain Phase: for implementation-ready task', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('Phase:');
  });

  it('does not contain Phase: for implementation-ready script task', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).not.toContain('Phase:');
  });

  it('does not contain "If technical plan is missing"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('If technical plan is missing');
  });

  it('does not contain "If work kind is missing"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('If work kind is missing');
  });

  it('does not contain "If target artifact path is missing"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('If target artifact path is missing');
  });

  it('JS/TS script implementation prompt does not contain run_dataverse_check_for_task', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyScriptTask({
      crmVerificationReports: undefined,
      implementationVerification: undefined,
    }));
    expect(prompt).not.toContain('run_dataverse_check_for_task');
  });

  it('contains "Do not guess paths, entities, fields, mappings, handlers"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain(
      'Do not guess paths, entities, fields, mappings, handlers',
    );
  });

  it('contains "Inspect only conventions and similar files recommended by the work packet"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain(
      'Inspect only conventions and similar files recommended by the work packet',
    );
  });

  it('does not contain "Confirm canWriteCode from the already-returned developer work packet"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain(
      'Confirm canWriteCode from the already-returned developer work packet',
    );
  });

  it('does not contain "Use conventionsSource and related files listed in Script target context"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain(
      'Use conventionsSource and related files listed in Script target context',
    );
  });

  it('does not contain mojibake markers', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).not.toContain('Ă˘');
    expect(prompt).not.toContain('PĹ™');
    expect(prompt).not.toContain('PĹ');
  });

  it('contains "Implement only exact field mappings returned"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Implement only exact field mappings returned');
  });

  it('contains "Do not add, infer, or substitute fields"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Do not add, infer, or substitute fields');
  });

  it('contains "Unmapped source fields are context only and must not be written"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Unmapped source fields are context only and must not be written');
  });

  it('contains "Follow AI Kit mandatory rules from workPacket.aiKit"', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Follow AI Kit mandatory rules from workPacket.aiKit');
  });

  it('contains AI Kit review guidance after implementation', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('AI Kit review');
  });

  it('does not encourage stub or placeholder handlers', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).not.toContain('create a stub');
    expect(prompt).not.toContain('create a placeholder handler');
    expect(prompt).not.toContain('add an empty');
  });
});

describe('buildAiWorkflowPrompt – existing file acceptance guardrails', () => {
  it('contains rule that existing file with TODO/scaffold is not acceptable as-is', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('TODO comments');
    expect(prompt).toContain('scaffold code');
    expect(prompt).toContain('do not accept it as complete');
  });

  it('distinguishes fixable TODO (packet has info) from blocking TODO (packet lacks info)', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    // Branch (a): packet provides enough info → fix it
    expect(prompt).toContain('fix the file by replacing every TODO with real implementation');
    // Branch (b): packet lacks info → stop and report blocker
    expect(prompt).toContain('stop immediately and report the blocker');
  });

  it('forbids leaving any TODO in output regardless of branch', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('do not leave any TODO in output');
  });

  it('prohibits continue_developer_workflow and record_local_test while TODO remains', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('Do not call continue_developer_workflow or record_local_test while any TODO');
  });

  it('prohibits accepting existing file outside fieldMappings as complete', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('fields outside workPacket.implementation.fieldMappings');
  });

  it('contains AI Kit rule for accepting existing files', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('aiKit.rulesFiles');
    expect(prompt).toContain('Before writing changes or accepting an existing target file as complete');
  });

  it('existing file guardrails appear only in implementation-ready prompt', () => {
    const setupPrompt = buildAiWorkflowPrompt(makeDevTask());
    const readyPrompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(setupPrompt).not.toContain('If the target file contains TODO');
    expect(readyPrompt).toContain('If the target file contains TODO');
  });
});

describe('buildAiWorkflowPrompt – post-implementation workflow', () => {
  it('contains post-implementation workflow section header', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Post-implementation workflow');
  });

  it('instructs AI to call continue_developer_workflow after file writes', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('continue_developer_workflow');
  });

  it('instructs AI not to stop after creating files', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('Do not stop after creating files');
  });

  it('references requiresUserApproval as the gate for branch/push actions', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('requiresUserApproval');
  });

  it('prohibits TODO or scaffold code as substitute for missing mappings', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('TODO');
    expect(prompt).toContain('scaffold');
  });

  it('post-implementation section appears only in implementation-ready prompt, not setup prompt', () => {
    const setupPrompt = buildAiWorkflowPrompt(makeDevTask());
    const readyPrompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(setupPrompt).not.toContain('Post-implementation workflow');
    expect(readyPrompt).toContain('Post-implementation workflow');
  });
});

describe('buildAiWorkflowPrompt – requiresFieldMappings stop condition and validationFields rules', () => {
  it('rule 10 references requiresFieldMappings and missingRequiredMappings in the prompt', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('requiresFieldMappings');
    expect(prompt).toContain('missingRequiredMappings');
  });

  it('rule 11 references validationFields in the prompt', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('validationFields');
  });

  it('stop condition text is present for requiresFieldMappings guard', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('stop immediately');
  });

  it('validationFields rule prohibits writing to target entity fields', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    // Rule 11 must say these fields must not be written to target entity fields
    expect(prompt).toContain('never write them to target entity fields');
  });

  it('rule references get_developer_work_packet as source of truth', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('get_developer_work_packet');
  });
});

describe('buildAiWorkflowPrompt – TODO/scaffold hard stop rules', () => {
  it('rule 13 blocks continue_developer_workflow while any TODO remains', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('Do not call continue_developer_workflow or record_local_test while any TODO');
  });

  it('post-implementation rule 5 states TODO is never acceptable in final output', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('TODO comments in final implementation output are never acceptable');
  });

  it('post-implementation rule 5 blocks continue_developer_workflow until every TODO is replaced', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('Do not call continue_developer_workflow or record_local_test until every TODO, FIXME, and placeholder comment has been replaced');
  });

  it('post-implementation rule 5 allows fixing TODO when packet provides enough information', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('If the packet provides enough information to replace a TODO, do so');
  });

  it('post-implementation rule 5 blocks when packet does not provide enough information', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('If not, report the blocker');
  });

  it('TODO/scaffold hard stop rules only appear in implementation-ready prompt', () => {
    const setupPrompt = buildAiWorkflowPrompt(makeDevTask());
    const readyPrompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(setupPrompt).not.toContain('TODO comments in final implementation output are never acceptable');
    expect(readyPrompt).toContain('TODO comments in final implementation output are never acceptable');
  });
});
