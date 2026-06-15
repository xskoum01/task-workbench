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

