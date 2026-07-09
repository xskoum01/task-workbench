/**
 * Unit tests for task-workbench MCP bridge (v0.5.0).
 *
 * Imports named exports from the bridge script (READ_ONLY_TOOL_NAMES,
 * TOOL_DEFINITIONS, callToolFallback).  The VITEST env var prevents
 * the script's process.exit handler from firing during tests.
 */
import { describe, it, expect } from 'vitest';
import {
  READ_ONLY_TOOL_NAMES, TOOL_DEFINITIONS, TASK_TEMPLATES, matchTaskTemplate, callToolFallback, applyDeveloperWorkflowTransition,
  REQUIRED_DEVELOPER_WORKFLOW_TOOLS, FALLBACK_WRITE_ALLOWED_TOOL_NAMES, computeMcpCapabilitiesFromToolNames,
  applyToolingAvailabilityGuard,
} from './task-workbench-mcp.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findTool(name) {
  return TOOL_DEFINITIONS.find((t) => t.name === name);
}

function toolEnum(toolName, property) {
  const tool = findTool(toolName);
  return tool?.inputSchema?.properties?.[property]?.enum ?? [];
}

// Build a minimal in-memory tasks.json fixture for fallback tests.
function makeTask(overrides = {}) {
  return {
    id: 'test-task-1',
    title: 'Test Task',
    status: 'in-progress',
    source: 'manual',
    taskType: 'feature',
    taskMode: 'developer',
    confidence: 80,
    originalMessage: 'Do the thing.',
    receivedAt: '2026-06-12T10:00:00.000Z',
    suggestedActions: [],
    ...overrides,
  };
}

// callToolFallback reads tasks.json from disk; we bypass it by patching the
// loadTasks dependency.  Instead of deep-mocking, we call the pure helper
// functions that callToolFallback delegates to by constructing a tiny fake
// tasks array and calling the handler directly via a re-exported path.
//
// For tests that only need schema/set inspection we just use TOOL_DEFINITIONS
// and READ_ONLY_TOOL_NAMES directly â€” no mock needed.

// ---------------------------------------------------------------------------
// 1. READ_ONLY_TOOL_NAMES classification
// ---------------------------------------------------------------------------

