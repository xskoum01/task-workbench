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

// Fully ready developer script task → produces implementation prompt with a target preview
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
          eventName: 'OnLoad',
          eventFieldName: 'new_status',
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

  it('includes the task status', () => {
    expect(buildAiWorkflowPrompt(makeTask({ status: 'analyzed' }))).toContain('Status: analyzed');
  });

  it('includes CRM workflow step when available', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({ crmDeveloperWorkflow: { currentStep: 'technical-plan' } }));
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
    const prompt = buildAiWorkflowPrompt(makeTask({ crmDeveloperWorkflow: { detectedWorkKind: 'plugin' } }));
    expect(prompt).toContain('Work classification: plugin');
  });

  it('includes customer/environment when customerId is set', () => {
    expect(buildAiWorkflowPrompt(makeTask({ customerId: 'cust-navertica' }))).toContain('Customer/environment: cust-navertica');
  });

  it('falls back to workflowSetup.customerId when task.customerId is missing', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({ customerId: undefined, workflowSetup: { customerId: 'setup-customer' } }));
    expect(prompt).toContain('Customer/environment: setup-customer');
  });

  it('includes customer developer defaults section when customer has repositoryRoot', () => {
    const customer = { id: 'c1', name: 'VSK-Test', shortCode: 'VSK', repositoryRoot: 'C:/repos/VSK' } as Customer;
    const prompt = buildAiWorkflowPrompt(makeTask(), customer);
    expect(prompt).toContain('Customer developer defaults (VSK-Test):');
    expect(prompt).toContain('Repository root: C:/repos/VSK');
  });

  it('prefers resolvedRepositoryPath over repositoryRoot in customer defaults', () => {
    const customer = { id: 'c1', name: 'VSK-Test', shortCode: 'VSK', repositoryRoot: 'C:/repos/raw', resolvedRepositoryPath: 'C:/repos/resolved' } as Customer;
    const prompt = buildAiWorkflowPrompt(makeTask(), customer);
    expect(prompt).toContain('Repository root: C:/repos/resolved');
    expect(prompt).not.toContain('C:/repos/raw');
  });

  it('includes scriptFolder and pluginFolder in customer defaults when set', () => {
    const customer = { id: 'c1', name: 'Acme', shortCode: 'ACM', repositoryRoot: 'C:/repos/Acme', scriptFolder: 'C:/repos/Acme/scripts', pluginFolder: 'C:/repos/Acme/plugins' } as Customer;
    const prompt = buildAiWorkflowPrompt(makeTask(), customer);
    expect(prompt).toContain('Script directory: C:/repos/Acme/scripts');
    expect(prompt).toContain('Plugin project path: C:/repos/Acme/plugins');
  });

  it('omits customer defaults section when customer has no relevant fields', () => {
    const customer = { id: 'c1', name: 'Acme', shortCode: 'ACM' } as Customer;
    expect(buildAiWorkflowPrompt(makeTask(), customer)).not.toContain('Customer developer defaults');
  });

  it('omits customer defaults section when no customer is provided', () => {
    expect(buildAiWorkflowPrompt(makeTask())).not.toContain('Customer developer defaults');
  });
});

describe('buildAiWorkflowPrompt — first MCP call and work packet primacy', () => {
  it('instructs AI to call get_developer_work_packet first with the task ID', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({ id: 'task-nvr-001' }));
    expect(prompt).toContain('First MCP call: `get_developer_work_packet`');
    expect(prompt).toContain('task-nvr-001');
  });

  it('states the work packet is the source of truth', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('source of truth for whether code may be written, where to write, what to implement, conventions, verification, and review/test/commit guidance');
  });

  it('instructs AI not to reason over internal workflow state', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Do not reason over internal workflow phase/currentStep/approval state');
  });

  it('instructs AI to use the task ID for all MCP calls without asking again', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Use this task ID for all Task Workbench MCP read/write calls');
    expect(prompt).toContain('Do not ask the user for it again');
  });

  it('same first-call instruction appears in both setup and ready prompts', () => {
    const setupPrompt = buildAiWorkflowPrompt(makeTask());
    const readyPrompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(setupPrompt).toContain('First MCP call: `get_developer_work_packet`');
    expect(readyPrompt).toContain('First MCP call: `get_developer_work_packet`');
  });
});

