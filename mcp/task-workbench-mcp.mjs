#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SERVER_NAME = 'task-workbench-mcp-bridge';
const SERVER_VERSION = '0.6.0';
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
  'get_power_platform_ai_kit_status',
  // run_dataverse_check_for_task performs no Dataverse/Git/external writes.
  // Its local report persistence is expected behavior, not a write side effect.
  'run_dataverse_check_for_task',
  // New read-only tools
  'get_dataverse_verification_report',
  'get_external_action_proposal',
  'get_implementation_verification_state',
  'get_implementation_readiness',
  'get_task_templates',
]);

/**
 * Built-in task templates. Matched by title prefix or exact title match.
 * The AI can use these to resolve missing setup fields automatically.
 */
const TASK_TEMPLATES = [
  {
    id: 'nvr-training-sh-script-prefill',
    name: 'NVR Training Service Hub — Script: Předvyplnění servisního požadavku',
    titlePattern: 'Script: Předvyplnění servisního požadavku',
    mode: 'developer',
    workKind: 'script',
    actionType: 'create-new-script',
    targetEntity: 'nvr_servicecase',
    scriptTarget: {
      entityLogicalName: 'nvr_servicecase',
      eventName: 'onChange',
      eventFieldName: 'nvr_assetid',
    },
    notes: 'onChange on nvr_assetid. Source entity: nvr_customerasset. Copy nvr_customerid, nvr_contactid, nvr_isunderwarranty, nvr_statuscustom → nvr_servicecase fields nvr_customerid, nvr_contactid, nvr_iswarrantycase. Solution: NVRTrainingServiceHubCore. App: nvr_trainingservicehub.',
  },
  {
    id: 'nvr-training-sh-plugin-workorderline',
    name: 'NVR Training Service Hub — Plugin: Výpočet částek na položce servisní zakázky',
    titlePattern: 'Plugin: Výpočet částek na položce servisní zakázky',
    mode: 'developer',
    workKind: 'plugin',
    actionType: 'create-new-plugin',
    targetEntity: 'nvr_workorderline',
    pluginTarget: {
      entityLogicalName: 'nvr_workorderline',
      messages: ['Create', 'Update'],
      stage: 'PreOperation',
      mode: 'Sync',
      filteringAttributes: ['nvr_quantity', 'nvr_unitprice', 'nvr_discountpercent', 'nvr_vatpercent'],
    },
    notes: 'Compute nvr_netamount, nvr_vatamount, nvr_totalamount from input fields nvr_quantity, nvr_unitprice, nvr_discountpercent, nvr_vatpercent.',
  },
];

/**
 * Match a task title against template patterns. Returns the first matching template or null.
 * Matching is substring-based and case-insensitive for robustness.
 */
