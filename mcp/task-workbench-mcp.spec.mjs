import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLIC_TOOL_NAMES,
  TOOL_DEFINITIONS,
  callTool,
  handleRequest,
} from './task-workbench-mcp.mjs';

const MUTATION_TOOLS = new Set([
  'create_work_item',
  'update_work_item',
  'patch_work_item',
  'transition_work_item',
  'append_work_item_note',
]);

function findTool(name) {
  const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
  expect(tool, `tool '${name}' should be defined`).toBeDefined();
  return tool;
}

// Minimal stand-in for the Rust bridge's POST /mcp/tools/call endpoint, so
// callTool()'s HTTP/error-propagation path can be exercised without a real
// Task Workbench instance running.
function withMockBridge(respond) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const { status, payload } = respond(body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
    server.on('error', reject);
  });
}

describe('Task Workbench MCP 2.x boundary', () => {
  it('exposes only canonical task-data tools', () => {
    expect([...PUBLIC_TOOL_NAMES].sort()).toEqual([
      'append_work_item_note',
      'create_work_item',
      'get_planning_today',
      'get_task_record',
      'get_work_item',
      'list_work_item_changes',
      'list_work_items',
      'patch_work_item',
      'transition_work_item',
      'update_work_item',
    ]);
  });

  it('does not advertise execution, git, deployment, prompt, or agent tools', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name).join(' ').toLowerCase();
    for (const forbidden of ['git', 'deploy', 'execute', 'prompt', 'agent', 'commit', 'push']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('publishes revision requirements on every mutation after create', () => {
    for (const name of [
      'update_work_item',
      'patch_work_item',
      'transition_work_item',
      'append_work_item_note',
    ]) {
      const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
      expect(tool.inputSchema.required).toContain('expectedRevision');
    }
  });

  it('returns a provider-neutral initialize contract', async () => {
    const response = await handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(response.result.serverInfo.version).toBe('2.0.0');
    expect(response.result.instructions).toContain('never performs the represented work');
    expect(response.result.instructions).toContain('never orchestrates coding agents');
    expect(response.result.instructions).toContain('never executes Git');
    expect(response.result.instructions).toContain('Prefer the narrowest read tool');
  });

  it('lists exactly the supported public definitions', async () => {
    const response = await handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(response.result.tools.map((tool) => tool.name)).toEqual(
      TOOL_DEFINITIONS.map((tool) => tool.name),
    );
  });

  it('tools/list contains only task/context-data tools, no Git/agent/execution/deployment tools', () => {
    const forbidden = [
      'commit_task_changes',
      'push_task_branch',
      'create_branch_for_task',
      'create_or_checkout_task_branch',
      'record_pull_request_created',
      'record_manual_deployment',
      'run_implementation_verification',
      'continue_developer_workflow',
      'save_generated_file',
      'create_plugin_project',
    ];
    const names = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
    for (const name of forbidden) {
      expect(names.has(name)).toBe(false);
    }
  });

  describe('list_work_items filter parity with GET /api/v1/work-items', () => {
    const tool = findTool('list_work_items');

    it('exposes the full canonical filter contract', () => {
      expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
        [
          'includeArchived',
          'limit',
          'cursor',
          'status',
          'kind',
          'owner',
          'area',
          'source',
          'planningBucket',
          'dueBefore',
          'dueAfter',
          'updatedAfter',
        ].sort(),
      );
    });

    it('constrains status to the canonical lifecycle enum', () => {
      expect(tool.inputSchema.properties.status.enum).toEqual([
        'planned',
        'ready',
        'in_progress',
        'waiting',
        'blocked',
        'review',
        'completed',
        'cancelled',
      ]);
    });

    it('constrains kind to task/obligation', () => {
      expect(tool.inputSchema.properties.kind.enum).toEqual(['task', 'obligation']);
    });

    it('accepts dueBefore/dueAfter/updatedAfter as unconstrained date-time strings', () => {
      for (const field of ['dueBefore', 'dueAfter', 'updatedAfter']) {
        expect(tool.inputSchema.properties[field].type).toBe('string');
      }
    });

    it('accepts planningBucket without inferring membership', () => {
      expect(tool.inputSchema.properties.planningBucket.type).toBe('string');
    });

    it('supports bounded pagination', () => {
      expect(tool.inputSchema.properties.limit).toMatchObject({
        type: 'integer',
        minimum: 1,
        maximum: 500,
      });
      expect(tool.inputSchema.properties.cursor.type).toBe('string');
    });

    it('fails closed on an unrecognized filter (additionalProperties: false)', () => {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    });
  });

  it('has no canonical search tool while documenting the filter-based alternative', () => {
    expect(TOOL_DEFINITIONS.some((tool) => tool.name === 'search_work_items')).toBe(false);
  });

  it('sets truthful readOnlyHint/destructiveHint annotations on every tool', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.annotations, `tool '${tool.name}' should carry annotations`).toBeDefined();
      expect(tool.annotations.readOnlyHint).toBe(!MUTATION_TOOLS.has(tool.name));
    }
    expect(findTool('update_work_item').annotations.destructiveHint).toBe(true);
  });

  describe('structured output contract', () => {
    it('list_work_items and get_planning_today declare a machine-readable outputSchema', () => {
      for (const name of ['list_work_items', 'get_planning_today']) {
        const tool = findTool(name);
        expect(tool.outputSchema).toBeDefined();
        expect(tool.outputSchema.required).toEqual(
          expect.arrayContaining(['apiVersion', 'generatedAt']),
        );
      }
    });
  });

  describe('bridge call behavior', () => {
    const servers = [];
    afterEach(() => {
      while (servers.length) servers.pop().close();
    });

    it('rejects a Git/agent tool name before any network call', async () => {
      await expect(callTool('commit_task_changes', {})).rejects.toThrow(
        /not part of the Task Workbench 2\.x task-data interface/,
      );
    });

    it('returns the bridge result on success', async () => {
      const bridge = await withMockBridge((body) => {
        expect(body.name).toBe('list_work_items');
        expect(body.args).toEqual({ status: 'in_progress' });
        return { status: 200, payload: { ok: true, result: { items: [] } } };
      });
      servers.push(bridge);
      process.env.TASK_WORKBENCH_BRIDGE_TOKEN ||= 'test-only-bridge-token-000000000000';
      const result = await callTool('list_work_items', { status: 'in_progress' }, bridge.url);
      expect(result).toEqual({ items: [] });
      // Slow on the first call only: loadBridgeToken() first probes Windows
      // Credential Manager via a spawned powershell.exe (up to its own 5s
      // timeout) before falling back to TASK_WORKBENCH_BRIDGE_TOKEN above.
    }, 10_000);

    it('propagates a revision_conflict from the bridge instead of silently succeeding', async () => {
      const bridge = await withMockBridge(() => ({
        status: 409,
        payload: {
          ok: false,
          error: { code: 'revision_conflict', message: 'Expected revision 2, but current revision is 3.', currentRevision: 3 },
        },
      }));
      servers.push(bridge);
      process.env.TASK_WORKBENCH_BRIDGE_TOKEN ||= 'test-only-bridge-token-000000000000';
      await expect(
        callTool('patch_work_item', { id: 'x', patch: {}, expectedRevision: 2 }, bridge.url),
      ).rejects.toThrow(/Expected revision 2, but current revision is 3/);
    });

    it('surfaces a rejected tool call as isError content via tools/call, never as a silent success', async () => {
      const response = await handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'commit_task_changes', arguments: {} },
      });
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toMatch(/not part of the Task Workbench 2\.x task-data interface/);
    });
  });
});
