#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SERVER_NAME = 'task-workbench-mcp-bridge';
const SERVER_VERSION = '0.4.0';
const APP_IDENTIFIER = 'com.vskoumal.task-workbench';
const PRODUCT_NAME = 'Task Workbench';
const MAX_SUMMARY_LENGTH = 700;
const MAX_COMMENT_LENGTH = 900;
const DEFAULT_BRIDGE_URL = process.env.TASK_WORKBENCH_BRIDGE_URL || 'http://127.0.0.1:38473';

let cachedBridgeToken = null;

const READ_ONLY_TOOL_NAMES = new Set([
  'list_tasks',
  'get_task',
  'get_task_summary',
  'get_task_full_context',
  'get_task_workflow_overview',
  'get_task_original_message',
  'get_task_developer_setup',
  'get_crm_workflow_state',
  'get_current_crm_workflow_step',
  'get_technical_plan',
  'get_pr_review_state',
  'get_next_recommended_step',
  'prepare_commit_for_task',
]);

const TOOL_DEFINITIONS = [
  {
    name: 'list_tasks',
    description: 'List sanitized task-workbench tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional task status filter.' },
        developerOnly: { type: 'boolean', description: 'When true, include only developer/CRM workflow tasks.' },
        limit: { type: 'number', description: 'Maximum number of tasks to return. Defaults to 25, capped at 100.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    description: 'Get one sanitized task by id. Does not include raw email HTML or full message body.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_summary',
    description: 'Get one sanitized task summary by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_crm_workflow_state',
    description: 'Get sanitized CRM Developer Workflow state for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_technical_plan',
    description: 'Get the persisted local technical implementation plan for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_current_crm_workflow_step',
    description: 'Get the current CRM workflow step and approval/checkpoint status for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_pr_review_state',
    description: 'Get sanitized local PR proposal, tracking, review intake, analysis, and fix proposal state.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_next_recommended_step',
    description: 'Get a conservative next recommended local CRM workflow step for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'append_task_note',
    description: 'Append a sanitized local note to task.notes for a given taskId.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['taskId', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_task_status',
    description: 'Set task.status with enum validation. Local write only.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['taskId', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_task_attention_state',
    description: 'Set task.attentionState with enum validation (or clear with null). Local write only.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        attentionState: { type: ['string', 'null'] },
      },
      required: ['taskId', 'attentionState'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_task_waiting_state',
    description: 'Set task.waitingState with enum validation (or clear with null). Local write only.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        waitingState: { type: ['string', 'null'] },
      },
      required: ['taskId', 'waitingState'],
      additionalProperties: false,
    },
  },
  // ── Task creation / deletion ───────────────────────────────────────────────
  {
    name: 'create_task',
    description: 'Create a new local task-workbench task. Validates all fields strictly. Does not write external systems.',
    inputSchema: {
      type: 'object',
      properties: {
        title:        { type: 'string' },
        source:       { type: 'string', enum: ['manual', 'email', 'teams', 'mcp', 'devops'] },
        taskType:     { type: 'string', enum: ['bug-fix', 'bug', 'feature', 'review', 'question', 'deployment', 'other'] },
        status:       { type: 'string', enum: ['new', 'analyzed', 'in-progress', 'ready-for-review', 'done', 'blocked'] },
        waitingState: { type: 'string', enum: ['none', 'pricing-approval', 'consultant-testing', 'code-review'] },
        mode:         { type: 'string', enum: ['developer', 'general'] },
        customerId:   { type: 'string' },
        notes:        { type: 'string' },
        summary:      { type: 'string' },
        estimateHours:{ type: 'number' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_test_task',
    description: 'Create a clearly marked temporary local task for MCP smoke testing. Returns the new task id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'delete_test_task',
    description: 'Delete a task created by create_test_task (mcpTestTask=true only). Cannot delete real tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  // ── New read tools ─────────────────────────────────────────────────────────
  {
    name: 'get_task_full_context',
    description: 'Get comprehensive task context: phase, mode, setup, estimate, checklist, notes, PR state, and next step.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_workflow_overview',
    description: 'Get simplified workflow state: display phase, waiting state, checklist rows, and next recommended step.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_original_message',
    description: 'Get sanitized original email/Teams/DevOps message content for a task.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_developer_setup',
    description: 'Get developer mode setup: mode, work kind, work action, repository root, plugin/script target.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  // ── New write tools ────────────────────────────────────────────────────────
  {
    name: 'save_task_analysis',
    description: 'Save local AI analysis: summary, requirements, assumptions, questions, risks, next step. No external writes.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        summary: { type: 'string' },
        requirements: { type: 'array', items: { type: 'string' } },
        assumptions:  { type: 'array', items: { type: 'string' } },
        questions:    { type: 'array', items: { type: 'string' } },
        risks:        { type: 'array', items: { type: 'string' } },
        suggestedNextStep: { type: 'string' },
      },
      required: ['taskId', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_task_summary',
    description: 'Update only the compact task summary and optional next-step text. Does not overwrite other analysis fields.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:   { type: 'string' },
        summary:  { type: 'string' },
        nextStep: { type: 'string' },
      },
      required: ['taskId', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_task_mode',
    description: 'Set task mode: developer or general.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        mode:   { type: 'string', enum: ['developer', 'general'] },
      },
      required: ['taskId', 'mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_task_work_classification',
    description: 'Set work kind (plugin/script/general/unknown) and work action (create/update/unknown). Strict enum validation.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:     { type: 'string' },
        workKind:   { type: 'string', enum: ['plugin', 'script', 'general', 'unknown'] },
        workAction: { type: 'string', enum: ['create', 'update', 'unknown'] },
      },
      required: ['taskId', 'workKind', 'workAction'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_task_developer_target',
    description: 'Set developer target fields: repository root, plugin project, script path, customer. Does not scan or write any files.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:                { type: 'string' },
        repositoryRoot:        { type: 'string' },
        selectedPluginProject: { type: 'string' },
        selectedScriptTarget:  { type: 'string' },
        customerId:            { type: 'string' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'confirm_task_setup',
    description: 'Record local setup confirmation timestamp. Advances status from new to analyzed.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_task_phase',
    description: 'Set task phase: new/analyzed/development/testing/review/done. Maps to internal status+waitingState model safely.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        phase:  { type: 'string', enum: ['new', 'analyzed', 'development', 'testing', 'review', 'done'] },
      },
      required: ['taskId', 'phase'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_local_test',
    description: 'Record local test result: not-started/passed/failed/not-needed. Updates checklist only.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string', enum: ['not-started', 'passed', 'failed', 'not-needed'] },
        note:   { type: 'string' },
      },
      required: ['taskId', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_consultant_testing',
    description: 'Record consultant testing status: requested/confirmed/failed/not-needed. Updates local workflow state only.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string', enum: ['requested', 'confirmed', 'failed', 'not-needed'] },
        note:   { type: 'string' },
      },
      required: ['taskId', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_task_estimate',
    description: 'Set task effort estimate in hours with optional budget note. Validates positive numeric input.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        hours:  { type: 'number' },
        note:   { type: 'string' },
      },
      required: ['taskId', 'hours'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_technical_plan',
    description: 'Save local technical plan: summary, steps, entities, test plan, risks. Does not write code or register anything.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:             { type: 'string' },
        planSummary:        { type: 'string' },
        implementationSteps:{ type: 'array', items: { type: 'string' } },
        affectedFiles:      { type: 'array', items: { type: 'string' } },
        crmEntities:        { type: 'array', items: { type: 'string' } },
        testPlan:           { type: 'array', items: { type: 'string' } },
        risks:              { type: 'array', items: { type: 'string' } },
      },
      required: ['taskId', 'planSummary'],
      additionalProperties: false,
    },
  },
  {
    name: 'mark_technical_plan_ready_for_approval',
    description: 'Mark saved technical plan as ready for user review. Requires save_technical_plan to have been called first.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_manual_pr',
    description: 'Record a pull request created manually outside task-workbench. Local tracking only — does not call GitHub or Azure DevOps.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:   { type: 'string' },
        provider: { type: 'string', enum: ['github', 'azure-devops', 'unknown'] },
        url:      { type: 'string' },
        title:    { type: 'string' },
        status:   { type: 'string' },
      },
      required: ['taskId', 'provider', 'url'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_pr_review_analysis',
    description: 'Save local PR review analysis: summary, action items, warnings. Does not reply to or resolve PR comments.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:      { type: 'string' },
        summary:     { type: 'string' },
        actionItems: { type: 'array', items: { type: 'string' } },
        warnings:    { type: 'array', items: { type: 'string' } },
      },
      required: ['taskId', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_pr_fix_proposal',
    description: 'Save local PR fix proposal: summary and proposed changes. Does not edit files, commit, or push.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:             { type: 'string' },
        summary:            { type: 'string' },
        proposedChanges:    { type: 'array', items: {
          type: 'object',
          properties: { title: { type: 'string' }, description: { type: 'string' } },
          required: ['title'],
          additionalProperties: false,
        }},
        implementationNotes:{ type: 'array', items: { type: 'string' } },
      },
      required: ['taskId', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_task_checklist_item',
    description: 'Set status of a local workflow checklist item. Strict key and status enum validation.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:  { type: 'string' },
        itemKey: { type: 'string', enum: ['task-analyzed','setup-confirmed','crm-metadata-verified','technical-plan-ready','implementation-done','local-test-done','consultant-testing','pull-request','code-review','done'] },
        status:  { type: 'string', enum: ['done','not-done','warning','blocked','optional'] },
      },
      required: ['taskId', 'itemKey', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_task_next_step',
    description: 'Set the AI-recommended next action and reason. Does not overwrite analysis or plan.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        action: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['taskId', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_dataverse_check_for_task',
    description:
      'Run a read-only Dataverse metadata check for a plugin task. ' +
      'Task Workbench resolves the implementation artifact, scans it for Dataverse logical-name ' +
      'references (entities, attributes, lookups), and verifies them against the connected ' +
      'Dataverse environment through the configured Primarch MCP integration. ' +
      'The verification report is saved to the local task state. ' +
      'This tool is READ-ONLY: no Dataverse writes, no Git writes, no file modifications ' +
      'other than persisting the report and optionally the inferred artifact path to local task state.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'ID of the task to verify.',
        },
        persistInferredArtifactPath: {
          type: 'boolean',
          description:
            'When true (default), if the artifact path is inferred from the project folder, ' +
            'persist it to workflowSetup.artifactPath for future use.',
        },
        primaryEntityOverride: {
          type: 'string',
          description:
            'Optional primary entity logical name override. ' +
            'Useful when the entity cannot be detected from the code automatically.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'prepare_commit_for_task',
    description:
      'Read-only preview of pending Git changes for a task. Returns the repository root, ' +
      'current branch, remote URL, list of changed files (with noise files excluded), ' +
      'warnings, and a suggested commit message derived from the task title and Azure DevOps ID. ' +
      'Does NOT stage, commit, or push anything. Use this before commit_task_changes.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'commit_task_changes',
    description:
      'WRITE — stages the specified files and creates a Git commit in the task repository. ' +
      'All file paths must be relative to the repository root. ' +
      'Noise files (bin/, obj/, .vs/, copilot-instructions, etc.) are automatically rejected. ' +
      'Does NOT push. Use push_task_branch or commit_and_push_task_changes to push afterwards. ' +
      'Only call this when the user has explicitly requested a commit.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:  { type: 'string', description: 'ID of the task.' },
        message: { type: 'string', description: 'Commit message.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relative file paths (from repo root) to stage and commit.',
        },
      },
      required: ['taskId', 'message', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'push_task_branch',
    description:
      'WRITE — pushes the current branch of the task repository to origin. ' +
      'Push to main/master is blocked. No force push. ' +
      'Only call this when the user has explicitly requested a push.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'commit_and_push_task_changes',
    description:
      'WRITE — stages files, creates a Git commit, and then pushes the current branch in one step. ' +
      'Equivalent to commit_task_changes followed by push_task_branch. ' +
      'Push to main/master is blocked. No force push. No PR creation. ' +
      'Only call this when the user has explicitly requested a commit and push. ' +
      'Set moveToReviewAfterPush=true to also move the task to Review / Waiting for code review ' +
      'after a successful push (default: false).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:  { type: 'string', description: 'ID of the task.' },
        message: { type: 'string', description: 'Commit message.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relative file paths (from repo root) to stage and commit.',
        },
        moveToReviewAfterPush: {
          type: 'boolean',
          description:
            'When true, moves the task to Review / Waiting for code review after a successful commit and push. ' +
            'Default: false. Only takes effect after a successful push.',
        },
      },
      required: ['taskId', 'message', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'mark_testing_confirmed_prepare_commit',
    description:
      'WRITE (local task state only) — marks consultant testing as confirmed and sets the next step ' +
      'to "Prepare commit and push". Does NOT commit, push, or move the task to Review. ' +
      'Use this when the consultant has confirmed the change and the developer needs to prepare a commit ' +
      'before requesting code review. ' +
      'To commit+push and move to Review in one step, use commit_and_push_task_changes with moveToReviewAfterPush=true.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task.' },
        note: { type: 'string', description: 'Optional note about the testing result.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
];

function getCliDataDir() {
  const index = process.argv.indexOf('--data-dir');
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return undefined;
}

function getCliBridgeUrl() {
  const index = process.argv.indexOf('--bridge-url');
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return DEFAULT_BRIDGE_URL;
}

function isFallbackReadOnlyEnabled() {
  return process.argv.includes('--fallback-readonly');
}

async function fetchBridgeToken(baseUrl) {
  try {
    const status = await bridgeRequestJson(baseUrl, '/mcp/status', null);
    const token = status?.bridgeToken ?? status?.result?.bridgeToken ?? null;
    if (token && typeof token === 'string') {
      cachedBridgeToken = token;
    }
  } catch {
    // token unavailable — proceed without token (will get 401 on write tools)
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function defaultDataDirCandidates() {
  const explicit = getCliDataDir() || process.env.TASK_WORKBENCH_DATA_DIR;
  const home = os.homedir();
  const platform = process.platform;
  const candidates = [];

  if (explicit) candidates.push(explicit);
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    candidates.push(
      appData && path.join(appData, APP_IDENTIFIER),
      appData && path.join(appData, PRODUCT_NAME),
      appData && path.join(appData, 'task-workbench'),
      localAppData && path.join(localAppData, APP_IDENTIFIER),
      localAppData && path.join(localAppData, PRODUCT_NAME),
      localAppData && path.join(localAppData, 'task-workbench'),
    );
  } else if (platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', APP_IDENTIFIER),
      path.join(home, 'Library', 'Application Support', PRODUCT_NAME),
      path.join(home, 'Library', 'Application Support', 'task-workbench'),
    );
  } else {
    const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    candidates.push(
      path.join(xdgDataHome, APP_IDENTIFIER),
      path.join(xdgDataHome, 'task-workbench'),
      path.join(home, '.config', APP_IDENTIFIER),
      path.join(home, '.config', 'task-workbench'),
    );
  }

  return unique(candidates);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveTasksFile() {
  for (const dir of defaultDataDirCandidates()) {
    const filePath = path.join(dir, 'tasks.json');
    if (await fileExists(filePath)) return filePath;
  }
  const first = defaultDataDirCandidates()[0];
  return first ? path.join(first, 'tasks.json') : undefined;
}

async function loadTasks() {
  const tasksFile = await resolveTasksFile();
  if (!tasksFile) {
    return { tasks: [], found: false, warning: 'Could not resolve a task-workbench data directory.' };
  }
  if (!(await fileExists(tasksFile))) {
    return {
      tasks: [],
      found: false,
      warning: 'tasks.json was not found. Set TASK_WORKBENCH_DATA_DIR or pass --data-dir to the MCP server if task-workbench stores data elsewhere.',
    };
  }

  const raw = await fs.readFile(tasksFile, 'utf8');
  const parsed = JSON.parse(raw);
  return { tasks: Array.isArray(parsed) ? parsed : [], found: true };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|td|th|h[1-6]|blockquote|pre|ul|ol|table|section|article|header|footer)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function summarize(value, maxLength = MAX_SUMMARY_LENGTH) {
  const text = stripHtml(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function latestVerification(task) {
  const reports = Array.isArray(task.crmVerificationReports) ? task.crmVerificationReports : [];
  const report = reports[0];
  if (!report) {
    return {
      exists: false,
      verdict: 'missing',
      summary: 'No CRM metadata verification report is stored for this task.',
    };
  }
  return {
    exists: true,
    verdict: report.verdict ?? report.status ?? 'unknown',
    createdAt: report.createdAt ?? report.generatedAt,
    summary: summarize(report.summary ?? report.message ?? 'CRM metadata verification report exists.'),
    issueCount: Array.isArray(report.issues) ? report.issues.length : report.issueCount,
    inspectedEntityCount: Array.isArray(report.inspectedEntities) ? report.inspectedEntities.length : report.inspectedEntityCount,
  };
}

function meaningfulVerification(verdict) {
  return ['pass', 'warnings', 'fail'].includes(verdict);
}

function approvalSummary(gate) {
  const value = asObject(gate);
  return {
    approved: value.approved === true && !value.invalidatedAt,
    approvedAt: value.approvedAt,
    invalidatedAt: value.invalidatedAt,
    invalidationReason: value.invalidationReason,
  };
}

function isDeveloperTask(task) {
  return task.taskMode === 'developer' || !!task.crmDeveloperWorkflow || !!task.workflowSetup || Array.isArray(task.crmVerificationReports);
}

function safeTaskSummary(task) {
  const analysis = asObject(task.analysisResult);
  const workflow = asObject(task.crmDeveloperWorkflow);
  return {
    id: task.id,
    title: task.title,
    source: task.source,
    taskType: task.taskType,
    status: task.status,
    customerId: task.customerId,
    receivedAt: task.receivedAt,
    dueAt: task.dueAt,
    classificationState: task.classificationState,
    taskMode: task.taskMode,
    developerWorkflowTask: isDeveloperTask(task),
    crmWorkflow: workflow.currentStep || workflow.detectedWorkKind ? {
      detectedWorkKind: workflow.detectedWorkKind,
      currentStep: workflow.currentStep,
      updatedAt: workflow.updatedAt,
    } : undefined,
    summary: summarize(analysis.summaryEn ?? analysis.summary ?? task.title),
  };
}

function safeTaskDetail(task) {
  const setup = asObject(task.workflowSetup);
  return {
    ...safeTaskSummary(task),
    analysis: sanitizeAnalysis(task.analysisResult),
    workflowSetup: sanitizeWorkflowSetup(setup),
    latestCrmVerification: latestVerification(task),
    crmWorkflowState: sanitizeCrmWorkflowState(task),
    adoContext: sanitizeAdoContext(task.adoContext),
  };
}

function sanitizeAnalysis(analysis) {
  const value = asObject(analysis);
  if (Object.keys(value).length === 0) return undefined;
  return {
    summary: summarize(value.summaryEn ?? value.summary),
    nextStep: summarize(value.nextStepEn ?? value.nextStep, 300),
    confidence: value.confidence,
    problemPoints: Array.isArray(value.problemPointsEn) ? value.problemPointsEn.slice(0, 8) : Array.isArray(value.problemPoints) ? value.problemPoints.slice(0, 8) : undefined,
    suggestedActions: Array.isArray(value.suggestedActions) ? value.suggestedActions.slice(0, 8).map((item) => ({
      id: item.id,
      label: item.label,
    })) : undefined,
  };
}

function sanitizeWorkflowSetup(setup) {
  if (Object.keys(setup).length === 0) return undefined;
  return {
    workIntent: setup.workIntent,
    devTargetKind: setup.devTargetKind,
    customerId: setup.customerId,
    pluginProject: setup.pluginProject,
    intendedPluginProjectName: setup.intendedPluginProjectName,
    scriptPath: setup.scriptPath,
    artifactPath: setup.artifactPath,
    repositoryRoot: setup.repositoryRoot,
  };
}

function sanitizeAdoContext(adoContext) {
  const value = asObject(adoContext);
  if (Object.keys(value).length === 0) return undefined;
  return {
    type: value.type,
    project: value.project,
    workItemId: value.workItemId,
    pullRequestId: value.pullRequestId,
    repository: value.repository,
    branch: value.branch,
    url: value.url,
  };
}

function sanitizeTechnicalPlan(plan) {
  const value = asObject(plan);
  if (Object.keys(value).length === 0) return undefined;
  return {
    generatedAt: value.generatedAt,
    generatedFromVerificationReportId: value.generatedFromVerificationReportId,
    workKind: value.workKind,
    summary: summarize(value.summary),
    target: value.target,
    implementationSteps: Array.isArray(value.implementationSteps) ? value.implementationSteps : [],
    dataverseFindings: Array.isArray(value.dataverseFindings) ? value.dataverseFindings : [],
    risks: Array.isArray(value.risks) ? value.risks : [],
    testChecklist: Array.isArray(value.testChecklist) ? value.testChecklist : [],
    externalActionPreview: Array.isArray(value.externalActionPreview) ? value.externalActionPreview : [],
  };
}

function sanitizeComments(comments) {
  if (!Array.isArray(comments)) return [];
  return comments.slice(0, 50).map((comment) => ({
    id: comment.id,
    author: comment.author,
    body: summarize(comment.body, MAX_COMMENT_LENGTH),
    filePath: comment.filePath,
    line: comment.line,
    isResolved: comment.isResolved,
    createdAt: comment.createdAt,
  }));
}

function sanitizeCrmWorkflowState(task) {
  const workflow = asObject(task.crmDeveloperWorkflow);
  if (Object.keys(workflow).length === 0) return undefined;
  return {
    detectedWorkKind: workflow.detectedWorkKind,
    currentStep: workflow.currentStep,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    approvals: {
      plan: approvalSummary(workflow.planApproval),
      diff: approvalSummary(workflow.diffApproval),
      externalAction: approvalSummary(workflow.externalActionApproval),
      pullRequest: approvalSummary(workflow.pullRequestApproval),
    },
    technicalPlan: sanitizeTechnicalPlan(workflow.technicalPlan),
    externalExecution: sanitizeExternalExecution(workflow.externalExecution),
    pullRequest: sanitizePullRequestState(workflow),
  };
}

function sanitizeExternalExecution(execution) {
  const value = asObject(execution);
  if (Object.keys(value).length === 0) return undefined;
  return {
    completed: value.completed === true && !value.invalidatedAt,
    completedAt: value.completedAt,
    notes: summarize(value.notes, 400),
    completedActionIds: Array.isArray(value.completedActionIds) ? value.completedActionIds : [],
    invalidatedAt: value.invalidatedAt,
    invalidationReason: value.invalidationReason,
  };
}

function sanitizePullRequestState(workflow) {
  return {
    proposal: sanitizePullRequestProposal(workflow.pullRequestProposal),
    tracking: sanitizePullRequestTracking(workflow.pullRequestTracking),
    review: sanitizePullRequestReview(workflow.pullRequestReview),
    analysis: sanitizePullRequestAnalysis(workflow.pullRequestReviewAnalysis),
    fixProposal: sanitizePullRequestFixProposal(workflow.pullRequestFixProposal),
    fixUpdateTracking: sanitizePullRequestFixUpdateTracking(workflow.pullRequestFixUpdateTracking),
  };
}

function sanitizePullRequestProposal(proposal) {
  const value = asObject(proposal);
  if (Object.keys(value).length === 0) return undefined;
  return {
    generatedAt: value.generatedAt,
    title: value.title,
    bodySummary: summarize(value.body),
    checklist: Array.isArray(value.checklist) ? value.checklist : [],
    warnings: Array.isArray(value.warnings) ? value.warnings : [],
    relatedArtifactPath: value.relatedArtifactPath,
    sourceSummary: summarize(value.sourceSummary, 400),
    invalidatedAt: value.invalidatedAt,
    invalidationReason: value.invalidationReason,
  };
}

function sanitizePullRequestTracking(tracking) {
  const value = asObject(tracking);
  if (Object.keys(value).length === 0) return undefined;
  return {
    createdManually: value.createdManually === true && !value.invalidatedAt,
    createdAt: value.createdAt,
    prUrl: value.prUrl,
    notes: summarize(value.notes, 400),
    invalidatedAt: value.invalidatedAt,
    invalidationReason: value.invalidationReason,
  };
}

function sanitizePullRequestReview(review) {
  const value = asObject(review);
  if (Object.keys(value).length === 0) return undefined;
  return {
    fetchedAt: value.fetchedAt,
    provider: value.provider,
    prUrl: value.prUrl,
    title: value.title,
    state: value.state,
    author: value.author,
    baseBranch: value.baseBranch,
    headBranch: value.headBranch,
    comments: sanitizeComments(value.comments),
    unresolvedCount: value.unresolvedCount,
    attentionRequired: value.attentionRequired,
    summary: summarize(value.summary),
    warnings: Array.isArray(value.warnings) ? value.warnings : [],
    error: summarize(value.error, 400),
    invalidatedAt: value.invalidatedAt,
    invalidationReason: value.invalidationReason,
  };
}

function sanitizePullRequestAnalysis(analysis) {
  const value = asObject(analysis);
  if (Object.keys(value).length === 0) return undefined;
  return {
    generatedAt: value.generatedAt,
    sourceReviewFetchedAt: value.sourceReviewFetchedAt,
    attentionRequired: value.attentionRequired,
    summary: summarize(value.summary),
    groupedFindings: Array.isArray(value.groupedFindings) ? value.groupedFindings.map((finding) => ({
      filePath: finding.filePath,
      title: finding.title,
      comments: sanitizeComments(finding.comments),
      suggestedAction: summarize(finding.suggestedAction, 500),
      riskLevel: finding.riskLevel,
    })) : [],
    actionItems: Array.isArray(value.actionItems) ? value.actionItems : [],
    testChecklist: Array.isArray(value.testChecklist) ? value.testChecklist : [],
    warnings: Array.isArray(value.warnings) ? value.warnings : [],
    limitations: Array.isArray(value.limitations) ? value.limitations : [],
    invalidatedAt: value.invalidatedAt,
    invalidationReason: value.invalidationReason,
  };
}

function sanitizePullRequestFixProposal(proposal) {
  const value = asObject(proposal);
  if (Object.keys(value).length === 0) return undefined;
  return {
    generatedAt: value.generatedAt,
    sourceAnalysisGeneratedAt: value.sourceAnalysisGeneratedAt,
    summary: summarize(value.summary),
    proposedChanges: Array.isArray(value.proposedChanges) ? value.proposedChanges.map((change) => ({
      filePath: change.filePath,
      title: change.title,
      description: summarize(change.description, 500),
      addressesCommentIds: Array.isArray(change.addressesCommentIds) ? change.addressesCommentIds : [],
      confidence: change.confidence,
      riskLevel: change.riskLevel,
    })) : [],
    implementationOrder: Array.isArray(value.implementationOrder) ? value.implementationOrder : [],
    testChecklist: Array.isArray(value.testChecklist) ? value.testChecklist : [],
    warnings: Array.isArray(value.warnings) ? value.warnings : [],
    limitations: Array.isArray(value.limitations) ? value.limitations : [],
    canGenerateCodeLater: value.canGenerateCodeLater === true,
    invalidatedAt: value.invalidatedAt,
    invalidationReason: value.invalidationReason,
  };
}

function sanitizePullRequestFixUpdateTracking(tracking) {
  const value = asObject(tracking);
  if (Object.keys(value).length === 0) return undefined;
  return {
    updatedManually: value.updatedManually === true && !value.invalidatedAt,
    updatedAt: value.updatedAt,
    notes: summarize(value.notes, 400),
    commitSha: value.commitSha,
    branchName: value.branchName,
    relatedFixProposalGeneratedAt: value.relatedFixProposalGeneratedAt,
    invalidatedAt: value.invalidatedAt,
    invalidationReason: value.invalidationReason,
  };
}

function getTaskById(tasks, id) {
  return tasks.find((task) => task && String(task.id) === String(id));
}

function nextRecommendedStep(task) {
  const workflow = asObject(task.crmDeveloperWorkflow);
  const verification = latestVerification(task);
  const plan = asObject(workflow.technicalPlan);
  const pr = sanitizePullRequestState(workflow);

  if (!isDeveloperTask(task)) {
    return {
      step: 'none',
      attentionRequired: false,
      reason: 'This does not appear to be a CRM developer workflow task.',
    };
  }
  if (Object.keys(workflow).length === 0) {
    return {
      step: 'diagnosis',
      attentionRequired: true,
      reason: 'Open the task in task-workbench and save the local CRM workflow diagnosis state.',
    };
  }
  if (!meaningfulVerification(verification.verdict)) {
    return {
      step: 'metadata-verification',
      attentionRequired: true,
      reason: 'Run the existing read-only CRM metadata verification in task-workbench.',
    };
  }
  if (Object.keys(plan).length === 0 || plan.invalidatedAt) {
    return {
      step: 'technical-plan',
      attentionRequired: true,
      reason: 'Generate a deterministic local technical implementation plan.',
    };
  }
  if (!approvalSummary(workflow.planApproval).approved) {
    return {
      step: 'technical-plan-approval',
      attentionRequired: true,
      reason: 'Review and explicitly approve the technical implementation plan locally.',
    };
  }
  if (!approvalSummary(workflow.diffApproval).approved) {
    return {
      step: 'diff-review',
      attentionRequired: true,
      reason: 'Use the existing draft flow if appropriate, review the generated changes, then approve the diff locally.',
    };
  }
  if (workflow.externalActionApproval && !approvalSummary(workflow.externalActionApproval).approved) {
    return {
      step: 'external-action-approval',
      attentionRequired: true,
      reason: 'Review and locally approve the proposed external action plan. This still does not execute anything.',
    };
  }
  if (workflow.externalActionApproval && approvalSummary(workflow.externalActionApproval).approved && !sanitizeExternalExecution(workflow.externalExecution)?.completed) {
    return {
      step: 'manual-external-execution-tracking',
      attentionRequired: true,
      reason: 'If external actions were completed outside the app, record that local tracking note.',
    };
  }
  if (!pr.proposal || pr.proposal.invalidatedAt) {
    return {
      step: 'pull-request-proposal',
      attentionRequired: true,
      reason: 'Generate a local PR proposal for manual PR creation.',
    };
  }
  if (!pr.tracking?.createdManually) {
    return {
      step: 'manual-pr-tracking',
      attentionRequired: true,
      reason: 'Create the PR outside task-workbench and record the PR URL or note locally.',
    };
  }
  if (!pr.review || pr.review.invalidatedAt) {
    return {
      step: 'pr-review-intake',
      attentionRequired: true,
      reason: 'Fetch or record read-only PR review status from the manually tracked PR URL.',
    };
  }
  if (pr.review.attentionRequired || (Array.isArray(pr.review.comments) && pr.review.comments.length > 0)) {
    if (!pr.analysis || pr.analysis.invalidatedAt) {
      return {
        step: 'pr-review-analysis',
        attentionRequired: true,
        reason: 'Generate a local PR review analysis and fix plan from the fetched snapshot.',
      };
    }
    if (!pr.fixProposal || pr.fixProposal.invalidatedAt) {
      return {
        step: 'pr-fix-proposal',
        attentionRequired: true,
        reason: 'Generate a local fix draft proposal from the review analysis.',
      };
    }
    if (!pr.fixUpdateTracking?.updatedManually) {
      return {
        step: 'manual-pr-fix-update-tracking',
        attentionRequired: true,
        reason: 'After applying/pushing fixes outside the app, record the manual PR update locally.',
      };
    }
    return {
      step: 'post-fix-pr-review-refresh',
      attentionRequired: true,
      reason: 'Fetch the PR review status again to see whether comments remain.',
    };
  }
  return {
    step: 'done-or-monitor',
    attentionRequired: false,
    reason: 'No fetched PR review comments are currently recorded. Continue manual review/merge outside the app.',
  };
}

async function callToolFallback(name, args = {}) {
  const { tasks, found, warning } = await loadTasks();
  const common = {
    storage: { tasksFileFound: found },
    warning,
    fallbackMode: true,
    warningMode: 'bridge_unavailable_debug_fallback',
  };

  switch (name) {
    case 'list_tasks': {
      const limit = Math.min(Math.max(Number(args.limit ?? 25), 1), 100);
      let filtered = tasks;
      if (args.status) filtered = filtered.filter((task) => task.status === args.status);
      if (args.developerOnly) filtered = filtered.filter(isDeveloperTask);
      return {
        ...common,
        count: filtered.length,
        tasks: filtered.slice(0, limit).map(safeTaskSummary),
      };
    }
    case 'get_task': {
      const task = getTaskById(tasks, args.id);
      return task ? { ...common, task: safeTaskDetail(task) } : { ...common, error: `Task not found: ${args.id}` };
    }
    case 'get_task_summary': {
      const task = getTaskById(tasks, args.id);
      return task ? { ...common, task: safeTaskSummary(task) } : { ...common, error: `Task not found: ${args.id}` };
    }
    case 'get_crm_workflow_state': {
      const task = getTaskById(tasks, args.id);
      return task ? { ...common, taskId: task.id, crmWorkflowState: sanitizeCrmWorkflowState(task) } : { ...common, error: `Task not found: ${args.id}` };
    }
    case 'get_technical_plan': {
      const task = getTaskById(tasks, args.id);
      const workflow = asObject(task?.crmDeveloperWorkflow);
      return task ? { ...common, taskId: task.id, technicalPlan: sanitizeTechnicalPlan(workflow.technicalPlan) } : { ...common, error: `Task not found: ${args.id}` };
    }
    case 'get_current_crm_workflow_step': {
      const task = getTaskById(tasks, args.id);
      const workflow = asObject(task?.crmDeveloperWorkflow);
      return task ? {
        ...common,
        taskId: task.id,
        currentStep: workflow.currentStep ?? 'diagnosis',
        detectedWorkKind: workflow.detectedWorkKind ?? 'unknown',
        latestCrmVerification: latestVerification(task),
        approvals: {
          plan: approvalSummary(workflow.planApproval),
          diff: approvalSummary(workflow.diffApproval),
          externalAction: approvalSummary(workflow.externalActionApproval),
          pullRequest: approvalSummary(workflow.pullRequestApproval),
        },
      } : { ...common, error: `Task not found: ${args.id}` };
    }
    case 'get_pr_review_state': {
      const task = getTaskById(tasks, args.id);
      const workflow = asObject(task?.crmDeveloperWorkflow);
      return task ? { ...common, taskId: task.id, pullRequest: sanitizePullRequestState(workflow) } : { ...common, error: `Task not found: ${args.id}` };
    }
    case 'get_next_recommended_step': {
      const task = getTaskById(tasks, args.id);
      return task ? { ...common, taskId: task.id, recommendation: nextRecommendedStep(task) } : { ...common, error: `Task not found: ${args.id}` };
    }
    default:
      throw new Error(`Tool '${name}' is not available in read-only fallback mode.`);
  }
}

function bridgeRequestJson(baseUrl, routePath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(routePath, baseUrl);
    const payload = body ? JSON.stringify(body) : '';
    const request = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...extraHeaders,
      },
      timeout: 2500,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          if (parsed?.ok === false) {
            // Clear cached token on auth failure so next call refetches
            if (String(parsed.error ?? '').toLowerCase().includes('token')) {
              cachedBridgeToken = null;
            }
            reject(new Error(String(parsed.error ?? 'Bridge call failed.')));
            return;
          }
          resolve(parsed?.result ?? parsed);
        } catch (error) {
          reject(new Error(`Bridge returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });
    request.on('error', (error) => reject(error));
    request.on('timeout', () => {
      request.destroy(new Error('Bridge request timed out.'));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

async function callTool(name, args = {}) {
  const bridgeUrl = getCliBridgeUrl();

  // Fetch token on first call if not cached
  if (!cachedBridgeToken) {
    await fetchBridgeToken(bridgeUrl);
  }

  const tokenHeader = cachedBridgeToken
    ? { 'X-Task-Workbench-Bridge-Token': cachedBridgeToken }
    : {};

  try {
    const result = await bridgeRequestJson(bridgeUrl, '/mcp/tools/call', { name, args }, tokenHeader);
    return {
      ...result,
      bridge: {
        mode: 'local-bridge',
        url: bridgeUrl,
      },
    };
  } catch (error) {
    const fallbackAllowed = isFallbackReadOnlyEnabled() || !!getCliDataDir();
    if (!fallbackAllowed || !READ_ONLY_TOOL_NAMES.has(name)) {
      throw new Error(
        `task-workbench local bridge is not running at ${bridgeUrl}. Start task-workbench app first. `
        + `Optional debug fallback for read-only tools only: pass --fallback-readonly with --data-dir. `
        + `Bridge error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const fallbackResult = await callToolFallback(name, args);
    return {
      ...fallbackResult,
      bridge: {
        mode: 'fallback-readonly',
        reason: 'task-workbench bridge unavailable',
      },
    };
  }
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function handleRequest(request) {
  if (!request || typeof request !== 'object') return;
  const { id, method, params } = request;

  if (!id && String(method ?? '').startsWith('notifications/')) return;

  try {
    if (method === 'initialize') {
      writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return;
    }

    if (method === 'tools/list') {
      writeMessage({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOL_DEFINITIONS },
      });
      return;
    }

    if (method === 'tools/call') {
      const result = await callTool(params?.name, params?.arguments ?? {});
      writeMessage({
        jsonrpc: '2.0',
        id,
        result: toolResult(result),
      });
      return;
    }

    writeMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (error) {
    writeMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

let buffer = '';
let pendingRequests = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line.length > 0) {
      try {
        const request = JSON.parse(line);
        pendingRequests = pendingRequests.then(() => handleRequest(request));
      } catch (error) {
        writeMessage({
          jsonrpc: '2.0',
          error: {
            code: -32700,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    newlineIndex = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => {
  pendingRequests.finally(() => process.exit(0));
});
