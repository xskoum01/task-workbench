/**
 * Unit tests for task-workbench MCP bridge (v0.5.0).
 *
 * Imports named exports from the bridge script (READ_ONLY_TOOL_NAMES,
 * TOOL_DEFINITIONS, callToolFallback).  The VITEST env var prevents
 * the script's process.exit handler from firing during tests.
 */
import { describe, it, expect } from 'vitest';
import { READ_ONLY_TOOL_NAMES, TOOL_DEFINITIONS, callToolFallback } from './task-workbench-mcp.mjs';

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
// and READ_ONLY_TOOL_NAMES directly — no mock needed.

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

  it('does NOT contain record_external_action_completed (it is a write tool)', () => {
    expect(READ_ONLY_TOOL_NAMES.has('record_external_action_completed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. set_task_work_classification — workKind enum
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
// 3. save_technical_plan — pluginTarget / scriptTarget schema
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
// 5. callToolFallback — new read tools (with synthetic task data)
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

describe('callToolFallback — get_dataverse_verification_report', () => {
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

describe('callToolFallback — get_external_action_proposal', () => {
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

describe('callToolFallback — get_implementation_verification_state', () => {
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
// 6. save_technical_plan fallback — persists pluginTarget / scriptTarget
//    (schema validation only; actual persistence is in the bridge/Rust)
// ---------------------------------------------------------------------------
describe('save_technical_plan — target field presence in schema', () => {
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
