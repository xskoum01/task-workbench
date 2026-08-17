import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativeFromThisFile) {
  return readFileSync(new URL(relativeFromThisFile, import.meta.url), 'utf8');
}

describe('product capability boundary', () => {
  it('keeps the active navigation focused on records and context', () => {
    const app = source('../App.tsx');
    for (const page of ['OverviewPage', 'InboxPage', 'TasksPage', 'ObligationsPage', 'ActivityPage']) {
      expect(app).toContain(page);
    }
    for (const forbidden of ['TaskDetail', 'WorkflowStepper', 'AiKitActionsPanel', 'GitCommitModal']) {
      expect(app).not.toContain(forbidden);
    }
  });

  it('does not expose execution or repository mutation commands through the canonical MCP boundary', () => {
    const rust = source('../../src-tauri/src/lib.rs');
    const canonicalTools = rust.match(/fn canonical_mcp_tool_definitions\(\) -> Vec<Value> \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(canonicalTools).not.toBe('');
    for (const forbidden of [
      'create_git_branch',
      'commit_task_changes',
      'push_task_branch',
      'generate_crm_skeleton',
      'create_plugin_project',
      'save_generated_file',
      'run_ai_kit_implementation',
    ]) {
      expect(canonicalTools).not.toContain(forbidden);
    }
  });

  it('fails closed at the bridge dispatcher: only canonical tools execute, no fallback to legacy Git/deployment tools', () => {
    // The definitions-only check above passed even while task_mcp_execute_tool (the function
    // POST /mcp/tools/call actually calls) still fell through to the archived Git/PR/deployment
    // match block for any unlisted name. This test reads the dispatcher's own body — the thing
    // POST /mcp/tools/call actually calls — instead of just the published tool list.
    const rust = source('../../src-tauri/src/lib.rs');
    const dispatcherMatch = rust.match(/fn task_mcp_execute_tool\([\s\S]*?\n\}\n\nfn task_mcp_http_response/);
    expect(dispatcherMatch, 'task_mcp_execute_tool body should be present').not.toBeNull();
    const dispatcher = dispatcherMatch[0];

    expect(dispatcher).toContain('task_mcp_is_canonical_tool_name(tool_name)');
    const gateIndex = dispatcher.indexOf('return Err(format!(');
    expect(gateIndex, 'a non-canonical tool name must hit an unconditional reject, not a legacy fallback').toBeGreaterThan(-1);
    expect(dispatcher.slice(gateIndex, gateIndex + 400)).toContain('unknown_tool');

    for (const forbidden of [
      'commit_task_changes',
      'push_task_branch',
      'create_or_checkout_task_branch',
      'record_pull_request_created',
      'record_manual_deployment',
    ]) {
      const forbiddenIndex = dispatcher.indexOf(`"${forbidden}"`);
      expect(forbiddenIndex, `'${forbidden}' is expected to remain as archived source`).toBeGreaterThan(-1);
      expect(forbiddenIndex, `'${forbidden}' must be unreachable — its match arm must appear after the fail-closed gate`).toBeGreaterThan(gateIndex);
    }

    // Exactly one call site may dispatch into this gate — a second entry point calling into the
    // same match block would bypass the gate above without this test noticing.
    const callSites = rust.match(/task_mcp_execute_tool\(app,/g) ?? [];
    expect(callSites.length).toBe(1);
  });

  it('keeps archived developer workflow out of the executable MCP entry point', () => {
    const mcp = source('../../mcp/task-workbench-mcp.mjs');
    for (const forbiddenTool of [
      "'commit_task_changes'",
      "'push_task_branch'",
      "'continue_developer_workflow'",
      "'run_implementation_verification'",
      "'record_manual_deployment'",
    ]) {
      expect(mcp).not.toContain(forbiddenTool);
    }
  });

  it('keeps modal semantics, focus trapping, and focus restoration in the shared primitive', () => {
    const modal = source('../components/Modal.tsx');
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain("e.key !== 'Tab'");
    expect(modal).toContain('previouslyFocused.focus()');
  });
});