describe('buildAiWorkflowPrompt — required MCP environment preflight', () => {
  it('includes a "Required MCP environment" section', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Required MCP environment:');
  });

  it('explicitly handles get_developer_work_packet not being available at all', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('If `get_developer_work_packet` is not available at all, stop immediately and report: "Task Workbench MCP tools are not connected to this Claude session."');
  });

  it('tells AI not to inspect files or implement anything without Task Workbench MCP tools', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Do not inspect files or implement anything without the Task Workbench MCP tools');
  });

  it('tells AI to ask the user to connect/reload the MCP server', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Ask the user to connect/reload the Task Workbench MCP server for this Claude session');
  });

  it('appears before the first MCP call instruction in both setup and ready prompts', () => {
    const setupPrompt = buildAiWorkflowPrompt(makeTask());
    const readyPrompt = buildAiWorkflowPrompt(makeReadyTask());
    for (const prompt of [setupPrompt, readyPrompt]) {
      const preflightIndex = prompt.indexOf('Required MCP environment:');
      const firstCallIndex = prompt.indexOf('First MCP call: `get_developer_work_packet`');
      expect(preflightIndex).toBeGreaterThan(-1);
      expect(preflightIndex).toBeLessThan(firstCallIndex);
    }
  });

  it('calls get_task_workbench_mcp_capabilities immediately after get_developer_work_packet succeeds, distinct from the not-connected-at-all case', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('After get_developer_work_packet succeeds, call `get_task_workbench_mcp_capabilities`');
    expect(prompt).toContain('a different condition than the MCP-connection check above');
    expect(prompt).toContain('bridgeMode="offline"');
    expect(prompt).toContain('missingRequiredTools');
    expect(prompt).toContain('canRunImplementationVerification=false');
    expect(prompt).toContain('canRecordAiKitReview=false');
  });

  it('capability preflight appears in both setup and ready prompts, right after the first MCP call', () => {
    const setupPrompt = buildAiWorkflowPrompt(makeTask());
    const readyPrompt = buildAiWorkflowPrompt(makeReadyTask());
    for (const prompt of [setupPrompt, readyPrompt]) {
      const firstCallIndex = prompt.indexOf('First MCP call: `get_developer_work_packet`');
      const capabilityIndex = prompt.indexOf('call `get_task_workbench_mcp_capabilities`');
      expect(capabilityIndex).toBeGreaterThan(firstCallIndex);
    }
  });
});

describe('buildAiWorkflowPrompt — coding style delegated to Claude Project / AI Kit', () => {
  it('points to Claude Project Instructions and Power Platform AI Kit for coding style', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('Use the Claude Project Instructions and Power Platform AI Kit rules for coding style');
  });

  it('states this prompt is a workflow contract, not a coding-standards document', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('workflow/task contract, not a coding-standards document');
  });

  it('appears in the setup prompt too', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Use the Claude Project Instructions and Power Platform AI Kit rules for coding style');
  });

  it('does not duplicate CRM JS naming-convention boilerplate (removed — moved to Claude Project)', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).not.toContain('CRM JS script naming conventions');
    expect(prompt).not.toContain('descriptive camelCase, no nvr_ prefix by default');
    expect(prompt).not.toContain('OnLoad handler:');
    expect(prompt).not.toContain('Helper functions: descriptive camelCase without namespace prefixes');
  });

  it('does not duplicate Client API / Xrm.Page coding-rule specifics (now implied by AI Kit review, not pasted)', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).not.toContain('no Xrm.Page/autosave, correct Client API usage');
  });

  it('does not include a full save-parameter dump for set_task_developer_target', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', actionType: 'create-new-script', primaryEntityLogicalName: 'nvr_servicecase' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    }));
    expect(prompt).not.toContain('Save this derived target via set_task_developer_target with:');
    expect(prompt).not.toContain('onLoadFunctionName:');
    expect(prompt).not.toContain('mainHelperSuggestion:');
  });
});

