/**
 * Unit tests for task-workbench MCP bridge (v0.5.0).
 *
 * Imports named exports from the bridge script (READ_ONLY_TOOL_NAMES,
 * TOOL_DEFINITIONS, callToolFallback).  The VITEST env var prevents
 * the script's process.exit handler from firing during tests.
 */
import { describe, it, expect } from 'vitest';
import { READ_ONLY_TOOL_NAMES, TOOL_DEFINITIONS, TASK_TEMPLATES, matchTaskTemplate, callToolFallback } from './task-workbench-mcp.mjs';

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
      expect(packet.dataverse.verificationStatus).toBe('not_available_for_js_ts_mcp');
      expect(packet.dataverse.instruction).toContain('Verify Implementation modal');
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

  it('returns wait_for_user for Dataverse verification after local test recorded (script task)', async () => {
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
      // No implementationVerification — Dataverse check not done
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-nodv' });
      expect(result.nextAction).toBe('wait_for_user');
      expect(result.requiresUserApproval).toBe(true);
      expect(result.blockingUserAction).toContain('Verify Implementation modal');
      expect(result.nextAction).not.toBe('mark_done');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns wait_for_user for AI Kit review after Dataverse verification done', async () => {
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
      expect(result.nextAction).toBe('wait_for_user');
      expect(result.requiresUserApproval).toBe(true);
      expect(result.blockingUserAction).toContain('AI Kit review');
    } finally {
      process.argv = origArgv;
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('returns propose_branch with requiresUserApproval=true after all verifications done', async () => {
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
      implementationVerification: { dataverseCheck: { status: 'skipped' } },
      aiKitReview: { status: 'passed', completedAt: '2026-06-15T10:05:00.000Z' },
    })]));

    const origArgv = process.argv;
    process.argv = [...process.argv, '--data-dir', tmpDir, '--fallback-readonly'];
    try {
      const result = await callToolFallback('continue_developer_workflow', { taskId: 'task-cdw-branch' });
      expect(result.nextAction).toBe('propose_branch');
      // Branch creation must require explicit user approval
      expect(result.requiresUserApproval).toBe(true);
      expect(result.forbiddenWrites).not.toContain('commit_task_changes');
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
      expect(result.canProceed).toBe(false);
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
      expect(result.warnings).toContain('Dataverse metadata verification for JS/TS is not available through MCP. Use the in-app Verify Implementation modal after implementation/upload.');
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
});