describe('READ_ONLY_TOOL_NAMES', () => {
  it('contains run_dataverse_check_for_task', () => {
    expect(READ_ONLY_TOOL_NAMES.has('run_dataverse_check_for_task')).toBe(true);
  });

  it('contains get_dataverse_verification_report', () => {
    expect(READ_ONLY_TOOL_NAMES.has('get_dataverse_verification_report')).toBe(true);
  });

  it('contains get_external_action_proposal', () => {
    expect(READ_ONLY_TOOL_NAMES.has('get_external_action_proposal')).toBe(true);
  });

  it('contains get_implementation_verification_state', () => {
    expect(READ_ONLY_TOOL_NAMES.has('get_implementation_verification_state')).toBe(true);
  });

  it('contains get_developer_work_packet', () => {
    expect(READ_ONLY_TOOL_NAMES.has('get_developer_work_packet')).toBe(true);
  });

  it('does NOT contain record_external_action_completed (it is a write tool)', () => {
    expect(READ_ONLY_TOOL_NAMES.has('record_external_action_completed')).toBe(false);
  });

  it('does NOT contain approve_technical_plan_if_safe (it is a write tool)', () => {
    expect(READ_ONLY_TOOL_NAMES.has('approve_technical_plan_if_safe')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: approve_technical_plan_if_safe MCP exposure
// ---------------------------------------------------------------------------

describe('approve_technical_plan_if_safe MCP exposure', () => {
  it('is present in TOOL_DEFINITIONS (tools/list)', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'approve_technical_plan_if_safe');
    expect(tool).toBeDefined();
  });

  it('has required inputSchema with taskId', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'approve_technical_plan_if_safe');
    expect(tool?.inputSchema?.properties?.taskId).toBeDefined();
    expect(tool?.inputSchema?.required).toContain('taskId');
  });

  it('is NOT in READ_ONLY_TOOL_NAMES', () => {
    expect(READ_ONLY_TOOL_NAMES.has('approve_technical_plan_if_safe')).toBe(false);
  });

  it('calling via MCP handler (callToolFallback) succeeds for safe template-derived task', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-expose-'));
    const task = makeTask({
      id: 'task-expose-test',
      title: 'Script: Předvyplnění servisního požadavku',
      customerId: 'nvr-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repos\\NVR',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
        eventName: 'onChange',
        eventFieldName: 'nvr_assetid',
        onLoadFunctionName: 'nvr_servicecase_OnLoad',
        onChangeFunctionName: 'nvr_assetid_OnChange',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Create onChange handler for nvr_assetid on nvr_servicecase.',
          implementationSteps: ['Implement the onChange prefill handler.'],
          fieldMappings: [],
          unmappedSourceFields: [],
          risks: [],
          testChecklist: [],
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventName: 'onChange', eventFieldName: 'nvr_assetid' },
        },
        // No planApproval set — the tool must set it
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-expose-test' });
      // Must return canApprove=true (not an error, not canApprove=false)
      expect(result.canApprove).toBe(true);
      expect(result.workPacket).toBeDefined();
      expect(result.workPacket.canWriteCode).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical developer workflow transition — applyDeveloperWorkflowTransition
// ---------------------------------------------------------------------------
//
// Regression coverage for the bug where record_ai_implementation_completed and
// approve_technical_plan_if_safe wrote helper fields (mcpChecklistOverrides,
// localTestRecord, lastAiImplementation) but never updated task.status/waitingState —
// the canonical fields TaskDetail / CrmDeveloperWorkflowPanel / workflowPlan.ts read to
// render the top-level phase (NEW/ANALYZED/DEVELOPMENT/TESTING/CODE REVIEW/DONE).

describe('applyDeveloperWorkflowTransition — canonical workflow phase', () => {
  it('technical_plan_approved advances status out of new when canWriteCode=true (straight to DEVELOPMENT)', () => {
    const task = makeTask({ status: 'new', crmDeveloperWorkflow: {} });
    applyDeveloperWorkflowTransition(task, 'technical_plan_approved', { canWriteCode: true });
    expect(task.status).toBe('in-progress');
    expect(task.waitingState).toBeNull();
  });

  it('technical_plan_approved only reaches analyzed when canWriteCode=false', () => {
    const task = makeTask({ status: 'new', crmDeveloperWorkflow: {} });
    applyDeveloperWorkflowTransition(task, 'technical_plan_approved', { canWriteCode: false });
    expect(task.status).toBe('analyzed');
  });

  it('ai_implementation_completed sets status to in-progress (DEVELOPMENT) without a testing waitingState', () => {
    const task = makeTask({ status: 'analyzed', crmDeveloperWorkflow: {} });
    applyDeveloperWorkflowTransition(task, 'ai_implementation_completed', {});
    expect(task.status).toBe('in-progress');
    expect(task.waitingState).not.toBe('consultant-testing');
  });

  it('manual_crm_verification_completed moves the task into testing (consultant-testing waitingState)', () => {
    const task = makeTask({ status: 'in-progress', crmDeveloperWorkflow: {} });
    applyDeveloperWorkflowTransition(task, 'manual_crm_verification_completed', {});
    expect(task.status).toBe('in-progress');
    expect(task.waitingState).toBe('consultant-testing');
  });
});

describe('approve_technical_plan_if_safe — advances the app-visible phase (fallback mode)', () => {
  it('moves status out of new once the plan is approved and canWriteCode=true', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-phase-approve-'));
    const task = makeTask({
      id: 'task-phase-approve',
      status: 'new',
      title: 'Script: Předvyplnění servisního požadavku',
      customerId: 'nvr-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repos\\NVR',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
        eventName: 'onChange',
        eventFieldName: 'nvr_assetid',
        onLoadFunctionName: 'nvr_servicecase_OnLoad',
        onChangeFunctionName: 'nvr_assetid_OnChange',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Create onChange handler for nvr_assetid on nvr_servicecase.',
          implementationSteps: ['Implement the onChange prefill handler.'],
          fieldMappings: [],
          unmappedSourceFields: [],
          risks: [],
          testChecklist: [],
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventName: 'onChange', eventFieldName: 'nvr_assetid' },
        },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-phase-approve' });
      expect(result.canApprove).toBe(true);
      expect(result.workPacket.canWriteCode).toBe(true);

      const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const savedTask = saved.find((t) => t.id === 'task-phase-approve');
      // canWriteCode=true means code can now be written — the UI must not show NEW/Analyze.
      expect(savedTask.status).not.toBe('new');
      expect(savedTask.status).toBe('in-progress');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe('record_ai_implementation_completed — advances to DEVELOPMENT / Verify Implementation', () => {
  it('sets status to in-progress, marks implementation-done, and does not jump to testing', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-phase-impl-'));
    const task = makeTask({
      id: 'task-phase-impl',
      status: 'analyzed',
      taskMode: 'developer',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        artifactPath: 'Scripts\\nvr.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        planApproval: { approved: true, approvedAt: '2026-06-01T10:05:00.000Z' },
      },
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('record_ai_implementation_completed', {
        taskId: 'task-phase-impl',
        filesChanged: ['Scripts\\nvr.js'],
        summary: 'Implemented the onChange handler.',
      });
      expect(result.recorded).toBe(true);
      expect(result.requiresManualCrmAction).toBe(true);

      const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const savedTask = saved.find((t) => t.id === 'task-phase-impl');
      expect(savedTask.status).toBe('in-progress');
      expect(savedTask.waitingState).not.toBe('consultant-testing');
      expect(savedTask.mcpChecklistOverrides['implementation-done']).toBe('done');

      // continue_developer_workflow must not silently skip ahead to testing/done, and must not
      // jump straight to wait_for_user either — run_implementation_verification has to run first.
      const cont = await callToolFallback('continue_developer_workflow', { taskId: 'task-phase-impl' });
      expect(cont.nextAction).toBe('run_implementation_verification');
      expect(cont.recommendedTool).toBe('run_implementation_verification');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe('callToolFallback get_developer_work_packet', () => {
  it('returns a simple no-code decision when technical plan approval is pending', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-packet-blocked-'));
    // customerId and all required setup fields are present so isImplementationReady=true;
    // canWriteCode must still be false because planApproval.approved=false.
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-packet-blocked',
      title: '[TEST] Script: Predvyplneni servisniho pozadavku',
      customerId: 'cust-blocked',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        absoluteScriptPath: 'C:\\Repo\\Scripts\\nvr_servicecase_events.js',
        eventName: 'onChange',
        eventFieldName: 'nvr_assetid',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        currentStep: 'technical-plan-approval',
        technicalPlan: {
          workKind: 'script',
          summary: 'Create the service case prefill script.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventFieldName: 'nvr_assetid' },
          implementationSteps: ['Implement the onChange prefill.'],
          fieldMappings: [{ source: 'nvr_customerasset.nvr_customerid', target: 'nvr_servicecase.nvr_customerid' }],
          risks: [],
          testChecklist: ['Test asset selection.'],
        },
        planApproval: { approved: false },
      },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-packet-blocked' });
      expect(packet.canWriteCode).toBe(false);
      expect(packet.status).toBe('not_ready');
      expect(packet.decisionReason).toContain('Technical plan approval is required');
      expect(packet.blockingUserAction).toContain('approve the technical implementation plan');
      expect(packet.writeTarget.artifactPath).toBe('Scripts\\nvr_servicecase_events.js');
      expect(packet.implementation.fieldMappings).toEqual([
        { source: 'nvr_customerasset.nvr_customerid', target: 'nvr_servicecase.nvr_customerid' },
      ]);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns a ready-to-code packet with target, conventions, Dataverse warning, and validation guidance', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-packet-ready-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-packet-ready',
      title: '[TEST] Script: Predvyplneni servisniho pozadavku',
      customerId: 'cust-ready',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        absoluteScriptPath: 'C:\\Repo\\Scripts\\nvr_servicecase_events.js',
        eventName: 'onChange',
        eventFieldName: 'nvr_assetid',
        onLoadFunctionName: 'nvr_servicecase_OnLoad',
        onChangeFunctionName: 'nvr_assetid_OnChange',
        mainHelperSuggestion: 'prefillServiceCaseFromAsset',
        conventionsSource: 'Scripts\\nvr_contact_events.js',
        relatedExistingFiles: ['Scripts\\nvr_contact_events.js'],
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        currentStep: 'code-generation',
        technicalPlan: {
          workKind: 'script',
          summary: 'Create the service case prefill script.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventName: 'onChange', eventFieldName: 'nvr_assetid' },
          implementationSteps: ['Implement asset lookup prefill.', 'Keep form registration manual.'],
          fieldMappings: [
            { source: 'nvr_customerasset.nvr_customerid', target: 'nvr_servicecase.nvr_customerid' },
            { source: 'nvr_customerasset.nvr_contactid', target: 'nvr_servicecase.nvr_contactid' },
          ],
          unmappedSourceFields: ['nvr_statuscustom'],
          risks: ['Handle empty asset values.'],
          testChecklist: ['Run local lint/build if available.', 'Test onChange with empty and populated asset.'],
        },
        planApproval: { approved: true, approvedAt: '2026-06-01T10:05:00.000Z' },
      },
      implementationVerification: {
        dataverseCheck: { status: 'skipped', reason: 'JS/TS verification is in-app only.' },
      },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-packet-ready' });
      expect(packet.canWriteCode).toBe(true);
      expect(packet.status).toBe('ready_to_code');
      expect(packet.writeTarget).toMatchObject({
        kind: 'script',
        repositoryRoot: 'C:\\Repo',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        absolutePath: 'C:\\Repo\\Scripts\\nvr_servicecase_events.js',
        targetEntity: 'nvr_servicecase',
        eventName: 'onChange',
        eventFieldName: 'nvr_assetid',
        helperSuggestion: 'prefillServiceCaseFromAsset',
      });
      expect(packet.writeTarget.handlers).toEqual({ onLoad: 'nvr_servicecase_OnLoad', onChange: 'nvr_assetid_OnChange' });
      expect(packet.conventions.sources).toContain('Scripts\\nvr_contact_events.js');
      expect(packet.conventions.relatedFiles).toContain('Scripts\\nvr_contact_events.js');
      expect(packet.dataverse.verificationStatus).toBe('missing');
      expect(packet.dataverse.instruction).toContain('run_implementation_verification');
      expect(JSON.stringify(packet)).not.toContain('run_dataverse_check_for_task');
      expect(packet.reviewTestCommit.localValidation).toContain('Test onChange with empty and populated asset.');
      expect(packet.reviewTestCommit.commit.join(' ')).toContain('Commit only files related to this task');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 1b. get_developer_work_packet – derived target guard, field mappings, aiKit
// ---------------------------------------------------------------------------

describe('callToolFallback get_developer_work_packet – derived target and field mapping guards', () => {
  it('returns canWriteCode=false when target path is not persisted in task setup (derived preview only)', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-preview-'));
    // Plan approval is granted, but NO artifactPath/scriptPath saved in workflowSetup.
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-preview-only',
      taskMode: 'developer',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        confirmedAt: '2026-06-01T10:00:00.000Z',
        // NO artifactPath, NO scriptPath — target only exists as naming contract preview
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Create script.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: '', eventFieldName: 'nvr_assetid' },
          implementationSteps: [],
          fieldMappings: [],
          risks: [],
          testChecklist: [],
        },
        planApproval: { approved: true },
      },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-preview-only' });
      expect(packet.canWriteCode).toBe(false);
      expect(packet.status).toBe('not_ready');
      expect(packet.decisionReason).toContain('has not been saved to task setup');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns recommendedNextAction referencing prepare_developer_task or set_task_developer_target when target not persisted', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-preview2-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-preview-2',
      taskMode: 'developer',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        primaryEntityLogicalName: 'nvr_servicecase',
        confirmedAt: '2026-06-01T10:00:00.000Z',
        // NO artifactPath, NO actionType, NO scriptPath
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        planApproval: { approved: true },
      },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-preview-2' });
      expect(packet.canWriteCode).toBe(false);
      expect(packet.recommendedNextAction).toMatch(/prepare_developer_task|set_task_developer_target/);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns exact 3-pair field mappings (customer/contact/warranty) for NVR servicecase script', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-fields-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-fields',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        absoluteScriptPath: 'C:\\Repo\\Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Prefill service case from asset.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventFieldName: 'nvr_assetid' },
          implementationSteps: [],
          fieldMappings: [
            { source: 'nvr_customerasset.nvr_customerid', target: 'nvr_servicecase.nvr_customerid' },
            { source: 'nvr_customerasset.nvr_contactid', target: 'nvr_servicecase.nvr_contactid' },
            { source: 'nvr_customerasset.nvr_isunderwarranty', target: 'nvr_servicecase.nvr_iswarrantycase' },
          ],
          unmappedSourceFields: ['nvr_customerasset.nvr_statuscustom'],
          risks: [],
          testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-fields' });
      expect(packet.implementation.fieldMappings).toHaveLength(3);
      expect(packet.implementation.fieldMappings[0]).toEqual({ source: 'nvr_customerasset.nvr_customerid', target: 'nvr_servicecase.nvr_customerid' });
      expect(packet.implementation.fieldMappings[1]).toEqual({ source: 'nvr_customerasset.nvr_contactid', target: 'nvr_servicecase.nvr_contactid' });
      expect(packet.implementation.fieldMappings[2]).toEqual({ source: 'nvr_customerasset.nvr_isunderwarranty', target: 'nvr_servicecase.nvr_iswarrantycase' });
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('lists nvr_statuscustom only in unmappedSourceFields with a forbiddenAssumptions entry, not in fieldMappings', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-unmapped-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-unmapped',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Prefill.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js' },
          implementationSteps: [],
          fieldMappings: [{ source: 'nvr_customerasset.nvr_customerid', target: 'nvr_servicecase.nvr_customerid' }],
          unmappedSourceFields: ['nvr_customerasset.nvr_statuscustom'],
          risks: [],
          testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-unmapped' });
      const mappedSources = packet.implementation.fieldMappings.map((m) => m.source);
      expect(mappedSources).not.toContain('nvr_customerasset.nvr_statuscustom');
      expect(packet.implementation.unmappedSourceFields).toContain('nvr_customerasset.nvr_statuscustom');
      expect(packet.implementation.forbiddenAssumptions).toEqual(
        expect.arrayContaining([expect.stringContaining('nvr_statuscustom')])
      );
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('work packet includes aiKit section with mandatory rules against stub handlers', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-aikit-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-aikit',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Test.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js' },
          implementationSteps: [],
          fieldMappings: [],
          risks: [],
          testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-aikit' });
      expect(packet.aiKit).toBeDefined();
      expect(packet.aiKit.mustInspectBeforeWriting).toBe(true);
      expect(packet.aiKit.mandatoryRulesSummary).toEqual(
        expect.arrayContaining([expect.stringContaining('stub')])
      );
      expect(packet.aiKit.reviewRequiredAfterImplementation).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('reviewTestCommit.afterImplementation references record_local_test and workflow advance tool', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-review-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-review-step',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Test.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js' },
          implementationSteps: [],
          fieldMappings: [],
          risks: [],
          testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-review-step' });
      const afterImpl = packet.reviewTestCommit.afterImplementation.join(' ');
      expect(afterImpl).toContain('record_local_test');
      expect(afterImpl).toContain('continue_developer_workflow');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 1c. continue_developer_workflow – guided post-implementation steps
// ---------------------------------------------------------------------------

describe('callToolFallback continue_developer_workflow', () => {
  it('returns record_results when local test has not been recorded yet', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdw-notest-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-cdw-notest',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      // No localTestRecord
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-notest' });
      expect(result.nextAction).toBe('record_results');
      expect(result.canProceed).toBe(false);
      expect(result.recommendedTool).toBe('record_local_test');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns run_implementation_verification (not wait_for_user) before verification has run (script task)', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdw-nodv-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-cdw-nodv',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-15T10:00:00.000Z' },
      // No implementationVerification — Dataverse check not done, mcpVerification never ran
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-nodv' });
      expect(result.nextAction).toBe('run_implementation_verification');
      expect(result.canProceed).toBe(true);
      expect(result.recommendedTool).toBe('run_implementation_verification');
      expect(result.nextAction).not.toBe('mark_done');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns wait_for_user with the exact modal-check message when mcpVerification is needs_manual_action', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdw-verified-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-cdw-verified',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-15T10:00:00.000Z' },
      implementationVerification: {
        mcpVerification: { status: 'needs_manual_action', checks: [], fixableFindings: [], nextAction: 'wait_for_user', ranAt: '2026-06-15T10:10:00.000Z' },
      },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-verified' });
      expect(result.nextAction).toBe('wait_for_user');
      expect(result.requiresUserApproval).toBe(true);
      expect(result.blockingUserAction).toBe(
        'Run Dataverse Metadata Check and AI Kit/Settings Review in the Implementation Verification modal. '
        + 'Then upload/register the web resource manually and record Local Test/browser validation.',
      );
      // Blocked from reaching commit/push while verification rows are unresolved.
      expect(result.nextAction).not.toBe('propose_branch');
      expect(result.forbiddenWrites).toContain('commit_task_changes');
      expect(result.forbiddenWrites).toContain('push_task_branch');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('retries run_implementation_verification when mcpVerification is passed but Dataverse Metadata Check was never actually recorded', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdw-verified-passed-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-cdw-verified-passed',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-15T10:00:00.000Z' },
      implementationVerification: {
        mcpVerification: { status: 'passed', checks: [], fixableFindings: [], nextAction: 'continue_workflow', ranAt: '2026-06-15T10:10:00.000Z' },
      },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-verified-passed' });
      // mcpVerification.status='passed' with no crmVerificationReports/dataverseCheck override is
      // an inconsistent/synthetic state a real run_implementation_verification call would never
      // produce (a real "passed" always means Dataverse Metadata Check resolved for real). This is
      // a rare-case backstop: retry the automated check rather than pointing at the old modal-only flow.
      expect(result.nextAction).toBe('run_implementation_verification');
      expect(result.canProceed).toBe(true);
      expect(result.recommendedTool).toBe('run_implementation_verification');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns fix_code when mcpVerification failed with fixable findings', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdw-fixcode-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-cdw-fixcode',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-15T10:00:00.000Z' },
      implementationVerification: {
        mcpVerification: {
          status: 'failed',
          checks: [],
          fixableFindings: [{ id: 'no-xrm-page', description: 'Must not reference Xrm.Page.' }],
          nextAction: 'fix_code',
          ranAt: '2026-06-15T10:10:00.000Z',
        },
      },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-fixcode' });
      expect(result.nextAction).toBe('fix_code');
      expect(result.canProceed).toBe(true);
      expect(result.allowedWrites).toContain('record_ai_implementation_completed');
      expect(result.allowedWrites).toContain('run_implementation_verification');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns run_ai_kit_review (agent-runnable) for AI Kit review after Dataverse verification done', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdw-noaikit-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-cdw-noaikit',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-15T10:00:00.000Z' },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
      // No aiKitReview — AI Kit review not done
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-noaikit' });
      expect(result.nextAction).toBe('run_ai_kit_review');
      expect(result.canProceed).toBe(true);
      expect(result.requiresUserApproval).toBe(false);
      expect(result.recommendedTool).toBe('record_ai_kit_review_result');
      expect(result.instructionForAI).toContain('AI Kit review');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns propose_branch recommending create_or_checkout_task_branch when no branch is confirmed yet', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdw-branch-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-cdw-branch',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-15T10:00:00.000Z' },
      implementationVerification: {
        dataverseCheck: { status: 'skipped' },
        // Hard gate: a "passed" AI Kit review only satisfies the gate with full review details
        // (reviewedFiles/rulesFiles/checklistFiles/knownPrReviewFiles all non-empty).
        aiCodeReview: {
          status: 'passed',
          reviewedFiles: ['Scripts/nvr.js'],
          rulesFiles: ['ai-rules/crm-javascript-rules.md'],
          checklistFiles: ['ai-rules/crm-code-review-checklist.md'],
          knownPrReviewFiles: ['ai-rules/known-pr-review-comments.md'],
        },
      },
      aiKitReview: { status: 'passed', completedAt: '2026-06-15T10:05:00.000Z' },
      // No gitWorkflow.confirmedBranch yet.
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-branch' });
      expect(result.nextAction).toBe('propose_branch');
      // Branch creation must require explicit user approval
      expect(result.requiresUserApproval).toBe(true);
      expect(result.recommendedTool).toBe('create_or_checkout_task_branch');
      // Until a branch is confirmed, commit/push tools must remain forbidden.
      expect(result.forbiddenWrites).toContain('commit_task_changes');
      expect(result.forbiddenWrites).toContain('push_task_branch');
      expect(result.forbiddenWrites).toContain('commit_and_push_task_changes');
      expect(result.allowedWrites).toContain('prepare_commit_for_task');
      expect(result.allowedWrites).toContain('create_or_checkout_task_branch');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns prepare_commit when gitWorkflow.confirmedBranch is already set', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdw-branch-confirmed-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-cdw-branch-confirmed',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-15T10:00:00.000Z' },
      implementationVerification: {
        dataverseCheck: { status: 'skipped' },
        aiCodeReview: {
          status: 'passed',
          reviewedFiles: ['Scripts/nvr.js'],
          rulesFiles: ['ai-rules/crm-javascript-rules.md'],
          checklistFiles: ['ai-rules/crm-code-review-checklist.md'],
          knownPrReviewFiles: ['ai-rules/known-pr-review-comments.md'],
        },
      },
      aiKitReview: { status: 'passed', completedAt: '2026-06-15T10:05:00.000Z' },
      gitWorkflow: { confirmedBranch: 'feature/123-add-thing', confirmedAt: '2026-06-15T10:06:00.000Z' },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-branch-confirmed' });
      expect(result.nextAction).toBe('prepare_commit');
      expect(result.requiresUserApproval).toBe(true);
      expect(result.recommendedTool).toBe('prepare_commit_for_task');
      expect(result.instructionForAI).toContain('feature/123-add-thing');
      expect(result.allowedWrites).toContain('prepare_commit_for_task');
      expect(result.allowedWrites).toContain('commit_task_changes');
      // Pushing still requires a further separate approval.
      expect(result.forbiddenWrites).toContain('push_task_branch');
      expect(result.forbiddenWrites).toContain('commit_and_push_task_changes');
      expect(result.allowedWrites).not.toContain('push_task_branch');
      expect(result.allowedWrites).not.toContain('commit_and_push_task_changes');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns run_ai_kit_review (not propose_branch) when task.aiKitReview.status is passed but implementationVerification.aiCodeReview is missing/incomplete', async () => {
    // Regression coverage for the AI Kit review hard-gate fix: recording ANY verdict (including
    // "failed") always sets task.aiKitReview.completedAt, so the old gate (completedAt ||
    // status==='passed'||'skipped' on task.aiKitReview) let a failed/incomplete review through.
    // The gate must read implementationVerification.aiCodeReview instead.
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdw-aigate-regression-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-cdw-aigate-regression',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-15T10:00:00.000Z' },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
      // Old-style gate flag looks satisfied, but the canonical field was never recorded/complete.
      aiKitReview: { status: 'passed', completedAt: '2026-06-15T10:05:00.000Z' },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-aigate-regression' });
      expect(result.nextAction).toBe('run_ai_kit_review');
      expect(result.nextAction).not.toBe('propose_branch');
      expect(result.recommendedTool).toBe('record_ai_kit_review_result');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('workflow does not reach mark_done after only record_local_test', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdw-nodone-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-cdw-nodone',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-15T10:00:00.000Z' },
      // Only local test recorded — no verification, no AI Kit review
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-nodone' });
      expect(result.nextAction).not.toBe('mark_done');
      // run_implementation_verification is AI-runnable, but branch/commit/push remain forbidden.
      expect(result.nextAction).toBe('run_implementation_verification');
      expect(result.forbiddenWrites).toContain('commit_task_changes');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns review_dataverse_warnings and blocks commit/push when mcpVerification is warnings_unaccepted', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdw-warnings-unaccepted-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-cdw-warnings-unaccepted',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-15T10:00:00.000Z' },
      implementationVerification: {
        mcpVerification: { status: 'warnings_unaccepted', checks: [], fixableFindings: [], nextAction: 'review_dataverse_warnings', ranAt: '2026-06-15T10:10:00.000Z' },
      },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-warnings-unaccepted' });
      expect(result.nextAction).toBe('review_dataverse_warnings');
      expect(result.canProceed).toBe(false);
      expect(result.requiresUserApproval).toBe(true);
      expect(result.recommendedTool).toBeNull();
      expect(result.allowedWrites).toEqual([]);
      expect(result.forbiddenWrites).toContain('commit_task_changes');
      expect(result.forbiddenWrites).toContain('push_task_branch');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('routes a plugin task through run_implementation_verification, not the old run_dataverse_check_for_task branch', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdw-plugin-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-cdw-plugin',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'plugin', repositoryRoot: 'C:\\Repo', pluginProject: 'Foo.Plugins', artifactPath: 'C:\\Repo\\Plugins\\Foo.Plugins\\Foo.cs' },
      crmDeveloperWorkflow: { detectedWorkKind: 'plugin' },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-15T10:00:00.000Z' },
      // No implementationVerification — Dataverse check not done, mcpVerification never ran.
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-plugin' });
      // Plugins now go through the same mcpVerification-based branch as script/ribbon tasks.
      expect(result.nextAction).toBe('run_implementation_verification');
      expect(result.nextAction).not.toBe('verify_dataverse');
      expect(result.recommendedTool).toBe('run_implementation_verification');
      expect(result.recommendedTool).not.toBe('run_dataverse_check_for_task');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 1d. get_developer_work_packet – fieldMappings guard (empty = canWriteCode=false)
// ---------------------------------------------------------------------------

describe('callToolFallback get_developer_work_packet – fieldMappings guard', () => {
  it('auto-populates fieldMappings from template when plan has none, enabling canWriteCode=true', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-fmguard-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-fmguard',
      taskMode: 'developer',
      title: '[TEST] Script: Předvyplnění servisního požadavku podle zařízení',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Create script.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventFieldName: 'nvr_assetid' },
          implementationSteps: ['Implement the handler.'],
          fieldMappings: [],  // Empty — template should auto-populate
          risks: [],
          testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-fmguard' });
      // Template auto-populates fieldMappings → canWriteCode=true
      expect(packet.canWriteCode).toBe(true);
      expect(packet.implementation.fieldMappingsSource).toBe('template');
      expect(packet.implementation.fieldMappings.length).toBe(3);
      // Source entity must be nvr_customerasset, not nvr_asset or nvr_assetid
      for (const m of packet.implementation.fieldMappings) {
        expect(m.source).toMatch(/^nvr_customerasset\./);
        expect(m.source).not.toMatch(/^nvr_asset\./);
        expect(m.source).not.toMatch(/^nvr_assetid/);
      }
      // nvr_statuscustom must be in validationFields, not in fieldMappings
      const mappingSources = packet.implementation.fieldMappings.map((m) => m.source);
      const mappingTargets = packet.implementation.fieldMappings.map((m) => m.target);
      expect(mappingSources.join(',')).not.toContain('nvr_statuscustom');
      expect(mappingTargets.join(',')).not.toContain('nvr_statuscustom');
      const vfStrs = (packet.implementation.validationFields || []).map((v) => String(v));
      expect(vfStrs.some((s) => s.includes('nvr_statuscustom'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns canWriteCode=false when non-template task has unmappedSourceFields but empty fieldMappings', async () => {
    // Guard 1 still fires when plan signals incomplete mappings and template cannot auto-populate
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-fmguard3-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-fmguard3',
      taskMode: 'developer',
      title: 'Script: custom work without template',  // No template match
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Create script.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js' },
          implementationSteps: ['Implement the handler.'],
          fieldMappings: [],
          unmappedSourceFields: ['nvr_statuscustom'],  // Plan signals mappings needed
          risks: [],
          testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-fmguard3' });
      // No template → no auto-population → Guard 1 fires
      expect(packet.canWriteCode).toBe(false);
      expect(packet.implementation.requiresFieldMappings).toBe(true);
      expect(packet.implementation.fieldMappings.length).toBe(0);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('does not block canWriteCode for tasks without template-defined source fields (no field mapping required)', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-fmguard2-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-fmguard2',
      taskMode: 'developer',
      title: 'Custom script without template',  // No template match
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'account',
        artifactPath: 'Scripts\\account_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Create script.',
          target: { entityLogicalName: 'account', scriptPath: 'Scripts\\account_events.js', eventName: 'OnLoad' },
          implementationSteps: [],
          fieldMappings: [],  // Empty but no template requires them
          risks: [],
          testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-fmguard2' });
      // No template → no fieldMappings requirement → canWriteCode should not be blocked by empty mappings
      expect(packet.canWriteCode).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. set_task_work_classification â€” workKind enum
// ---------------------------------------------------------------------------

describe('set_task_work_classification schema', () => {
  const REQUIRED_KINDS = ['plugin', 'script', 'ribbon', 'repo-only', 'bugfix', 'review', 'general', 'unknown'];

  it('tool definition exists', () => {
    expect(findTool('set_task_work_classification')).toBeDefined();
  });

  for (const kind of REQUIRED_KINDS) {
    it(`workKind enum includes '${kind}'`, () => {
      expect(toolEnum('set_task_work_classification', 'workKind')).toContain(kind);
    });
  }

  it('workAction enum is unchanged', () => {
    const allowed = toolEnum('set_task_work_classification', 'workAction');
    expect(allowed).toContain('create');
    expect(allowed).toContain('update');
    expect(allowed).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// 3. save_technical_plan â€” pluginTarget / scriptTarget schema
// ---------------------------------------------------------------------------

describe('save_technical_plan schema', () => {
  it('tool definition exists', () => {
    expect(findTool('save_technical_plan')).toBeDefined();
  });

  it('has pluginTarget property', () => {
    const tool = findTool('save_technical_plan');
    expect(tool.inputSchema.properties.pluginTarget).toBeDefined();
  });

  it('pluginTarget has entityLogicalName', () => {
    const pt = findTool('save_technical_plan').inputSchema.properties.pluginTarget;
    expect(pt.properties.entityLogicalName).toBeDefined();
  });

  it('pluginTarget has stage enum with expected values', () => {
    const pt = findTool('save_technical_plan').inputSchema.properties.pluginTarget;
    const stages = pt.properties.stage.enum;
    expect(stages).toContain('PreValidation');
    expect(stages).toContain('PreOperation');
    expect(stages).toContain('PostOperation');
  });

  it('pluginTarget has mode enum with Sync and Async', () => {
    const pt = findTool('save_technical_plan').inputSchema.properties.pluginTarget;
    const modes = pt.properties.mode.enum;
    expect(modes).toContain('Sync');
    expect(modes).toContain('Async');
  });

  it('pluginTarget has filteringAttributes, preImageName, preImageAttributes, postImageName, postImageAttributes', () => {
    const pt = findTool('save_technical_plan').inputSchema.properties.pluginTarget;
    expect(pt.properties.filteringAttributes).toBeDefined();
    expect(pt.properties.preImageName).toBeDefined();
    expect(pt.properties.preImageAttributes).toBeDefined();
    expect(pt.properties.postImageName).toBeDefined();
    expect(pt.properties.postImageAttributes).toBeDefined();
  });

  it('has scriptTarget property', () => {
    const tool = findTool('save_technical_plan');
    expect(tool.inputSchema.properties.scriptTarget).toBeDefined();
  });

  it('scriptTarget has entityLogicalName, scriptPath, webResourceName, formName, eventName, functionName', () => {
    const st = findTool('save_technical_plan').inputSchema.properties.scriptTarget;
    expect(st.properties.entityLogicalName).toBeDefined();
    expect(st.properties.scriptPath).toBeDefined();
    expect(st.properties.webResourceName).toBeDefined();
    expect(st.properties.formName).toBeDefined();
    expect(st.properties.eventName).toBeDefined();
    expect(st.properties.functionName).toBeDefined();
  });

  it('planSummary and taskId are still required', () => {
    const tool = findTool('save_technical_plan');
    expect(tool.inputSchema.required).toContain('taskId');
    expect(tool.inputSchema.required).toContain('planSummary');
  });
});

// ---------------------------------------------------------------------------
// 4. New tool definitions exist
// ---------------------------------------------------------------------------

describe('new tool definitions (v0.5.0)', () => {
  const NEW_TOOLS = [
    'get_dataverse_verification_report',
    'get_external_action_proposal',
    'record_external_action_completed',
    'get_implementation_verification_state',
  ];

  for (const name of NEW_TOOLS) {
    it(`TOOL_DEFINITIONS includes '${name}'`, () => {
      expect(findTool(name)).toBeDefined();
    });
  }

  it('get_dataverse_verification_report requires id', () => {
    const tool = findTool('get_dataverse_verification_report');
    expect(tool.inputSchema.required).toContain('id');
  });

  it('get_external_action_proposal requires id', () => {
    const tool = findTool('get_external_action_proposal');
    expect(tool.inputSchema.required).toContain('id');
  });

  it('get_implementation_verification_state requires id', () => {
    const tool = findTool('get_implementation_verification_state');
    expect(tool.inputSchema.required).toContain('id');
  });

  it('record_external_action_completed requires taskId and actionType', () => {
    const tool = findTool('record_external_action_completed');
    expect(tool.inputSchema.required).toContain('taskId');
    expect(tool.inputSchema.required).toContain('actionType');
  });

  it('record_external_action_completed actionType enum has all expected values', () => {
    const types = toolEnum('record_external_action_completed', 'actionType');
    expect(types).toContain('plugin-registration');
    expect(types).toContain('web-resource-upload');
    expect(types).toContain('publish-customizations');
    expect(types).toContain('pull-request');
    expect(types).toContain('manual-check');
  });
});

// ---------------------------------------------------------------------------
// Regression: create_branch_for_task / create_or_checkout_task_branch MCP exposure.
// Both are Git-mutation tools that are proxied straight to the live Rust bridge (no JS
// fallback implementation) — but they still must be declared in TOOL_DEFINITIONS so a client
// connected only to the JS side can see them via tools/list. create_branch_for_task was
// previously missing from this list entirely.
// ---------------------------------------------------------------------------

describe('create_branch_for_task / create_or_checkout_task_branch MCP exposure', () => {
  it('TOOL_DEFINITIONS includes create_branch_for_task', () => {
    expect(findTool('create_branch_for_task')).toBeDefined();
  });

  it('TOOL_DEFINITIONS includes create_or_checkout_task_branch', () => {
    expect(findTool('create_or_checkout_task_branch')).toBeDefined();
  });

  it('create_branch_for_task requires taskId and branchName', () => {
    const tool = findTool('create_branch_for_task');
    expect(tool.inputSchema.required).toContain('taskId');
    expect(tool.inputSchema.required).toContain('branchName');
  });

  it('create_or_checkout_task_branch requires taskId and branchName', () => {
    const tool = findTool('create_or_checkout_task_branch');
    expect(tool.inputSchema.required).toContain('taskId');
    expect(tool.inputSchema.required).toContain('branchName');
  });

  it('neither tool is in READ_ONLY_TOOL_NAMES (both are Git-mutation writes)', () => {
    expect(READ_ONLY_TOOL_NAMES.has('create_branch_for_task')).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has('create_or_checkout_task_branch')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. callToolFallback â€” new read tools (with synthetic task data)
// ---------------------------------------------------------------------------

// callToolFallback internally calls loadTasks() which reads from the
// filesystem.  We can't mock that without module-level patching.
//
// Instead we test the outcome via a tasks fixture written to a temp file
// and passed via the --data-dir mechanism.  However, since this is a unit
// test and not an integration test, we focus on testing the pure-function
// branches by constructing a task object and calling the underlying helpers
// that callToolFallback delegates to.  The simpler approach below tests
// fallback behaviour end-to-end by passing a synthetic tasks array directly
// to the internal implementation.
//
// callToolFallback is designed to read from loadTasks(), so we test by
// creating a real temp tasks.json file and using --data-dir.
// Instead, for now, we verify the *shape* of results using the fallback
// with a real (but empty) data dir, and focus on schema tests for the new
// tools.

describe('callToolFallback â€” get_dataverse_verification_report', () => {
  it('returns hasReport:false with a message when no report stored', async () => {
    // Provide a synthetic tasks array by writing a temp file
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-test-'));
    const task = makeTask({
      id: 'task-dvr-1',
      crmVerificationReports: [],
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    // Temporarily override argv to inject --data-dir
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_dataverse_verification_report', { id: 'task-dvr-1' });
      expect(result.hasReport).toBe(false);
      expect(result.report).toBeNull();
      expect(typeof result.message).toBe('string');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns hasReport:true with report fields when a report is stored', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-test-'));
    const task = makeTask({
      id: 'task-dvr-2',
      crmVerificationReports: [{
        id: 'rpt-1',
        createdAt: '2026-06-12T10:00:00.000Z',
        verdict: 'pass',
        summary: 'All references confirmed.',
        inspectedEntities: ['account'],
        confirmedReferences: [{ kind: 'entity', displayName: 'account' }],
        missingReferences: [],
        ambiguousReferences: [],
      }],
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_dataverse_verification_report', { id: 'task-dvr-2' });
      expect(result.hasReport).toBe(true);
      expect(result.report).not.toBeNull();
      expect(result.report.verdict).toBe('pass');
      expect(result.report.inspectedEntities).toContain('account');
      expect(result.report.confirmedCount).toBe(1);
      expect(result.report.missingCount).toBe(0);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe('callToolFallback â€” get_external_action_proposal', () => {
  it('returns hasProposal:false when no workflow state', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-test-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({ id: 'task-eap-1' })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_external_action_proposal', { id: 'task-eap-1' });
      expect(result.hasProposal).toBe(false);
      expect(typeof result.message).toBe('string');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns hasProposal:true with preview when externalActionPreview is set', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-test-'));
    const task = makeTask({
      id: 'task-eap-2',
      crmDeveloperWorkflow: {
        detectedWorkKind: 'plugin',
        technicalPlan: {
          generatedAt: '2026-06-12T10:00:00.000Z',
          workKind: 'plugin',
          summary: 'Plan summary.',
          implementationSteps: [],
          dataverseFindings: [],
          risks: [],
          testChecklist: [],
          externalActionPreview: ['Register plugin step for account Create PreOperation'],
        },
        externalActionApproval: { approved: true, approvedAt: '2026-06-12T11:00:00.000Z' },
      },
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_external_action_proposal', { id: 'task-eap-2' });
      expect(result.hasProposal).toBe(true);
      expect(result.externalActionPreview).toHaveLength(1);
      expect(result.approval.approved).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe('callToolFallback â€” get_implementation_verification_state', () => {
  it('returns all null fields when implementationVerification is absent', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-test-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({ id: 'task-ivs-1' })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_implementation_verification_state', { id: 'task-ivs-1' });
      expect(result.taskId).toBe('task-ivs-1');
      expect(result.buildCheck).toBeNull();
      expect(result.dataverseCheck).toBeNull();
      expect(result.aiCodeReview).toBeNull();
      expect(result.localTest).toBeNull();
      expect(result.localTestRecord).toBeNull();
      expect(result.consultantTestRecord).toBeNull();
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns populated fields when implementationVerification is present', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-test-'));
    const task = makeTask({
      id: 'task-ivs-2',
      implementationVerification: {
        buildCheck: { status: 'passed', runAt: '2026-06-12T10:00:00.000Z', summary: 'Build OK' },
        aiCodeReview: { status: 'warnings', summary: 'One minor issue' },
        localTest: { status: 'passed', recordedAt: '2026-06-12T11:00:00.000Z' },
        updatedAt: '2026-06-12T11:00:00.000Z',
      },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-12T11:00:00.000Z' },
      consultantTestRecord: { status: 'confirmed', updatedAt: '2026-06-12T12:00:00.000Z' },
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_implementation_verification_state', { id: 'task-ivs-2' });
      expect(result.buildCheck).not.toBeNull();
      expect(result.buildCheck.status).toBe('passed');
      expect(result.aiCodeReview.status).toBe('warnings');
      expect(result.localTest.status).toBe('passed');
      expect(result.localTestRecord.status).toBe('passed');
      expect(result.consultantTestRecord.status).toBe('confirmed');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. save_technical_plan fallback â€” persists pluginTarget / scriptTarget
//    (schema validation only; actual persistence is in the bridge/Rust)
// ---------------------------------------------------------------------------
describe('save_technical_plan â€” target field presence in schema', () => {
  it('accepts pluginTarget without additionalProperties errors (schema is open to these keys)', () => {
    const schema = findTool('save_technical_plan').inputSchema;
    // Verify the object property names match what we pass in real calls
    const ptKeys = Object.keys(schema.properties.pluginTarget.properties);
    expect(ptKeys).toContain('entityLogicalName');
    expect(ptKeys).toContain('message');
    expect(ptKeys).toContain('stage');
    expect(ptKeys).toContain('mode');
    expect(ptKeys).toContain('pluginProject');
    expect(ptKeys).toContain('filteringAttributes');
    expect(ptKeys).toContain('preImageName');
    expect(ptKeys).toContain('preImageAttributes');
    expect(ptKeys).toContain('postImageName');
    expect(ptKeys).toContain('postImageAttributes');
  });

  it('accepts scriptTarget without additionalProperties errors', () => {
    const schema = findTool('save_technical_plan').inputSchema;
    const stKeys = Object.keys(schema.properties.scriptTarget.properties);
    expect(stKeys).toContain('entityLogicalName');
    expect(stKeys).toContain('scriptPath');
    expect(stKeys).toContain('webResourceName');
    expect(stKeys).toContain('formName');
    expect(stKeys).toContain('eventName');
    expect(stKeys).toContain('functionName');
  });
});

// ---------------------------------------------------------------------------
// 7. set_task_developer_target â€” schema completeness for script target fields
// ---------------------------------------------------------------------------

describe('set_task_developer_target schema', () => {
  it('tool definition exists', () => {
    expect(findTool('set_task_developer_target')).toBeDefined();
  });

  it('requires taskId', () => {
    expect(findTool('set_task_developer_target').inputSchema.required).toContain('taskId');
  });

  it('has selectedScriptTarget (target directory) property', () => {
    const tool = findTool('set_task_developer_target');
    expect(tool.inputSchema.properties.selectedScriptTarget).toBeDefined();
  });

  it('selectedScriptTarget description mentions target directory', () => {
    const desc = findTool('set_task_developer_target').inputSchema.properties.selectedScriptTarget.description;
    expect(desc).toMatch(/directory|folder/i);
  });

  it('has desiredScriptFile property', () => {
    expect(findTool('set_task_developer_target').inputSchema.properties.desiredScriptFile).toBeDefined();
  });

  it('desiredScriptFile description references naming convention example', () => {
    const desc = findTool('set_task_developer_target').inputSchema.properties.desiredScriptFile.description;
    expect(desc).toContain('nvr_servicecase_events.js');
  });

  it('has primaryEntityLogicalName property', () => {
    expect(findTool('set_task_developer_target').inputSchema.properties.primaryEntityLogicalName).toBeDefined();
  });

  it('has actionType property with create-new-script enum value', () => {
    const actionTypeEnum = toolEnum('set_task_developer_target', 'actionType');
    expect(actionTypeEnum).toContain('create-new-script');
    expect(actionTypeEnum).toContain('update-existing-script');
    expect(actionTypeEnum).toContain('create-new-plugin');
    expect(actionTypeEnum).toContain('update-existing-plugin');
  });

  it('has eventName property', () => {
    expect(findTool('set_task_developer_target').inputSchema.properties.eventName).toBeDefined();
  });

  it('has eventFieldName property', () => {
    expect(findTool('set_task_developer_target').inputSchema.properties.eventFieldName).toBeDefined();
  });

  it('eventFieldName description mentions onChange events', () => {
    const desc = findTool('set_task_developer_target').inputSchema.properties.eventFieldName.description;
    expect(desc).toMatch(/onChange|change/i);
  });

  it('has repositoryRoot property', () => {
    expect(findTool('set_task_developer_target').inputSchema.properties.repositoryRoot).toBeDefined();
  });

  it('all required script target fields exist for NVR servicecase scenario', () => {
    const props = findTool('set_task_developer_target').inputSchema.properties;
    // For a complete create-new-script call: selectedScriptTarget (dir), desiredScriptFile (name),
    // primaryEntityLogicalName, actionType, eventName, eventFieldName, repositoryRoot
    for (const field of ['selectedScriptTarget', 'desiredScriptFile', 'primaryEntityLogicalName', 'actionType', 'eventName', 'eventFieldName', 'repositoryRoot']) {
      expect(props[field], `field '${field}' should be in schema`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. TASK_TEMPLATES â€” NVR servicecase script template
// ---------------------------------------------------------------------------

describe('TASK_TEMPLATES â€” NVR servicecase script template', () => {
  it('has template for NVR Training Service Hub script task', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl).toBeDefined();
  });

  it('NVR servicecase template has correct entity, event, and eventFieldName', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl.scriptTarget.entityLogicalName).toBe('nvr_servicecase');
    expect(tpl.scriptTarget.eventName).toBe('onChange');
    expect(tpl.scriptTarget.eventFieldName).toBe('nvr_assetid');
  });

  it('matchTaskTemplate matches NVR servicecase title', () => {
    const matched = matchTaskTemplate('Script: Předvyplnění servisního požadavku');
    expect(matched).not.toBeNull();
    expect(matched.id).toBe('nvr-training-sh-script-prefill');
  });

  it('matchTaskTemplate returns null for unrelated title', () => {
    expect(matchTaskTemplate('Plugin: Calculate something')).toBeNull();
  });

  it('NVR servicecase template specifies create-new-script action type', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl.actionType).toBe('create-new-script');
  });

  it('callToolFallback get_task_templates returns matchedTemplate for NVR task title', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-tpl-'));
    const task = makeTask({
      id: 'task-tpl-nvr',
      title: 'Script: Předvyplnění servisního požadavku',
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_task_templates', { taskId: 'task-tpl-nvr' });
      expect(result.matchedTemplate).toBeDefined();
      expect(result.matchedTemplate.id).toBe('nvr-training-sh-script-prefill');
      expect(result.matchedTemplate.scriptTarget.entityLogicalName).toBe('nvr_servicecase');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 9. TASK_TEMPLATES â€” NVR servicecase scriptNaming enrichment
// ---------------------------------------------------------------------------

describe('TASK_TEMPLATES â€” NVR servicecase scriptNaming block', () => {
  it('template has scriptNaming block', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl.scriptNaming).toBeDefined();
  });

  it('scriptNaming.namingSource is Scripts_Naming', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl.scriptNaming.namingSource).toBe('Scripts_Naming');
  });

  it('scriptNaming.desiredScriptFile is nvr_servicecase_events.js', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl.scriptNaming.desiredScriptFile).toBe('nvr_servicecase_events.js');
  });

  it('scriptNaming.onLoadFunctionName is nvr_servicecase_OnLoad', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl.scriptNaming.onLoadFunctionName).toBe('nvr_servicecase_OnLoad');
  });

  it('scriptNaming.onChangeFunctionName is nvr_assetid_OnChange', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl.scriptNaming.onChangeFunctionName).toBe('nvr_assetid_OnChange');
  });

  it('scriptNaming.mainHelperSuggestion is prefillServiceCaseFromAsset', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl.scriptNaming.mainHelperSuggestion).toBe('prefillServiceCaseFromAsset');
  });

  it('template has sourceEntity nvr_customerasset', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl.sourceEntity).toBe('nvr_customerasset');
  });

  it('template sourceFields contains nvr_customerid', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl.sourceFields).toContain('nvr_customerid');
  });

  it('template keeps nvr_statuscustom as additional source context, not a mapped source field', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl.sourceFields).not.toContain('nvr_statuscustom');
    expect(tpl.additionalSourceFields).toContain('nvr_statuscustom');
  });

  it('template targetFields contains nvr_iswarrantycase', () => {
    const tpl = TASK_TEMPLATES.find((t) => t.id === 'nvr-training-sh-script-prefill');
    expect(tpl.targetFields).toContain('nvr_iswarrantycase');
  });
});

// ---------------------------------------------------------------------------
// 10. set_task_developer_target schema â€” new naming fields
// ---------------------------------------------------------------------------

describe('set_task_developer_target schema â€” naming fields', () => {
  it('schema accepts namingSource', () => {
    expect(findTool('set_task_developer_target').inputSchema.properties.namingSource).toBeDefined();
  });

  it('schema accepts onLoadFunctionName', () => {
    expect(findTool('set_task_developer_target').inputSchema.properties.onLoadFunctionName).toBeDefined();
  });

  it('schema accepts onChangeFunctionName', () => {
    expect(findTool('set_task_developer_target').inputSchema.properties.onChangeFunctionName).toBeDefined();
  });

  it('schema accepts mainHelperSuggestion', () => {
    expect(findTool('set_task_developer_target').inputSchema.properties.mainHelperSuggestion).toBeDefined();
  });

  it('mainHelperSuggestion description mentions camelCase', () => {
    const desc = findTool('set_task_developer_target').inputSchema.properties.mainHelperSuggestion.description;
    expect(desc).toMatch(/camelCase/i);
  });

  it('schema accepts absoluteScriptPath', () => {
    expect(findTool('set_task_developer_target').inputSchema.properties.absoluteScriptPath).toBeDefined();
  });

  it('absoluteScriptPath description mentions repositoryRoot', () => {
    const desc = findTool('set_task_developer_target').inputSchema.properties.absoluteScriptPath.description;
    expect(desc).toMatch(/repositoryRoot/i);
  });

  it('schema accepts artifactPath', () => {
    expect(findTool('set_task_developer_target').inputSchema.properties.artifactPath).toBeDefined();
  });

  it('artifactPath description mentions folder and file', () => {
    const desc = findTool('set_task_developer_target').inputSchema.properties.artifactPath.description;
    expect(desc).toMatch(/folder|selectedScriptTarget|desiredScriptFile/i);
  });
});

// ---------------------------------------------------------------------------
// 11. prepare_developer_task orchestration
// ---------------------------------------------------------------------------

describe('prepare_developer_task schema', () => {
  it('tool definition exists and requires taskId', () => {
    const tool = findTool('prepare_developer_task');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toContain('taskId');
  });

  it('supports setup-until-approval-gate mode only', () => {
    const modeEnum = toolEnum('prepare_developer_task', 'mode');
    expect(modeEnum).toEqual(['setup-until-approval-gate']);
  });
});

describe('get_developer_work_packet schema', () => {
  it('tool definition exists and requires taskId', () => {
    const tool = findTool('get_developer_work_packet');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toContain('taskId');
  });
});

describe('callToolFallback prepare_developer_task', () => {
  it('applies template/defaults, saves target and plan, then stops at technical plan approval', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-prepare-'));
    const task = makeTask({
      id: 'task-prepare-nvr',
      title: TASK_TEMPLATES[0].titlePattern,
      status: 'new',
      taskMode: 'general',
      customerId: 'cust-prepare',
      workflowSetup: {},
      crmDeveloperWorkflow: undefined,
      analysisResult: undefined,
    });
    const customer = {
      id: 'cust-prepare',
      repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
      scriptFolder: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts',
    };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    await fs.writeFile(path.join(tmpDir, 'customers.json'), JSON.stringify([customer]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('prepare_developer_task', { taskId: 'task-prepare-nvr' });
      expect(result.status).toBe('stopped_at_approval_gate');
      expect(result.appliedActions).toContain('applied_template');
      expect(result.appliedActions).toContain('applied_customer_defaults');
      expect(result.appliedActions).toContain('saved_developer_target');
      expect(result.appliedActions).toContain('saved_technical_plan');
      expect(result.appliedActions).toContain('marked_technical_plan_ready');
      expect(result.appliedActions).toContain('confirmed_setup');
      expect(result.approvalGates[0].type).toBe('technical-plan-approval');
      expect(result.hardBlockers).toEqual([]);
      expect(result.skippedActions.some((item) => item.action === 'run_dataverse_check_for_task')).toBe(true);
      expect(result.warnings).toContain('Dataverse metadata verification for JS/TS runs automatically after implementation via run_implementation_verification (Primarch, when configured) — not before.');
      expect(result.implementationReadiness.blockers).not.toContain('Dataverse metadata verification has not been completed or explicitly skipped.');
      expect(result.task.workflowSetup.primaryEntityLogicalName).toBe('nvr_servicecase');
      expect(result.task.workflowSetup.artifactPath).toBe('Scripts\\nvr_servicecase_events.js');
      expect(result.task.crmWorkflowState.technicalPlan.summary).toContain('Dataverse form script');
      expect(JSON.stringify(result.task.crmWorkflowState.technicalPlan)).not.toContain('(mapped, exact target TBD)');
      expect(result.task.crmWorkflowState.technicalPlan.fieldMappings).toEqual([
        { source: 'nvr_customerasset.nvr_customerid', target: 'nvr_servicecase.nvr_customerid' },
        { source: 'nvr_customerasset.nvr_contactid', target: 'nvr_servicecase.nvr_contactid' },
        { source: 'nvr_customerasset.nvr_isunderwarranty', target: 'nvr_servicecase.nvr_iswarrantycase' },
      ]);
      expect(result.task.crmWorkflowState.technicalPlan.unmappedSourceFields).toEqual(['nvr_statuscustom']);

      const stored = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'))[0];
      expect(stored.workflowSetup.absoluteScriptPath).toBe('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
      expect(stored.crmDeveloperWorkflow.currentStep).toBe('technical-plan');
      expect(stored.notes).toContain('prepare_developer_task');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('blocks before plan/confirm when repository root is missing', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-prepare-block-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-prepare-blocked',
      title: TASK_TEMPLATES[0].titlePattern,
      taskMode: 'general',
      workflowSetup: {},
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('prepare_developer_task', { taskId: 'task-prepare-blocked' });
      expect(result.status).toBe('blocked');
      expect(result.missingInputs).toContain('repositoryRoot');
      expect(result.appliedActions).toContain('applied_template');
      expect(result.appliedActions).not.toContain('saved_technical_plan');
      expect(result.appliedActions).not.toContain('confirmed_setup');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('does not zip sourceFields beyond available targetFields and reports unmapped fields separately', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const template = {
      id: 'test-uneven-field-map',
      name: 'Uneven field map',
      titlePattern: '[TEST] Uneven Field Map',
      mode: 'developer',
      workKind: 'script',
      actionType: 'create-new-script',
      targetEntity: 'target_table',
      scriptTarget: { entityLogicalName: 'target_table', eventName: 'onChange', eventFieldName: 'target_lookup' },
      scriptNaming: { namingSource: 'Scripts_Naming', scriptsFolderRelative: 'Scripts', desiredScriptFile: 'target_table_events.js' },
      sourceEntity: 'source_table',
      sourceFields: ['source_a', 'source_b', 'source_unmapped'],
      targetFields: ['target_a', 'target_b'],
    };
    TASK_TEMPLATES.push(template);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-uneven-map-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-uneven-map',
      title: '[TEST] Uneven Field Map',
      taskMode: 'general',
      customerId: 'cust-uneven',
      workflowSetup: {},
    })]));
    await fs.writeFile(path.join(tmpDir, 'customers.json'), JSON.stringify([{
      id: 'cust-uneven',
      repositoryRoot: 'C:\\Repo',
      scriptFolder: 'C:\\Repo\\Scripts',
    }]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('prepare_developer_task', { taskId: 'task-uneven-map' });
      const plan = result.task.crmWorkflowState.technicalPlan;
      const rawPlan = JSON.stringify(plan);
      expect(rawPlan).not.toContain('(mapped, exact target TBD)');
      expect(rawPlan).not.toContain('source_unmapped ->');
      expect(plan.fieldMappings).toEqual([
        { source: 'source_table.source_a', target: 'target_table.target_a' },
        { source: 'source_table.source_b', target: 'target_table.target_b' },
      ]);
      expect(plan.unmappedSourceFields).toEqual(['source_unmapped']);
      expect(plan.dataverseFindings).toContain('Additional source field available from template: source_unmapped. No target mapping is defined.');
    } finally {
      process.argv = origArgv;
      TASK_TEMPLATES.pop();
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 11b. prepare_developer_task â€” inference for explicit-but-untemplated script tasks
// (NVR Training Automation Lab: high-priority servicecase description gate)
// ---------------------------------------------------------------------------

describe('callToolFallback prepare_developer_task â€” explicit-assignment inference', () => {
  const LAB_TITLE = '[TEST] Script: Povinný popis pro vysokou prioritu servisního případu';
  const LAB_DESCRIPTION =
    'Create a JavaScript form script for the NVR Training Automation Lab table `nvr_labservicecase`. ' +
    'Target file: Scripts\\nvr_labservicecase_events.js. ' +
    'Events: Form OnLoad, OnChange of `nvr_priority`. ' +
    'Handlers: `nvr_labservicecase_OnLoad`, `nvr_priority_OnChange`. ' +
    'Logic: if nvr_priority is High (100000002), make nvr_description required and show a notification, ' +
    'otherwise make nvr_description not required and clear the notification.';

  async function withTasksFixture(tasks, customers, fn) {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-lab-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify(tasks));
    if (customers) await fs.writeFile(path.join(tmpDir, 'customers.json'), JSON.stringify(customers));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      await fn(tmpDir, fs, path);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  }

  it('matches the built-in lab template from title+description markers and infers script setup, not incident', async () => {
    const matched = matchTaskTemplate(LAB_TITLE, LAB_DESCRIPTION);
    expect(matched).toBeTruthy();
    expect(matched.id).toBe('nvr-training-automation-lab-servicecase-priority-description');
    expect(matched.targetEntity).toBe('nvr_labservicecase');
    expect(matched.targetEntity).not.toBe('incident');
  });

  it('is not a hard blocker for missing workKind/actionType/targetEntity when the template matches', async () => {
    await withTasksFixture(
      [makeTask({
        id: 'task-lab-001',
        title: LAB_TITLE,
        originalMessage: LAB_DESCRIPTION,
        taskMode: 'general',
        customerId: 'cust-lab',
        workflowSetup: {},
      })],
      [{ id: 'cust-lab', repositoryRoot: 'C:\\Repo\\Lab', scriptFolder: 'C:\\Repo\\Lab\\Scripts' }],
      async () => {
        const result = await callToolFallback('prepare_developer_task', { taskId: 'task-lab-001' });
        expect(result.hardBlockers).toEqual([]);
        expect(result.missingInputs).toEqual([]);
        expect(result.appliedActions).toContain('applied_template');
        expect(result.task.workflowSetup.devTargetKind).toBe('script');
        expect(result.task.workflowSetup.actionType).toBe('create-new-script');
        expect(result.task.workflowSetup.primaryEntityLogicalName).toBe('nvr_labservicecase');
        expect(result.task.workflowSetup.eventFieldName).toBe('nvr_priority');
        expect(result.task.workflowSetup.onLoadFunctionName).toBe('nvr_labservicecase_OnLoad');
        expect(result.task.workflowSetup.onChangeFunctionName).toBe('nvr_priority_OnChange');
      },
    );
  });

  it('returns proposedSetup/appliedSetup/confidence/assumptions/requiresUserConfirmation and business rules', async () => {
    await withTasksFixture(
      [makeTask({
        id: 'task-lab-002',
        title: LAB_TITLE,
        originalMessage: LAB_DESCRIPTION,
        taskMode: 'general',
        customerId: 'cust-lab',
        workflowSetup: {},
      })],
      [{ id: 'cust-lab', repositoryRoot: 'C:\\Repo\\Lab', scriptFolder: 'C:\\Repo\\Lab\\Scripts' }],
      async () => {
        const result = await callToolFallback('prepare_developer_task', { taskId: 'task-lab-002' });
        expect(result.requiresUserConfirmation).toBe(true);
        expect(result.confidence).toBe('high');
        expect(Array.isArray(result.assumptions)).toBe(true);
        expect(result.assumptions.length).toBeGreaterThan(0);
        expect(result.proposedSetup.workKind).toBe('script');
        expect(result.proposedSetup.actionType).toBe('create-new-script');
        expect(result.proposedSetup.targetEntity).toBe('nvr_labservicecase');
        expect(result.proposedSetup.eventField).toBe('nvr_priority');
        expect(result.proposedSetup.handlers.onLoad).toBe('nvr_labservicecase_OnLoad');
        expect(result.proposedSetup.handlers.onChange).toBe('nvr_priority_OnChange');
        expect(result.appliedSetup).toEqual(result.proposedSetup);
        expect(result.businessRules.join(' ')).toContain('Xrm.Page');
        expect(result.businessRules.join(' ')).toContain('setValue on nvr_description');
      },
    );
  });

  it('keeps canWriteCode false until the technical plan is approved, then true after approval', async () => {
    await withTasksFixture(
      [makeTask({
        id: 'task-lab-003',
        title: LAB_TITLE,
        originalMessage: LAB_DESCRIPTION,
        taskMode: 'general',
        customerId: 'cust-lab',
        workflowSetup: {},
      })],
      [{ id: 'cust-lab', repositoryRoot: 'C:\\Repo\\Lab', scriptFolder: 'C:\\Repo\\Lab\\Scripts' }],
      async () => {
        await callToolFallback('prepare_developer_task', { taskId: 'task-lab-003' });
        const packetBefore = await callToolFallback('get_developer_work_packet', { taskId: 'task-lab-003' });
        expect(packetBefore.canWriteCode).toBe(false);

        const approval = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-lab-003' });
        expect(approval.canApprove).toBe(true);

        const packetAfter = await callToolFallback('get_developer_work_packet', { taskId: 'task-lab-003' });
        expect(packetAfter.canWriteCode).toBe(true);
        expect(packetAfter.writeTarget.targetEntity).toBe('nvr_labservicecase');
        expect(packetAfter.writeTarget.eventFieldName).toBe('nvr_priority');
        expect(packetAfter.writeTarget.handlers.onLoad).toBe('nvr_labservicecase_OnLoad');
        expect(packetAfter.writeTarget.handlers.onChange).toBe('nvr_priority_OnChange');
      },
    );
  });

  it('title-only "servisní případu" wording does not override the explicit table name when no template matches', async () => {
    // A near-miss title (only 2 of the 6 markers) so the built-in template does NOT match,
    // exercising the generic fallback inference path directly.
    await withTasksFixture(
      [makeTask({
        id: 'task-lab-004',
        title: '[TEST] Oprava chyby ve servisním případu',
        originalMessage: 'JavaScript form script: onChange of `nvr_priority` on the `nvr_labservicecase` table.',
        taskMode: 'general',
        customerId: 'cust-lab',
        workflowSetup: {},
      })],
      [{ id: 'cust-lab', repositoryRoot: 'C:\\Repo\\Lab', scriptFolder: 'C:\\Repo\\Lab\\Scripts' }],
      async () => {
        const matched = matchTaskTemplate('[TEST] Oprava chyby ve servisním případu', 'JavaScript form script: onChange of `nvr_priority` on the `nvr_labservicecase` table.');
        expect(matched).toBeNull();

        const result = await callToolFallback('prepare_developer_task', { taskId: 'task-lab-004' });
        expect(result.appliedActions).toContain('applied_generic_inference');
        expect(result.task.workflowSetup.primaryEntityLogicalName).toBe('nvr_labservicecase');
        expect(result.task.workflowSetup.primaryEntityLogicalName).not.toBe('incident');
        expect(result.hardBlockers).toEqual([]);
      },
    );
  });

  it('does not hard-block on "script target path" when the customer has no explicit scriptFolder (only repositoryRoot)', async () => {
    // Regression: a customer configured only with repositoryRoot (e.g. derived from
    // crmBaseDirectory + folderName, no explicit scriptFolder) never gets workflowSetup.scriptPath
    // populated by the customerDevDefaults step. artifactPath/desiredScriptFile are still resolved
    // correctly from the template + naming step, so this must not be treated as a hard blocker —
    // found via a live-data replay against a real customer record shaped exactly like this.
    await withTasksFixture(
      [makeTask({
        id: 'task-lab-005',
        title: LAB_TITLE,
        originalMessage: LAB_DESCRIPTION,
        taskMode: 'general',
        customerId: 'cust-lab-no-scriptfolder',
        workflowSetup: {},
      })],
      [{ id: 'cust-lab-no-scriptfolder', repositoryRoot: 'C:\\Repo\\Lab' }],
      async () => {
        const result = await callToolFallback('prepare_developer_task', { taskId: 'task-lab-005' });
        expect(result.hardBlockers).toEqual([]);
        expect(result.missingInputs).toEqual([]);
        expect(result.status).toBe('stopped_at_approval_gate');
        expect(result.task.workflowSetup.artifactPath).toBe('Scripts\\nvr_labservicecase_events.js');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 11c. UI/business-rule script implementation pattern â€” approve_technical_plan_if_safe
// must not require fieldMappings for scripts that legitimately have none by design.
// ---------------------------------------------------------------------------

describe('ui-business-rule implementation pattern (no fieldMappings by design)', () => {
  const LAB_TITLE = '[TEST] Script: Povinný popis pro vysokou prioritu servisního případu';
  const LAB_DESCRIPTION =
    'Create a JavaScript form script for the NVR Training Automation Lab table `nvr_labservicecase`. ' +
    'Target file: Scripts\\nvr_labservicecase_events.js. ' +
    'Events: Form OnLoad, OnChange of `nvr_priority`. ' +
    'Handlers: `nvr_labservicecase_OnLoad`, `nvr_priority_OnChange`. ' +
    'Logic: if nvr_priority is High (100000002), make nvr_description required and show a notification, ' +
    'otherwise make nvr_description not required and clear the notification.';

  async function withTasksFixture(tasks, customers, fn) {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-uibr-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify(tasks));
    if (customers) await fs.writeFile(path.join(tmpDir, 'customers.json'), JSON.stringify(customers));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      await fn(tmpDir, fs, path);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  }

  const CUSTOMERS = [{ id: 'cust-uibr', repositoryRoot: 'C:\\Repo\\Lab', scriptFolder: 'C:\\Repo\\Lab\\Scripts' }];

  it('is classified as implementationPattern=ui-business-rule with requiresFieldMappings=false', async () => {
    await withTasksFixture(
      [makeTask({ id: 'task-uibr-001', title: LAB_TITLE, originalMessage: LAB_DESCRIPTION, customerId: 'cust-uibr', workflowSetup: {} })],
      CUSTOMERS,
      async () => {
        await callToolFallback('prepare_developer_task', { taskId: 'task-uibr-001' });
        const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-uibr-001' });
        expect(packet.implementation.implementationPattern).toBe('ui-business-rule');
        expect(packet.implementation.requiresFieldMappings).toBe(false);
        expect(packet.implementation.referencedFields).toEqual(['nvr_priority', 'nvr_description']);
        expect(packet.implementation.affectedFields).toEqual(['nvr_description']);
        expect(packet.implementation.forbiddenOperations.join(' ')).toContain('Xrm.WebApi');
      },
    );
  });

  it('is not scaffoldOnly despite empty fieldMappings', async () => {
    await withTasksFixture(
      [makeTask({ id: 'task-uibr-002', title: LAB_TITLE, originalMessage: LAB_DESCRIPTION, customerId: 'cust-uibr', workflowSetup: {} })],
      CUSTOMERS,
      async () => {
        await callToolFallback('prepare_developer_task', { taskId: 'task-uibr-002' });
        const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-uibr-002' });
        expect(packet.implementation.fieldMappings).toEqual([]);
        expect(packet.implementation.scaffoldOnly).toBe(false);
      },
    );
  });

  it('approve_technical_plan_if_safe approves the lab priority-description task, and canWriteCode becomes true', async () => {
    await withTasksFixture(
      [makeTask({ id: 'task-uibr-003', title: LAB_TITLE, originalMessage: LAB_DESCRIPTION, customerId: 'cust-uibr', workflowSetup: {} })],
      CUSTOMERS,
      async () => {
        await callToolFallback('prepare_developer_task', { taskId: 'task-uibr-003' });
        const approval = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-uibr-003' });
        expect(approval.canApprove).toBe(true);
        expect(approval.workPacket.canWriteCode).toBe(true);
        expect(approval.workPacket.implementation.fieldMappings).toEqual([]);

        const packetAfter = await callToolFallback('get_developer_work_packet', { taskId: 'task-uibr-003' });
        expect(packetAfter.canWriteCode).toBe(true);
        expect(packetAfter.writeTarget.targetEntity).toBe('nvr_labservicecase');
      },
    );
  });

  it('does not fabricate a bogus fieldMapping from nvr_priority to nvr_description', async () => {
    // Regression: this template must not declare sourceFields/targetFields — doing so previously
    // made deterministicPlanDraft synthesize a fake "source.nvr_priority -> ...nvr_description"
    // mapping (the priority value is never copied anywhere; only its required-level is toggled).
    await withTasksFixture(
      [makeTask({ id: 'task-uibr-004', title: LAB_TITLE, originalMessage: LAB_DESCRIPTION, customerId: 'cust-uibr', workflowSetup: {} })],
      CUSTOMERS,
      async () => {
        const result = await callToolFallback('prepare_developer_task', { taskId: 'task-uibr-004' });
        expect(result.task.crmWorkflowState.technicalPlan.fieldMappings).toEqual([]);
      },
    );
  });

  it('still blocks a stale legacy plan.unmappedSourceFields signal for this task from forcing scaffoldOnly', async () => {
    // A pre-existing plan (e.g. saved before this template existed) may carry stale
    // unmappedSourceFields. The explicit implementationPattern/requiresFieldMappings override
    // must win over that heuristic signal.
    await withTasksFixture(
      [makeTask({
        id: 'task-uibr-005',
        title: LAB_TITLE,
        originalMessage: LAB_DESCRIPTION,
        customerId: 'cust-uibr',
        workflowSetup: {},
        crmDeveloperWorkflow: {
          detectedWorkKind: 'script',
          technicalPlan: { fieldMappings: [], unmappedSourceFields: ['nvr_priority'] },
          planApproval: { approved: true, approvedAt: '2026-01-01T00:00:00.000Z' },
        },
      })],
      CUSTOMERS,
      async () => {
        const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-uibr-005' });
        expect(packet.implementation.requiresFieldMappings).toBe(false);
        expect(packet.implementation.scaffoldOnly).toBe(false);
      },
    );
  });

  it('field-mapping script tasks still require fieldMappings (unaffected by the ui-business-rule fix)', async () => {
    await withTasksFixture(
      [makeTask({
        id: 'task-fm-001',
        title: TASK_TEMPLATES[0].titlePattern,
        customerId: 'cust-fm',
        workflowSetup: {},
      })],
      [{ id: 'cust-fm', repositoryRoot: 'C:\\Repo\\FM', scriptFolder: 'C:\\Repo\\FM\\Scripts' }],
      async () => {
        await callToolFallback('prepare_developer_task', { taskId: 'task-fm-001' });
        const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-fm-001' });
        expect(packet.implementation.requiresFieldMappings).toBe(true);
        expect(packet.implementation.implementationPattern).toBe('field-mapping');
      },
    );
  });

  it('empty fieldMappings still blocks a field-mapping/prefill script task from being approved', async () => {
    // No template match — mirrors the existing "plan-based fieldMappings guard" fixture shape:
    // the plan itself signals unmapped source fields with no corresponding fieldMappings, and no
    // template/text-extraction path can fill them in, so this must stay blocked.
    await withTasksFixture(
      [makeTask({
        id: 'task-fm-002',
        title: 'Custom CRM Script Task Without A Template Match',
        customerId: 'cust-fm2',
        workflowSetup: {
          devTargetKind: 'script', repositoryRoot: 'C:\\Repo\\FM2', actionType: 'create-new-script',
          primaryEntityLogicalName: 'account', artifactPath: 'Scripts\\account_events.js',
          confirmedAt: '2026-06-01T10:00:00.000Z',
        },
        crmDeveloperWorkflow: {
          detectedWorkKind: 'script',
          technicalPlan: {
            workKind: 'script', summary: 'Create account script.',
            target: { entityLogicalName: 'account', scriptPath: 'Scripts\\account_events.js', eventName: 'OnLoad' },
            implementationSteps: [], fieldMappings: [], unmappedSourceFields: ['related.field_a'],
            risks: [], testChecklist: [],
          },
          planApproval: null,
        },
        implementationVerification: { dataverseCheck: { status: 'skipped' } },
      })],
      [{ id: 'cust-fm2', repositoryRoot: 'C:\\Repo\\FM2', scriptFolder: 'C:\\Repo\\FM2\\Scripts' }],
      async () => {
        const approval = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-fm-002' });
        expect(approval.canApprove).toBe(false);
        expect(approval.reasons.join(' ')).toContain('Field mappings are required but not defined');
      },
    );
  });

  it('Dataverse verification context for a ui-business-rule script lists referencedFields/affectedFields, not fieldMappings', async () => {
    await withTasksFixture(
      [makeTask({ id: 'task-uibr-006', title: LAB_TITLE, originalMessage: LAB_DESCRIPTION, customerId: 'cust-uibr', workflowSetup: {} })],
      CUSTOMERS,
      async () => {
        await callToolFallback('prepare_developer_task', { taskId: 'task-uibr-006' });
        const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-uibr-006' });
        expect(packet.implementation.validationFields).toEqual(
          expect.arrayContaining(['nvr_labservicecase.nvr_priority', 'nvr_labservicecase.nvr_description']),
        );
        expect(packet.implementation.fieldMappings).toEqual([]);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 11d. Template matching hardening (requiredKeywords) + taskTextForInference +
// persisted implementation-pattern setup surviving a template re-match miss.
// ---------------------------------------------------------------------------

describe('matchTaskTemplate requiredKeywords gate', () => {
  const LAB_TITLE = '[TEST] Script: Povinný popis pro vysokou prioritu servisního případu';

  it('does NOT match the lab template from the title alone, with no explicit logical name anywhere', () => {
    expect(matchTaskTemplate(LAB_TITLE, '')).toBeNull();
  });

  it('DOES match the lab template once the description explicitly names nvr_labservicecase (with nvr_priority/nvr_description)', () => {
    const matched = matchTaskTemplate(
      'Some other title entirely',
      'nvr_labservicecase nvr_priority nvr_description',
    );
    expect(matched?.id).toBe('nvr-training-automation-lab-servicecase-priority-description');
  });

  it('legacy titlePattern templates are unaffected by the requiredKeywords gate', () => {
    const matched = matchTaskTemplate(TASK_TEMPLATES[0].titlePattern, '');
    expect(matched?.id).toBe(TASK_TEMPLATES[0].id);
  });
});

describe('taskTextForInference — description-only explicit facts', () => {
  const CZECH_TITLE_NO_ENTITY = '[TEST] Oprava chyby ve servisním případu';
  const DESCRIPTION_WITH_ENTITY =
    'JavaScript form script: Form OnLoad and onChange of `nvr_priority` on the `nvr_labservicecase` table. ' +
    'Target file: Scripts\\nvr_labservicecase_events.js. Handlers: `nvr_labservicecase_OnLoad`, `nvr_priority_OnChange`.';

  async function withTasksFixture(tasks, customers, fn) {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-desc-only-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify(tasks));
    if (customers) await fs.writeFile(path.join(tmpDir, 'customers.json'), JSON.stringify(customers));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      await fn(tmpDir, fs, path);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  }

  it('infers nvr_labservicecase (not incident) when the explicit logical name is only in task.description, not originalMessage', async () => {
    await withTasksFixture(
      [makeTask({
        id: 'task-desc-only-1',
        title: CZECH_TITLE_NO_ENTITY,
        originalMessage: '',
        description: DESCRIPTION_WITH_ENTITY,
        taskMode: 'general',
        customerId: 'cust-desc',
        workflowSetup: {},
      })],
      [{ id: 'cust-desc', repositoryRoot: 'C:\\Repo\\Desc', scriptFolder: 'C:\\Repo\\Desc\\Scripts' }],
      async () => {
        const result = await callToolFallback('prepare_developer_task', { taskId: 'task-desc-only-1' });
        expect(result.appliedActions).toContain('applied_generic_inference');
        expect(result.task.workflowSetup.primaryEntityLogicalName).toBe('nvr_labservicecase');
        expect(result.task.workflowSetup.primaryEntityLogicalName).not.toBe('incident');
      },
    );
  });

  it('get_task_templates resolves the lab matchedTemplate when explicit logical names are only in task.description', async () => {
    await withTasksFixture(
      [makeTask({
        id: 'task-desc-only-2',
        title: '[TEST] Script: Povinný popis pro vysokou prioritu servisního případu',
        originalMessage: '',
        description: 'nvr_labservicecase nvr_priority nvr_description',
        workflowSetup: {},
      })],
      null,
      async () => {
        const result = await callToolFallback('get_task_templates', { taskId: 'task-desc-only-2' });
        expect(result.matchedTemplate?.id).toBe('nvr-training-automation-lab-servicecase-priority-description');
      },
    );
  });
});

describe('persisted implementation-pattern setup survives a later template re-match miss', () => {
  const LAB_TITLE = '[TEST] Script: Povinný popis pro vysokou prioritu servisního případu';
  const LAB_DESCRIPTION =
    'Create a JavaScript form script for the NVR Training Automation Lab table `nvr_labservicecase`. ' +
    'Target file: Scripts\\nvr_labservicecase_events.js. ' +
    'Events: Form OnLoad, OnChange of `nvr_priority`. ' +
    'Handlers: `nvr_labservicecase_OnLoad`, `nvr_priority_OnChange`. ' +
    'Logic: if nvr_priority is High (100000002), make nvr_description required and show a notification, ' +
    'otherwise make nvr_description not required and clear the notification.';
  const CUSTOMERS = [{ id: 'cust-persist', repositoryRoot: 'C:\\Repo\\Persist', scriptFolder: 'C:\\Repo\\Persist\\Scripts' }];

  async function withTasksFixture(tasks, customers, fn) {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-persist-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify(tasks));
    if (customers) await fs.writeFile(path.join(tmpDir, 'customers.json'), JSON.stringify(customers));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      return await fn(tmpDir, fs, path);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  }

  it('prepare_developer_task persists implementationPattern and the field/rule lists into workflowSetup', async () => {
    await withTasksFixture(
      [makeTask({ id: 'task-persist-1', title: LAB_TITLE, originalMessage: LAB_DESCRIPTION, customerId: 'cust-persist', workflowSetup: {} })],
      CUSTOMERS,
      async () => {
        const result = await callToolFallback('prepare_developer_task', { taskId: 'task-persist-1' });
        const setup = result.task.workflowSetup;
        expect(setup.implementationPattern).toBe('ui-business-rule');
        expect(setup.requiresFieldMappings).toBe(false);
        expect(setup.referencedFields).toEqual(['nvr_priority', 'nvr_description']);
        expect(setup.triggerFields).toEqual(['nvr_priority']);
        expect(setup.affectedFields).toEqual(['nvr_description']);
        expect(setup.uiRules).toEqual([
          'If nvr_priority == 100000002 (High), set nvr_description required and show a form notification.',
          'Otherwise, set nvr_description not required and clear the notification.',
        ]);
        expect(setup.optionSetValues).toEqual({ nvr_priority: { High: 100000002 } });
        expect(setup.notificationIds).toEqual(['nvr_description_required_notice']);
        expect(setup.forbiddenOperations).toEqual(expect.arrayContaining(['Xrm.WebApi', 'Xrm.Page']));
      },
    );
  });

  it('buildDeveloperWorkPacket still reports the persisted pattern/fields once the task no longer re-matches the template', async () => {
    await withTasksFixture(
      [makeTask({ id: 'task-persist-2', title: LAB_TITLE, originalMessage: LAB_DESCRIPTION, customerId: 'cust-persist', workflowSetup: {} })],
      CUSTOMERS,
      async (tmpDir, fs, path) => {
        await callToolFallback('prepare_developer_task', { taskId: 'task-persist-2' });

        // Simulate the template no longer matching: strip every explicit marker from the
        // title/description while leaving the already-persisted workflowSetup untouched.
        const tasksPath = path.join(tmpDir, 'tasks.json');
        const tasks = JSON.parse(await fs.readFile(tasksPath, 'utf8'));
        const task = tasks.find((t) => t.id === 'task-persist-2');
        expect(matchTaskTemplate(task.title, taskTextForInferenceForTest(task))).toBeTruthy();
        task.title = 'Generic follow-up task';
        task.originalMessage = 'Please double check the earlier change.';
        expect(matchTaskTemplate(task.title, task.originalMessage)).toBeNull();
        await fs.writeFile(tasksPath, JSON.stringify(tasks));

        const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-persist-2' });
        expect(packet.implementation.implementationPattern).toBe('ui-business-rule');
        expect(packet.implementation.requiresFieldMappings).toBe(false);
        expect(packet.implementation.fieldMappings).toEqual([]);
        expect(packet.implementation.scaffoldOnly).toBe(false);
        expect(packet.implementation.referencedFields).toEqual(['nvr_priority', 'nvr_description']);
        expect(packet.implementation.affectedFields).toEqual(['nvr_description']);
      },
    );
  });

  // Local helper mirroring the MCP module's taskTextForInference, only used to sanity-check the
  // "template matches before the mutation" assumption above without importing an unexported fn.
  function taskTextForInferenceForTest(task) {
    return [task.title, task.originalMessage, task.description, task.analysisResult?.summary, task.analysisResult?.summaryEn]
      .filter(Boolean).join('\n');
  }

  it('template-derived fieldMappings for the field-mapping prefill template are unaffected', async () => {
    await withTasksFixture(
      [makeTask({ id: 'task-persist-fm', title: TASK_TEMPLATES[0].titlePattern, customerId: 'cust-fm-persist', workflowSetup: {} })],
      [{ id: 'cust-fm-persist', repositoryRoot: 'C:\\Repo\\FMPersist', scriptFolder: 'C:\\Repo\\FMPersist\\Scripts' }],
      async () => {
        const result = await callToolFallback('prepare_developer_task', { taskId: 'task-persist-fm' });
        expect(result.task.workflowSetup.implementationPattern).toBeUndefined();
        const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-persist-fm' });
        expect(packet.implementation.implementationPattern).toBe('field-mapping');
        expect(packet.implementation.requiresFieldMappings).toBe(true);
        expect(packet.implementation.fieldMappings.length).toBeGreaterThan(0);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 12. callToolFallback get_task_full_context â€” developerWorkPacket.scriptNaming
// ---------------------------------------------------------------------------

describe('callToolFallback get_task_full_context â€” developerWorkPacket.scriptNaming', () => {
  it('includes developerWorkPacket.scriptNaming when entity and customer scriptFolder are set', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-naming-'));
    const task = makeTask({
      id: 'task-naming-001',
      title: '[TEST] Script naming test',
      customerId: 'cust-naming-001',
      workflowSetup: {
        devTargetKind: 'script',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        eventFieldName: 'nvr_assetid',
      },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    const customer = {
      id: 'cust-naming-001',
      name: 'VSK-Test',
      scriptFolder: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts',
      repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
    };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    await fs.writeFile(path.join(tmpDir, 'customers.json'), JSON.stringify([customer]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_task_full_context', { id: 'task-naming-001' });
      const naming = result.task.developerWorkPacket?.scriptNaming;
      expect(naming).toBeDefined();
      expect(naming.desiredScriptFile).toBe('nvr_servicecase_events.js');
      expect(naming.onLoadFunctionName).toBe('nvr_servicecase_OnLoad');
      expect(naming.onChangeFunctionName).toBe('nvr_assetid_OnChange');
      expect(naming.absoluteScriptPath).toBe('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
      expect(naming.scriptPath).toBe('Scripts\\nvr_servicecase_events.js');
      expect(naming.scriptsFolderRelative).toBe('Scripts');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('derives absoluteScriptPath from repositoryRoot when customer has no scriptFolder', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-nofolder-'));
    const task = makeTask({
      id: 'task-naming-nofolder',
      title: '[TEST] Script: Předvyplnění servisního požadavku',
      customerId: 'cust-naming-nofolder',
      workflowSetup: {
        devTargetKind: 'script',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        eventFieldName: 'nvr_assetid',
      },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    const customer = {
      id: 'cust-naming-nofolder',
      name: 'VSK-Test-NoFolder',
      repositoryRoot: 'C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test',
      // No scriptFolder
    };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    await fs.writeFile(path.join(tmpDir, 'customers.json'), JSON.stringify([customer]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_task_full_context', { id: 'task-naming-nofolder' });
      const naming = result.task.developerWorkPacket?.scriptNaming;
      expect(naming?.absoluteScriptPath).toBe('C:\\Users\\vskoumal\\Documents\\CRM\\VSK-Test\\Scripts\\nvr_servicecase_events.js');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('developerWorkPacket absent when task has no entity logical name', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-naming2-'));
    const task = makeTask({
      id: 'task-naming-002',
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_task_full_context', { id: 'task-naming-002' });
      expect(result.task.developerWorkPacket).toBeUndefined();
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 13. get_developer_work_packet – plan-based fieldMappings guard
// ---------------------------------------------------------------------------

describe('callToolFallback get_developer_work_packet – plan-based fieldMappings guard', () => {
  async function importHelpers() {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return { os, fs, path };
  }

  async function writeTask(tmpDir, fs, path, taskOverrides) {
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask(taskOverrides)]));
  }

  it('returns canWriteCode=false when non-template plan has unmappedSourceFields but empty fieldMappings', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-plan-guard-'));
    await writeTask(tmpDir, fs, path, {
      id: 'task-plan-guard',
      title: 'Custom CRM Script Task',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script', repositoryRoot: 'C:\\Repo', actionType: 'create-new-script',
        primaryEntityLogicalName: 'account', artifactPath: 'Scripts\\account_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script', summary: 'Create account script.',
          target: { entityLogicalName: 'account', scriptPath: 'Scripts\\account_events.js', eventName: 'OnLoad' },
          implementationSteps: [],
          fieldMappings: [],                                              // EMPTY
          unmappedSourceFields: ['related.field_a', 'related.field_b'],  // plan knows about fields but has no targets
          risks: [], testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-plan-guard' });
      expect(packet.canWriteCode).toBe(false);
      expect(packet.status).toBe('not_ready');
      expect(packet.decisionReason).toContain('Field mappings are missing');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('sets implementation.requiresFieldMappings=true when plan signals all fields unmapped', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-reqfmap-'));
    await writeTask(tmpDir, fs, path, {
      id: 'task-reqfmap',
      title: 'Custom CRM Script Task',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script', repositoryRoot: 'C:\\Repo',
        artifactPath: 'Scripts\\account_events.js', confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script', summary: 'Script.',
          target: { entityLogicalName: 'account', scriptPath: 'Scripts\\account_events.js' },
          implementationSteps: [], fieldMappings: [],
          unmappedSourceFields: ['related.field_a'],
          risks: [], testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-reqfmap' });
      expect(packet.implementation.requiresFieldMappings).toBe(true);
      expect(packet.implementation.scaffoldOnly).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('populates implementation.missingRequiredMappings from plan unmappedSourceFields when non-template', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-missing-'));
    await writeTask(tmpDir, fs, path, {
      id: 'task-missing-maps',
      title: 'Custom CRM Script Task',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script', repositoryRoot: 'C:\\Repo',
        artifactPath: 'Scripts\\account_events.js', confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script', summary: 'Script.',
          target: { entityLogicalName: 'account', scriptPath: 'Scripts\\account_events.js' },
          implementationSteps: [], fieldMappings: [],
          unmappedSourceFields: ['src.field_a', 'src.field_b'],
          risks: [], testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-missing-maps' });
      expect(packet.implementation.missingRequiredMappings.length).toBeGreaterThan(0);
      expect(packet.implementation.missingRequiredMappings.some((m) => m.includes('src.field_a'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('populates implementation.validationFields from template additionalSourceFields', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-valfields-'));
    await writeTask(tmpDir, fs, path, {
      id: 'task-valfields',
      title: '[TEST] Script: Předvyplnění servisního požadavku podle zařízení', // NVR template match
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script', repositoryRoot: 'C:\\Repo',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js', confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script', summary: 'Prefill.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventFieldName: 'nvr_assetid' },
          implementationSteps: [],
          fieldMappings: [
            { source: 'nvr_customerasset.nvr_customerid', target: 'nvr_servicecase.nvr_customerid' },
            { source: 'nvr_customerasset.nvr_contactid', target: 'nvr_servicecase.nvr_contactid' },
            { source: 'nvr_customerasset.nvr_isunderwarranty', target: 'nvr_servicecase.nvr_iswarrantycase' },
          ],
          unmappedSourceFields: ['nvr_customerasset.nvr_statuscustom'],
          risks: [], testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-valfields' });
      // nvr_statuscustom is in template.additionalSourceFields — must appear in validationFields
      expect(packet.implementation.validationFields).toEqual(
        expect.arrayContaining([expect.stringContaining('nvr_statuscustom')])
      );
      // must NOT appear in fieldMappings
      const mappedSources = packet.implementation.fieldMappings.map((m) => m.source);
      expect(mappedSources.some((s) => s.includes('nvr_statuscustom'))).toBe(false);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('allows canWriteCode=true when plan has both fieldMappings and unmappedSourceFields (partial is fine)', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-partial-'));
    await writeTask(tmpDir, fs, path, {
      id: 'task-partial',
      title: 'Custom CRM Script Task',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script', repositoryRoot: 'C:\\Repo',
        primaryEntityLogicalName: 'account',
        actionType: 'create-new-script',
        artifactPath: 'Scripts\\account_events.js', confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script', summary: 'Script.',
          target: { entityLogicalName: 'account', scriptPath: 'Scripts\\account_events.js', eventName: 'OnLoad' },
          implementationSteps: [],
          fieldMappings: [{ source: 'src.field_a', target: 'account.field_x' }],
          unmappedSourceFields: ['src.validation_field'],
          risks: [], testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-partial' });
      expect(packet.canWriteCode).toBe(true);
      expect(packet.implementation.scaffoldOnly).toBe(false);
      expect(packet.implementation.requiresFieldMappings).toBe(false);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('sets implementation.requiresFieldMappings=false for tasks with empty fieldMappings and no unmapped fields', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-no-req-'));
    await writeTask(tmpDir, fs, path, {
      id: 'task-no-req',
      title: 'Custom script without template',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script', repositoryRoot: 'C:\\Repo',
        primaryEntityLogicalName: 'account',
        artifactPath: 'Scripts\\account_events.js', confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script', summary: 'Script.',
          target: { entityLogicalName: 'account', scriptPath: 'Scripts\\account_events.js', eventName: 'OnLoad' },
          implementationSteps: [], fieldMappings: [],   // empty — and no unmappedSourceFields
          risks: [], testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-no-req' });
      expect(packet.implementation.requiresFieldMappings).toBe(false);
      expect(packet.implementation.scaffoldOnly).toBe(false);
      expect(packet.implementation.missingRequiredMappings).toEqual([]);
      expect(packet.canWriteCode).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 14. get_developer_work_packet – text-based field mapping detection
// ---------------------------------------------------------------------------

describe('callToolFallback get_developer_work_packet – text-based field mapping detection', () => {
  async function importHelpers() {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return { os, fs, path };
  }

  // Original assignment with "Source entity/fields" and "Target entity/fields" sections
  // but NO matching template title and NO unmappedSourceFields in the plan.
  const NVR_ORIGINAL_MESSAGE = [
    'Source entity: nvr_customerasset',
    'Source fields: nvr_customerid, nvr_contactid, nvr_isunderwarranty, nvr_statuscustom',
    'Target entity: nvr_servicecase',
    'Target fields: nvr_customerid, nvr_contactid, nvr_iswarrantycase',
  ].join('\n');

  function makeTextDetectionTask(id, extraOverrides) {
    return makeTask({
      id,
      title: 'Customní skript pro předvyplnění', // does NOT match any template titlePattern
      customerId: 'cust-test',
      originalMessage: NVR_ORIGINAL_MESSAGE,
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repo',
        primaryEntityLogicalName: 'nvr_servicecase',
        actionType: 'create-new-script',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Create prefill script.',
          target: {
            entityLogicalName: 'nvr_servicecase',
            scriptPath: 'Scripts\\nvr_servicecase_events.js',
            eventName: 'onChange',
            eventFieldName: 'nvr_assetid',
          },
          implementationSteps: [],
          fieldMappings: [],        // empty — not set in plan
          unmappedSourceFields: [], // empty — not set in plan
          risks: [],
          testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
      ...(extraOverrides || {}),
    });
  }

  it('extracts 3-pair fieldMappings from original assignment text when plan has none', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-txtextract-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTextDetectionTask('task-txt-extract')]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-txt-extract' });
      expect(packet.canWriteCode).toBe(true);
      expect(packet.implementation.fieldMappings).toHaveLength(3);
      expect(packet.implementation.fieldMappings[0]).toMatchObject({ source: 'nvr_customerasset.nvr_customerid', target: 'nvr_servicecase.nvr_customerid' });
      expect(packet.implementation.fieldMappings[1]).toMatchObject({ source: 'nvr_customerasset.nvr_contactid', target: 'nvr_servicecase.nvr_contactid' });
      expect(packet.implementation.fieldMappings[2]).toMatchObject({ source: 'nvr_customerasset.nvr_isunderwarranty', target: 'nvr_servicecase.nvr_iswarrantycase' });
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('puts nvr_statuscustom (4th source field with no target pair) into validationFields', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-txtval-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTextDetectionTask('task-txt-val')]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-txt-val' });
      expect(packet.implementation.validationFields).toEqual(
        expect.arrayContaining([expect.stringContaining('nvr_statuscustom')])
      );
      const sources = packet.implementation.fieldMappings.map((m) => m.source);
      expect(sources.some((s) => s.includes('nvr_statuscustom'))).toBe(false);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns canWriteCode=false when text detects mapping work but extraction fails (no safe pairs)', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-txtblock-'));
    // Has source/target entity context but no "Source fields:" / "Target fields:" lines
    const task = makeTextDetectionTask('task-txt-block', {
      originalMessage: 'Source entity: nvr_customerasset\nTarget entity: nvr_servicecase\nCopy fields: nvr_customerid, nvr_contactid, nvr_isunderwarranty',
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-txt-block' });
      expect(packet.canWriteCode).toBe(false);
      expect(packet.implementation.requiresFieldMappings).toBe(true);
      expect(packet.implementation.scaffoldOnly).toBe(true);
      expect(packet.implementation.missingRequiredMappings.length).toBeGreaterThan(0);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('does not fire detection on tasks with CRM field names but no source/target entity context', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-txt-nofire-'));
    const task = makeTextDetectionTask('task-txt-nofire', {
      originalMessage: 'Fix the nvr_servicecase form. The nvr_customerid field is not updating when the form loads.',
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-txt-nofire' });
      expect(packet.canWriteCode).toBe(true);
      expect(packet.implementation.requiresFieldMappings).toBe(false);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 15. continue_developer_workflow – scaffold/TODO guard
// ---------------------------------------------------------------------------

describe('callToolFallback continue_developer_workflow – scaffold guard blocks advancement', () => {
  async function importHelpers() {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return { os, fs, path };
  }

  it('returns define_field_mappings when template requires mappings but none defined, even after local test recorded', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdwf-scaffold-'));
    const task = makeTask({
      id: 'task-cdwf-scaffold',
      title: '[TEST] Script: Předvyplnění servisního požadavku podle zařízení',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script', repositoryRoot: 'C:\\Repo',
        primaryEntityLogicalName: 'nvr_servicecase', actionType: 'create-new-script',
        artifactPath: 'Scripts\\nvr_servicecase_events.js', confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script', summary: 'Prefill.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventName: 'onChange', eventFieldName: 'nvr_assetid' },
          implementationSteps: [],
          fieldMappings: [],        // template exists but no mappings
          unmappedSourceFields: [],
          risks: [], testChecklist: [],
        },
        planApproval: { approved: true },
      },
      // AI already "recorded" test results on scaffold code
      localTestRecord: { status: 'passed', recordedAt: '2026-06-01T12:00:00.000Z' },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdwf-scaffold' });
      expect(result.nextAction).toBe('define_field_mappings');
      expect(result.canProceed).toBe(false);
      expect(result.forbiddenWrites).toEqual(expect.arrayContaining(['record_local_test']));
      expect(result.forbiddenWrites).toEqual(expect.arrayContaining(['commit_task_changes']));
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('does not trigger scaffold guard when fieldMappings are present', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cdwf-ready-'));
    const task = makeTask({
      id: 'task-cdwf-ready',
      title: '[TEST] Script: Předvyplnění servisního požadavku podle zařízení',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script', repositoryRoot: 'C:\\Repo',
        primaryEntityLogicalName: 'nvr_servicecase', actionType: 'create-new-script',
        artifactPath: 'Scripts\\nvr_servicecase_events.js', confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script', summary: 'Prefill.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventName: 'onChange', eventFieldName: 'nvr_assetid' },
          implementationSteps: [],
          fieldMappings: [
            { source: 'nvr_customerasset.nvr_customerid', target: 'nvr_servicecase.nvr_customerid' },
            { source: 'nvr_customerasset.nvr_contactid', target: 'nvr_servicecase.nvr_contactid' },
            { source: 'nvr_customerasset.nvr_isunderwarranty', target: 'nvr_servicecase.nvr_iswarrantycase' },
          ],
          unmappedSourceFields: [],
          risks: [], testChecklist: [],
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdwf-ready' });
      // Not blocked — should proceed to record_results since local test is not done
      expect(result.nextAction).toBe('record_results');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 16. get_developer_work_packet – consistency guard + plan-text-based detection
// ---------------------------------------------------------------------------

describe('callToolFallback get_developer_work_packet – consistency guard and plan-based detection', () => {
  async function importHelpers() {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return { os, fs, path };
  }

  function makeConsistencyTask(id, planOverrides, taskOverrides) {
    return makeTask({
      id,
      title: 'Custom CRM Script Task',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script', repositoryRoot: 'C:\\Repo',
        primaryEntityLogicalName: 'nvr_servicecase', actionType: 'create-new-script',
        artifactPath: 'Scripts\\nvr_servicecase_events.js', confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script', summary: 'Prefill script.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventName: 'onChange', eventFieldName: 'nvr_assetid' },
          implementationSteps: [], fieldMappings: [], unmappedSourceFields: [],
          risks: [], testChecklist: [],
          ...(planOverrides || {}),
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
      ...(taskOverrides || {}),
    });
  }

  it('canWriteCode=true with requiresFieldMappings=true is impossible (consistency guard)', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-consgrd-'));
    const task = makeConsistencyTask('task-consgrd', {
      risks: ['Field mappings are not defined for nvr_customerasset -> nvr_servicecase'],
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-consgrd' });
      if (packet.implementation.requiresFieldMappings && packet.implementation.fieldMappings.length === 0) {
        expect(packet.canWriteCode).toBe(false);
      }
      if (!packet.canWriteCode && packet.implementation.requiresFieldMappings) {
        expect(packet.implementation.scaffoldOnly).toBe(true);
      }
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('detects field mapping requirement from plan risks text', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-plnrisk-'));
    const task = makeConsistencyTask('task-plnrisk', {
      risks: [
        'Field mappings are not defined - nvr_customerasset -> nvr_servicecase mapping must be completed.',
        'nvr_customerid, nvr_contactid, nvr_isunderwarranty fields must be mapped.',
      ],
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-plnrisk' });
      expect(packet.canWriteCode).toBe(false);
      expect(packet.implementation.requiresFieldMappings).toBe(true);
      expect(packet.implementation.scaffoldOnly).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('detects field mapping requirement from plan steps with TODO + CRM field names', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-plnsteps-'));
    const task = makeConsistencyTask('task-plnsteps', {
      implementationSteps: [
        'Create nvr_assetid_OnChange handler function',
        'Retrieve nvr_customerasset record via WebApi',
        'TODO: map nvr_customerasset fields to nvr_servicecase (nvr_customerid, nvr_contactid, nvr_isunderwarranty)',
      ],
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-plnsteps' });
      expect(packet.canWriteCode).toBe(false);
      expect(packet.implementation.requiresFieldMappings).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('detectionSources lists scanned text sources when text detection fires', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-detsrc-'));
    const task = makeConsistencyTask('task-detsrc', {
      risks: ['Field mappings are not defined for nvr_customerasset, nvr_servicecase, nvr_customerid, nvr_contactid'],
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-detsrc' });
      if (packet.implementation.requiresFieldMappings) {
        expect(Array.isArray(packet.implementation.detectionSources)).toBe(true);
        expect(packet.implementation.detectionSources.length).toBeGreaterThan(0);
        expect(packet.implementation.detectionSources).toContain('planRisks');
      }
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('original message structured fields win over scaffold plan steps (extraction beats detection-only block)', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-msgwin-'));
    const task = makeConsistencyTask(
      'task-msgwin',
      {
        implementationSteps: ['Create handler', 'TODO: map nvr_customerasset fields to nvr_servicecase'],
        risks: ['Field mappings are not defined'],
        fieldMappings: [], unmappedSourceFields: [],
      },
      {
        originalMessage: [
          'Source entity: nvr_customerasset',
          'Source fields: nvr_customerid, nvr_contactid, nvr_isunderwarranty, nvr_statuscustom',
          'Target entity: nvr_servicecase',
          'Target fields: nvr_customerid, nvr_contactid, nvr_iswarrantycase',
        ].join('\n'),
      }
    );
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-msgwin' });
      // originalMessage has extractable "Source fields/Target fields" → extraction should succeed
      expect(packet.implementation.fieldMappings.length).toBeGreaterThanOrEqual(3);
      expect(packet.canWriteCode).toBe(true);
      const mappedSources = packet.implementation.fieldMappings.map((m) => m.source);
      expect(mappedSources.some((s) => s.includes('nvr_statuscustom'))).toBe(false);
      expect(packet.implementation.validationFields.some((f) => f.includes('nvr_statuscustom'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe('callToolFallback get_developer_work_packet – Czech scaffold guard and sanitization', () => {
  async function importHelpers() {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return { os, fs, path };
  }

  function makeCzechTask(id, planOverrides, taskOverrides) {
    return makeTask({
      id,
      title: 'Czech CRM Script Task',
      customerId: 'cust-test',
      workflowSetup: {
        devTargetKind: 'script', repositoryRoot: 'C:\\Repo',
        primaryEntityLogicalName: 'nvr_servicecase', actionType: 'create-new-script',
        artifactPath: 'Scripts\\nvr_servicecase_events.js', confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script', summary: 'Prefill script.',
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventName: 'onChange', eventFieldName: 'nvr_assetid' },
          implementationSteps: [], fieldMappings: [], unmappedSourceFields: [],
          risks: [], testChecklist: [],
          ...(planOverrides || {}),
        },
        planApproval: { approved: true },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
      ...(taskOverrides || {}),
    });
  }

  it('Czech risk "nejsou definovány" blocks canWriteCode when fieldMappings empty', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cz-risk-'));
    const task = makeCzechTask('task-cz-risk', {
      implementationSteps: [
        'Create nvr_assetid_OnChange handler',
        'Retrieve nvr_customerasset record via WebApi',
      ],
      risks: [
        'Field mappings nejsou definovány – skript obsahuje pouze strukturu a TODO komentáře; mapování musí být doplněno před ostrým provozem',
      ],
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-cz-risk' });
      expect(packet.canWriteCode).toBe(false);
      expect(packet.implementation.scaffoldOnly).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('Czech step "Připravit TODO komentáře" blocks canWriteCode when fieldMappings empty', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cz-step-'));
    const task = makeCzechTask('task-cz-step', {
      implementationSteps: [
        'Create nvr_assetid_OnChange handler',
        'Retrieve nvr_customerasset record via WebApi',
        'Připravit TODO komentáře pro doplnění konkrétních field mappings',
      ],
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-cz-step' });
      expect(packet.canWriteCode).toBe(false);
      expect(packet.implementation.scaffoldOnly).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('canWriteCode=true packet never contains TODO/scaffold in implementation steps', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-no-todo-'));
    const task = makeCzechTask(
      'task-no-todo',
      {
        implementationSteps: [
          'Create handler for nvr_assetid onChange',
          'Připravit TODO komentáře pro doplnění konkrétních field mappings',
        ],
        fieldMappings: [], unmappedSourceFields: [],
      },
      {
        originalMessage: [
          'Source entity: nvr_customerasset',
          'Source fields: nvr_customerid, nvr_contactid, nvr_isunderwarranty',
          'Target entity: nvr_servicecase',
          'Target fields: nvr_customerid, nvr_contactid, nvr_iswarrantycase',
        ].join('\n'),
      }
    );
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-no-todo' });
      if (packet.canWriteCode) {
        const stepsText = packet.implementation.steps.join('\n');
        expect(/\btodo\b/i.test(stepsText)).toBe(false);
      }
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('extracts nvr_customerasset as source entity (not nvr_assetid) from originalMessage', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-src-ent-'));
    const task = makeCzechTask(
      'task-src-entity',
      { fieldMappings: [], unmappedSourceFields: [] },
      {
        originalMessage: [
          'Source entity: nvr_customerasset',
          'Source fields: nvr_customerid, nvr_contactid, nvr_isunderwarranty',
          'Target entity: nvr_servicecase',
          'Target fields: nvr_customerid, nvr_contactid, nvr_iswarrantycase',
        ].join('\n'),
      }
    );
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-src-entity' });
      if (packet.implementation.fieldMappings.length > 0) {
        expect(packet.implementation.fieldMappings.every((m) => m.source.startsWith('nvr_customerasset.'))).toBe(true);
        expect(packet.implementation.fieldMappings.some((m) => m.source.startsWith('nvr_assetid.'))).toBe(false);
      }
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('extracts field mappings from Czech abbreviated Zdroj/Cíl format', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-cz-abbrev-'));
    const task = makeCzechTask(
      'task-cz-abbrev',
      { fieldMappings: [], unmappedSourceFields: [] },
      {
        originalMessage: [
          'Zdroj: nvr_customerasset',
          'Pole zdroje: nvr_customerid, nvr_contactid, nvr_isunderwarranty',
          'Cíl: nvr_servicecase',
          'Pole cíle: nvr_customerid, nvr_contactid, nvr_iswarrantycase',
        ].join('\n'),
      }
    );
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-cz-abbrev' });
      expect(packet.implementation.fieldMappings.length).toBeGreaterThanOrEqual(2);
      expect(packet.canWriteCode).toBe(true);
      expect(packet.implementation.fieldMappings.every((m) => m.source.startsWith('nvr_customerasset.'))).toBe(true);
      expect(packet.implementation.fieldMappings.every((m) => m.target.startsWith('nvr_servicecase.'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('final packet invariant fires on exact real-task Czech text when uniqueCrmNames < 2', async () => {
    // Exercises the FINAL PACKET INVARIANT (not Guard 1 or Guard 2 enforcement).
    // The task has ONLY scaffold steps/risks — no other CRM entity names in any text source,
    // so uniqueCrmNames.size < 2 and planSignalsIncomplete stays false. Input-side
    // detection does not fire, requiresFieldMappings=false, canWriteCode=true before guards.
    // Guard 2 sets scaffoldSignalDetected=true (diagnostic).
    // The final packet invariant then sees TODO in sanitizedSteps and enforces canWriteCode=false.
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-final-inv-'));
    const task = makeCzechTask('task-final-inv', {
      implementationSteps: [
        'Připravit TODO komentáře pro doplnění konkrétních field mappings',
      ],
      risks: [
        'Field mappings nejsou definovány – skript obsahuje pouze strukturu a TODO komentáře; mapování musí být doplněno před ostrým provozem',
      ],
      fieldMappings: [], unmappedSourceFields: [],
      summary: 'Prefill script.',
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-final-inv' });
      expect(packet.canWriteCode).toBe(false);
      expect(packet.implementation.scaffoldOnly).toBe(true);
      expect(packet.implementation.finalConsistencyGuardApplied).toBe(true);
      expect(packet.implementation.scaffoldSignalDetected).toBe(true);
      expect(packet.implementation.fieldMappingsCount).toBe(0);
      expect(typeof packet.packetGeneratorVersion).toBe('string');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 17. approve_technical_plan_if_safe – safety conditions and audit note
// ---------------------------------------------------------------------------

describe('callToolFallback approve_technical_plan_if_safe', () => {
  async function importHelpers() {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return { os, fs, path };
  }

  // Template task that matches the nvr-training-sh-script-prefill template.
  // planApproval is NOT set — the tool is supposed to set it.
  function makeTemplateTaskAwaitingApproval(id = 'task-approve-tpl') {
    return makeTask({
      id,
      title: 'Script: Předvyplnění servisního požadavku',
      customerId: 'nvr-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repos\\NVR',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
        eventName: 'onChange',
        eventFieldName: 'nvr_assetid',
        onLoadFunctionName: 'nvr_servicecase_OnLoad',
        onChangeFunctionName: 'nvr_assetid_OnChange',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Create onChange handler for nvr_assetid on nvr_servicecase.',
          implementationSteps: ['Implement the onChange prefill handler.'],
          fieldMappings: [],
          unmappedSourceFields: [],
          risks: [],
          testChecklist: [],
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventName: 'onChange', eventFieldName: 'nvr_assetid' },
        },
        // planApproval intentionally absent — tool must set it
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
  }

  function makeNonTemplateTaskWithUnmappedFields(id = 'task-approve-unmapped') {
    return makeTask({
      id,
      title: 'Script: custom work without template',
      customerId: 'cust-1',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repos\\NVR',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
        eventName: 'onChange',
        eventFieldName: 'nvr_assetid',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        planApproval: { approved: true },
        technicalPlan: {
          workKind: 'script',
          summary: 'Custom handler without template.',
          implementationSteps: ['Implement the handler.'],
          fieldMappings: [],
          unmappedSourceFields: ['nvr_statuscustom'],
          risks: [],
          testChecklist: [],
          target: { entityLogicalName: 'nvr_servicecase', eventName: 'onChange', eventFieldName: 'nvr_assetid' },
        },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
  }

  it('scenario 1: template-derived plan with valid fieldMappings can be auto-approved', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve1-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTemplateTaskAwaitingApproval()]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-tpl' });
      expect(result.canApprove).toBe(true);
      expect(result.approvedAt).toBeDefined();
      expect(Array.isArray(result.reasons)).not.toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 2: auto-approval changes workPacket from canWriteCode=false to canWriteCode=true', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve2-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTemplateTaskAwaitingApproval()]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      // Verify that before approval, canWriteCode=false
      const before = await callToolFallback('get_developer_work_packet', { taskId: 'task-approve-tpl' });
      expect(before.canWriteCode).toBe(false);

      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-tpl' });
      expect(result.canApprove).toBe(true);
      expect(result.workPacket.canWriteCode).toBe(true);
      expect(result.workPacket.implementation.fieldMappings.length).toBe(3);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 3: missing fieldMappings blocks auto-approval', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve3-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeNonTemplateTaskWithUnmappedFields()]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-unmapped' });
      expect(result.canApprove).toBe(false);
      expect(Array.isArray(result.reasons)).toBe(true);
      expect(result.reasons.some((r) => r.includes('required but not defined'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 4: scaffoldOnly=true blocks auto-approval', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve4-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeNonTemplateTaskWithUnmappedFields('task-approve-scaffold')]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-scaffold' });
      expect(result.canApprove).toBe(false);
      expect(result.reasons.some((r) => r.includes('scaffoldOnly=true'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 5: TODO/scaffold in plan steps is safe-refreshed and approved when trusted template fieldMappings present', async () => {
    // Stale scaffold steps + trusted template fieldMappings → safe refresh path fires:
    // steps are replaced with concrete packet-derived steps, plan is approved, canApprove=true.
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve5-'));
    const task = makeTemplateTaskAwaitingApproval('task-approve-todo');
    task.crmDeveloperWorkflow.technicalPlan.implementationSteps = [
      'TODO: implement the field copy logic',
      'TODO: fill in field mappings',
    ];
    task.crmDeveloperWorkflow.technicalPlan.risks = [
      'field mappings are not defined',
      'script contains TODO comments',
    ];
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-todo' });
      expect(result.canApprove).toBe(true);
      expect(result.planRefreshed).toBe(true);
      expect(result.workPacket.canWriteCode).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it("scenario 6: untrusted fieldMappingsSource blocks auto-approval", async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve6-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeNonTemplateTaskWithUnmappedFields('task-approve-src')]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-src' });
      expect(result.canApprove).toBe(false);
      expect(result.reasons.some((r) => r.includes('fieldMappingsSource'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 7: external actions in plan block auto-approval', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve7-'));
    const task = makeTemplateTaskAwaitingApproval('task-approve-ext');
    task.crmDeveloperWorkflow.technicalPlan.externalActionPreview = ['Register plugin step in Dataverse.'];
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-ext' });
      expect(result.canApprove).toBe(false);
      expect(result.reasons.some((r) => r.includes('external actions'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 8: audit note is recorded after auto-approval', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve8-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTemplateTaskAwaitingApproval('task-approve-audit')]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-audit' });
      expect(result.canApprove).toBe(true);
      // appendMcpAuditNote writes to task.notes (a string). Verify it was persisted to disk.
      const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const savedTask = saved.find((t) => t.id === 'task-approve-audit');
      const notes = savedTask?.notes ?? '';
      expect(typeof notes).toBe('string');
      expect(notes.includes('approve_technical_plan_if_safe')).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 9: refreshed plan contains concrete mapping steps (no TODO text)', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve9-'));
    const task = makeTemplateTaskAwaitingApproval('task-approve-refresh-steps');
    task.crmDeveloperWorkflow.technicalPlan.implementationSteps = ['TODO: implement the field copy logic'];
    task.crmDeveloperWorkflow.technicalPlan.risks = ['field mappings are not defined'];
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-refresh-steps' });
      expect(result.canApprove).toBe(true);
      expect(result.planRefreshed).toBe(true);

      // Verify the refreshed plan in persisted tasks.json
      const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const savedTask = saved.find((t) => t.id === 'task-approve-refresh-steps');
      const steps = savedTask?.crmDeveloperWorkflow?.technicalPlan?.implementationSteps ?? [];
      expect(steps.some((s) => /Copy.*nvr_customerid/i.test(s))).toBe(true);
      expect(steps.some((s) => /Copy.*nvr_contactid/i.test(s))).toBe(true);
      expect(steps.some((s) => /Copy.*nvr_isunderwarranty/i.test(s))).toBe(true);
      expect(steps.every((s) => !/todo|scaffold|placeholder/i.test(s))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 10: refreshed plan removes scaffold risks and adds standard guardrail risks', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve10-'));
    const task = makeTemplateTaskAwaitingApproval('task-approve-refresh-risks');
    task.crmDeveloperWorkflow.technicalPlan.implementationSteps = ['TODO: implement'];
    task.crmDeveloperWorkflow.technicalPlan.risks = [
      'field mappings are not defined',
      'script contains TODO comments',
      'Manual testing should be performed after deployment.',
    ];
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-refresh-risks' });
      const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const savedTask = saved.find((t) => t.id === 'task-approve-refresh-risks');
      const risks = savedTask?.crmDeveloperWorkflow?.technicalPlan?.risks ?? [];
      // Scaffold risks removed
      expect(risks.every((r) => !/todo|scaffold|placeholder|field mappings are not defined/i.test(r))).toBe(true);
      // Real risk preserved
      expect(risks.some((r) => r.includes('Manual testing'))).toBe(true);
      // Standard risks added
      expect(risks.some((r) => r.includes('Dataverse'))).toBe(true);
      expect(risks.some((r) => /web resource/i.test(r))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 11: TODO in plan with empty fieldMappings still blocks (no refresh possible)', async () => {
    // Non-template task: empty fieldMappings → canSafelyRefreshPlan=false → canApprove=false.
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve11-'));
    const task = makeTask({
      id: 'task-approve-todo-no-fm',
      title: 'Script: custom work no mappings',
      taskMode: 'developer',
      workflowSetup: {
        devTargetKind: 'script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts/nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        technicalPlan: {
          workKind: 'script',
          summary: 'Custom handler.',
          implementationSteps: ['TODO: implement the handler'],
          fieldMappings: [],
          unmappedSourceFields: [],
          risks: [],
          testChecklist: [],
          target: { entityLogicalName: 'nvr_servicecase' },
        },
      },
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-todo-no-fm' });
      // Cannot refresh because fieldMappings is empty → still blocks
      expect(result.canApprove).toBe(false);
      expect(Array.isArray(result.reasons)).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 12: plan refresh audit note contains safe plan refresh marker', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve12-'));
    const task = makeTemplateTaskAwaitingApproval('task-approve-refresh-audit');
    task.crmDeveloperWorkflow.technicalPlan.implementationSteps = ['TODO: implement the field copy logic'];
    task.crmDeveloperWorkflow.technicalPlan.risks = ['field mappings are not defined'];
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-refresh-audit' });
      expect(result.canApprove).toBe(true);
      expect(result.planRefreshed).toBe(true);
      // Audit note for the refresh must be persisted
      const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const savedTask = saved.find((t) => t.id === 'task-approve-refresh-audit');
      const notes = savedTask?.notes ?? '';
      expect(notes.includes('safe plan refresh')).toBe(true);
      expect(notes.includes('approve_technical_plan_if_safe')).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 13: normal approval (no scaffold steps) returns planRefreshed=false', async () => {
    // Template task with clean steps → normal approval, planRefreshed must be false.
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve13-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTemplateTaskAwaitingApproval('task-approve-no-refresh')]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-no-refresh' });
      expect(result.canApprove).toBe(true);
      expect(result.planRefreshed).toBe(false);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 14: plan refresh removes risks mentioning hallucinated entity nvr_asset not in packet', async () => {
    // The stale plan risk mentions "nvr_asset" — an entity name hallucinated from the lookup
    // field "nvr_assetid". The real source entity is nvr_customerasset (per fieldMappings/template).
    // After safe plan refresh, no risk should mention nvr_asset.
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve14-'));
    const task = makeTemplateTaskAwaitingApproval('task-approve-stale-entity');
    task.crmDeveloperWorkflow.technicalPlan.implementationSteps = ['TODO: implement the field copy logic'];
    task.crmDeveloperWorkflow.technicalPlan.risks = [
      'TODO: verify fields',
      'Logický název entity zařízení (nvr_asset) musí být ověřen v prostředí.',
      'Manual testing should be performed after deployment.',
    ];
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-stale-entity' });
      expect(result.canApprove).toBe(true);
      expect(result.planRefreshed).toBe(true);

      const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const savedTask = saved.find((t) => t.id === 'task-approve-stale-entity');
      const risks = savedTask?.crmDeveloperWorkflow?.technicalPlan?.risks ?? [];

      // No risk should mention the hallucinated nvr_asset entity (without also mentioning nvr_customerasset).
      expect(risks.every((r) => !(r.includes('nvr_asset') && !r.includes('nvr_customerasset')))).toBe(true);
      // The generic real risk must be preserved (it contains no CRM entity names).
      expect(risks.some((r) => r.includes('Manual testing'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('scenario 15: plan refresh preserves risks mentioning the allowed entity nvr_customerasset', async () => {
    // A risk that explicitly references the correct source entity nvr_customerasset must survive
    // the unknown-entity filter, since nvr_customerasset IS in the packet's allowed name set.
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-approve15-'));
    const task = makeTemplateTaskAwaitingApproval('task-approve-allowed-entity');
    task.crmDeveloperWorkflow.technicalPlan.implementationSteps = ['TODO: implement'];
    task.crmDeveloperWorkflow.technicalPlan.risks = [
      'Logické názvy entity nvr_customerasset a polí podléhají ověření v prostředí.',
    ];
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('approve_technical_plan_if_safe', { taskId: 'task-approve-allowed-entity' });
      expect(result.canApprove).toBe(true);
      expect(result.planRefreshed).toBe(true);

      const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const savedTask = saved.find((t) => t.id === 'task-approve-allowed-entity');
      const risks = savedTask?.crmDeveloperWorkflow?.technicalPlan?.risks ?? [];

      // The risk mentioning the legitimate entity nvr_customerasset must be preserved.
      expect(risks.some((r) => r.includes('nvr_customerasset'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// get_developer_work_packet — post-packet stale entity risk filtering
// Tests that already-approved plans with persisted stale CRM entity risks have those
// risks filtered from the returned packet, even without going through the refresh path.
// ---------------------------------------------------------------------------

describe('get_developer_work_packet – stale entity risk filtering', () => {
  async function importHelpers() {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return { os, fs, path };
  }

  // Task matching nvr-training-sh-script-prefill template; planApproval already set;
  // persisted risks contain a hallucinated nvr_asset entity name.
  function makeApprovedTaskWithStaleNvrAssetRisk(id = 'task-gdwp-stale') {
    return makeTask({
      id,
      title: 'Script: Předvyplnění servisního požadavku',
      customerId: 'nvr-test',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repos\\NVR',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
        eventName: 'onChange',
        eventFieldName: 'nvr_assetid',
        onLoadFunctionName: 'nvr_servicecase_OnLoad',
        onChangeFunctionName: 'nvr_assetid_OnChange',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        planApproval: { approved: true, approvedAt: '2026-06-01T11:00:00.000Z' },
        technicalPlan: {
          workKind: 'script',
          summary: 'Create onChange handler for nvr_assetid on nvr_servicecase.',
          implementationSteps: ['Implement the onChange prefill handler.'],
          fieldMappings: [],
          unmappedSourceFields: [],
          risks: [
            'Logický název entity zařízení (nvr_asset) musí být ověřen v prostředí.',
            'Dataverse metadata must be verified in-app for JS/TS.',
          ],
          testChecklist: [],
          target: { entityLogicalName: 'nvr_servicecase', scriptPath: 'Scripts\\nvr_servicecase_events.js', eventName: 'onChange', eventFieldName: 'nvr_assetid' },
        },
      },
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
    });
  }

  it('already-approved task: returned packet risks exclude hallucinated nvr_asset entity', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-gdwp1-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeApprovedTaskWithStaleNvrAssetRisk()]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-gdwp-stale' });
      expect(packet.canWriteCode).toBe(true);
      const risks = packet.implementation?.risks ?? [];
      expect(risks.every((r) => !(r.includes('nvr_asset') && !r.includes('nvr_customerasset')))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('already-approved task: canWriteCode remains true after stale risk is filtered', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-gdwp2-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeApprovedTaskWithStaleNvrAssetRisk()]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-gdwp-stale' });
      expect(packet.canWriteCode).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('already-approved task: nvr_assetid event field is allowed; nvr_asset is not inferred from it', async () => {
    // The event field name nvr_assetid must not cause nvr_asset to be treated as an entity name.
    // Only nvr_asset risks (not nvr_assetid risks) must be removed.
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-gdwp3-'));
    const task = makeApprovedTaskWithStaleNvrAssetRisk('task-gdwp-fields');
    task.crmDeveloperWorkflow.technicalPlan.risks = [
      'Logický název entity zařízení (nvr_asset) musí být ověřen.',
      'Dataverse metadata must be verified in-app for JS/TS.',
    ];
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-gdwp-fields' });
      const risks = packet.implementation?.risks ?? [];
      // Stale nvr_asset risk removed; standard Dataverse risk (no CRM entity names) preserved.
      expect(risks.every((r) => !(r.includes('nvr_asset') && !r.includes('nvr_customerasset')))).toBe(true);
      expect(risks.some((r) => r.includes('Dataverse'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('already-approved task: risk mentioning allowed entity nvr_customerasset is preserved', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-gdwp4-'));
    const task = makeApprovedTaskWithStaleNvrAssetRisk('task-gdwp-allowed');
    task.crmDeveloperWorkflow.technicalPlan.risks = [
      'Logické názvy entity nvr_customerasset a polí podléhají ověření v prostředí.',
    ];
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-gdwp-allowed' });
      const risks = packet.implementation?.risks ?? [];
      expect(risks.some((r) => r.includes('nvr_customerasset'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('approved nvr-training-sh-script-prefill task: packet contains businessRules and acceptanceCriteria', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-brac-'));
    const task = makeApprovedTaskWithStaleNvrAssetRisk('task-brac');
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const packet = await callToolFallback('get_developer_work_packet', { taskId: 'task-brac' });
      const br = packet.implementation?.businessRules ?? [];
      const ac = packet.implementation?.acceptanceCriteria ?? [];
      expect(br.length).toBeGreaterThan(0);
      expect(ac.length).toBeGreaterThan(0);
      // Key business rules must be present
      expect(br.some((r) => r.includes('no-op'))).toBe(true);
      expect(br.some((r) => r.includes('nvr_statuscustom'))).toBe(true);
      expect(br.some((r) => r.includes('Xrm.Page'))).toBe(true);
      // Acceptance criteria must cover prefill path and empty-field no-op
      expect(ac.some((c) => c.includes('empty') && c.includes('nvr_assetid'))).toBe(true);
      expect(ac.some((c) => c.includes('nvr_customerid'))).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// record_ai_implementation_completed tool
// ---------------------------------------------------------------------------

describe('record_ai_implementation_completed tool', () => {
  async function importHelpers() {
    const { default: os } = await import('node:os');
    const { default: fs } = await import('node:fs/promises');
    const { default: path } = await import('node:path');
    return { os, fs, path };
  }

  function makeApprovedScriptTask(id = 'task-raic') {
    return makeTask({
      id,
      title: 'Script: Předvyplnění servisního požadavku',
      taskMode: 'developer',
      workflowSetup: {
        devTargetKind: 'script',
        repositoryRoot: 'C:\\Repos\\NVR',
        actionType: 'create-new-script',
        primaryEntityLogicalName: 'nvr_servicecase',
        artifactPath: 'Scripts\\nvr_servicecase_events.js',
        confirmedAt: '2026-06-01T10:00:00.000Z',
      },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        planApproval: { approved: true, approvedAt: '2026-06-01T11:00:00.000Z' },
        technicalPlan: {
          workKind: 'script',
          summary: 'Create onChange handler.',
          implementationSteps: ['Implement onChange handler.'],
          fieldMappings: [],
          risks: [],
          testChecklist: [],
        },
      },
    });
  }

  it('tool definition is present in TOOL_DEFINITIONS', () => {
    const tool = findTool('record_ai_implementation_completed');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toContain('taskId');
    expect(tool.inputSchema.required).toContain('filesChanged');
    expect(tool.inputSchema.required).toContain('summary');
  });

  it('tool is not in READ_ONLY_TOOL_NAMES (it writes)', () => {
    expect(READ_ONLY_TOOL_NAMES.has('record_ai_implementation_completed')).toBe(false);
  });

  it('records implementation and sets checklist overrides', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-raic1-'));
    const task = makeApprovedScriptTask('task-raic-1');
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('record_ai_implementation_completed', {
        taskId: 'task-raic-1',
        filesChanged: ['Scripts/nvr_servicecase_events.js'],
        summary: 'Implemented onChange prefill handler.',
      });
      expect(result.recorded).toBe(true);
      expect(result.requiresManualCrmAction).toBe(true);
      expect(result.nextStep).toContain('Upload');

      const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const saved = raw.find((t) => t.id === 'task-raic-1');
      expect(saved.mcpChecklistOverrides?.['implementation-done']).toBe('done');
      expect(saved.mcpChecklistOverrides?.['local-test-done']).toBe('optional');
      expect(saved.localTestRecord?.status).toBe('not-needed');
      expect(saved.crmDeveloperWorkflow.lastAiImplementation?.filesChanged).toEqual(['Scripts/nvr_servicecase_events.js']);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns error when task is not developer mode', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-raic2-'));
    const task = makeApprovedScriptTask('task-raic-2');
    task.taskMode = 'general';
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('record_ai_implementation_completed', {
        taskId: 'task-raic-2',
        filesChanged: ['Scripts/nvr_servicecase_events.js'],
        summary: 'Implemented.',
      });
      expect(result.error).toContain('developer mode');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns error when plan is not approved', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-raic3-'));
    const task = makeApprovedScriptTask('task-raic-3');
    task.crmDeveloperWorkflow.planApproval = { approved: false };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('record_ai_implementation_completed', {
        taskId: 'task-raic-3',
        filesChanged: ['Scripts/nvr_servicecase_events.js'],
        summary: 'Implemented.',
      });
      expect(result.error).toContain('not approved');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns error when filesChanged is empty', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-raic4-'));
    const task = makeApprovedScriptTask('task-raic-4');
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('record_ai_implementation_completed', {
        taskId: 'task-raic-4',
        filesChanged: [],
        summary: 'Implemented.',
      });
      expect(result.error).toContain('filesChanged');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('persists the implemented script artifact into workflowSetup so the UI script panel resolves it', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-raic5-'));
    const task = makeApprovedScriptTask('task-raic-5');
    // Simulate the reported bug: no artifact selected on the task yet.
    delete task.workflowSetup.artifactPath;
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('record_ai_implementation_completed', {
        taskId: 'task-raic-5',
        filesChanged: ['Scripts\\nvr_servicecase_events.js'],
        summary: 'Implemented onChange prefill handler.',
      });
      expect(result.implementedArtifactPath).toBe('Scripts\\nvr_servicecase_events.js');

      const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const saved = raw.find((t) => t.id === 'task-raic-5');
      expect(saved.workflowSetup.artifactPath).toBe('Scripts\\nvr_servicecase_events.js');
      expect(saved.workflowSetup.desiredScriptFile).toBe('nvr_servicecase_events.js');
      expect(saved.workflowSetup.absoluteScriptPath).toBe(path.join('C:\\Repos\\NVR', 'Scripts\\nvr_servicecase_events.js'));
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('invalidates a stale run_implementation_verification result when re-recording implementation', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-raic6-'));
    const task = makeApprovedScriptTask('task-raic-6');
    task.implementationVerification = {
      mcpVerification: { status: 'failed', checks: [], fixableFindings: [{ id: 'no-xrm-page', description: 'x' }], nextAction: 'fix_code', ranAt: '2026-06-01T12:00:00.000Z' },
    };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      await callToolFallback('record_ai_implementation_completed', {
        taskId: 'task-raic-6',
        filesChanged: ['Scripts/nvr_servicecase_events.js'],
        summary: 'Fixed Xrm.Page usage.',
      });
      const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const saved = raw.find((t) => t.id === 'task-raic-6');
      expect(saved.implementationVerification.mcpVerification).toBeUndefined();
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// run_implementation_verification tool
// ---------------------------------------------------------------------------

describe('run_implementation_verification tool', () => {
  async function importHelpers() {
    const { default: os } = await import('node:os');
    const { default: fs } = await import('node:fs/promises');
    const { default: path } = await import('node:path');
    return { os, fs, path };
  }

  const GOOD_SCRIPT = `
    function nvr_assetid_OnChange(executionContext) {
      const formContext = executionContext.getFormContext();
      const assetAttr = formContext.getAttribute("nvr_assetid");
      const assetIdValue = assetAttr && assetAttr.getValue();
      if (!assetIdValue || assetIdValue.length === 0) {
        return;
      }
      const assetId = assetIdValue[0].id;
      Xrm.WebApi.retrieveRecord("nvr_customerasset", assetId, "?$select=nvr_customerid,nvr_contactid,nvr_isunderwarranty,nvr_statuscustom").then(function (asset) {
        const statusValue = (asset.nvr_statuscustom || "").toLowerCase();
        if (statusValue === "inactive" || statusValue === "retired" || statusValue === "lost") {
          formContext.ui.setFormNotification("Selected asset is inactive/retired/lost.", "WARNING", "nvr_assetid_status");
          return;
        }
        const customerAttr = formContext.getAttribute("nvr_customerid");
        if (customerAttr) {
          customerAttr.setValue(asset.nvr_customerid ? [{ id: asset.nvr_customerid, entityType: "account", name: "" }] : null);
        }
      });
    }
  `;

  const BAD_SCRIPT = `
    function nvr_assetid_OnChange(executionContext) {
      // TODO: implement retrieveRecord call
      var formContext = Xrm.Page;
      formContext.data.save();
    }
  `;

  function makeVerificationTask(id, { repositoryRoot, artifactPath, devTargetKind = 'script' }) {
    return makeTask({
      id,
      title: 'Script: Předvyplnění servisního požadavku',
      taskMode: 'developer',
      workflowSetup: { devTargetKind, repositoryRoot, artifactPath },
      crmDeveloperWorkflow: {
        detectedWorkKind: devTargetKind,
        planApproval: { approved: true },
        // Non-empty fieldMappings so the scaffold/TODO guard in computeContinueWorkflowStep
        // does not fire ahead of the check under test.
        technicalPlan: {
          workKind: devTargetKind,
          summary: 'Prefill service case from asset.',
          implementationSteps: ['Implement onChange handler.'],
          fieldMappings: [
            { source: 'nvr_customerasset.nvr_customerid', target: 'nvr_servicecase.nvr_customerid' },
            { source: 'nvr_customerasset.nvr_contactid', target: 'nvr_servicecase.nvr_contactid' },
            { source: 'nvr_customerasset.nvr_isunderwarranty', target: 'nvr_servicecase.nvr_iswarrantycase' },
          ],
          risks: [],
          testChecklist: [],
        },
      },
    });
  }

  it('tool definition is present and read-only', () => {
    const tool = findTool('run_implementation_verification');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['taskId']);
    expect(READ_ONLY_TOOL_NAMES.has('run_implementation_verification')).toBe(true);
  });

  it('passes Script File Readiness and Local Static/Business-Rule Verification for a compliant script', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-good-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    const task = makeVerificationTask('task-riv-good', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-good' });
      expect(result.fixableFindings).toEqual([]);
      const readinessCheck = result.checks.find((c) => c.name === 'Script File Readiness');
      expect(readinessCheck.status).toBe('passed');
      const staticCheck = result.checks.find((c) => c.name === 'Local Static/Business-Rule Verification');
      expect(staticCheck.status).toBe('passed');
      // No fixable findings, but AI Internal Code Review has not been recorded yet — the agent
      // must review it itself (record_ai_kit_review_result), not wait_for_user.
      expect(result.status).toBe('pending_ai_kit_review');
      expect(result.nextAction).toBe('run_ai_kit_review');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns fix_code with fixable findings for a script violating business rules (TODO, Xrm.Page, autosave)', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-bad-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), BAD_SCRIPT);
    const task = makeVerificationTask('task-riv-bad', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-bad' });
      expect(result.status).toBe('failed');
      expect(result.nextAction).toBe('fix_code');
      expect(result.fixableFindings.length).toBeGreaterThan(0);
      const ids = result.fixableFindings.map((f) => f.id);
      expect(ids).toContain('no-xrm-page');
      expect(ids).toContain('no-autosave');
      expect(ids).toContain('no-todo-fixme-placeholder');
      expect(ids).toContain('retrieve-source-entity');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns a fixable Script File Readiness finding when the artifact file does not exist on disk', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-missing-'));
    const task = makeVerificationTask('task-riv-missing', { repositoryRoot: tmpDir, artifactPath: 'Scripts/does_not_exist.js' });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-missing' });
      expect(result.status).toBe('failed');
      expect(result.nextAction).toBe('fix_code');
      const readinessCheck = result.checks.find((c) => c.name === 'Script File Readiness');
      expect(readinessCheck.status).toBe('failed');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('rejects non-verifiable (e.g. repo-only) work kinds with a clear error', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-nonverifiable-'));
    const task = makeVerificationTask('task-riv-nonverifiable', { repositoryRoot: tmpDir, artifactPath: 'Plugins/Foo.cs', devTargetKind: 'repo-only' });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-nonverifiable' });
      expect(result.error).toContain('script/ribbon/plugin tasks only');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('accepts plugin tasks and runs Plugin File Readiness / Dataverse Metadata Check / AI Internal Code Review', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-plugin-'));
    const pluginsDir = path.join(tmpDir, 'Plugins');
    await fs.mkdir(pluginsDir, { recursive: true });
    const pluginFilePath = path.join(pluginsDir, 'Foo.cs');
    await fs.writeFile(pluginFilePath, 'public class Foo : IPlugin { public void Execute(IServiceProvider sp) {} }');
    // Plugin artifactPath is resolved as-is (no repositoryRoot join, unlike scripts) — the UI lets
    // the user pick a plugin file directly, so it is expected to already be absolute.
    const task = makeVerificationTask('task-riv-plugin', { repositoryRoot: tmpDir, artifactPath: pluginFilePath, devTargetKind: 'plugin' });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-plugin' });
      expect(result.error).toBeUndefined();

      const readinessCheck = result.checks.find((c) => c.name === 'Plugin File Readiness');
      expect(readinessCheck).toBeDefined();
      expect(readinessCheck.status).toBe('passed');

      // Static rule templates are JS/TS-only — plugins skip this check rather than attempting
      // to match a template.
      const staticCheck = result.checks.find((c) => c.name === 'Local Static/Business-Rule Verification');
      expect(staticCheck.status).toBe('skipped');

      const dvCheck = result.checks.find((c) => c.name === 'Dataverse Metadata Check');
      expect(dvCheck).toBeDefined();

      const aiCheck = result.checks.find((c) => c.name === 'AI Internal Code Review');
      expect(aiCheck).toBeDefined();

      const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const saved = raw.find((t) => t.id === 'task-riv-plugin');
      expect(saved.implementationVerification.buildCheck.status).toBe('passed');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('persists mcpVerification to the task so continue_developer_workflow can read it back', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-persist-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    const task = makeVerificationTask('task-riv-persist', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    task.localTestRecord = { status: 'not-needed' };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      await callToolFallback('run_implementation_verification', { taskId: 'task-riv-persist' });
      const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const saved = raw.find((t) => t.id === 'task-riv-persist');
      expect(saved.implementationVerification.mcpVerification.ranAt).toBeDefined();
      expect(saved.implementationVerification.buildCheck.status).toBe('passed');

      // continue_developer_workflow must now report run_ai_kit_review (the agent can perform the
      // remaining review itself), not re-recommend run_implementation_verification.
      const cont = await callToolFallback('continue_developer_workflow', { taskId: 'task-riv-persist' });
      expect(cont.nextAction).toBe('run_ai_kit_review');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  // ── Split-brain regression coverage: MCP verification must orchestrate over the same
  // canonical fields ImplementationVerificationModal reads, not a side-channel result. ──────

  it('does not return passed while Dataverse Metadata Check is not-run and required', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-dv-notrun-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    // No crmVerificationReports, no dataverseCheck override — modal would show "Not run".
    const task = makeVerificationTask('task-riv-dv-notrun', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-dv-notrun' });
      expect(result.status).not.toBe('passed');
      const dvCheck = result.checks.find((c) => c.name === 'Dataverse Metadata Check');
      // Standalone MCP fallback (no bridge) cannot run Primarch itself — needs_configuration
      // reports exactly what unblocks it, not a generic needs_manual_action.
      expect(dvCheck.status).toBe('needs_configuration');
      expect(dvCheck.findings[0]).toContain('Task Workbench app');
      // MCP must not fabricate a PASSING verdict — no scan/report was actually run. The hard-gate
      // persists the needs_configuration marker (with the specific reason) onto dataverseCheck so
      // the modal shows why, rather than leaving it silently blank.
      const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const saved = raw.find((t) => t.id === 'task-riv-dv-notrun');
      expect(saved.implementationVerification.dataverseCheck.status).toBe('needs_configuration');
      expect(saved.crmVerificationReports).toBeUndefined();
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('reports Dataverse Metadata Check as resolved once the modal has already recorded a verdict', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-dv-done-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    const task = makeVerificationTask('task-riv-dv-done', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    task.crmVerificationReports = [{ verdict: 'pass' }];
    task.implementationVerification = { aiCodeReview: { status: 'skipped' } };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-dv-done' });
      const dvCheck = result.checks.find((c) => c.name === 'Dataverse Metadata Check');
      expect(dvCheck.status).toBe('passed');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('does not return passed while AI Internal Code Review is not-run and required', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-ai-notrun-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    const task = makeVerificationTask('task-riv-ai-notrun', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    // Dataverse already resolved so AI Internal Code Review is isolated as the only pending row.
    task.crmVerificationReports = [{ verdict: 'pass' }];
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-ai-notrun' });
      expect(result.status).not.toBe('passed');
      const aiCheck = result.checks.find((c) => c.name === 'AI Internal Code Review');
      // The calling agent can perform this review itself — needs_ai_kit_review, not a generic
      // needs_manual_action.
      expect(aiCheck.status).toBe('needs_ai_kit_review');
      expect(aiCheck.findings[0]).toContain('record_ai_kit_review_result');
      // MCP must not fabricate an aiCodeReview result — do not conflate static checks with AI review.
      const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const saved = raw.find((t) => t.id === 'task-riv-ai-notrun');
      expect(saved.implementationVerification.aiCodeReview).toBeUndefined();
      // The deterministic static-rule check is its own row, distinct from AI Internal Code Review.
      const staticCheck = result.checks.find((c) => c.name === 'Local Static/Business-Rule Verification');
      expect(staticCheck).toBeDefined();
      expect(staticCheck.name).not.toBe(aiCheck.name);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('does not auto-pass the modal Local Test row — it stays not-run separate from task.localTestRecord', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-localtest-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    const task = makeVerificationTask('task-riv-localtest', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    // Simulates record_ai_implementation_completed's effect: the workflow-gate field is
    // 'not-needed', but the modal's own Local Test row must remain untouched by MCP.
    task.localTestRecord = { status: 'not-needed' };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-localtest' });
      const localTestCheck = result.checks.find((c) => c.name === 'Local Test');
      expect(localTestCheck.status).toBe('needs_manual_action');
      expect(result.status).not.toBe('passed');

      const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const saved = raw.find((t) => t.id === 'task-riv-localtest');
      // task.localTestRecord ('not-needed', the continue_developer_workflow gate) must not leak
      // into implementationVerification.localTest (the modal row) as an auto-pass.
      expect(saved.implementationVerification.localTest).toBeUndefined();
      expect(saved.localTestRecord.status).toBe('not-needed');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('reports passed only once Dataverse, AI review, and Local Test are all resolved in the modal', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-all-resolved-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    const task = makeVerificationTask('task-riv-all-resolved', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    task.crmVerificationReports = [{ verdict: 'pass' }];
    task.implementationVerification = {
      // Hard gate: a "passed" AI Kit review only satisfies the gate with full review details.
      aiCodeReview: {
        status: 'passed',
        reviewedFiles: ['Scripts/nvr_servicecase_events.js'],
        rulesFiles: ['ai-rules/crm-javascript-rules.md'],
        checklistFiles: ['ai-rules/crm-code-review-checklist.md'],
        knownPrReviewFiles: ['ai-rules/known-pr-review-comments.md'],
      },
      localTest: { status: 'not-needed' },
    };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-all-resolved' });
      expect(result.status).toBe('passed');
      expect(result.nextAction).toBe('continue_workflow');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  // ── Modal-visible implementationVerification summary + nextRecommendedStep ──────────────

  it('response includes a modal-visible implementationVerification summary matching the live example', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-summary-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    // No crmVerificationReports, no aiCodeReview, no localTest — matches the reported live state:
    // Script File Readiness passed, static rules passed, Dataverse/AI/Local Test needs_manual_action.
    const task = makeVerificationTask('task-riv-summary', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-summary' });
      const iv = result.implementationVerification;
      expect(iv.buildCheck).toMatchObject({ status: 'passed', label: 'Script File Readiness' });
      expect(iv.dataverseCheck).toMatchObject({ status: 'needs_manual_action', label: 'Dataverse Metadata Check' });
      expect(iv.aiCodeReview).toMatchObject({ status: 'needs_manual_action', label: 'AI Internal Code Review' });
      expect(iv.localTest).toMatchObject({ status: 'needs_manual_action', label: 'Local Test' });
      expect(iv.staticBusinessRules).toMatchObject({ status: 'passed', label: 'Local Static/Business-Rule Verification' });
      // Static rules are a distinct row from AI Internal Code Review.
      expect(iv.staticBusinessRules.label).not.toBe(iv.aiCodeReview.label);

      expect(result.unresolvedRequiredRows.sort()).toEqual(['aiCodeReview', 'dataverseCheck', 'localTest']);
      // Top-level nextRecommendedStep reflects the tool-orchestration nextAction (run_ai_kit_review
      // — agent-actionable), not the modal-summary unresolvedRequiredRows wording above.
      expect(result.nextAction).toBe('run_ai_kit_review');
      expect(result.nextRecommendedStep).toBe(
        'Read the applicable AI Kit rules and the target file, then call record_ai_kit_review_result with your verdict, then call run_implementation_verification again.',
      );
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('modal summary treats aiCodeReview="skipped" as resolved, but the hard gate still requires a genuine passed AI Kit review', async () => {
    // "skipped" is a legitimate modal-display override (shown as resolved so the UI doesn't nag),
    // but it is not one of the three real review verdicts (passed/failed/warnings) the hard gate
    // accepts — aiKitReviewGate treats it as not_run, same as never having reviewed at all. This
    // is intentional: the hardening closes exactly this kind of bypass.
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-partial-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    const task = makeVerificationTask('task-riv-partial', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    task.crmVerificationReports = [{ verdict: 'pass' }];
    task.implementationVerification = { aiCodeReview: { status: 'skipped' } };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-partial' });
      // Modal-visible summary still shows aiCodeReview as resolved ("skipped") — only localTest
      // is genuinely not-run from the modal's point of view.
      expect(result.unresolvedRequiredRows).toEqual(['localTest']);
      // But the tool-orchestration nextAction is driven by the hard gate, which does not accept
      // "skipped" as a satisfying AI Kit review verdict.
      expect(result.nextAction).toBe('run_ai_kit_review');
      expect(result.nextRecommendedStep).toBe(
        'Read the applicable AI Kit rules and the target file, then call record_ai_kit_review_result with your verdict, then call run_implementation_verification again.',
      );
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  // ── Hard-gate coverage: warnings_unaccepted / not_run rollup buckets ────────────────────

  it('reports warnings_unaccepted when Dataverse Metadata Check has warnings that are not yet accepted', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-dv-warnings-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    const task = makeVerificationTask('task-riv-dv-warnings', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    task.crmVerificationReports = [{ verdict: 'warnings' }];
    task.implementationVerification = {
      aiCodeReview: {
        status: 'passed',
        reviewedFiles: ['Scripts/nvr_servicecase_events.js'],
        rulesFiles: ['ai-rules/crm-javascript-rules.md'],
        checklistFiles: ['ai-rules/crm-code-review-checklist.md'],
        knownPrReviewFiles: ['ai-rules/known-pr-review-comments.md'],
      },
      localTest: { status: 'not-needed' },
    };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-dv-warnings' });
      const dvCheck = result.checks.find((c) => c.name === 'Dataverse Metadata Check');
      expect(dvCheck.status).toBe('warnings_unaccepted');
      expect(dvCheck.rawStatus).toBe('warnings');
      // warnings_unaccepted requires the user, but ranks below fix_code/run_ai_kit_review/
      // needs_configuration and above the generic needs_manual_action/wait_for_user bucket.
      expect(result.status).toBe('warnings_unaccepted');
      expect(result.nextAction).toBe('review_dataverse_warnings');
      expect(result.nextRecommendedStep).toContain('warnings that are not yet accepted');
      expect(result.progressionGate.canProceed).toBe(false);
      expect(result.progressionGate.dataverseGateStatus).toBe('warnings_unaccepted');
      expect(result.progressionGate.requiresUserAction).toBe(true);
      expect(result.progressionGate.nextRecommendedAction).toBe('review_dataverse_warnings');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('reports passed for Dataverse Metadata Check once warnings are explicitly accepted', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-dv-warnings-accepted-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    const task = makeVerificationTask('task-riv-dv-warnings-accepted', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    task.crmVerificationReports = [{ verdict: 'warnings' }];
    task.implementationVerification = {
      dataverseCheck: { warningsAccepted: { accepted: true } },
      aiCodeReview: {
        status: 'passed',
        reviewedFiles: ['Scripts/nvr_servicecase_events.js'],
        rulesFiles: ['ai-rules/crm-javascript-rules.md'],
        checklistFiles: ['ai-rules/crm-code-review-checklist.md'],
        knownPrReviewFiles: ['ai-rules/known-pr-review-comments.md'],
      },
      localTest: { status: 'not-needed' },
    };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-dv-warnings-accepted' });
      const dvCheck = result.checks.find((c) => c.name === 'Dataverse Metadata Check');
      expect(dvCheck.status).toBe('passed');
      expect(result.status).toBe('passed');
      expect(result.nextAction).toBe('continue_workflow');
      expect(result.progressionGate.canProceed).toBe(true);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('rolls a dataverse "not_run" check up into needs_manual_action, never silently into passed', async () => {
    // Requesting only dataverseMetadataCheck (skipping scriptFileReadiness) means the artifact
    // path is never resolved, so the check reports "not_run" with no fixable finding attached —
    // this exercises the rollup's not_run bucket in isolation from the readiness check's own
    // fixable "failed" finding.
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-dv-notrun-standalone-'));
    const task = makeVerificationTask('task-riv-dv-notrun-standalone', { repositoryRoot: tmpDir, artifactPath: '', devTargetKind: 'script' });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', {
        taskId: 'task-riv-dv-notrun-standalone',
        checks: ['dataverseMetadataCheck'],
      });
      const dvCheck = result.checks.find((c) => c.name === 'Dataverse Metadata Check');
      expect(dvCheck.status).toBe('not_run');
      expect(dvCheck.findings[0]).toContain('artifact file path is not resolved');
      expect(result.fixableFindings).toEqual([]);
      expect(result.status).toBe('needs_manual_action');
      expect(result.nextAction).toBe('wait_for_user');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  // ── Dataverse environment-mismatch hard gate ────────────────────────────────────────────

  it('blocks Dataverse Metadata Check with needs_configuration on an environment mismatch, without trusting the existing report', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-dv-envmismatch-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    const task = makeVerificationTask('task-riv-dv-envmismatch', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    task.customerId = 'cust-envmismatch';
    // A previously-recorded passing report exists — the mismatch must still block progression
    // rather than trusting a report that may have run against the wrong Dataverse environment.
    // The standalone fallback has no Primarch client of its own to begin with (see the
    // "requires the Task Workbench app" branch above), so the meaningful assertion here is that
    // the mismatch is reported with its own specific reason instead of the generic one, and that
    // the existing report/state is left untouched rather than being reinterpreted as valid.
    task.crmVerificationReports = [{ verdict: 'pass' }];
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    await fs.writeFile(path.join(tmpDir, 'customers.json'), JSON.stringify([
      { id: 'cust-envmismatch', dataverseEnvironmentLabel: 'Production' },
    ]));
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({ primarchMcpEnvironmentLabel: 'Sandbox' }));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-dv-envmismatch' });
      const dvCheck = result.checks.find((c) => c.name === 'Dataverse Metadata Check');
      expect(dvCheck.status).toBe('needs_configuration');
      expect(dvCheck.findings[0]).toContain("does not match this task's expected environment");
      expect(dvCheck.findings[0]).toContain('Production');
      expect(dvCheck.findings[0]).toContain('Sandbox');
      expect(dvCheck.environment).toEqual({ expected: 'Production', active: 'Sandbox', mismatch: true });

      const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const saved = raw.find((t) => t.id === 'task-riv-dv-envmismatch');
      expect(saved.crmVerificationReports).toEqual([{ verdict: 'pass' }]);
      expect(saved.implementationVerification.dataverseCheck.status).toBe('needs_configuration');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('does not report a mismatch when customer/settings environment labels match case-insensitively', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-dv-envmatch-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), GOOD_SCRIPT);
    const task = makeVerificationTask('task-riv-dv-envmatch', { repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' });
    task.customerId = 'cust-envmatch';
    task.crmVerificationReports = [{ verdict: 'pass' }];
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));
    await fs.writeFile(path.join(tmpDir, 'customers.json'), JSON.stringify([
      { id: 'cust-envmatch', dataverseEnvironmentLabel: 'PRODUCTION' },
    ]));
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({ primarchMcpEnvironmentLabel: 'production' }));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-dv-envmatch' });
      const dvCheck = result.checks.find((c) => c.name === 'Dataverse Metadata Check');
      expect(dvCheck.environment.mismatch).toBe(false);
      expect(dvCheck.status).toBe('passed');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// record_ai_kit_review_result tool
// ---------------------------------------------------------------------------

describe('record_ai_kit_review_result tool', () => {
  async function importHelpers() {
    const { default: os } = await import('node:os');
    const { default: fs } = await import('node:fs/promises');
    const { default: path } = await import('node:path');
    return { os, fs, path };
  }

  it('tool definition is present with the expected status enum and required fields', () => {
    const tool = findTool('record_ai_kit_review_result');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['taskId', 'status']);
    expect(tool.inputSchema.properties.status.enum).toEqual(['passed', 'failed', 'warnings']);
  });

  it('rejects an invalid status value', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-aikit-badstatus-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({ id: 'task-aikit-bad', taskMode: 'developer' })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('record_ai_kit_review_result', { taskId: 'task-aikit-bad', status: 'ok' });
      expect(result.error).toContain('Invalid status');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('persists the review to implementationVerification.aiCodeReview and task.aiKitReview without calling any external system', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-aikit-record-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({ id: 'task-aikit-record', taskMode: 'developer' })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('record_ai_kit_review_result', {
        taskId: 'task-aikit-record',
        status: 'passed',
        reviewedFiles: ['Scripts/nvr_servicecase_events.js'],
        findings: ['No TODOs found.', 'Client API usage correct.'],
      });
      expect(result.recorded).toBe(true);

      const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      const saved = raw.find((t) => t.id === 'task-aikit-record');
      expect(saved.implementationVerification.aiCodeReview).toMatchObject({
        status: 'passed',
        reviewSource: 'claude-ai-kit',
        reviewedFiles: ['Scripts/nvr_servicecase_events.js'],
        findings: ['No TODOs found.', 'Client API usage correct.'],
      });
      // Keeps continue_developer_workflow's separate pre-branch AI Kit gate from dead-ending.
      expect(saved.aiKitReview).toMatchObject({ status: 'passed', reviewSource: 'claude-ai-kit' });
      expect(saved.aiKitReview.completedAt).toBeDefined();

      // implementationVerification.aiCodeReview (the modal-visible row) now reports the recorded
      // status instead of needs_manual_action/not-run.
      const summary = await callToolFallback('get_implementation_verification_summary', { taskId: 'task-aikit-record' });
      expect(summary.implementationVerification.aiCodeReview.status).toBe('passed');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('resolves the AI Kit review gate so continue_developer_workflow no longer dead-ends on it', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-aikit-cdw-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({
      id: 'task-aikit-cdw',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      localTestRecord: { status: 'passed', updatedAt: '2026-06-15T10:00:00.000Z' },
      crmVerificationReports: [{ verdict: 'pass' }],
      // No aiKitReview yet.
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const before = await callToolFallback('continue_developer_workflow', { taskId: 'task-aikit-cdw' });
      expect(before.nextAction).toBe('run_ai_kit_review');

      // Hard gate: status='passed' alone is not enough — reviewedFiles/rulesFiles/checklistFiles/
      // knownPrReviewFiles must also be non-empty for the gate to actually pass.
      await callToolFallback('record_ai_kit_review_result', {
        taskId: 'task-aikit-cdw',
        status: 'passed',
        reviewedFiles: ['Scripts/nvr.js'],
        rulesFiles: ['ai-rules/crm-javascript-rules.md'],
        checklistFiles: ['ai-rules/crm-code-review-checklist.md'],
        knownPrReviewFiles: ['ai-rules/known-pr-review-comments.md'],
      });

      const after = await callToolFallback('continue_developer_workflow', { taskId: 'task-aikit-cdw' });
      expect(after.nextAction).not.toBe('run_ai_kit_review');
      expect(after.nextAction).toBe('propose_branch');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  // ── gateStatus / missingReviewDetails hard-gate response fields ─────────────────────────

  it('returns gateStatus="passed" when status=passed and all detail fields are non-empty', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-aikit-gate-passed-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({ id: 'task-aikit-gate-passed', taskMode: 'developer' })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('record_ai_kit_review_result', {
        taskId: 'task-aikit-gate-passed',
        status: 'passed',
        reviewedFiles: ['Scripts/nvr.js'],
        rulesFiles: ['ai-rules/crm-javascript-rules.md'],
        checklistFiles: ['ai-rules/crm-code-review-checklist.md'],
        knownPrReviewFiles: ['ai-rules/known-pr-review-comments.md'],
      });
      expect(result.gateStatus).toBe('passed');
      expect(result.missingReviewDetails).toEqual([]);
      expect(result.nextRecommendedStep).toBe('Call run_implementation_verification again to confirm all automated checks are resolved.');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns gateStatus="incomplete" when status=passed but the detail fields are empty', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-aikit-gate-incomplete-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({ id: 'task-aikit-gate-incomplete', taskMode: 'developer' })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('record_ai_kit_review_result', { taskId: 'task-aikit-gate-incomplete', status: 'passed' });
      expect(result.gateStatus).toBe('incomplete');
      expect(result.missingReviewDetails).toEqual(expect.arrayContaining([
        'reviewedFiles is empty', 'rulesFiles is empty', 'checklistFiles is empty', 'knownPrReviewFiles is empty',
      ]));
      expect(result.nextRecommendedStep).toContain('gateStatus=incomplete');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns gateStatus="failed" when fixableFindings is present, even though status=passed', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-aikit-gate-fixable-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([makeTask({ id: 'task-aikit-gate-fixable', taskMode: 'developer' })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('record_ai_kit_review_result', {
        taskId: 'task-aikit-gate-fixable',
        status: 'passed',
        reviewedFiles: ['Scripts/nvr.js'],
        rulesFiles: ['ai-rules/crm-javascript-rules.md'],
        checklistFiles: ['ai-rules/crm-code-review-checklist.md'],
        knownPrReviewFiles: ['ai-rules/known-pr-review-comments.md'],
        fixableFindings: [{ id: 'todo-left-in', description: 'Remove leftover TODO comment.' }],
      });
      expect(result.gateStatus).toBe('failed');
      expect(result.missingReviewDetails).toContain('fixableFindings is non-empty');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// get_task_workbench_mcp_capabilities tool + tooling-availability fail-fast guard
// ---------------------------------------------------------------------------

describe('get_task_workbench_mcp_capabilities tool', () => {
  async function importHelpers() {
    const { default: os } = await import('node:os');
    const { default: fs } = await import('node:fs/promises');
    const { default: path } = await import('node:path');
    return { os, fs, path };
  }

  it('tool definition is present and read-only, with no required arguments', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'get_task_workbench_mcp_capabilities');
    expect(tool).toBeDefined();
    expect(READ_ONLY_TOOL_NAMES.has('get_task_workbench_mcp_capabilities')).toBe(true);
    expect(tool.inputSchema.required ?? []).toEqual([]);
  });

  it('is answerable even with no bridge and no --data-dir/--fallback-readonly flags (bridgeMode=offline)', async () => {
    // This is the exact scenario that must never throw "bridge is not running" — the whole point
    // of this tool is to diagnose that condition, not fail with the same opaque error as everything else.
    const origArgv = process.argv;
    process.argv = process.argv.filter((a) => a !== '--data-dir' && a !== '--fallback-readonly');
    try {
      const result = await callToolFallback('get_task_workbench_mcp_capabilities', {});
      expect(result.bridgeMode).toBe('offline');
      expect(result.canRunDeveloperWorkflow).toBe(false);
      expect(result.recommendedAction).toContain('Start the Task Workbench app');
    } finally {
      process.argv = origArgv;
    }
  });

  it('reports canRecordAiKitReview=true and no missing tools when running with --data-dir (js-fallback mode)', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-capabilities-'));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('get_task_workbench_mcp_capabilities', {});
      expect(result.bridgeMode).toBe('js-fallback');
      expect(result.canRecordAiKitReview).toBe(true);
      expect(result.canRunImplementationVerification).toBe(true);
      expect(result.canRunDeveloperWorkflow).toBe(true);
      expect(result.missingRequiredTools).toEqual([]);
      expect(result.requiredDeveloperWorkflowTools).toEqual(REQUIRED_DEVELOPER_WORKFLOW_TOOLS);
      expect(result.recommendedAction).toBeNull();
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('reports record_ai_kit_review_result as missingRequiredTools when absent from the toolset', () => {
    // Simulates a stale/older running process whose tool list predates this tool — exactly the
    // live failure this feature exists to diagnose.
    const definedNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    definedNames.delete('record_ai_kit_review_result');

    const capabilities = computeMcpCapabilitiesFromToolNames(definedNames, { dataDir: '/tmp/x', fallbackReadOnly: false });
    expect(capabilities.missingRequiredTools).toEqual(['record_ai_kit_review_result']);
    expect(capabilities.canRecordAiKitReview).toBe(false);
    expect(capabilities.canRunDeveloperWorkflow).toBe(false);
    // run_implementation_verification itself is unaffected — only the AI Kit review path is.
    expect(capabilities.canRunImplementationVerification).toBe(true);
    expect(capabilities.recommendedAction).toContain('record_ai_kit_review_result');
  });

  it('allows record_ai_kit_review_result in the fallback write allowlist only when --data-dir is set', () => {
    expect(FALLBACK_WRITE_ALLOWED_TOOL_NAMES.has('record_ai_kit_review_result')).toBe(true);
    const withDataDir = computeMcpCapabilitiesFromToolNames(new Set(TOOL_DEFINITIONS.map((t) => t.name)), { dataDir: '/tmp/x', fallbackReadOnly: false });
    expect(withDataDir.canRecordAiKitReview).toBe(true);
    const withoutDataDir = computeMcpCapabilitiesFromToolNames(new Set(TOOL_DEFINITIONS.map((t) => t.name)), { dataDir: undefined, fallbackReadOnly: true });
    expect(withoutDataDir.canRecordAiKitReview).toBe(false);
  });
});

describe('applyToolingAvailabilityGuard — run_implementation_verification fail-fast', () => {
  async function importHelpers() {
    const { default: os } = await import('node:os');
    const { default: fs } = await import('node:fs/promises');
    const { default: path } = await import('node:path');
    return { os, fs, path };
  }

  it('passes nextAction=run_ai_kit_review through unchanged when record_ai_kit_review_result is available', () => {
    const result = applyToolingAvailabilityGuard('pending_ai_kit_review', 'run_ai_kit_review', { canRecordAiKitReview: true });
    expect(result).toEqual({ status: 'pending_ai_kit_review', nextAction: 'run_ai_kit_review', missingRequiredTools: [] });
  });

  it('overrides to tooling_error/reload_mcp_or_start_app when record_ai_kit_review_result is unavailable', () => {
    // run_implementation_verification must never report status=pending_ai_kit_review /
    // nextAction=run_ai_kit_review when record_ai_kit_review_result is unavailable — the agent
    // would be told to call a tool that does not exist in its current environment.
    const result = applyToolingAvailabilityGuard('pending_ai_kit_review', 'run_ai_kit_review', { canRecordAiKitReview: false });
    expect(result.status).toBe('tooling_error');
    expect(result.nextAction).toBe('reload_mcp_or_start_app');
    expect(result.missingRequiredTools).toEqual(['record_ai_kit_review_result']);
  });

  it('does not touch unrelated nextAction values even when record_ai_kit_review_result is unavailable', () => {
    const result = applyToolingAvailabilityGuard('passed', 'continue_workflow', { canRecordAiKitReview: false });
    expect(result).toEqual({ status: 'passed', nextAction: 'continue_workflow', missingRequiredTools: [] });
  });

  it('run_implementation_verification actually applies the guard end-to-end when the tool is available', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-riv-tooling-ok-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(scriptsDir, 'nvr_servicecase_events.js'), 'function noop() {}');
    const task = {
      id: 'task-riv-tooling-ok',
      title: 'Script: Předvyplnění servisního požadavku',
      status: 'in-progress',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    };
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const result = await callToolFallback('run_implementation_verification', { taskId: 'task-riv-tooling-ok' });
      // record_ai_kit_review_result is available in this toolset, so the AI Kit review step must
      // never be silently downgraded to tooling_error.
      expect(result.status).not.toBe('tooling_error');
      expect(result.nextAction).not.toBe('reload_mcp_or_start_app');
      expect(result.missingRequiredTools).toEqual([]);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// get_implementation_verification_summary tool
// ---------------------------------------------------------------------------

describe('get_implementation_verification_summary tool', () => {
  async function importHelpers() {
    const { default: os } = await import('node:os');
    const { default: fs } = await import('node:fs/promises');
    const { default: path } = await import('node:path');
    return { os, fs, path };
  }

  it('tool definition is present and read-only', () => {
    const tool = findTool('get_implementation_verification_summary');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['taskId']);
    expect(READ_ONLY_TOOL_NAMES.has('get_implementation_verification_summary')).toBe(true);
  });

  it('returns the same summary and nextRecommendedStep as run_implementation_verification without re-running checks', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-givs-1-'));
    const scriptsDir = path.join(tmpDir, 'Scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(
      path.join(scriptsDir, 'nvr_servicecase_events.js'),
      'function nvr_assetid_OnChange(ctx) { Xrm.WebApi.retrieveRecord("nvr_customerasset", "id"); }',
    );
    const task = makeTask({
      id: 'task-givs-1',
      title: 'Script: Předvyplnění servisního požadavku',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: tmpDir, artifactPath: 'Scripts/nvr_servicecase_events.js' },
      crmDeveloperWorkflow: {
        detectedWorkKind: 'script',
        planApproval: { approved: true },
        technicalPlan: {
          workKind: 'script', summary: 'Prefill.', implementationSteps: [],
          fieldMappings: [
            { source: 'nvr_customerasset.nvr_customerid', target: 'nvr_servicecase.nvr_customerid' },
            { source: 'nvr_customerasset.nvr_contactid', target: 'nvr_servicecase.nvr_contactid' },
            { source: 'nvr_customerasset.nvr_isunderwarranty', target: 'nvr_servicecase.nvr_iswarrantycase' },
          ],
          risks: [], testChecklist: [],
        },
      },
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir];
    try {
      const ranResult = await callToolFallback('run_implementation_verification', { taskId: 'task-givs-1' });
      const summaryResult = await callToolFallback('get_implementation_verification_summary', { taskId: 'task-givs-1' });

      expect(summaryResult.implementationVerification).toEqual(ranResult.implementationVerification);
      expect(summaryResult.unresolvedRequiredRows.sort()).toEqual(ranResult.unresolvedRequiredRows.sort());
      expect(summaryResult.nextRecommendedStep).toBe(ranResult.nextRecommendedStep);
      expect(summaryResult.nextAction).toBe(ranResult.nextAction);
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns not-run/needs_manual_action summary for a task where nothing has been verified yet', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-givs-2-'));
    const task = makeTask({
      id: 'task-givs-2',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_implementation_verification_summary', { taskId: 'task-givs-2' });
      expect(result.implementationVerification.buildCheck.status).toBe('not-run');
      expect(result.implementationVerification.dataverseCheck.status).toBe('needs_manual_action');
      expect(result.nextAction).toBe('wait_for_user');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns error for missing task', async () => {
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-givs-3-'));
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([]));
    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_implementation_verification_summary', { taskId: 'does-not-exist' });
      expect(result.error).toContain('Task not found');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('legacy task.localTestRecord cannot make the modal-visible localTest row appear resolved', async () => {
    // Regression: record_ai_implementation_completed sets task.localTestRecord.status='not-needed'
    // (the continue_developer_workflow step-1 gate) — that must never leak into or be conflated
    // with implementationVerification.localTest (the modal's Local Test row).
    const { os, fs, path } = await importHelpers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-mcp-givs-4-'));
    const task = makeTask({
      id: 'task-givs-4',
      taskMode: 'developer',
      workflowSetup: { devTargetKind: 'script', repositoryRoot: 'C:\\Repo', artifactPath: 'Scripts\\nvr.js' },
      crmDeveloperWorkflow: { detectedWorkKind: 'script' },
      localTestRecord: {
        status: 'not-needed',
        note: 'Script implementation completed by AI — no local test required before Dataverse upload.',
      },
    });
    await fs.writeFile(path.join(tmpDir, 'tasks.json'), JSON.stringify([task]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('get_implementation_verification_summary', { taskId: 'task-givs-4' });
      expect(result.implementationVerification.localTest.status).toBe('needs_manual_action');
      expect(result.implementationVerification.localTest.message).toBe(
        'Record Local Test in the Implementation Verification modal after manual/browser CRM testing (or mark it not-needed there).',
      );
      expect(result.implementationVerification.localTest).not.toHaveProperty('note');
      expect(JSON.stringify(result.implementationVerification.localTest).toLowerCase()).not.toContain('localtestrecord');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
