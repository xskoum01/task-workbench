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
