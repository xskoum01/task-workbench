import { describe, it, expect } from 'vitest';
import { buildAiWorkflowPrompt } from './aiWorkflowPrompt';
import type { Task, CrmVerificationReport } from '../types';

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
});

describe('buildAiWorkflowPrompt — setup prompt (not ready)', () => {
  it('instructs AI not to implement code before understanding context', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Do not implement code before understanding');
  });

  it('instructs AI not to perform external writes', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Do not perform external writes');
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

  it('instructs AI to re-generate prompt after resolving issues', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('re-generate this prompt');
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
