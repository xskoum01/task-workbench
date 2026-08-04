import { describe, expect, it } from 'vitest';
import {
  PUBLIC_TOOL_NAMES,
  TOOL_DEFINITIONS,
  handleRequest,
} from './task-workbench-mcp.mjs';

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
    expect(response.result.instructions).toContain('does not execute tasks');
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
});