describe('buildAiWorkflowPrompt — setup prompt (not ready)', () => {
  it('instructs AI not to implement code or modify files', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Do not implement code or modify files');
  });

  it('instructs AI not to perform external writes during setup', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('do not perform external writes');
  });

  it('stops AI if MCP fails after 3 retries', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('stop immediately');
    expect(prompt).toContain('fails after 3 retries');
  });

  it('includes recommended next step', () => {
    expect(buildAiWorkflowPrompt(makeDevTask())).toContain('Recommended next step:');
  });

  it('does NOT contain implementation-only sections', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).not.toContain('If workPacket.canWriteCode is true:');
    expect(prompt).not.toContain('After every file write:');
  });

  it('separates blockers by category', () => {
    const prompt = buildAiWorkflowPrompt(makeTask());
    expect(prompt).toContain('Auto-resolvable');
  });

  it('lists mode blocker for non-developer task', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Task mode is not set to Developer.');
  });

  it('lists multiple blockers for developer plugin task missing setup', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    expect(prompt).toContain('Repository root is not set.');
    expect(prompt).toContain('Developer setup has not been confirmed.');
    expect(prompt).toContain('Technical implementation plan is missing.');
    expect(prompt).toContain('Plugin project is not selected.');
  });

  it('shows Dataverse check as read-only workflow action for plugin tasks (not hard blocker)', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    expect(prompt).toContain('Read-only workflow actions');
    expect(prompt).toContain('run_dataverse_check_for_task');
  });

  it('does not instruct JS script setup prompts to call run_dataverse_check_for_task', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask({
      workflowSetup: { devTargetKind: 'script' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      crmVerificationReports: undefined,
      implementationVerification: undefined,
    }));
    expect(prompt).toContain('Dataverse metadata verification for JS/TS runs automatically after implementation via run_implementation_verification');
    expect(prompt).not.toContain('run_dataverse_check_for_task');
  });

  it('shows technical plan as a proposal action (not hard blocker)', () => {
    const prompt = buildAiWorkflowPrompt(makeDevTask());
    expect(prompt).toContain('Proposal/draft actions');
    expect(prompt).toContain('save_technical_plan');
  });

  it('forbids low-level reads before get_developer_work_packet', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('Do not call get_task_full_context, get_implementation_readiness, or get_task_templates before get_developer_work_packet');
  });

  it('mentions approve_technical_plan_if_safe as the safe-approval path once ready', () => {
    expect(buildAiWorkflowPrompt(makeTask())).toContain('approve_technical_plan_if_safe');
  });
});

describe('buildAiWorkflowPrompt — target preview (script tasks only)', () => {
  it('includes the known-preview disclaimer for script tasks', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyScriptTask());
    expect(prompt).toContain('Known preview only; file writes require workPacket.canWriteCode === true.');
  });

  it('shows the saved target file when one is set', () => {
    expect(buildAiWorkflowPrompt(makeReadyScriptTask())).toContain('Target file: C:/repos/CrmScripts/src/scripts/account_form.js');
  });

  it('shows entity and event/field preview', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyScriptTask());
    expect(prompt).toContain('Entity: account');
    expect(prompt).toContain('Event / field: OnLoad / new_status');
  });

  it('shows a target file preview (not yet saved) for create-new-script tasks with a known naming template', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({
      taskMode: 'developer',
      title: '[TEST] Script: Předvyplnění servisního požadavku podle zařízení',
      workflowSetup: { devTargetKind: 'script', actionType: 'create-new-script', primaryEntityLogicalName: 'nvr_servicecase' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    }));
    expect(prompt).toContain('Target file preview: Scripts/nvr_servicecase_events.js (not yet saved to task setup)');
  });

  it('shows "not yet set" without guessing when entity is unknown', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', actionType: 'create-new-script' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    }));
    expect(prompt).toContain('Target file: not yet set — resolve via get_developer_work_packet, do not guess.');
  });

  it('does not include a target preview section for plugin tasks', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('Known preview only');
  });

  it('uses customer scriptFolder to build an absolute preview path', () => {
    const task = makeTask({
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', actionType: 'create-new-script', primaryEntityLogicalName: 'nvr_servicecase' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    const customer = { id: 'c1', name: 'VSK-Test', scriptFolder: 'C:\\CRM\\VSK-Test\\Scripts' } as Customer;
    const prompt = buildAiWorkflowPrompt(task, customer);
    expect(prompt).toContain('Target file preview: C:\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js (not yet saved to task setup)');
  });

  it('does not contain TBD or placeholder namespace patterns', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({
      taskMode: 'developer',
      title: '[TEST] Script: Předvyplnění servisního požadavku podle zařízení',
    }));
    expect(prompt).not.toContain('TBD');
    expect(prompt).not.toContain('NVR.ServiceCase');
    expect(prompt).not.toContain('AssetPrefill');
  });
});