function matchTaskTemplate(title) {
  if (!title) return null;
  const lower = String(title).toLowerCase();
  return TASK_TEMPLATES.find((t) => lower.includes(t.titlePattern.toLowerCase())) ?? null;
}

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
    description: 'Set work kind and work action. workKind must be one of: plugin, script, ribbon, repo-only, bugfix, review, general, unknown. Strict enum validation.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:     { type: 'string' },
        workKind:   { type: 'string', enum: ['plugin', 'script', 'ribbon', 'repo-only', 'bugfix', 'review', 'general', 'unknown'] },
        workAction: { type: 'string', enum: ['create', 'update', 'unknown'] },
      },
      required: ['taskId', 'workKind', 'workAction'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_task_developer_target',
    description: 'Set developer target fields: repository root, plugin project, script path, primary entity logical name, action type, event context, customer. Does not scan or write any files.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:                     { type: 'string' },
        repositoryRoot:             { type: 'string' },
        selectedPluginProject:      { type: 'string' },
        selectedScriptTarget:       { type: 'string' },
        primaryEntityLogicalName:   {
          type: 'string',
          description: 'Primary Dataverse entity logical name (e.g. "account", "nvr_servicecase"). Saved to workflowSetup.primaryEntityLogicalName.',
        },
        actionType: {
          type: 'string',
          enum: ['create-new-script', 'update-existing-script', 'create-new-plugin', 'update-existing-plugin'],
          description: 'What kind of artifact action this task performs.',
        },
        eventName: {
          type: 'string',
          description: 'Form event name (e.g. "onChange", "onLoad", "onSave"). Mirrors plan.target.eventName.',
        },
        eventFieldName: {
          type: 'string',
          description: 'Field/column logical name that triggers the event (for onChange events). Mirrors plan.target.eventFieldName.',
        },
        desiredScriptFile: {
          type: 'string',
          description: 'Desired output file name for a new script (e.g. "prefillServiceCase.js"). Used when action is create-new-script.',
        },
        customerId:                 { type: 'string' },
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
    description: 'Save local technical plan: summary, steps, entities, test plan, risks, and optional plugin or script target details. Does not write code or register anything.',
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
        pluginTarget: {
          type: 'object',
          description: 'Optional plugin-specific target details. Only relevant for plugin (C#) tasks.',
          properties: {
            entityLogicalName:  { type: 'string' },
            message:            { type: 'string', enum: ['Create','Update','Delete','Retrieve','RetrieveMultiple','Associate','Disassociate','Assign','SetState'] },
            stage:              { type: 'string', enum: ['PreValidation','PreOperation','PostOperation'] },
            mode:               { type: 'string', enum: ['Sync','Async'] },
            pluginProject:      { type: 'string' },
            filteringAttributes:{ type: 'array', items: { type: 'string' } },
            preImageName:       { type: 'string' },
            preImageAttributes: { type: 'array', items: { type: 'string' } },
            postImageName:      { type: 'string' },
            postImageAttributes:{ type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        scriptTarget: {
          type: 'object',
          description: 'Optional script-specific target details. Only relevant for script (JS/TS) tasks.',
          properties: {
            entityLogicalName: { type: 'string' },
            scriptPath:        { type: 'string' },
            webResourceName:   { type: 'string' },
            formName:          { type: 'string' },
            eventName:         { type: 'string' },
            functionName:      { type: 'string' },
          },
          additionalProperties: false,
        },
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
      'Run a read-only Dataverse metadata check for a task (plugin or script). ' +
      'For plugin (C#) tasks: Task Workbench resolves the implementation artifact, scans it for Dataverse logical-name ' +
      'references (entities, attributes, lookups), and verifies them against the connected ' +
      'Dataverse environment through the configured Primarch MCP integration. ' +
      'For script (JS/TS) tasks: returns a structured "not-supported" result — use the in-app ' +
      'Verify Implementation modal instead, which handles JavaScript/TypeScript directly. ' +
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
      'Set moveToReviewAfterPush=true to also move the task to Code Review / Waiting for code review ' +
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
            'When true, moves the task to Code Review / Waiting for code review after a successful commit and push. ' +
            'Default: false. Only takes effect after a successful push.',
        },
      },
      required: ['taskId', 'message', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_power_platform_ai_kit_status',
    description:
      'Read-only. Returns the Power Platform AI Kit configuration status: whether a kit path is configured, ' +
      'whether all required rule files are present, and which files are available. ' +
      'Does NOT call AI, modify files, or perform any write action. ' +
      'Use this to check if AI Kit integration is available before planning AI-assisted implementation or review steps.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'mark_testing_confirmed_prepare_commit',
    description:
      'WRITE (local task state only) — marks consultant testing as confirmed and sets the next step ' +
      'to "Prepare commit and push". Does NOT commit, push, or move the task to Code Review. ' +
      'Use this when the consultant has confirmed the change and the developer needs to prepare a commit ' +
      'before requesting code review. ' +
      'To commit+push and move to Code Review in one step, use commit_and_push_task_changes with moveToReviewAfterPush=true.',
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
  // ── New read-only tools added in v0.5.0 ───────────────────────────────────
  {
    name: 'get_dataverse_verification_report',
    description:
      'Read-only. Returns the stored Dataverse verification report for a task (saved by run_dataverse_check_for_task). ' +
      'Returns a null/empty result with a helpful message if no report has been saved yet. ' +
      'Does NOT run a new check. Does NOT write anything.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_external_action_proposal',
    description:
      'Read-only. Returns the current external action proposal state for a task: ' +
      'externalActionPreview from the technical plan, external action approval gate status, ' +
      'and any recorded external execution tracking. ' +
      'Returns a null/empty result with a message if nothing is present. ' +
      'Does NOT write anything.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_external_action_completed',
    description:
      'WRITE (local task state only) — records that the developer manually completed the required external action ' +
      '(plugin registration, web resource upload, publish customizations, etc.). ' +
      'Does NOT call Dataverse, GitHub, Azure DevOps, PAC CLI, XrmToolBox, or any external system. ' +
      'If completedAt is omitted the current timestamp is used. ' +
      'Appends an audit note. Safe to call multiple times.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        actionType: {
          type: 'string',
          enum: ['plugin-registration', 'web-resource-upload', 'publish-customizations', 'pull-request', 'manual-check'],
          description: 'The type of external action that was completed.',
        },
        completedAt: { type: 'string', description: 'ISO timestamp of completion. Defaults to current time if omitted.' },
        note: { type: 'string', description: 'Optional note describing what was done.' },
      },
      required: ['taskId', 'actionType'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_implementation_verification_state',
    description:
      'Read-only. Returns the implementation verification state for a task: ' +
      'build check, Dataverse check override, AI code review, local test record, and consultant testing record. ' +
      'Fields are null when not yet recorded. Does NOT write anything.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_implementation_readiness',
    description:
      'Read-only. Returns whether the task is ready for code generation, with a list of blockers ' +
      'and warnings that must be resolved first, and a recommended next step. ' +
      'Applies only to developer mode plugin/script tasks. Does NOT write anything.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_templates',
    description:
      'Read-only. Returns built-in task templates that can be used to auto-resolve missing setup fields. ' +
      'When a taskId is provided, also returns the matched template for that task based on title pattern. ' +
      'Use this to discover default workKind, actionType, targetEntity, and other setup values for known task types. ' +
      'Does NOT write anything.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Optional task ID. When provided, the response includes matchedTemplate for this task.',
        },
      },
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

async function resolveSettingsFile() {
  for (const dir of defaultDataDirCandidates()) {
    const filePath = path.join(dir, 'settings.json');
    if (await fileExists(filePath)) return filePath;
  }
  return undefined;
}

async function loadSettings() {
  const settingsFile = await resolveSettingsFile();
  if (!settingsFile) return null;
  try {
    const raw = await fs.readFile(settingsFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function resolveCustomersFile() {
  for (const dir of defaultDataDirCandidates()) {
    const filePath = path.join(dir, 'customers.json');
    if (await fileExists(filePath)) return filePath;
  }
  return undefined;
}

async function loadCustomers() {
  const customersFile = await resolveCustomersFile();
  if (!customersFile) return [];
  try {
    const raw = await fs.readFile(customersFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function computeCustomerDevDefaults(customer, crmBaseDir) {
  if (!customer) return null;
  const repoRoot =
    (customer.repositoryRootOverride && customer.repositoryRootOverride.trim()) ||
    (customer.repositoryRoot && customer.repositoryRoot.trim()) ||
    (customer.folderName && customer.folderName.trim() && crmBaseDir && crmBaseDir.trim()
      ? `${crmBaseDir.replace(/[/\\]+$/, '')}/${customer.folderName.trim()}`
      : null);
  const scriptDirectory    = customer.scriptFolder        || null;
  const pluginProjectPath  = customer.pluginFolder        || null;
  const jsConventionsSource    = customer.jsConventionsSource    || null;
  const pluginConventionsSource = customer.pluginConventionsSource || null;

  if (!repoRoot && !scriptDirectory && !pluginProjectPath && !jsConventionsSource && !pluginConventionsSource) {
    return null;
  }
  const result = {};
  if (repoRoot)               result.repositoryRoot         = repoRoot;
  if (scriptDirectory)        result.scriptDirectory        = scriptDirectory;
  if (pluginProjectPath)      result.pluginProjectPath      = pluginProjectPath;
  if (jsConventionsSource)    result.jsConventionsSource    = jsConventionsSource;
  if (pluginConventionsSource) result.pluginConventionsSource = pluginConventionsSource;
  return result;
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
    primaryEntityLogicalName: setup.primaryEntityLogicalName,
    actionType: setup.actionType,
    eventName: setup.eventName,
    eventFieldName: setup.eventFieldName,
    desiredScriptFile: setup.desiredScriptFile,
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

const READINESS_VERIFIED_VERDICTS = new Set(['pass', 'warnings', 'fail']);

function computeImplementationReadiness(task) {
  const blockers = [];
  const warnings = [];

  if (task.taskMode !== 'developer') {
    return {
      isImplementationReady: false,
      blockers: ['Task mode is not set to Developer.'],
      warnings: [],
      recommendedNextStep: 'Set task mode to Developer.',
    };
  }

  const setup = asObject(task.workflowSetup);
  const workflow = asObject(task.crmDeveloperWorkflow);
  const detectedWorkKind = workflow.detectedWorkKind ?? '';
  const devTargetKind = setup.devTargetKind ?? '';

  const isPlugin = devTargetKind === 'plugin' || detectedWorkKind === 'plugin';
  const isScript = devTargetKind === 'script' || detectedWorkKind === 'script' || detectedWorkKind === 'ribbon';

  if (!isPlugin && !isScript) {
    const corpus = `${task.title ?? ''} ${task.originalMessage ?? ''} ${task.classificationLabel ?? ''}`.toLowerCase();
    const looksScript = /\b(javascript|form\s*script|web\s*resource|jscript|on.?load|on.?save|field.*change|column.*change|onchange|onload|onsave)\b/.test(corpus);
    return {
      isImplementationReady: false,
      blockers: ['Work kind must be plugin or script.'],
      warnings: looksScript
        ? ['Task text mentions JavaScript/form scripts. Consider classifying this task as script work kind.']
        : [],
      recommendedNextStep: looksScript
        ? 'Set work classification to script (JavaScript form script indicators found in task text).'
        : 'Set work classification to plugin or script via Set Work Classification.',
    };
  }

  const customer = setup.customerId || task.customerId || '';
  if (!customer) blockers.push('Customer/environment is not set.');
  if (!setup.repositoryRoot) blockers.push('Repository root is not set.');
  if (!setup.confirmedAt) blockers.push('Developer setup has not been confirmed.');

  const plan = asObject(workflow.technicalPlan && typeof workflow.technicalPlan === 'object' ? workflow.technicalPlan : null);
  const hasPlan = !!(workflow.technicalPlan && typeof workflow.technicalPlan === 'object');
  if (!hasPlan) blockers.push('Technical implementation plan is missing.');

  const reports = Array.isArray(task.crmVerificationReports) ? task.crmVerificationReports : [];
  const latestVerdict = reports[0]?.verdict ?? '';
  const dvCheck = asObject(asObject(task.implementationVerification).dataverseCheck);
  const dvSatisfied = READINESS_VERIFIED_VERDICTS.has(latestVerdict)
    || !!dvCheck.skippedAt || !!dvCheck.manuallyVerifiedAt
    || dvCheck.status === 'skipped' || dvCheck.status === 'manually-verified';

  if (!dvSatisfied) {
    blockers.push('Dataverse metadata verification has not been completed or explicitly skipped.');
  } else {
    if (latestVerdict === 'warnings') warnings.push('Dataverse verification completed with warnings. Review before implementing.');
    if (latestVerdict === 'fail')     warnings.push('Dataverse verification found issues. Ensure they are accounted for in the technical plan.');
  }

  const planTarget = hasPlan ? asObject(plan.target) : {};

  if (isPlugin) {
    const pluginProject = setup.pluginProject || task.selectedPluginProject || planTarget.pluginProject || '';
    if (!pluginProject) blockers.push('Plugin project is not selected.');

    const entity = setup.primaryEntityLogicalName || planTarget.entityLogicalName || '';
    if (!entity) blockers.push('Target entity logical name is not set.');

    if (hasPlan) {
      const missing = [
        !planTarget.message ? 'message' : null,
        !planTarget.stage   ? 'stage'   : null,
        !planTarget.mode    ? 'mode'    : null,
      ].filter(Boolean);
      if (missing.length > 0) blockers.push(`Plugin registration details are incomplete: ${missing.join(', ')} not specified in technical plan.`);
    }
  }

  if (isScript) {
    const targetPath = setup.artifactPath || setup.scriptPath || planTarget.scriptPath || '';
    if (!targetPath) {
      blockers.push('Target script/artifact path is not set.');
    } else {
      const actionType = setup.actionType ?? '';
      const isSpecificFile = (p) => p && /\.[jt]sx?$/.test(p);

      if (actionType === 'create-new-script') {
        const hasDir      = !!(setup.scriptPath || planTarget.scriptPath);
        const hasFileName = !!(setup.artifactPath) || isSpecificFile(setup.scriptPath) || isSpecificFile(planTarget.scriptPath) || !!(setup.desiredScriptFile);
        if (!hasDir || !hasFileName) {
          blockers.push('Script creation requires a known target directory and file name. Set script path and desired file name.');
        }
      } else if (actionType === 'update-existing-script') {
        const hasSpecific = !!(setup.artifactPath) || isSpecificFile(setup.scriptPath) || isSpecificFile(planTarget.scriptPath);
        if (!hasSpecific) {
          blockers.push('Script update requires a specific existing file path. Set script path to an existing .js file.');
        }
      }
    }

    const entity = setup.primaryEntityLogicalName || planTarget.entityLogicalName || '';
    if (!entity) blockers.push('Target entity logical name (table) is not set.');

    if (hasPlan) {
      const hasFormEvent = !!(planTarget.formName || planTarget.eventName || planTarget.eventFieldName || planTarget.functionName);
      const manualLater = setup.scriptFormRegistration === 'manual-later';
      if (!hasFormEvent && !manualLater) {
        blockers.push('Form/event registration details are not set. Add form name, event name, or mark as manual registration later.');
      }
    }
  }

  const isReady = blockers.length === 0;
  let recommendedNextStep;
  if (isReady) {
    recommendedNextStep = warnings.length > 0 ? 'Review warnings, then proceed with code generation.' : 'Ready for code generation.';
  } else {
    const first = blockers[0] ?? '';
    if (first.includes('Customer'))                     recommendedNextStep = 'Set customer/environment for this task.';
    else if (first.includes('Repository root'))         recommendedNextStep = 'Set repository root via Developer Target Setup.';
    else if (first.includes('setup has not been'))      recommendedNextStep = 'Complete and confirm the developer setup.';
    else if (first.includes('Technical implementation'))recommendedNextStep = 'Generate a technical implementation plan.';
    else if (first.includes('Dataverse metadata'))      recommendedNextStep = 'Run Dataverse metadata verification or mark it as not required.';
    else if (first.includes('Plugin project'))          recommendedNextStep = 'Select the plugin project.';
    else if (first.includes('Target entity'))           recommendedNextStep = 'Specify the target entity logical name in the technical plan.';
    else if (first.includes('Plugin registration'))     recommendedNextStep = 'Specify message, stage, and execution mode in the technical plan.';
    else if (first.includes('Script creation requires')) recommendedNextStep = 'Set target directory and file name for script creation in Developer Target Setup.';
    else if (first.includes('Script update requires'))  recommendedNextStep = 'Set the existing script file path in Developer Target Setup.';
    else if (first.includes('Target script'))           recommendedNextStep = 'Set the target script path via Developer Target Setup.';
    else if (first.includes('Form/event'))              recommendedNextStep = 'Add form/event details to the technical plan, or mark form registration as manual-later.';
    else                                                recommendedNextStep = 'Resolve all blockers before proceeding with implementation.';
  }

  return { isImplementationReady: isReady, blockers, warnings, recommendedNextStep };
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
    case 'get_task_full_context': {
      const task = getTaskById(tasks, args.id);
      if (!task) return { ...common, error: `Task not found: ${args.id}` };
      const detail = safeTaskDetail(task);
      detail.implementationReadiness = computeImplementationReadiness(task);
      const customerId = task.customerId || task.workflowSetup?.customerId;
      if (customerId) {
        const [customers, settings] = await Promise.all([loadCustomers(), loadSettings()]);
        const customer = customers.find((c) => c.id === customerId);
        const crmBaseDir = settings?.crmBaseDirectory ?? '';
        const devDefaults = computeCustomerDevDefaults(customer, crmBaseDir);
        if (devDefaults) detail.customerDevDefaults = devDefaults;
      }
      return { ...common, task: detail };
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
    case 'get_dataverse_verification_report': {
      const task = getTaskById(tasks, args.id);
      if (!task) return { ...common, error: `Task not found: ${args.id}` };
      const reports = Array.isArray(task.crmVerificationReports) ? task.crmVerificationReports : [];
      const report = reports[0];
      if (!report) {
        return {
          ...common,
          taskId: task.id,
          hasReport: false,
          report: null,
          message: 'No Dataverse verification report is stored for this task. Run run_dataverse_check_for_task first.',
        };
      }
      return {
        ...common,
        taskId: task.id,
        hasReport: true,
        report: {
          id: report.id,
          createdAt: report.createdAt ?? report.generatedAt,
          filePath: report.filePath,
          verdict: report.verdict ?? report.status ?? 'unknown',
          metadataVerdict: report.metadataVerdict,
          summary: summarize(report.summary ?? report.message ?? ''),
          issueCount: Array.isArray(report.issues) ? report.issues.length : (report.issueCount ?? 0),
          inspectedEntities: Array.isArray(report.inspectedEntities) ? report.inspectedEntities : [],
          confirmedCount: Array.isArray(report.confirmedReferences) ? report.confirmedReferences.length : 0,
          missingCount: Array.isArray(report.missingReferences) ? report.missingReferences.length : 0,
          ambiguousCount: Array.isArray(report.ambiguousReferences) ? report.ambiguousReferences.length : 0,
          runtimeReadiness: report.runtimeReadiness,
          compileReadiness: report.compileReadiness ? {
            canCompile: report.compileReadiness.canCompile,
            missingUsings: Array.isArray(report.compileReadiness.missingUsings) ? report.compileReadiness.missingUsings : [],
          } : undefined,
        },
      };
    }
    case 'get_external_action_proposal': {
      const task = getTaskById(tasks, args.id);
      if (!task) return { ...common, error: `Task not found: ${args.id}` };
      const workflow = asObject(task.crmDeveloperWorkflow);
      const plan = asObject(workflow.technicalPlan);
      const preview = Array.isArray(plan.externalActionPreview) ? plan.externalActionPreview : [];
      const approval = approvalSummary(workflow.externalActionApproval);
      const execution = sanitizeExternalExecution(workflow.externalExecution);
      const hasProposal = preview.length > 0 || Object.keys(asObject(workflow.externalActionApproval)).length > 0;
      if (!hasProposal && !execution) {
        return {
          ...common,
          taskId: task.id,
          hasProposal: false,
          message: 'No external action proposal is present for this task. A technical plan with externalActionPreview is needed first.',
        };
      }
      return {
        ...common,
        taskId: task.id,
        hasProposal: true,
        externalActionPreview: preview,
        approval,
        execution: execution ?? null,
      };
    }
    case 'get_implementation_verification_state': {
      const task = getTaskById(tasks, args.id);
      if (!task) return { ...common, error: `Task not found: ${args.id}` };
      const impl = asObject(task.implementationVerification);
      return {
        ...common,
        taskId: task.id,
        buildCheck: impl.buildCheck ?? null,
        dataverseCheck: impl.dataverseCheck ?? null,
        aiCodeReview: impl.aiCodeReview ?? null,
        localTest: impl.localTest ?? null,
        localTestRecord: task.localTestRecord ?? null,
        consultantTestRecord: task.consultantTestRecord ?? null,
        updatedAt: impl.updatedAt ?? null,
      };
    }
    case 'get_implementation_readiness': {
      const task = getTaskById(tasks, args.id);
      if (!task) return { ...common, error: `Task not found: ${args.id}` };
      return { ...common, taskId: task.id, ...computeImplementationReadiness(task) };
    }
    case 'get_power_platform_ai_kit_status': {
      const settings = await loadSettings();
      const kitPath = (settings?.powerPlatformAiKitPath ?? '').trim();
      if (!kitPath) {
        return { ...common, configured: false, kitPath: null, valid: false, statusMessage: 'Power Platform AI Kit path is not configured.' };
      }
      const requiredFiles = [
        'AGENTS.md',
        'ai-rules/crm-plugin-rules.md',
        'ai-rules/crm-javascript-rules.md',
        'ai-rules/crm-ribbon-rules.md',
        'ai-rules/crm-other-rules.md',
        'ai-rules/known-pr-review-comments.md',
        'ai-rules/crm-code-review-checklist.md',
        'prompts/pp-implement-crm-task.md',
        'prompts/pp-review-diff.md',
      ];
      const normalised = kitPath.replace(/[\\/]+$/, '').replace(/\\/g, '/');
      const fileStatus = await Promise.all(
        requiredFiles.map(async (rel) => {
          const full = path.join(normalised.replace(/\//g, path.sep), rel);
          return { file: rel, present: await fileExists(full) };
        }),
      );
      const missingFiles = fileStatus.filter((f) => !f.present).map((f) => f.file);
      const valid = missingFiles.length === 0;
      return {
        ...common,
        configured: true,
        kitPath,
        valid,
        missingFiles,
        availableFiles: fileStatus.filter((f) => f.present).map((f) => f.file),
        statusMessage: valid ? 'Valid kit — all required files found.' : `Invalid kit: missing ${missingFiles.join(', ')}`,
      };
    }
    case 'get_task_templates': {
      let matchedTemplate = null;
      if (args.taskId) {
        const task = getTaskById(tasks, args.taskId);
        if (task) matchedTemplate = matchTaskTemplate(task.title);
      }
      return {
        ...common,
        templates: TASK_TEMPLATES,
        matchedTemplate: matchedTemplate ?? undefined,
      };
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
  if (!process.env.VITEST) pendingRequests.finally(() => process.exit(0));
});

// Named exports for unit tests. Does not affect runtime behaviour when executed as a script.
export { READ_ONLY_TOOL_NAMES, TOOL_DEFINITIONS, TASK_TEMPLATES, matchTaskTemplate, callToolFallback };