describe('buildAiWorkflowPrompt — implementation prompt (ready task)', () => {
  it('does not include NOT implementation-ready warning', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).not.toContain('NOT implementation-ready');
  });

  it('includes canWriteCode=false handling with safe-approval branching', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('If workPacket.canWriteCode is false:');
    expect(prompt).toContain('approve_technical_plan_if_safe');
    expect(prompt).toContain('canApprove=true');
    expect(prompt).toContain('canApprove=false');
  });

  it('includes canWriteCode=true implementation boundaries', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('If workPacket.canWriteCode is true:');
    expect(prompt).toContain('workPacket.implementation.fieldMappings');
    expect(prompt).toContain('do not add, infer, or substitute fields');
  });

  it('states validationFields are read-only and never written to target fields', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('validationFields are read-only source context');
  });

  it('forbids TODO/scaffold code in the final file', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('No TODO/FIXME/placeholder/scaffold code in the final file');
  });

  it('forbids external writes without explicit approval', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('Do not perform external writes');
    expect(prompt).toContain('without explicit user approval');
  });

  it('stops on MCP unavailability after 3 retries', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('stop immediately');
    expect(prompt).toContain('fails after 3 retries');
  });

  it('shows warnings inline when present but does not block, pointing back to get_developer_work_packet instead of being self-contained', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask({
      crmVerificationReports: [{ verdict: 'warnings', summary: 'Some warnings.' }] as CrmVerificationReport[],
    }));
    expect(prompt).toContain('Warnings:');
    expect(prompt).toContain('Dataverse verification has warnings. Read the warning details from get_developer_work_packet before implementing.');
    expect(prompt).not.toContain('Dataverse verification completed with warnings. Review before implementing.');
  });
});

describe('buildAiWorkflowPrompt — post-file-write loop', () => {
  it('step 1: re-read and self-check against fieldMappings/validationFields/businessRules/acceptanceCriteria', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('Re-read the file');
    expect(prompt).toContain('fieldMappings, validationFields, businessRules, and acceptanceCriteria');
  });

  it('step 2: record_ai_implementation_completed', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('record_ai_implementation_completed');
    expect(prompt).toContain('Do not call record_local_test for script/ribbon tasks');
  });

  it('step 3: continue_developer_workflow', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('continue_developer_workflow');
  });

  it('includes the capability check before automated verification (checked earlier, right after the first work packet call)', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('get_task_workbench_mcp_capabilities');
    expect(prompt).toContain('canRunImplementationVerification');
    expect(prompt).toContain('canRecordAiKitReview');
  });

  it('post-write step 4 re-checks get_task_workbench_mcp_capabilities after a tooling error and does not fall back to manual/fabricated instructions', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('4. After any "tool not found" or "bridge is not running" error, call `get_task_workbench_mcp_capabilities` again if it is available.');
    expect(prompt).toContain('If it is not available at all, report that the Task Workbench MCP toolset itself is not connected');
    expect(prompt).toContain('do not fall back to old manual-modal instructions');
    expect(prompt).toContain('do not fabricate calling record_ai_kit_review_result');
  });

  it('runs run_implementation_verification when recommended', () => {
    expect(buildAiWorkflowPrompt(makeReadyTask())).toContain('nextAction=run_implementation_verification');
  });

  it('uses the canonical nextAction=run_ai_kit_review value for both continue_developer_workflow and run_implementation_verification, and also mentions status=pending_ai_kit_review', () => {
    // Canonical values (verified against mcp/task-workbench-mcp.mjs and src-tauri/src/lib.rs):
    // continue_developer_workflow and run_implementation_verification both set nextAction to
    // "run_ai_kit_review"; run_implementation_verification additionally sets status to
    // "pending_ai_kit_review". The prompt must not invent nextAction=pending_ai_kit_review.
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('If continue_developer_workflow or run_implementation_verification returns nextAction=run_ai_kit_review');
    expect(prompt).toContain('status=pending_ai_kit_review');
    expect(prompt).not.toContain('nextAction=pending_ai_kit_review');
  });

  it('AI Kit review instruction references fieldMappings, validationFields, businessRules, acceptanceCriteria, Claude Project Instructions, and AI Kit rules', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('review the target file yourself against fieldMappings, validationFields, businessRules, acceptanceCriteria, Claude Project Instructions, and Power Platform AI Kit rules');
  });

  it('handles pending_ai_kit_review via AI Kit review then record_ai_kit_review_result', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('nextAction=run_ai_kit_review');
    expect(prompt).toContain('record_ai_kit_review_result');
    expect(prompt).toContain('Label it as an AI/Claude review, not an independent human review');
  });

  it('fixable findings wording unambiguously names both possible sources (run_implementation_verification or AI Kit review)', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('If run_implementation_verification or the AI Kit review result returns fixableFindings, fix the code and repeat from step 2');
  });

  it('stops on wait_for_user / reload_mcp_or_start_app / requiresUserApproval', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('wait_for_user');
    expect(prompt).toContain('reload_mcp_or_start_app');
    expect(prompt).toContain('requiresUserApproval=true');
  });

  it('instructs stopping and asking the user when the Dataverse gate is not resolved', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('needs_configuration, not run, failed, or warnings not yet accepted');
    expect(prompt).toContain('nextAction is needs_configuration or review_dataverse_warnings');
    expect(prompt).toContain('stop and report the exact results to the user');
    expect(prompt).toContain('Ask whether to fix the code, rerun the check, configure the connection, or accept the warnings');
    expect(prompt).toContain("do not proceed past this without the user's answer");
  });

  it('requires the full detail payload when calling record_ai_kit_review_result', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('always including the full detail payload');
    expect(prompt).toContain('reviewedFiles, rulesFiles, checklistFiles, knownPrReviewFiles, checkedItems');
    expect(prompt).toContain('findings/fixableFindings/nonFixableWarnings/summary');
    expect(prompt).toContain('a bare status with empty detail arrays is recorded as incomplete, not passed');
  });

  it('requires retrying record_ai_kit_review_result when gateStatus is not passed', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain("If record_ai_kit_review_result's response reports a gateStatus other than passed");
    expect(prompt).toContain('or run_implementation_verification returns nextAction=run_ai_kit_review again');
    expect(prompt).toContain("a status:'passed' call alone is not sufficient");
  });

  it('stops only once both the Dataverse gate and the AI Kit review gate resolve via nextAction=continue_workflow', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('Stop when run_implementation_verification returns nextAction=continue_workflow');
    expect(prompt).toContain('meaning both the Dataverse gate and the AI Kit review gate are resolved');
    expect(prompt).toContain('review_dataverse_warnings');
  });

  it('reports tooling_error distinctly from a manual-review requirement', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('status=tooling_error');
    expect(prompt).toContain('this is a tooling problem, not a manual-review requirement');
  });

  it('names both run_implementation_verification and continue_developer_workflow as possible tooling_error sources, not just "it"', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).not.toContain('If it returns status=tooling_error');
    expect(prompt).toContain('If run_implementation_verification or continue_developer_workflow returns status=tooling_error or nextAction=reload_mcp_or_start_app');
    expect(prompt).toContain('Report missingRequiredTools/recommendedAction');
  });
});

describe('buildAiWorkflowPrompt — compact final output', () => {
  it('requires a compact final summary and forbids repeating the work packet/rules', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    expect(prompt).toContain('Final output: a compact summary only');
    expect(prompt).toContain('files changed, verification status, and any remaining manual step');
    expect(prompt).toContain('Do not repeat the work packet or restate these rules');
  });
});

describe('buildAiWorkflowPrompt — prompt length reduction', () => {
  it('ready-task prompt is significantly shorter than the previous long-form version (~140 lines)', () => {
    const prompt = buildAiWorkflowPrompt(makeReadyTask());
    const lineCount = prompt.split('\n').length;
    // Previous version's implementation-ready prompt ran to ~140 lines (14 implementation rules +
    // 13 post-implementation steps + full script naming contract). The new contract-style prompt
    // must be well under half that.
    expect(lineCount).toBeLessThan(70);
  });

  it('setup-prompt is short when only a couple of blockers are present', () => {
    const prompt = buildAiWorkflowPrompt(makeTask({ taskMode: 'developer' }));
    const lineCount = prompt.split('\n').length;
    expect(lineCount).toBeLessThan(60);
  });
});
