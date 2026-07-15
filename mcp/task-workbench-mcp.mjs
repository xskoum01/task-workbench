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

/**
 * Bridge error classification. bridgeRequestJson/callTool must distinguish these so a valid
 * business rejection from a reachable bridge is never reported as "the bridge is not running":
 *
 * - BridgeUnavailableError: transport/connection failure (connection refused, timeout, DNS, etc.)
 *   — the bridge process itself could not be reached. This is the only case that should trigger
 *   the existing bridge-unavailable / capability-fallback behavior.
 * - BridgeToolError: the bridge was reached and responded with a valid `{ ok: false }` JSON body —
 *   a normal application/tool-level rejection (e.g. a safety-gate guard). Surface the original
 *   message directly; never wrap it and never fall back.
 * - BridgeProtocolError: the bridge was reached but returned a response that could not be parsed
 *   as JSON — a bridge protocol/response bug, not proof the bridge is not running.
 */
class BridgeUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'BridgeUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

class BridgeToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeToolError';
  }
}

class BridgeProtocolError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'BridgeProtocolError';
    if (cause !== undefined) this.cause = cause;
  }
}

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
  'get_developer_work_packet',
  'get_task_templates',
  'continue_developer_workflow',
  // run_implementation_verification performs no external/Dataverse/Git writes. Like
  // run_dataverse_check_for_task, its local report persistence is expected behavior.
  'run_implementation_verification',
  'get_implementation_verification_summary',
  'get_task_workbench_mcp_capabilities',
  // Deployment & Testing / Pull Request read-only tools (see section 5/8 of the workflow spec)
  'get_deployment_testing_state',
  'get_pull_request_state',
  // Requires the live git-enabled bridge (like prepare_commit_for_task) — no JS fallback case.
  'prepare_pull_request_for_task',
  // Read-only Git inspection + local tracking-state reconciliation — never mutates Git.
  'reconcile_task_git_state',
]);

/** Tool names the developer workflow (post-plan-approval through Implementation Verification)
 *  depends on being available in the current MCP toolset. Used by
 *  get_task_workbench_mcp_capabilities and the pending_ai_kit_review fail-fast guard in
 *  run_implementation_verification. Keep in sync with the Rust REQUIRED_DEVELOPER_WORKFLOW_TOOLS
 *  list in src-tauri/src/lib.rs. */
const REQUIRED_DEVELOPER_WORKFLOW_TOOLS = [
  'get_developer_work_packet',
  'approve_technical_plan_if_safe',
  'record_ai_implementation_completed',
  'run_implementation_verification',
  'record_ai_kit_review_result',
  'get_implementation_verification_summary',
  'continue_developer_workflow',
  'get_task_workflow_overview',
  // Deployment & Testing -> Commit & Push -> Pull Request -> Code Review sequence
  'get_deployment_testing_state',
  'record_manual_deployment',
  'record_deployment_test',
  'prepare_pull_request_for_task',
  'record_pull_request_created',
  'get_pull_request_state',
];

/** Write tool names the standalone MCP fallback (no live app bridge) may execute, and only when
 *  --data-dir is set. Mirrors the fallbackWriteAllowed check inside callTool() — kept as a single
 *  named set so get_task_workbench_mcp_capabilities and callTool() cannot drift apart. */
const FALLBACK_WRITE_ALLOWED_TOOL_NAMES = new Set([
  'prepare_developer_task',
  'approve_technical_plan_if_safe',
  'record_ai_implementation_completed',
  'record_ai_kit_review_result',
  'set_task_phase',
  // Pure local JSON reads/writes — no Dataverse/Git/external call, safe without a live bridge.
  'record_manual_deployment',
  'record_deployment_test',
  'record_pull_request_created',
]);

/**
 * Built-in task templates. Matched by title prefix or exact title match.
 * The AI can use these to resolve missing setup fields automatically.
 */
const TASK_TEMPLATES = [
  {
    id: 'nvr-training-sh-script-prefill',
    name: 'NVR Training Service Hub – Script: Předvyplnění servisního požadavku',
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
    scriptNaming: {
      namingSource: 'Scripts_Naming',
      scriptsFolderRelative: 'Scripts',
      desiredScriptFile: 'nvr_servicecase_events.js',
      onLoadFunctionName: 'nvr_servicecase_OnLoad',
      onChangeFunctionName: 'nvr_assetid_OnChange',
      mainHelperSuggestion: 'prefillServiceCaseFromAsset',
    },
    sourceEntity: 'nvr_customerasset',
    sourceFields: ['nvr_customerid', 'nvr_contactid', 'nvr_isunderwarranty'],
    targetFields: ['nvr_customerid', 'nvr_contactid', 'nvr_iswarrantycase'],
    additionalSourceFields: ['nvr_statuscustom'],
    notes: 'onChange on nvr_assetid. Source entity: nvr_customerasset. Copy nvr_customerid, nvr_contactid, nvr_isunderwarranty to nvr_servicecase fields nvr_customerid, nvr_contactid, nvr_iswarrantycase. Additional source field available: nvr_statuscustom. Solution: NVRTrainingServiceHubCore. App: nvr_trainingservicehub.',
    businessRules: [
      'Empty nvr_assetid means no-op: do not clear or modify any form fields.',
      'Retrieve source record from nvr_customerasset using Xrm.WebApi.retrieveRecord before copying fields.',
      'Check nvr_statuscustom on the retrieved asset: if inactive, retired, or lost, show a form notification and skip prefill.',
      'Never write validationFields (nvr_statuscustom) to the target entity — read-only source context only.',
      'Never set a lookup field entityType to an empty string.',
      'Guard attribute access: check that getFormContext().getAttribute returns non-null before calling setValue.',
      'Do not use Xrm.Page — use the execution context passed to the event handler.',
      'Do not trigger autosave and do not upload or register the web resource.',
    ],
    acceptanceCriteria: [
      'onChange fires on nvr_assetid: if the field is empty, the handler exits without modifying any other field.',
      'onChange fires on nvr_assetid: if the field has a value, retrieveRecord is called on nvr_customerasset with the selected ID.',
      'If nvr_statuscustom indicates inactive/retired/lost: a form notification is shown and no field values are written.',
      'nvr_customerasset.nvr_customerid is copied to nvr_servicecase.nvr_customerid.',
      'nvr_customerasset.nvr_contactid is copied to nvr_servicecase.nvr_contactid.',
      'nvr_customerasset.nvr_isunderwarranty is copied to nvr_servicecase.nvr_iswarrantycase.',
      'No Xrm.Page reference appears in the output code.',
      'No autosave call appears in the output code.',
    ],
    // Deterministic regex checks run by run_implementation_verification. No LLM call —
    // catches the concrete, checkable failure modes called out for this script task.
    staticRules: [
      { id: 'retrieve-source-entity', description: 'retrieveRecord must target nvr_customerasset.', type: 'must-match', pattern: 'retrieveRecord\\s*\\(\\s*["\']nvr_customerasset["\']' },
      { id: 'no-xrm-page', description: 'Must not reference Xrm.Page.', type: 'must-not-match', pattern: 'Xrm\\.Page' },
      { id: 'no-autosave', description: 'Must not trigger autosave (formContext.data.save()).', type: 'must-not-match', pattern: '\\.data\\.save\\s*\\(' },
      { id: 'no-webresource-upload', description: 'Must not upload or register web resources.', type: 'must-not-match', pattern: 'uploadWebResource|RegisterEvent|updatewebresourceset' },
      { id: 'no-todo-fixme-placeholder', description: 'Must not contain TODO/FIXME/placeholder markers.', type: 'must-not-match', pattern: '\\b(TODO|FIXME|placeholder)\\b' },
      { id: 'no-empty-lookup-entitytype', description: 'Lookup entityType must never be an empty string.', type: 'must-not-match', pattern: 'entityType\\s*:\\s*["\']\\s*["\']' },
      { id: 'no-write-validationfields', description: 'nvr_statuscustom (validation field) must not be written to a target with setValue.', type: 'must-not-match', pattern: 'setValue\\s*\\([^)]*nvr_statuscustom' },
      { id: 'status-custom-checks-inactive-values', description: 'nvr_statuscustom must be checked against inactive/retired/lost values, not merely non-null.', type: 'must-match', pattern: 'inactive|retired|lost' },
      { id: 'notification-on-inactive-status', description: 'Must show a form notification when status is inactive/retired/lost.', type: 'must-match', pattern: 'notification' },
    ],
  },
  {
    id: 'nvr-training-sh-plugin-workorderline',
    name: 'NVR Training Service Hub – Plugin: Výpočet částek na položce servisní zakázky',
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
  {
    id: 'nvr-training-automation-lab-servicecase-priority-description',
    name: 'NVR Training Automation Lab – Script: Povinný popis pro vysokou prioritu servisního případu',
    // No single titlePattern substring reliably identifies this task — match on a combination
    // of title/description markers instead (see matchKeywords/minKeywordMatches below).
    matchKeywords: ['[test] script', 'povinný popis', 'vysokou prioritu', 'nvr_labservicecase', 'nvr_priority', 'nvr_description'],
    minKeywordMatches: 3,
    // The Czech title markers above are generic enough that a different lab task with a similar
    // title could hit minKeywordMatches without ever naming this table. Require explicit
    // Dataverse logical-name evidence before this template is allowed to match at all.
    requiredKeywords: ['nvr_labservicecase'],
    mode: 'developer',
    workKind: 'script',
    actionType: 'create-new-script',
    targetEntity: 'nvr_labservicecase',
    scriptTarget: {
      entityLogicalName: 'nvr_labservicecase',
      eventName: 'onChange',
      eventFieldName: 'nvr_priority',
    },
    scriptNaming: {
      namingSource: 'Scripts_Naming',
      scriptsFolderRelative: 'Scripts',
      desiredScriptFile: 'nvr_labservicecase_events.js',
      onLoadFunctionName: 'nvr_labservicecase_OnLoad',
      onChangeFunctionName: 'nvr_priority_OnChange',
      mainHelperSuggestion: 'updateDescriptionRequirementByPriority',
    },
    // This is a UI/business-rule script (required-level + notification toggling), not a
    // source→target field-mapping script — it must not define sourceFields/targetFields.
    // Doing so previously made deterministicPlanDraft/templateFieldMapping fabricate a bogus
    // "source.nvr_priority -> nvr_labservicecase.nvr_description" field mapping (nvr_priority's
    // value is never copied anywhere), which then let approval slip through for the wrong
    // reason instead of being recognized as not needing field mappings at all.
    implementationPattern: 'ui-business-rule',
    requiresFieldMappings: false,
    referencedFields: ['nvr_priority', 'nvr_description'],
    triggerFields: ['nvr_priority'],
    affectedFields: ['nvr_description'],
    uiRules: [
      'If nvr_priority == 100000002 (High), set nvr_description required and show a form notification.',
      'Otherwise, set nvr_description not required and clear the notification.',
    ],
    optionSetValues: { nvr_priority: { High: 100000002 } },
    notificationIds: ['nvr_description_required_notice'],
    forbiddenOperations: [
      'Xrm.WebApi',
      'autosave (formContext.data.save())',
      'Xrm.Page',
      'setValue on nvr_description',
      'early returns unless explicitly allowed by existing repo style',
      'generated header/task-summary comments',
    ],
    notes: 'Form OnLoad + onChange on nvr_priority. When nvr_priority is High (100000002), make nvr_description required and show a form notification; otherwise make it not required and clear the notification.',
    businessRules: [
      'High priority is choice value 100000002. Compare against this value, not a hardcoded label string.',
      'Do not use Xrm.Page — use the execution context passed to the event handler.',
      'Do not trigger autosave (formContext.data.save()).',
      'Do not call Xrm.WebApi — this logic is entirely local to the form, no server round trip is needed.',
      'Never call setValue on nvr_description — only toggle its required level (setIsRequiredLevel) and the form notification. The field value itself is user-entered.',
      'Do not add early returns unless the existing scripts in the repository already use them.',
      'Do not add a generated header/task-summary comment block to the script file.',
      'Run the same logic on both form OnLoad and onChange of nvr_priority, so the required state is correct on load and after every change.',
    ],
    acceptanceCriteria: [
      'On form OnLoad and on change of nvr_priority: when nvr_priority equals 100000002 (High), nvr_description is set to required and a form notification is shown.',
      'On form OnLoad and on change of nvr_priority: when nvr_priority is not 100000002, nvr_description is set to not required and the notification is cleared.',
      'No Xrm.Page reference appears in the output code.',
      'No autosave call appears in the output code.',
      'No Xrm.WebApi call appears in the output code.',
      'No setValue call targets nvr_description in the output code.',
    ],
    staticRules: [
      { id: 'no-xrm-page', description: 'Must not reference Xrm.Page.', type: 'must-not-match', pattern: 'Xrm\\.Page' },
      { id: 'no-autosave', description: 'Must not trigger autosave (formContext.data.save()).', type: 'must-not-match', pattern: '\\.data\\.save\\s*\\(' },
      { id: 'no-webapi', description: 'Must not call Xrm.WebApi — logic is form-local only.', type: 'must-not-match', pattern: 'Xrm\\.WebApi' },
      { id: 'no-setvalue-on-description', description: 'Must not call setValue on nvr_description — only toggle required level/notification.', type: 'must-not-match', pattern: 'setValue\\s*\\([^)]*nvr_description' },
      { id: 'no-todo-fixme-placeholder', description: 'Must not contain TODO/FIXME/placeholder markers.', type: 'must-not-match', pattern: '\\b(TODO|FIXME|placeholder)\\b' },
      { id: 'checks-high-priority-choice-value', description: 'Must compare nvr_priority against the High choice value 100000002.', type: 'must-match', pattern: '100000002' },
      { id: 'sets-required-level', description: 'Must toggle nvr_description required level via setIsRequiredLevel.', type: 'must-match', pattern: 'setIsRequiredLevel' },
      { id: 'shows-notification', description: 'Must show/clear a form notification.', type: 'must-match', pattern: 'notification' },
    ],
  },
];

/**
 * Match a task title/description against template patterns. Returns the first matching
 * template or null. Matching is substring-based and case-insensitive for robustness.
 *
 * Gate, evaluated before any match strategy below — if either is defined and not satisfied,
 * the template is skipped entirely (never matches via titlePattern or matchKeywords):
 * - `requiredKeywords` — every listed keyword must be present in the combined text.
 * - `requiredAnyKeywords` — at least one listed keyword must be present.
 * Use these to require explicit evidence (e.g. a Dataverse logical name) so a template with
 * broad/generic matchKeywords cannot match a different task that merely has a similar title.
 *
 * Match strategies, tried per-template in declaration order once the gate above passes:
 * 1. `titlePattern` — a single substring that must appear in the title (legacy, exact templates).
 * 2. `matchKeywords` + `minKeywordMatches` — matches when at least `minKeywordMatches` of the
 *    listed keywords appear anywhere in the combined text. Use this when no single substring
 *    reliably identifies the task (e.g. a synthetic test-lab task title).
 */
function matchTaskTemplate(title, description) {
  const haystack = `${title || ''} ${description || ''}`;
  if (!haystack.trim()) return null;
  const lower = haystack.toLowerCase();
  for (const t of TASK_TEMPLATES) {
    if (Array.isArray(t.requiredKeywords) && t.requiredKeywords.length > 0) {
      const allPresent = t.requiredKeywords.every((k) => lower.includes(k.toLowerCase()));
      if (!allPresent) continue;
    }
    if (Array.isArray(t.requiredAnyKeywords) && t.requiredAnyKeywords.length > 0) {
      const anyPresent = t.requiredAnyKeywords.some((k) => lower.includes(k.toLowerCase()));
      if (!anyPresent) continue;
    }
    if (t.titlePattern && String(title || '').toLowerCase().includes(t.titlePattern.toLowerCase())) {
      return t;
    }
    if (Array.isArray(t.matchKeywords) && t.matchKeywords.length > 0) {
      const minMatches = t.minKeywordMatches ?? t.matchKeywords.length;
      const hits = t.matchKeywords.filter((k) => lower.includes(k.toLowerCase())).length;
      if (hits >= minMatches) return t;
    }
  }
  return null;
}

/**
 * Combined text used by every template-match / setup-inference path so explicit facts (a
 * Dataverse logical name, a target file, a handler name) are found regardless of which field
 * they were typed into. Do not match/infer from task.title + task.originalMessage alone —
 * task.description and the stored analysis summaries can also carry the explicit assignment
 * text, depending on how the task was created.
 */
function taskTextForInference(task) {
  return [
    task?.title,
    task?.originalMessage,
    task?.description,
    task?.analysisResult?.summary,
    task?.analysisResult?.summaryEn,
  ].filter(Boolean).join('\n');
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
  // â”€â”€ Task creation / deletion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  // â”€â”€ New read tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  // â”€â”€ New write tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        selectedScriptTarget: {
          type: 'string',
          description: 'Target directory or script folder path for script tasks (e.g. "Scripts"). Saved to workflowSetup.scriptPath. For create-new-script, set this to the directory where the new file will be created (from customer scriptFolder default or "Scripts/").',
        },
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
          description: 'Field/column logical name that triggers the event (for onChange events, e.g. "nvr_assetid"). Mirrors plan.target.eventFieldName.',
        },
        desiredScriptFile: {
          type: 'string',
          description: 'Desired output file name for a new script following project naming convention (e.g. "nvr_servicecase_events.js" for entity nvr_servicecase). Used when action is create-new-script.',
        },
        customerId: { type: 'string' },
        namingSource: {
          type: 'string',
          description: 'Naming convention source identifier (e.g. "Scripts_Naming"). Set when derived from a template.',
        },
        onLoadFunctionName: {
          type: 'string',
          description: 'OnLoad handler function name derived from Scripts_Naming (e.g. "nvr_servicecase_OnLoad").',
        },
        onChangeFunctionName: {
          type: 'string',
          description: 'OnChange handler function name derived from Scripts_Naming (e.g. "nvr_assetid_OnChange").',
        },
        mainHelperSuggestion: {
          type: 'string',
          description: 'Suggested main helper function name (e.g. "prefillServiceCaseFromAsset"). Descriptive camelCase, no nvr_ prefix.',
        },
        absoluteScriptPath: {
          type: 'string',
          description: 'Absolute path of the target script file computed from repositoryRoot + scriptFolder + desiredScriptFile (e.g. "C:\\\\Users\\\\...\\\\Scripts\\\\nvr_servicecase_events.js"). Persisted when known before file creation.',
        },
        artifactPath: {
          type: 'string',
          description: 'Full relative path of the target script file (selectedScriptTarget + desiredScriptFile, e.g. "Scripts\\\\nvr_servicecase_events.js"). Saved to workflowSetup.artifactPath. For create-new-script, set this to the combined folder + file path.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'prepare_developer_task',
    description: 'High-level safe local orchestration: apply templates/defaults, derive developer target, draft technical plan, and stop at the first approval gate or hard blocker. Does not write code or external systems.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        mode: {
          type: 'string',
          enum: ['setup-until-approval-gate'],
          description: 'Only supported mode. Applies safe setup metadata and stops before implementation.',
        },
        confirmSetup: {
          type: 'boolean',
          description: 'Defaults to true. Only confirms local setup when no hard blockers remain and target metadata is complete.',
        },
        createTechnicalPlan: {
          type: 'boolean',
          description: 'Defaults to true. Creates a deterministic technical plan draft when enough context is known.',
        },
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
    description:
      'Set task phase: new/analyzed/development/testing/review/done. Maps to internal status+waitingState model safely. ' +
      "phase='new' on a task that already carries workflow state (analysis, developer setup, technical plan/approvals, " +
      'implementation verification, AI reviews, test/checklist results, next-step state, or local Git workflow tracking) ' +
      'performs a COMPLETE reset of that state back to a fresh NEW task, not just a status change — see confirmReset. ' +
      'Never deletes/edits repository files, changes the current Git branch, deletes branches/commits, stages/commits/' +
      'pushes/resets Git, or touches Dataverse/any external system. Preserves task identity, original assignment, notes, ' +
      'and import/tracking metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        phase:  { type: 'string', enum: ['new', 'analyzed', 'development', 'testing', 'review', 'done'] },
        confirmReset: {
          type: 'boolean',
          description:
            "Required (true) to reset phase='new' on a task that already carries workflow state — an explicit signal " +
            'that the user approved discarding that state. Not required when the task is already a clean NEW task ' +
            '(idempotent no-op) or when phase is not "new". An AI agent must never set this to true on its own initiative ' +
            "— only after the user has explicitly confirmed the reset (see the tool's rejection message for the exact " +
            'wording to relay to the user).',
        },
      },
      required: ['taskId', 'phase'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_ai_implementation_completed',
    description: 'Record that AI has finished writing implementation files. Sets implementation-done, persists the implemented script artifact into workflowSetup for the UI, and advances past local-test. Call continue_developer_workflow next — it will recommend run_implementation_verification before wait_for_user. Use this instead of record_local_test for script/ribbon tasks after AI file write.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:              { type: 'string' },
        filesChanged:        { type: 'array', items: { type: 'string' } },
        summary:             { type: 'string' },
        implementationChecks: { type: 'array', items: { type: 'string' } },
      },
      required: ['taskId', 'filesChanged', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_implementation_verification',
    description: 'Orchestrates the same Verify Implementation checks/state as ImplementationVerificationModal for a script/ribbon/plugin task: runs Artifact (Script/Plugin) File Readiness and Local Static/Business-Rule Verification directly (static rules are JS/TS-only; skipped for plugins); when running via the Task Workbench app (bridge mode), also runs Dataverse Metadata Check for real via Primarch (read-only, no Dataverse writes) and reports whether AI Internal Code Review still needs to be performed by the calling AI agent (call record_ai_kit_review_result). Both checks are hard gates: Dataverse "warnings" only counts once explicitly accepted, and a "passed" AI Kit review with missing review details is reported as incomplete. Local Test remains a read-only passthrough — it is the one genuinely manual/browser step. Never reports status=passed while a required row is still unresolved. No external writes, no web resource upload, no form event registration, no commit/push. Returns status (needs_configuration/failed/pending_ai_kit_review/warnings_unaccepted/needs_manual_action/passed), checks, fixableFindings, nextAction (needs_configuration/fix_code/run_ai_kit_review/review_dataverse_warnings/wait_for_user/continue_workflow), and progressionGate (the same canProceed/blockingChecks gate the "Move to Code Review" UI action enforces).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId:                    { type: 'string' },
        checks:                    { type: 'array', items: { type: 'string', enum: ['scriptFileReadiness', 'localStaticVerification', 'dataverseMetadataCheck', 'aiInternalCodeReview', 'localTest'] } },
        allowReadOnlyDataverseCheck: { type: 'boolean' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_implementation_verification_summary',
    description: 'Read-only. Returns the same normalized, modal-truth Implementation Verification summary as run_implementation_verification and get_task_workflow_overview, from currently persisted state only (does not re-run any check). Use this to check current verification status without re-running Script File Readiness / static rules.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
      },
      required: ['taskId'],
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
    name: 'approve_technical_plan_if_safe',
    description: 'Approve the technical plan automatically when all safety conditions are met: plan exists and is not invalidated, no TODO/scaffold/placeholder text in steps or risks, all required field mappings are present with a trusted source (template or plan), scaffoldOnly=false, finalConsistencyGuardApplied=false, no external actions in the plan. Returns canApprove=false with explicit reasons if any condition fails. Does not approve if external writes, deploys, uploads, or Dataverse actions are pending.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_manual_pr',
    description: 'Record a pull request created manually outside task-workbench. Local tracking only â€” does not call GitHub or Azure DevOps.',
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
      'For script (JS/TS) tasks: returns a structured "not-supported" result â€” use the in-app ' +
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
    name: 'create_branch_for_task',
    description:
      'WRITE — creates and switches to a new local Git branch, rebased onto the remote base branch ' +
      '(fetches origin first). Creates a local branch only — no commit, no push, no PR, no GitHub/Azure ' +
      'DevOps API calls. Prefer create_or_checkout_task_branch for the normal propose-then-approve workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task.' },
        branchName: { type: 'string', description: 'Name of the branch to create.' },
      },
      required: ['taskId', 'branchName'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_or_checkout_task_branch',
    description:
      'WRITE — requires explicit prior user approval of the exact branch name. Creates the branch from ' +
      'the CURRENT HEAD (no fetch, no remote-base rebase) if it does not exist, or checks it out if it ' +
      "already exists, and records it as the task's confirmed branch. Rejects main/master and unsafe names. " +
      "Never force-checks-out (refuses if uncommitted changes would be overwritten, surfacing git's own " +
      'blocker). Does not commit, push, or modify any file.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task.' },
        branchName: { type: 'string', description: 'User-approved exact branch name to create or check out.' },
        mode: {
          type: 'string',
          description: "Optional. Only 'create_if_missing_and_checkout' is supported (the default).",
        },
      },
      required: ['taskId', 'branchName'],
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
      'WRITE â€” stages the specified files and creates a Git commit in the task repository. ' +
      'All file paths must be relative to the repository root. ' +
      'Noise files (bin/, obj/, .vs/, copilot-instructions, etc.) are automatically rejected. ' +
      'Files outside this task\'s recorded implementation are rejected unless confirmUnrelatedFiles ' +
      'is set after explicit user approval. Files matched by .gitignore are rejected unless listed ' +
      'in forceAddFiles after explicit user approval. ' +
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
        confirmUnrelatedFiles: {
          type: 'boolean',
          description:
            'May only be true after the user explicitly approves committing files outside this ' +
            'task\'s recorded implementation. Without it, unrelated files are rejected.',
        },
        forceAddFiles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Repository-relative paths that may be force-added after the user explicitly approves ' +
            'including files ignored by .gitignore. Only the listed paths are force-added; any other ' +
            'ignored file among "files" is still rejected.',
        },
      },
      required: ['taskId', 'message', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'push_task_branch',
    description:
      'WRITE â€” pushes the current branch of the task repository to origin. ' +
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
      'WRITE â€” stages files, creates a Git commit, and then pushes the current branch in one step. ' +
      'Equivalent to commit_task_changes followed by push_task_branch. ' +
      'Files outside this task\'s recorded implementation are rejected unless confirmUnrelatedFiles ' +
      'is set after explicit user approval. Files matched by .gitignore are rejected unless listed ' +
      'in forceAddFiles after explicit user approval. ' +
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
        confirmUnrelatedFiles: {
          type: 'boolean',
          description:
            'May only be true after the user explicitly approves committing files outside this ' +
            'task\'s recorded implementation. Without it, unrelated files are rejected.',
        },
        forceAddFiles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Repository-relative paths that may be force-added after the user explicitly approves ' +
            'including files ignored by .gitignore. Only the listed paths are force-added; any other ' +
            'ignored file among "files" is still rejected.',
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
      'LEGACY (local task state only) â€” marks the old consultantTestRecord as confirmed. Does NOT satisfy ' +
      'the canonical Deployment & Testing gate (see get_deployment_testing_state, record_manual_deployment, ' +
      'record_deployment_test) and does NOT commit, push, or move the task to Code Review. Prefer ' +
      'record_manual_deployment + record_deployment_test for new workflows; this tool is kept only for ' +
      'backward compatibility with existing consultant-testing displays.',
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
  // â”€â”€ Deployment & Testing -> Commit & Push -> Pull Request -> Code Review â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    name: 'get_deployment_testing_state',
    description:
      'Read-only. Returns the canonical Deployment & Testing state for a task: manual deployment status, ' +
      'browser/model-driven app test status, unresolved required rows, whether commit preparation is ' +
      'allowed (deploymentTestingGate.canProceedToCommit), and the exact next recommended action. Never ' +
      'reads implementationVerification.localTest, localTestRecord, or consultantTestRecord as evidence — ' +
      'those predate the artifact ever being deployed. Does NOT deploy, test, or write anything.',
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
    name: 'record_manual_deployment',
    description:
      'WRITE (local task state only) â€” records that the user manually deployed the CRM artifact. ' +
      'This tool does NOT deploy anything, does NOT call Dataverse/Primarch/PAC CLI/Power Apps, and does ' +
      'NOT perform any external write. It only records a manual action the user already completed. ' +
      "status='deployed' is a one-click user confirmation and does NOT require notes. status='not-needed' is " +
      'rejected without meaningful notes (a real explanation, not a placeholder). Never call this speculatively ' +
      'or because static verification/AI Kit review passed — only call it after the user explicitly states in ' +
      'chat that they performed the deployment. Never claim Claude performed the deployment itself.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task.' },
        status: { type: 'string', enum: ['deployed', 'failed', 'not-needed'], description: 'Deployment result.' },
        notes: { type: 'string', description: "Optional for 'deployed'/'failed'. Required for 'not-needed' — what was actually done." },
        environmentId: { type: 'string' },
        environmentName: { type: 'string' },
        solutionUniqueName: { type: 'string' },
        artifactType: { type: 'string', enum: ['script', 'plugin'] },
        artifactPath: { type: 'string' },
        webResourceName: { type: 'string' },
        entityLogicalName: { type: 'string' },
        formName: { type: 'string' },
      },
      required: ['taskId', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_deployment_test',
    description:
      'WRITE (local task state only) — records the result of a real browser/model-driven app test performed ' +
      'after manual deployment. Does NOT run a test, does NOT open a browser, does NOT call any external ' +
      "system. status='passed' is a one-click user confirmation and does NOT require notes. status='not-needed' " +
      'is rejected without meaningful notes. Do not call this merely because static verification/AI Kit review ' +
      'passed — it records a real test the user performed after deployment. Only call it after the user ' +
      'explicitly states in chat that the test passed. A failed test blocks commit preparation.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task.' },
        status: { type: 'string', enum: ['passed', 'failed', 'not-needed'], description: 'Test result.' },
        notes: { type: 'string', description: "Optional for 'passed'/'failed'. Required for 'not-needed' — what was actually tested." },
        testedEnvironment: { type: 'string' },
        testedAcceptanceCriteria: { type: 'array', items: { type: 'string' } },
      },
      required: ['taskId', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'reconcile_task_git_state',
    description:
      'Read-only Git inspection + local tracking-state repair. Inspects the current branch, HEAD, and the ' +
      "configured remote branch, and verifies whether the task's expected commit SHA is present on the " +
      "remote. May repair ONLY Task Workbench's local gitWorkflow tracking fields (e.g. when a commit/push " +
      'actually succeeded but a later diagnostic falsely reported failure). Never modifies Git history, ' +
      'stages files, commits, pushes, deletes lock files, or runs destructive reset operations.',
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
    name: 'prepare_pull_request_for_task',
    description:
      'Read-only PR preview. Returns the detected provider/repository, source and target branch, a draft ' +
      'title/description, the commits/files that would be included, and any existing recorded pull request. ' +
      'Does NOT create a pull request and does NOT call GitHub/Azure DevOps. Use before record_pull_request_created.',
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
    name: 'record_pull_request_created',
    description:
      'WRITE (local task state only) â€” records that a pull request was created, either manually by the ' +
      'user or by Claude only after a SEPARATE explicit user approval distinct from any commit/push approval. ' +
      'This tool does NOT create a pull request on GitHub/Azure DevOps/any provider â€” it only records a PR ' +
      'that already exists. Never call this with a fabricated URL/number.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task.' },
        prUrl: { type: 'string', description: 'URL of the pull request that was actually created.' },
        notes: { type: 'string' },
      },
      required: ['taskId', 'prUrl'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_pull_request_state',
    description:
      'Read-only. Returns the current pull request state for a task: whether one has been created/recorded, ' +
      'its URL, and whether the Code Review readiness gate (commit verified + push verified + PR recorded) ' +
      'is satisfied. Does NOT call any external provider.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  // â”€â”€ New read-only tools added in v0.5.0 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      'WRITE (local task state only) â€” records that the developer manually completed the required external action ' +
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
    name: 'record_ai_kit_review_result',
    description:
      'WRITE (local task state only) â€” records the result of an AI Kit / Client-API code review performed ' +
      'by the calling AI agent itself (reviewSource=claude-ai-kit). Requires reviewedFiles, rulesFiles, ' +
      'checklistFiles, and knownPrReviewFiles to be non-empty for the review to pass the hard gate â€” a ' +
      "status='passed' call with those fields empty is recorded as gateStatus='incomplete', not passed. " +
      'Persists to implementationVerification.aiCodeReview (the same field the modal reads) and task.aiKitReview. ' +
      'Does not call any external LLM, API, or system â€” the caller supplies its own verdict after reading the ' +
      'AI Kit rules, the CRM code review checklist, known PR review comments, and the target file directly.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID of the task.' },
        status: { type: 'string', enum: ['passed', 'failed', 'warnings'], description: 'Overall review verdict.' },
        reviewedFiles: { type: 'array', items: { type: 'string' }, description: 'Files that were reviewed.' },
        findings: { type: 'array', items: { type: 'string' }, description: 'Review findings/comments.' },
        fixableFindings: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, description: { type: 'string' } },
            required: ['id', 'description'],
          },
          description: 'Findings that should be fixed before the task can proceed.',
        },
        nonFixableWarnings: { type: 'array', items: { type: 'string' }, description: 'Warnings noted but not required to fix.' },
        rulesFiles: { type: 'array', items: { type: 'string' }, description: 'AI Kit rules files actually consulted. Required (non-empty) for the hard gate to pass.' },
        checklistFiles: { type: 'array', items: { type: 'string' }, description: 'CRM code review checklist files actually consulted. Required (non-empty) for the hard gate to pass.' },
        knownPrReviewFiles: { type: 'array', items: { type: 'string' }, description: 'Known PR review comment files actually consulted. Required (non-empty) for the hard gate to pass.' },
        checkedItems: { type: 'array', items: { type: 'string' }, description: 'Checklist/rule items explicitly checked.' },
        skippedItems: { type: 'array', items: { type: 'string' }, description: 'Checklist/rule items explicitly skipped, with reason noted in findings/summary.' },
        summary: { type: 'string', description: 'Short human-readable summary of the review.' },
      },
      required: ['taskId', 'status'],
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
    name: 'get_developer_work_packet',
    description:
      'Read-only. Returns a simplified AI-facing developer work packet: whether code may be written, why, ' +
      'where to write, what to implement, applicable conventions, Dataverse verification status, and review/test/commit guidance. ' +
      'This hides internal Task Workbench workflow gates and does NOT write anything.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'continue_developer_workflow',
    description:
      'Returns the next required workflow step after implementation. ' +
      'Always call this after creating or modifying files, and always call it again after run_implementation_verification ' +
      'returns nextAction=continue_workflow — that result is not a stopping point, it means call this tool next. ' +
      'When verification has just resolved, this call also persists the local transition from Development into ' +
      'Deployment & Testing (sets waitingState only; never Git, filesystem, Dataverse, deployment, commit, push, or PR). ' +
      'Returns nextAction, canProceed, requiresUserApproval, blockingUserAction, recommendedTool, instructionForAI, ' +
      'allowedWrites, forbiddenWrites, transitionedToDeploymentTesting.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID.' },
      },
      required: ['taskId'],
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
  {
    name: 'get_task_workbench_mcp_capabilities',
    description:
      'Read-only health/capability check for the current MCP session. Call this before relying on automated ' +
      'Dataverse Metadata Check / AI Kit review (e.g. after get_developer_work_packet, or before ' +
      'run_implementation_verification / record_ai_kit_review_result) whenever there is any doubt the live ' +
      'Task Workbench app + MCP bridge is reachable, or after a "tool not found" / "bridge is not running" ' +
      'error. Returns bridgeMode (live-rust/js-fallback/offline), which developer-workflow tools are actually ' +
      'available right now, missingRequiredTools, and a recommendedAction. Does NOT write anything, and never ' +
      'throws even when the bridge is unreachable and no --data-dir/--fallback-readonly flags are set.',
    inputSchema: {
      type: 'object',
      properties: {},
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

/**
 * Pure core of get_task_workbench_mcp_capabilities' standalone-fallback result — takes the set of
 * tool names actually defined (normally TOOL_DEFINITIONS.map(t => t.name)) plus the resolved CLI
 * flags, with no reference to process.argv/module-level state, so tests can simulate a toolset
 * that is missing a required tool. bridgeMode is 'js-fallback' when local-file access is at least
 * attempted (--data-dir or --fallback-readonly given), else 'offline' (nothing beyond this health
 * check itself will work). A tool only counts as usable if it is both in `definedNames` AND
 * actually callable in the current mode — read-only tools need fallbackAllowed, write tools
 * additionally need FALLBACK_WRITE_ALLOWED_TOOL_NAMES + dataDir, mirroring callTool() exactly.
 */
function computeMcpCapabilitiesFromToolNames(definedNames, { dataDir, fallbackReadOnly }) {
  const fallbackAllowed = fallbackReadOnly || !!dataDir;
  const bridgeMode = fallbackAllowed ? 'js-fallback' : 'offline';

  const isToolUsable = (toolName) => {
    if (!definedNames.has(toolName)) return false;
    if (READ_ONLY_TOOL_NAMES.has(toolName)) return fallbackAllowed;
    return FALLBACK_WRITE_ALLOWED_TOOL_NAMES.has(toolName) && !!dataDir;
  };

  const missingRequiredTools = REQUIRED_DEVELOPER_WORKFLOW_TOOLS.filter((t) => !isToolUsable(t));
  const canRunImplementationVerification = isToolUsable('run_implementation_verification');
  const canRecordAiKitReview = isToolUsable('record_ai_kit_review_result');
  const canRunDeveloperWorkflow = missingRequiredTools.length === 0;

  let recommendedAction = null;
  if (bridgeMode === 'offline') {
    recommendedAction = 'Start the Task Workbench app so the local MCP bridge is reachable, then reload/reconnect the MCP server. No developer-workflow tools are available until then.';
  } else if (missingRequiredTools.length > 0) {
    recommendedAction = `Start the Task Workbench app for full functionality — this standalone MCP fallback cannot run: ${missingRequiredTools.join(', ')}.`;
  }

  return {
    bridgeMode,
    bridgeUrl: getCliBridgeUrl(),
    appVersion: null,
    serverVersion: SERVER_VERSION,
    toolsetVersion: SERVER_VERSION,
    requiredDeveloperWorkflowTools: REQUIRED_DEVELOPER_WORKFLOW_TOOLS,
    missingRequiredTools,
    canRunDeveloperWorkflow,
    canRunImplementationVerification,
    canRecordAiKitReview,
    recommendedAction,
  };
}

/** Computes get_task_workbench_mcp_capabilities' result for the standalone MCP fallback, from the
 *  live TOOL_DEFINITIONS list and current CLI flags. See computeMcpCapabilitiesFromToolNames. */
function computeMcpCapabilities() {
  const definedNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));
  return computeMcpCapabilitiesFromToolNames(definedNames, {
    dataDir: getCliDataDir(),
    fallbackReadOnly: isFallbackReadOnlyEnabled(),
  });
}

/**
 * Fail-fast guard for run_implementation_verification: if `nextAction` is 'run_ai_kit_review'
 * (i.e. the agent would be told to call record_ai_kit_review_result next) but `capabilities`
 * reports it as unavailable, override to a tooling_error / reload_mcp_or_start_app result instead
 * of a misleading instruction the agent cannot actually follow. Pure — no I/O — takes an already-
 * computed capabilities object (see computeMcpCapabilities/computeMcpCapabilitiesFromToolNames) so
 * tests can simulate a toolset missing the tool. run_implementation_verification must never report
 * status=pending_ai_kit_review / nextAction=run_ai_kit_review when record_ai_kit_review_result is
 * unavailable.
 */
function applyToolingAvailabilityGuard(status, nextAction, capabilities) {
  if (nextAction === 'run_ai_kit_review' && !capabilities.canRecordAiKitReview) {
    return { status: 'tooling_error', nextAction: 'reload_mcp_or_start_app', missingRequiredTools: ['record_ai_kit_review_result'] };
  }
  return { status, nextAction, missingRequiredTools: [] };
}

async function fetchBridgeToken(baseUrl) {
  try {
    const status = await bridgeRequestJson(baseUrl, '/mcp/status', null);
    const token = status?.bridgeToken ?? status?.result?.bridgeToken ?? null;
    if (token && typeof token === 'string') {
      cachedBridgeToken = token;
    }
  } catch {
    // token unavailable â€” proceed without token (will get 401 on write tools)
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

/**
 * Compute a resolved script naming block from customer dev defaults, task setup, and a matched template.
 * Returns null when the entity logical name cannot be determined.
 */
function computeScriptNaming(template, customerDevDefaults, taskSetup) {
  const entityName =
    (taskSetup && taskSetup.primaryEntityLogicalName) ||
    (template && template.scriptTarget && template.scriptTarget.entityLogicalName) ||
    (template && template.targetEntity) ||
    null;
  if (!entityName) return null;

  const eventFieldName =
    (taskSetup && taskSetup.eventFieldName) ||
    (template && template.scriptTarget && template.scriptTarget.eventFieldName) ||
    null;

  let scriptsFolderAbsolute = (customerDevDefaults && customerDevDefaults.scriptDirectory) || null;
  const repoRoot = (customerDevDefaults && customerDevDefaults.repositoryRoot) || null;

  // Derive relative folder from absolute path minus repositoryRoot prefix
  let scriptsFolderRelative =
    (template && template.scriptNaming && template.scriptNaming.scriptsFolderRelative) || null;
  if (!scriptsFolderRelative && scriptsFolderAbsolute) {
    if (repoRoot) {
      const normRepo = repoRoot.replace(/[/\\]+$/, '');
      if (scriptsFolderAbsolute.toLowerCase().startsWith(normRepo.toLowerCase())) {
        const rel = scriptsFolderAbsolute.slice(normRepo.length).replace(/^[/\\]+/, '');
        if (rel) scriptsFolderRelative = rel;
      }
    }
    if (!scriptsFolderRelative) {
      scriptsFolderRelative =
        scriptsFolderAbsolute.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Scripts';
    }
  }

  // Use backslash when any path uses backslash (Windows convention)
  const sep =
    (scriptsFolderAbsolute && scriptsFolderAbsolute.includes('\\')) ||
    (repoRoot && repoRoot.includes('\\'))
      ? '\\'
      : '/';

  // Derive absolute from repositoryRoot + relative folder when scriptDirectory not explicitly set
  if (!scriptsFolderAbsolute && repoRoot && scriptsFolderRelative) {
    scriptsFolderAbsolute = `${repoRoot}${sep}${scriptsFolderRelative}`;
  }

  const desiredScriptFile =
    (taskSetup && taskSetup.desiredScriptFile) ||
    (template && template.scriptNaming && template.scriptNaming.desiredScriptFile) ||
    `${entityName}_events.js`;

  const scriptPath = scriptsFolderRelative ? `${scriptsFolderRelative}${sep}${desiredScriptFile}` : null;
  const absoluteScriptPath = scriptsFolderAbsolute
    ? `${scriptsFolderAbsolute}${sep}${desiredScriptFile}`
    : null;

  const onLoadFunctionName =
    (taskSetup && taskSetup.onLoadFunctionName) ||
    (template && template.scriptNaming && template.scriptNaming.onLoadFunctionName) ||
    `${entityName}_OnLoad`;

  const onChangeFunctionName =
    (taskSetup && taskSetup.onChangeFunctionName) ||
    (template && template.scriptNaming && template.scriptNaming.onChangeFunctionName) ||
    (eventFieldName ? `${eventFieldName}_OnChange` : null);

  const mainHelperSuggestion =
    (taskSetup && taskSetup.mainHelperSuggestion) ||
    (template && template.scriptNaming && template.scriptNaming.mainHelperSuggestion) ||
    null;

  const namingSource =
    (taskSetup && taskSetup.namingSource) ||
    (template && template.scriptNaming && template.scriptNaming.namingSource) ||
    'Scripts_Naming';

  const result = {
    namingSource,
    entityLogicalName: entityName,
    desiredScriptFile,
    onLoadFunctionName,
    helperNamingRule: 'descriptive camelCase, no nvr_ prefix by default',
  };
  if (scriptsFolderAbsolute) result.scriptsFolderAbsolute = scriptsFolderAbsolute;
  if (scriptsFolderRelative) result.scriptsFolderRelative = scriptsFolderRelative;
  if (scriptPath) result.scriptPath = scriptPath;
  if (absoluteScriptPath) result.absoluteScriptPath = absoluteScriptPath;
  if (onChangeFunctionName) result.onChangeFunctionName = onChangeFunctionName;
  if (mainHelperSuggestion) result.mainHelperSuggestion = mainHelperSuggestion;
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

async function saveTasks(tasks) {
  const tasksFile = await resolveTasksFile();
  if (!tasksFile) throw new Error('Could not resolve tasks.json for local fallback write.');
  await fs.writeFile(tasksFile, JSON.stringify(tasks, null, 2));
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

function planApprovalSafetyCheck(task, packet) {
  const reasons = [];
  const workflow = asObject(task?.crmDeveloperWorkflow);
  const impl = asObject(packet?.implementation);
  const plan = asObject(workflow.technicalPlan);
  const hasPlan = !!workflow.technicalPlan && typeof workflow.technicalPlan === 'object';

  if (task.taskMode !== 'developer') {
    reasons.push("Task mode is not 'developer'.");
  }

  const workKind = workflow.detectedWorkKind || task.workflowSetup?.devTargetKind || 'unknown';
  if (!workKind || workKind === 'unknown') {
    reasons.push('Work kind is not yet classified. Set work kind to plugin or script.');
  }

  if (!hasPlan) {
    reasons.push('No technical plan has been saved. Call save_technical_plan first.');
  } else {
    if (plan.invalidatedAt) {
      reasons.push('Technical plan has been invalidated and must be regenerated.');
    }
    if (Array.isArray(plan.externalActionPreview) && plan.externalActionPreview.length > 0) {
      reasons.push('Technical plan includes external actions (deploy/upload/Dataverse write). These require manual user approval and cannot be auto-approved.');
    }
    const hasTodo = [
      ...(Array.isArray(plan.implementationSteps) ? plan.implementationSteps : []),
      ...(Array.isArray(plan.risks) ? plan.risks : []),
    ].some((s) => {
      const lower = String(s).toLowerCase();
      return lower.includes('todo') || lower.includes('scaffold') || lower.includes('placeholder');
    });
    if (hasTodo) {
      reasons.push('Technical plan steps or risks contain TODO/scaffold/placeholder text. Regenerate the plan with concrete implementation steps.');
    }
  }

  if (impl.scaffoldOnly === true) {
    reasons.push('scaffoldOnly=true: required write targets or field mappings are not fully defined.');
  }

  if (impl.finalConsistencyGuardApplied === true) {
    reasons.push('finalConsistencyGuardApplied=true: plan still contains scaffold/TODO text alongside empty field mappings.');
  }

  const requiresFm = impl.requiresFieldMappings === true;
  const fmCount = Array.isArray(impl.fieldMappings) ? impl.fieldMappings.length : 0;
  const fmSource = impl.fieldMappingsSource ?? 'none';
  const implementationPattern = impl.implementationPattern ?? null;
  const isNonMappingPattern = implementationPattern === 'ui-business-rule' || implementationPattern === 'ribbon-action';

  if (requiresFm) {
    if (fmCount === 0) {
      reasons.push('Field mappings are required but not defined. Define source→target field mappings in the technical plan before approving.');
    }
    if (fmSource !== 'template' && fmSource !== 'plan') {
      reasons.push(`fieldMappingsSource='${fmSource}' is not a trusted source. Only 'template' or 'plan' field mapping sources can be auto-approved.`);
    }
  } else if (isNonMappingPattern) {
    // UI/business-rule and ribbon-action scripts legitimately have no fieldMappings by design
    // (impl.requiresFieldMappings is already false for this pattern — see buildDeveloperWorkPacket).
    // Waiving the field-mapping checks above must not waive scrutiny outright: the rest of the
    // write target and business context still has to be concrete before auto-approval.
    const wt = asObject(packet?.writeTarget);
    if (!wt.targetEntity) reasons.push('Target entity is not set.');
    if (!wt.artifactPath) reasons.push('Target file/artifact path is not set.');
    if (!wt.eventName && !wt.eventFieldName) reasons.push('Event/eventField is not set.');
    const referencedFields = Array.isArray(impl.referencedFields) ? impl.referencedFields : [];
    const affectedFields = Array.isArray(impl.affectedFields) ? impl.affectedFields : [];
    if (referencedFields.length === 0 && affectedFields.length === 0) {
      reasons.push('No referenced/affected fields are defined for this UI/business-rule script.');
    }
    const businessRules = Array.isArray(impl.businessRules) ? impl.businessRules : [];
    if (businessRules.length === 0) {
      reasons.push('No business rules are defined for this UI/business-rule script.');
    }
    const acceptanceCriteria = Array.isArray(impl.acceptanceCriteria) ? impl.acceptanceCriteria : [];
    if (acceptanceCriteria.length === 0) {
      reasons.push('No acceptance criteria are defined for this UI/business-rule script.');
    }
  }

  return reasons;
}

/**
 * Returns true when the packet has the concrete trusted data needed to safely replace
 * stale scaffold plan steps/risks with deterministic steps derived from the work packet.
 *
 * Called only when planApprovalSafetyCheck returned exactly one reason (the scaffold text
 * reason). Belt-and-suspenders double-check of packet-level conditions.
 */
function canSafelyRefreshPlan(packet) {
  const impl = asObject(packet?.implementation);
  const wt   = asObject(packet?.writeTarget);

  const fmCount  = Array.isArray(impl.fieldMappings) ? impl.fieldMappings.length : 0;
  if (fmCount === 0) return false;

  const fmSource = impl.fieldMappingsSource ?? 'none';
  if (fmSource !== 'template' && fmSource !== 'plan') return false;

  if (impl.scaffoldOnly === true)                return false;
  if (impl.finalConsistencyGuardApplied === true) return false;

  if (!wt.artifactPath) return false;
  if (!wt.targetEntity)  return false;

  return true;
}

/**
 * Generates concrete, deterministic implementation steps from a trusted work packet.
 * Used by the safe plan refresh path to replace stale scaffold/TODO steps.
 */
function generateConcreteStepsFromPacket(packet) {
  const wt   = asObject(packet?.writeTarget);
  const impl = asObject(packet?.implementation);
  const fieldMappings    = Array.isArray(impl.fieldMappings)    ? impl.fieldMappings    : [];
  const validationFields = Array.isArray(impl.validationFields) ? impl.validationFields : [];
  const workKind = wt.kind ?? '';
  const steps = [];

  if (workKind === 'script' || workKind === 'ribbon') {
    if (wt.artifactPath) {
      steps.push(`Create or update ${wt.artifactPath}.`);
    }
    const onLoad   = wt.handlers?.onLoad   ?? '';
    const onChange = wt.handlers?.onChange ?? '';
    if (onLoad && onChange) {
      steps.push(`Register/prepare handlers ${onLoad} and ${onChange}.`);
    } else if (onLoad) {
      steps.push(`Register/prepare handler ${onLoad}.`);
    }
    if (wt.eventFieldName) {
      const sourceEntity = fieldMappings[0]?.source?.split('.')[0] ?? 'source';
      steps.push(`On ${wt.eventFieldName} change, retrieve ${sourceEntity} using Xrm.WebApi.retrieveRecord.`);
    }
    for (const m of fieldMappings) {
      if (m.source && m.target) {
        steps.push(`Copy ${m.source} to ${m.target}.`);
      }
    }
    for (const vf of validationFields) {
      if (typeof vf === 'string') {
        steps.push(`Use ${vf} only as validation source for conditional logic.`);
      }
    }
    steps.push('Do not auto-save the form.');
    steps.push('Do not upload/register the web resource automatically.');
  } else {
    // Plugin
    const artifact = wt.artifactPath || wt.pluginProject || '';
    if (artifact) {
      steps.push(`Create or update the plugin class in ${artifact}.`);
    }
    if (wt.message && wt.stage && wt.targetEntity) {
      steps.push(`Register handler for ${wt.message} ${wt.stage} on ${wt.targetEntity}.`);
    }
    for (const m of fieldMappings) {
      if (m.source && m.target) {
        steps.push(`Set ${m.target} from ${m.source}.`);
      }
    }
  }

  return steps;
}

const SCAFFOLD_TEXT_RE = /\btodo\b|\bscaffold\b|\bplaceholder\b|field\s+mappings?\s+(?:are\s+)?not\s+defined|field\s+mappings?\s+nejsou\s+definov|doplnění.*field\s+mapping|připravit\s+todo/i;

/**
 * Returns true if `word` (already lowercased) looks like a CRM logical entity/field name.
 * Requires a 3–5 lowercase-letter publisher prefix, an underscore, and a ≥3-char suffix.
 * The 3-char minimum on the prefix avoids common 2-letter English words (is_, on_, no_).
 */
function looksCrmLike(word) {
  const us = word.indexOf('_');
  if (us < 3 || us > 5 || us === word.length - 1) return false;
  const prefix = word.slice(0, us);
  const suffix = word.slice(us + 1);
  if (!/^[a-z]{3,5}$/.test(prefix)) return false;
  if (suffix.length < 3) return false;
  if (!/^[a-z]/.test(suffix)) return false;
  return /^[a-z0-9_]+$/.test(suffix);
}

/**
 * Builds the set of logical names (entities and fields) that are trusted in the given packet.
 * Includes: targetEntity, eventFieldName, entity/field parts from fieldMappings and validationFields.
 */
function buildAllowedLogicalNames(packet) {
  const allowed = new Set();
  const impl = asObject(packet?.implementation);
  const wt   = asObject(packet?.writeTarget);

  function addDotted(s) {
    if (!s) return;
    const lower = s.toLowerCase();
    allowed.add(lower);
    const dot = lower.indexOf('.');
    if (dot > 0) {
      allowed.add(lower.slice(0, dot));
      allowed.add(lower.slice(dot + 1));
    }
  }

  if (wt.targetEntity)   allowed.add(wt.targetEntity.toLowerCase());
  // eventFieldName is a field name (e.g. nvr_assetid), not an entity — add so risks that mention
  // the trigger field are not incorrectly removed.
  if (wt.eventFieldName) allowed.add(wt.eventFieldName.toLowerCase());

  (Array.isArray(impl.fieldMappings) ? impl.fieldMappings : []).forEach((m) => {
    addDotted(m.source);
    addDotted(m.target);
  });
  (Array.isArray(impl.validationFields) ? impl.validationFields : []).forEach(addDotted);

  return allowed;
}

/**
 * Returns true if riskText mentions a CRM-style logical name not present in allowed.
 * Iterates over word tokens (ASCII alphanumeric + underscore runs) to avoid false positives
 * from Czech or other multibyte characters.
 */
function riskMentionsUnknownEntity(riskText, allowed) {
  const lower = riskText.toLowerCase();
  const words = lower.match(/[a-z0-9_]+/g) ?? [];
  return words.some((w) => looksCrmLike(w) && !allowed.has(w));
}

/**
 * Returns cleaned risks: removes scaffold/TODO risks from existingRisks, also removes risks
 * that mention CRM entity names not present in the trusted packet (to eliminate hallucinated
 * or stale entity references), and appends standard guardrail risks if not already present.
 */
function generateCleanRisksFromPacket(existingRisks, packet) {
  const workKind = asObject(packet?.writeTarget).kind ?? '';
  const allowed  = buildAllowedLogicalNames(packet);
  const risks = (Array.isArray(existingRisks) ? existingRisks : [])
    .filter((r) => {
      const text = typeof r === 'string' ? r : JSON.stringify(r);
      return !SCAFFOLD_TEXT_RE.test(text) && !riskMentionsUnknownEntity(text, allowed);
    });

  const standard = (workKind === 'script' || workKind === 'ribbon')
    ? [
        'Dataverse metadata must be verified in-app for JS/TS.',
        'Web resource upload and form registration are manual/approval-gated steps.',
      ]
    : ['Plugin registration is a manual approval-gated step.'];

  for (const risk of standard) {
    const alreadyPresent = risks.some((r) => typeof r === 'string' && r.includes(risk));
    if (!alreadyPresent) risks.push(risk);
  }

  return risks;
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
    namingSource: setup.namingSource,
    onLoadFunctionName: setup.onLoadFunctionName,
    onChangeFunctionName: setup.onChangeFunctionName,
    mainHelperSuggestion: setup.mainHelperSuggestion,
    absoluteScriptPath: setup.absoluteScriptPath,
    implementationPattern: setup.implementationPattern,
    requiresFieldMappings: setup.requiresFieldMappings,
    referencedFields: setup.referencedFields,
    triggerFields: setup.triggerFields,
    affectedFields: setup.affectedFields,
    uiRules: setup.uiRules,
    optionSetValues: setup.optionSetValues,
    notificationIds: setup.notificationIds,
    forbiddenOperations: setup.forbiddenOperations,
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
    fieldMappings: Array.isArray(value.fieldMappings) ? value.fieldMappings : [],
    unmappedSourceFields: Array.isArray(value.unmappedSourceFields) ? value.unmappedSourceFields : [],
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

function appendMcpAuditNote(task, action) {
  const existing = String(task.notes ?? '').trim();
  const line = `[${new Date().toISOString()}] MCP local write: ${action}`;
  task.notes = existing ? `${existing}\n${line}` : line;
}

/** True for script/ribbon (JS/TS form) developer tasks, matching the branch used throughout the workflow gates. */
function isScriptWorkflowTask(task) {
  const setup = asObject(task.workflowSetup);
  const workflow = asObject(task.crmDeveloperWorkflow);
  const workKind = workflow.detectedWorkKind || setup.devTargetKind || 'unknown';
  return workKind === 'script' || workKind === 'ribbon' || setup.devTargetKind === 'script';
}

/** True for script/ribbon AND plugin tasks — the task kinds run_implementation_verification's
 *  hard-gate pipeline covers. Other kinds (repo-only, bugfix, review, general) are not part of
 *  the orchestrated verification pipeline and keep using their existing manual workflow. Mirrors
 *  Rust task_mcp_is_verifiable_dev_task — keep both in sync. */
function isVerifiableDevTask(task) {
  const setup = asObject(task.workflowSetup);
  const workflow = asObject(task.crmDeveloperWorkflow);
  const workKind = workflow.detectedWorkKind || setup.devTargetKind || 'unknown';
  return workKind === 'script' || workKind === 'ribbon' || workKind === 'plugin'
    || setup.devTargetKind === 'script' || setup.devTargetKind === 'plugin';
}

/** Mirrors Rust task_mcp_is_plugin_dev_task. */
function isPluginDevTask(task) {
  const setup = asObject(task.workflowSetup);
  const workflow = asObject(task.crmDeveloperWorkflow);
  return workflow.detectedWorkKind === 'plugin' || setup.devTargetKind === 'plugin';
}

/**
 * Compares the task's customer's expected Dataverse environment label against the active
 * Primarch connection's configured environment label. Returns [expected, active] only when BOTH
 * are set (non-empty, trimmed) and they differ under a case-insensitive comparison — an
 * intentionally opt-in check: tasks/connections that never set a label are not blocked by a check
 * that has nothing to compare against. Mirrors Rust task_mcp_dataverse_environment_mismatch.
 */
function dataverseEnvironmentMismatch(task, customers, settings) {
  const customerId = task.customerId || '';
  const customer = (Array.isArray(customers) ? customers : []).find((c) => c && c.id === customerId);
  const expected = String(customer?.dataverseEnvironmentLabel ?? '').trim() || null;
  const active = String(asObject(settings).primarchMcpEnvironmentLabel ?? '').trim() || null;
  if (expected && active && expected.toLowerCase() !== active.toLowerCase()) {
    return [expected, active];
  }
  return null;
}

/**
 * Normalizes a raw Dataverse Metadata Check status (from deriveDataverseCheckStatusForVerification,
 * or a manual override such as "skipped"/"manually-verified") into the hard-gate status used to
 * decide workflow progression. "warnings" only becomes "passed" once the user has explicitly
 * accepted them (implementationVerification.dataverseCheck.warningsAccepted.accepted) —
 * otherwise it is "warnings_unaccepted" and blocks progression. Mirrors Rust
 * task_mcp_normalize_dataverse_gate.
 */
function normalizeDataverseGate(rawStatus, warningsAccepted) {
  switch (rawStatus) {
    case 'passed':
    case 'skipped':
    case 'manually-verified':
      return 'passed';
    case 'warnings':
      return warningsAccepted ? 'passed' : 'warnings_unaccepted';
    case 'failed':
      return 'failed';
    case 'needs_configuration':
      return 'needs_configuration';
    default:
      return 'not_run';
  }
}

/**
 * Evaluates whether a persisted AI Kit review payload (implementationVerification.aiCodeReview)
 * satisfies the hard-gate requirements. There are two independent ways to resolve the gate:
 *   1. An automated review with status "passed", empty fixableFindings, and non-empty
 *      reviewedFiles/rulesFiles/checklistFiles/knownPrReviewFiles — a "passed" status with
 *      missing details is treated as incomplete, not passed.
 *   2. An explicit manual UI override ("manually-verified" or "skipped") — these represent an
 *      explicit user decision and resolve the gate without requiring the automated detail payload.
 * Returns [gateStatus, missingDetailReasons] where gateStatus is one of
 * "passed" | "incomplete" | "failed" | "pending" | "not_run". Mirrors Rust task_mcp_ai_kit_review_gate.
 */
function aiKitReviewGate(review) {
  if (!review || typeof review !== 'object') return ['not_run', []];
  const status = review.status || '';
  if (!status) return ['not_run', []];

  if (status === 'manually-verified' || status === 'skipped') return ['passed', []];

  const hasItems = (key) => Array.isArray(review[key]) && review[key].length > 0;
  const missing = [];
  if (!hasItems('reviewedFiles')) missing.push('reviewedFiles is empty');
  if (!hasItems('rulesFiles')) missing.push('rulesFiles is empty');
  if (!hasItems('checklistFiles')) missing.push('checklistFiles is empty');
  if (!hasItems('knownPrReviewFiles')) missing.push('knownPrReviewFiles is empty');

  if (hasItems('fixableFindings')) {
    missing.push('fixableFindings is non-empty');
    return ['failed', missing];
  }
  switch (status) {
    case 'failed':
      return ['failed', missing];
    case 'warnings':
      return ['pending', missing];
    case 'passed':
      return missing.length === 0 ? ['passed', []] : ['incomplete', missing];
    default:
      return ['not_run', []];
  }
}

/** Reads whether the user has explicitly accepted the current Dataverse Metadata Check warnings
 *  (implementationVerification.dataverseCheck.warningsAccepted.accepted). Never true unless a
 *  prior accept_dataverse_warnings call set it. Mirrors Rust task_mcp_dataverse_warnings_accepted. */
function dataverseWarningsAccepted(task) {
  return asObject(asObject(asObject(task.implementationVerification).dataverseCheck).warningsAccepted).accepted === true;
}

/**
 * Builds the flat "kind/logicalName/entity/attribute/status" reference list the Implementation
 * Verification modal and Dataverse checks render as "checked entities/fields" — factored out so
 * run_implementation_verification's Dataverse Metadata Check step reports the exact same detail
 * shape. Mirrors Rust task_mcp_build_verified_references_list.
 */
function buildVerifiedReferencesList(report) {
  const r = asObject(report);
  const verified = [];
  for (const ref of Array.isArray(r.confirmedReferences) ? r.confirmedReferences : []) {
    verified.push({
      kind: ref.kind, logicalName: ref.displayName,
      entityLogicalName: ref.entityLogicalName, attributeLogicalName: ref.attributeLogicalName,
      status: 'found',
    });
  }
  for (const ref of Array.isArray(r.missingReferences) ? r.missingReferences : []) {
    verified.push({
      kind: ref.kind, logicalName: ref.displayName,
      entityLogicalName: ref.entityLogicalName, attributeLogicalName: ref.attributeLogicalName,
      status: 'missing',
    });
  }
  for (const ref of Array.isArray(r.ambiguousReferences) ? r.ambiguousReferences : []) {
    verified.push({
      kind: ref.kind, logicalName: ref.displayName, entityLogicalName: ref.entityLogicalName,
      status: 'unverified',
    });
  }
  return verified;
}

/** Picks the file from filesChanged that best matches the task's known script artifact/name. */
function resolveImplementedScriptArtifact(task, filesChanged) {
  const scriptCandidates = filesChanged.filter((f) => /\.[jt]sx?$/i.test(String(f)));
  if (scriptCandidates.length === 0) return null;
  const setup = asObject(task.workflowSetup);
  const normalize = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();
  const desired = normalize(setup.desiredScriptFile);
  const existing = normalize(setup.artifactPath || setup.scriptPath);
  let match = desired ? scriptCandidates.find((f) => normalize(f).endsWith(desired)) : null;
  if (!match && existing) {
    match = scriptCandidates.find((f) => normalize(f) === existing || (existing && existing.endsWith(normalize(f))));
  }
  return match || scriptCandidates[0];
}

/**
 * Persists the file AI just implemented into the UI-visible script selection fields, so
 * TaskDevModePanel / ImplementationVerificationModal / repositoryContext.ts resolve to the
 * actual implemented artifact instead of a stale or empty workflowSetup.artifactPath.
 */
function applyImplementedScriptArtifactToWorkflowSetup(task, implementedPath) {
  if (!implementedPath) return;
  const setup = asObject(task.workflowSetup);
  task.workflowSetup = setup;
  const normalizedPath = String(implementedPath).replace(/\\/g, '/');
  setup.artifactPath = implementedPath;
  setup.desiredScriptFile = normalizedPath.split('/').pop();
  if (path.isAbsolute(implementedPath)) {
    setup.absoluteScriptPath = implementedPath;
  } else if (setup.repositoryRoot) {
    setup.absoluteScriptPath = path.join(setup.repositoryRoot, implementedPath);
  }
}

/**
 * Applies an AI Kit / Client-API review result (performed by the calling AI agent itself) to a
 * task: writes implementationVerification.aiCodeReview (the canonical field the modal reads) and
 * task.aiKitReview (the separate continue_developer_workflow pre-branch gate, kept for
 * back-compat — no longer the real gate). `args` is the raw record_ai_kit_review_result tool
 * payload — this is the single place that knows the full review payload shape (reviewedFiles,
 * rulesFiles, checklistFiles, knownPrReviewFiles, nonFixableWarnings, checkedItems, skippedItems,
 * summary), so a "passed" review missing those details can be told apart from a genuinely
 * complete one (see aiKitReviewGate). Throws on an invalid status. Mirrors Rust
 * task_mcp_apply_ai_kit_review_result.
 */
function applyAiKitReviewResult(task, args, now) {
  const status = String(args.status ?? '').trim();
  if (!['passed', 'failed', 'warnings'].includes(status)) {
    throw new Error(`Invalid status '${status}'. Allowed: passed, failed, warnings`);
  }
  const arr = (key) => (Array.isArray(args[key]) ? args[key] : []);
  const summary = String(args.summary ?? '');

  task.implementationVerification = asObject(task.implementationVerification);
  task.implementationVerification.aiCodeReview = {
    status,
    reviewSource: 'claude-ai-kit',
    reviewedFiles: arr('reviewedFiles'),
    findings: arr('findings'),
    fixableFindings: arr('fixableFindings'),
    nonFixableWarnings: arr('nonFixableWarnings'),
    rulesFiles: arr('rulesFiles'),
    checklistFiles: arr('checklistFiles'),
    knownPrReviewFiles: arr('knownPrReviewFiles'),
    checkedItems: arr('checkedItems'),
    skippedItems: arr('skippedItems'),
    summary,
    reviewedAt: now,
    runAt: now,
  };
  task.implementationVerification.updatedAt = now;
  // Keeps continue_developer_workflow's separate pre-branch AI Kit gate
  // (task.aiKitReview.completedAt/status) from dead-ending after this review.
  task.aiKitReview = { completedAt: now, status, reviewSource: 'claude-ai-kit' };
}

/** Resolves an absolute filesystem path for the task's current script artifact, if known. */
function resolveScriptAbsolutePath(task) {
  const setup = asObject(task.workflowSetup);
  if (setup.absoluteScriptPath) return setup.absoluteScriptPath;
  const artifact = setup.artifactPath || setup.scriptPath || '';
  if (!artifact) return null;
  if (path.isAbsolute(artifact)) return artifact;
  if (setup.repositoryRoot) return path.join(setup.repositoryRoot, artifact);
  return null;
}

/**
 * Resolves an absolute artifact path for a plugin task, mirroring Rust's mcp_resolve_artifact_path:
 * explicit workflowSetup.artifactPath/scriptPath first, then infers a single .cs file from the
 * plugin project folder (repositoryRoot/Plugins/<project>/<project>, or customer.pluginFolder/
 * <project>/<project>, or settings.crmBaseDirectory/customer.folderName/Plugins/<project>/
 * <project>). When exactly one .cs file (excluding AssemblyInfo.cs) is found in a candidate
 * folder, the result is persisted into task.workflowSetup.artifactPath so subsequent calls and
 * the UI see the same resolved path. Returns null when nothing can be resolved unambiguously.
 */
async function resolvePluginArtifactPath(task, customers, settings) {
  const setup = asObject(task.workflowSetup);
  const explicit = setup.artifactPath || setup.scriptPath;
  if (explicit) return String(explicit).replace(/\\/g, '/');

  const projectName = String(setup.pluginProject || task.selectedPluginProject || '').trim();
  if (!projectName) return null;

  const candidates = [];
  if (setup.repositoryRoot) {
    candidates.push(path.join(setup.repositoryRoot, 'Plugins', projectName, projectName));
  }
  const customerId = task.customerId || '';
  if (customerId) {
    const customer = (Array.isArray(customers) ? customers : []).find((c) => c && c.id === customerId);
    if (customer?.pluginFolder) {
      candidates.push(path.join(customer.pluginFolder, projectName, projectName));
    }
    const crmBaseDirectory = asObject(settings).crmBaseDirectory;
    if (crmBaseDirectory && customer?.folderName) {
      candidates.push(path.join(crmBaseDirectory, customer.folderName, 'Plugins', projectName, projectName));
    }
  }

  for (const folder of candidates) {
    let entries;
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    const csFiles = entries
      .filter((e) => e.isFile() && /\.cs$/i.test(e.name) && !/assemblyinfo/i.test(e.name))
      .map((e) => path.join(folder, e.name).replace(/\\/g, '/'));
    if (csFiles.length === 1) {
      setup.artifactPath = csFiles[0];
      task.workflowSetup = setup;
      return csFiles[0];
    }
    // Zero or multiple matches in this candidate folder: try the next candidate rather than
    // erroring — a clean single match is preferred, but an ambiguous folder should not prevent
    // trying other known locations.
  }
  return null;
}

/** Artifact File Readiness check for run_implementation_verification: real filesystem read.
 *  Generic over script/ribbon (.js/.ts) and plugin (.cs) artifacts — only the wording differs. */
async function checkArtifactFileReadinessForVerification(absolutePath, isPlugin) {
  const kind = isPlugin ? 'plugin' : 'script';
  if (!absolutePath) {
    return {
      status: 'failed',
      findings: [`No ${kind} artifact path is set on the task. Call record_ai_implementation_completed with filesChanged first.`],
      fixable: true,
      fixDescription: 'Persist the implemented file path via record_ai_implementation_completed before verifying.',
      fileContent: null,
    };
  }
  try {
    const content = await fs.readFile(absolutePath, 'utf8');
    const lineCount = content.split('\n').length;
    const isEmpty = content.trim().length === 0;
    return {
      status: isEmpty ? 'failed' : 'passed',
      findings: [
        isEmpty
          ? `Artifact file exists but is empty: ${path.basename(absolutePath)}.`
          : `Artifact file found: ${path.basename(absolutePath)} (${lineCount} lines).`,
      ],
      fixable: isEmpty,
      fixDescription: isEmpty ? 'Write the actual implementation to the artifact file.' : null,
      fileContent: isEmpty ? null : content,
    };
  } catch (e) {
    return {
      status: 'failed',
      findings: [`Artifact file not found or unreadable at ${absolutePath}: ${String(e?.message || e)}`],
      fixable: true,
      fixDescription: 'Verify the implemented file was written to the expected path and call record_ai_implementation_completed again.',
      fileContent: null,
    };
  }
}

/** Deterministic regex-based business-rule checks, driven by template.staticRules. No LLM call. */
function runStaticBusinessRuleChecks(template, fileContent) {
  const rules = Array.isArray(template?.staticRules) ? template.staticRules : [];
  if (rules.length === 0) {
    return {
      name: 'Local Static/Business-Rule Verification',
      status: 'skipped',
      findings: ['No static rules are defined for this task template.'],
      fixableFindings: [],
    };
  }
  const results = rules.map((rule) => {
    let matched = false;
    try {
      matched = new RegExp(rule.pattern, 'i').test(fileContent);
    } catch {
      matched = false;
    }
    const pass = rule.type === 'must-not-match' ? !matched : matched;
    return { id: rule.id, description: rule.description, pass };
  });
  const failed = results.filter((r) => !r.pass);
  return {
    name: 'Local Static/Business-Rule Verification',
    status: failed.length === 0 ? 'passed' : 'failed',
    findings: results.map((r) => `${r.pass ? 'pass' : 'fail'}|${r.description}`),
    fixableFindings: failed.map((r) => ({ id: r.id, description: r.description })),
  };
}

/**
 * AI Internal Code Review is the in-app LLM-backed review (Implementation Verification modal /
 * AI Kit). MCP cannot trigger that from a headless tool call, so this only reports back whatever
 * has already been recorded — it does not duplicate a separate MCP-only AI review path.
 */
// Statuses that count as "resolved" for a modal check row without MCP re-running it.
const IMPL_CHECK_RESOLVED_STATUSES = new Set(['passed', 'warnings', 'skipped', 'manually-verified', 'failed']);

/**
 * Mirrors ImplementationVerificationModal's deriveDataverseCheckStatus (src/components/
 * ImplementationVerificationModal.tsx). Read-only — MCP cannot run the Dataverse metadata
 * check for JS/TS files (Rust's run_dataverse_check_for_task rejects .js/.ts artifacts and
 * tells the caller to use the modal, which uses a browser-side scanner + live Primarch call
 * unavailable to a headless tool). This only reports the same status the modal would show.
 */
function deriveDataverseCheckStatusForVerification(task) {
  const override = asObject(asObject(task.implementationVerification).dataverseCheck);
  if (override.status === 'skipped' || override.status === 'manually-verified' || override.status === 'needs_configuration') {
    return override.status;
  }
  const verdict = (Array.isArray(task.crmVerificationReports) ? task.crmVerificationReports : [])[0]?.verdict;
  if (verdict === 'pass') return 'passed';
  if (verdict === 'warnings') return 'warnings';
  if (verdict === 'fail') return 'failed';
  if (verdict === 'not_configured') return 'warnings';
  return 'not-run';
}

/**
 * Read-only passthrough for the "Dataverse Metadata Check" modal row. Never writes
 * task.implementationVerification.dataverseCheck — MCP is not the source of truth for this
 * check for script tasks, it only reports back what the modal already recorded (or hasn't).
 */
function dataverseMetadataCheckPassthrough(task) {
  const status = deriveDataverseCheckStatusForVerification(task);
  if (IMPL_CHECK_RESOLVED_STATUSES.has(status)) {
    return { name: 'Dataverse Metadata Check', status, findings: [`Existing Dataverse Metadata Check status: ${status}.`] };
  }
  return {
    name: 'Dataverse Metadata Check',
    status: 'needs_manual_action',
    findings: ['Run Dataverse Metadata Check in the Implementation Verification modal.'],
  };
}

/**
 * Read-only passthrough for the "AI Internal Code Review" modal row (task.
 * implementationVerification.aiCodeReview — the LLM-backed AI Kit/Settings Reviewer, distinct
 * from the deterministic staticRules check below). MCP cannot invoke a live LLM reviewer from
 * a headless tool call, so this only reports back what the modal already recorded.
 */
function aiInternalCodeReviewPassthrough(task) {
  const status = asObject(asObject(task.implementationVerification).aiCodeReview).status;
  if (IMPL_CHECK_RESOLVED_STATUSES.has(status)) {
    return { name: 'AI Internal Code Review', status, findings: [`Existing AI Kit review status: ${status}.`] };
  }
  return {
    name: 'AI Internal Code Review',
    status: 'needs_manual_action',
    findings: ['Run AI Kit Review or Settings Reviewer in the Implementation Verification modal.'],
  };
}

/**
 * Read-only passthrough for the "Local Test" modal row (task.implementationVerification.
 * localTest — distinct from the top-level task.localTestRecord used by continue_developer_
 * workflow's step 1 gate). record_ai_implementation_completed now writes this field directly
 * for new AI-managed completions; for tasks completed before that write existed, backfill the
 * same derivation here so every read path agrees.
 */
function localTestImplPassthrough(task) {
  const status = asObject(asObject(task.implementationVerification).localTest).status;
  if (status === 'passed' || status === 'not-needed' || status === 'failed') {
    return { name: 'Local Test', status, findings: [`Existing Local Test status: ${status}.`] };
  }
  if (isLegacyAiManagedLocalTestNotNeeded(task)) {
    return {
      name: 'Local Test',
      status: 'not-needed',
      findings: ['Skipped for AI-managed workflow; no browser/model-driven app test was performed.'],
    };
  }
  return {
    name: 'Local Test',
    status: 'needs_manual_action',
    findings: ['Record Local Test in the Implementation Verification modal after manual/browser CRM testing (or mark it not-needed there).'],
  };
}

/**
 * Compatibility/backfill condition: an AI implementation was completed AND the legacy
 * localTestRecord already marks Local Test as not-needed, but the canonical
 * implementationVerification.localTest field predates record_ai_implementation_completed
 * writing it directly. Ordinary manually managed tasks (no completed AI implementation) never
 * match this and must still show Local Test as not-run/needs_manual_action.
 */
function isLegacyAiManagedLocalTestNotNeeded(task) {
  const aiCompleted = Boolean(asObject(task.crmDeveloperWorkflow?.lastAiImplementation).completedAt);
  const legacyNotNeeded = asObject(task.localTestRecord).status === 'not-needed';
  return aiCompleted && legacyNotNeeded;
}

/**
 * Called by record_ai_implementation_completed to write the canonical Local Test result for an
 * AI-managed workflow — no browser/model-driven app test was performed, so it is recorded as
 * not-needed, never as passed. Never overwrites an explicit passed/failed result already
 * recorded via the Implementation Verification modal.
 */
function recordAiManagedLocalTestNotNeeded(task, now) {
  task.implementationVerification = asObject(task.implementationVerification);
  const existingStatus = asObject(task.implementationVerification.localTest).status;
  if (existingStatus === 'passed' || existingStatus === 'failed') return;
  task.implementationVerification.localTest = {
    status: 'not-needed',
    recordedAt: now,
    notes: 'Skipped for AI-managed workflow; no browser/model-driven app test was performed.',
  };
}

/**
 * Normalized, modal-truth verification summary — the same shape regardless of which MCP tool
 * returns it (run_implementation_verification, get_implementation_verification_summary, or the
 * Rust get_task_workflow_overview). Built ONLY from the canonical fields ImplementationVerification
 * Modal reads (task.implementationVerification.buildCheck/dataverseCheck/aiCodeReview/localTest,
 * task.crmVerificationReports). Never a side-channel-only MCP result.
 */
function buildModalVerificationSummary(task) {
  const buildCheck = asObject(asObject(task.implementationVerification).buildCheck);
  const dv = dataverseMetadataCheckPassthrough(task);
  const ai = aiInternalCodeReviewPassthrough(task);
  const lt = localTestImplPassthrough(task);
  return {
    buildCheck: {
      status: buildCheck.status || 'not-run',
      label: 'Script File Readiness',
      ...(buildCheck.summary ? { message: buildCheck.summary } : {}),
    },
    dataverseCheck: { status: dv.status, label: 'Dataverse Metadata Check', message: dv.findings[0] },
    aiCodeReview: { status: ai.status, label: 'AI Internal Code Review', message: ai.findings[0] },
    localTest: { status: lt.status, label: 'Local Test', message: lt.findings[0] },
  };
}

/** Keys of the modal-required rows still unresolved (needs_manual_action or genuinely not-run). */
function unresolvedModalRows(summary) {
  const unresolved = (row) => row.status === 'needs_manual_action' || row.status === 'not-run';
  const rows = [];
  if (unresolved(summary.dataverseCheck)) rows.push('dataverseCheck');
  if (unresolved(summary.aiCodeReview)) rows.push('aiCodeReview');
  if (unresolved(summary.localTest)) rows.push('localTest');
  return rows;
}

/**
 * Single source of truth for "can this task move to Code Review / Waiting for PR". Computed from
 * the exact same fields (implementationVerification.dataverseCheck / implementationVerification.
 * aiCodeReview) that run_implementation_verification and the Implementation Verification modal
 * both read/write, so the MCP-facing workflow and the human-facing "Move to Code Review" button
 * enforce identical rules. Mirrors Rust task_mcp_compute_progression_gate. Pure — no I/O.
 */
function computeProgressionGate(task) {
  const dvRaw = deriveDataverseCheckStatusForVerification(task);
  const dvAccepted = dataverseWarningsAccepted(task);
  const dvGate = normalizeDataverseGate(dvRaw, dvAccepted);

  const aiReview = asObject(asObject(task.implementationVerification).aiCodeReview);
  const [aiGate, aiMissing] = aiKitReviewGate(aiReview);

  const blockingChecks = [];
  const blockingFindings = [];

  switch (dvGate) {
    case 'passed':
      break;
    case 'warnings_unaccepted':
      blockingChecks.push({
        check: 'dataverseCheck', status: dvGate,
        reason: 'Dataverse Metadata Check completed with warnings that have not been explicitly accepted.',
      });
      break;
    case 'needs_configuration':
      blockingChecks.push({
        check: 'dataverseCheck', status: dvGate,
        reason: "Dataverse Metadata Check cannot run — Primarch/Dataverse connection is not configured or does not match the task's environment.",
      });
      break;
    case 'failed': {
      const missingRefs = Array.isArray(task.crmVerificationReports?.[0]?.missingReferences)
        ? task.crmVerificationReports[0].missingReferences : [];
      for (const m of missingRefs) {
        blockingFindings.push({ check: 'dataverseCheck', description: `'${m.displayName ?? 'unknown'}' was not found in Dataverse.` });
      }
      blockingChecks.push({
        check: 'dataverseCheck', status: dvGate,
        reason: 'Dataverse Metadata Check found missing/incorrect references.',
      });
      break;
    }
    default:
      blockingChecks.push({ check: 'dataverseCheck', status: dvGate, reason: 'Dataverse Metadata Check has not run yet.' });
  }

  switch (aiGate) {
    case 'passed':
      break;
    case 'failed': {
      const fixable = Array.isArray(aiReview.fixableFindings) ? aiReview.fixableFindings : [];
      for (const f of fixable) blockingFindings.push({ check: 'aiCodeReview', description: f.description });
      blockingChecks.push({
        check: 'aiCodeReview', status: aiGate,
        reason: 'AI Kit Code Review found fixable findings or an explicit failed verdict.',
      });
      break;
    }
    case 'incomplete':
      blockingChecks.push({
        check: 'aiCodeReview', status: aiGate,
        reason: `AI Kit Code Review is missing required details: ${aiMissing.join(', ')}.`,
      });
      break;
    case 'pending':
      blockingChecks.push({
        check: 'aiCodeReview', status: aiGate,
        reason: "AI Kit Code Review verdict is 'warnings' — must be resolved to 'passed'.",
      });
      break;
    default:
      blockingChecks.push({ check: 'aiCodeReview', status: aiGate, reason: 'AI Kit Code Review has not run yet.' });
  }

  const canProceed = blockingChecks.length === 0;
  const requiresUserAction = dvGate === 'warnings_unaccepted' || dvGate === 'needs_configuration';
  let nextRecommendedAction;
  if (canProceed) {
    nextRecommendedAction = 'continue_workflow';
  } else if (blockingFindings.length > 0) {
    nextRecommendedAction = 'fix_code';
  } else if (aiGate === 'incomplete' || aiGate === 'pending' || aiGate === 'not_run') {
    nextRecommendedAction = 'run_ai_kit_review';
  } else if (dvGate === 'needs_configuration') {
    nextRecommendedAction = 'needs_configuration';
  } else if (dvGate === 'warnings_unaccepted') {
    nextRecommendedAction = 'review_dataverse_warnings';
  } else {
    nextRecommendedAction = 'wait_for_user';
  }

  return {
    canProceed,
    blockingChecks,
    blockingFindings,
    requiresUserAction,
    nextRecommendedAction,
    dataverseGateStatus: dvGate,
    aiReviewGateStatus: aiGate,
  };
}

/**
 * Composes the single, complete manual-action message used by continue_developer_workflow,
 * get_task_workflow_overview.nextRecommendedStep, run_implementation_verification, and the
 * Implementation Verification modal footer — so all four always say the same thing. Only
 * mentions the checks that are actually still unresolved. Deliberately covers only Dataverse/AI
 * Kit review — deployment/browser testing is a later, separate phase (see
 * computeDeploymentTestingGate below and src/lib/deploymentTestingGate.ts).
 */
function composeManualVerificationStep(summary) {
  const dvNeeds = summary.dataverseCheck.status === 'needs_manual_action' || summary.dataverseCheck.status === 'not-run';
  const aiNeeds = summary.aiCodeReview.status === 'needs_manual_action' || summary.aiCodeReview.status === 'not-run';

  const modalNames = [];
  if (dvNeeds) modalNames.push('Dataverse Metadata Check');
  if (aiNeeds) modalNames.push('AI Kit/Settings Review');

  return modalNames.length > 0
    ? `Run ${modalNames.join(' and ')} in the Implementation Verification modal.`
    : 'All Implementation Verification checks are resolved.';
}

// ---------------------------------------------------------------------------
// Deployment & Testing gate — mirrors src/lib/deploymentTestingGate.ts
// (computeDeploymentTestingGate, computeCodeReviewReadinessGate) and
// task_mcp_compute_deployment_testing_gate / task_mcp_compute_code_review_readiness_gate in
// src-tauri/src/lib.rs. Deliberately never reads implementationVerification.localTest, the legacy
// localTestRecord, or consultantTestRecord — those predate the artifact ever being deployed.
// ---------------------------------------------------------------------------

function deriveManualDeploymentStatus(task) {
  return asObject(asObject(task.deploymentTesting).deployment).status || 'not-run';
}

function deriveDeploymentTestStatus(task) {
  return asObject(asObject(task.deploymentTesting).test).status || 'not-run';
}

/** Single source of truth for "can this task proceed to Commit & Push". Pure — no I/O. */
function computeDeploymentTestingGate(task) {
  const deploymentStatus = deriveManualDeploymentStatus(task);
  const testStatus = deriveDeploymentTestStatus(task);
  const blockingChecks = [];

  const deploymentResolved = deploymentStatus === 'deployed' || deploymentStatus === 'not-needed';
  if (!deploymentResolved) {
    blockingChecks.push({
      check: 'deployment', status: deploymentStatus,
      reason: deploymentStatus === 'failed'
        ? 'Manual deployment was recorded as failed. Redeploy and record the result before testing.'
        : 'Manual deployment has not been recorded yet.',
    });
  }
  if (deploymentResolved) {
    if (testStatus === 'failed') {
      blockingChecks.push({ check: 'test', status: testStatus, reason: 'Deployment test failed. Fix the code or redeploy, then record a new test result.' });
    } else if (testStatus === 'not-run') {
      blockingChecks.push({ check: 'test', status: testStatus, reason: 'Browser/model-driven app test has not been recorded yet.' });
    }
  }

  const canProceedToCommit = blockingChecks.length === 0;
  let nextRecommendedAction;
  if (canProceedToCommit) nextRecommendedAction = 'prepare_commit';
  else if (!deploymentResolved) nextRecommendedAction = 'wait_for_manual_deployment';
  else if (testStatus === 'failed') nextRecommendedAction = 'fix_code_or_redeploy';
  else nextRecommendedAction = 'wait_for_deployment_test';

  return { canProceedToCommit, deploymentStatus, testStatus, blockingChecks, nextRecommendedAction };
}

/**
 * Single source of truth for "can this task enter Code Review / waiting for colleague review".
 * Requires a verified local commit, a verified push of that same branch, and an explicitly
 * created/recorded pull request — never satisfied by an AI/Claude code review alone.
 */
function computeCodeReviewReadinessGate(task) {
  const gw = asObject(task.gitWorkflow);
  const commitVerified = !!gw.lastCommitHash;
  const pushVerified = !!gw.lastPushedBranch && !!gw.lastPushedAt
    && (!gw.lastCommitBranch || gw.lastPushedBranch === gw.lastCommitBranch);

  const prTracking = asObject(asObject(task.crmDeveloperWorkflow).pullRequestTracking);
  const prRecorded = !!(prTracking.createdManually && prTracking.prUrl && !prTracking.invalidatedAt);

  const blockingReasons = [];
  if (!commitVerified) blockingReasons.push('No verified commit is recorded for this task yet.');
  if (commitVerified && !pushVerified) blockingReasons.push('Commit is not yet verified as pushed to the remote branch.');
  if (pushVerified && !prRecorded) blockingReasons.push('No pull request has been created or recorded for this task yet.');

  const canEnterCodeReview = commitVerified && pushVerified && prRecorded;
  let nextRecommendedAction;
  if (canEnterCodeReview) nextRecommendedAction = 'wait_for_colleague_code_review';
  else if (!commitVerified || !pushVerified) nextRecommendedAction = 'commit_and_push';
  else nextRecommendedAction = 'prepare_pull_request';

  return { canEnterCodeReview, commitVerified, pushVerified, prRecorded, blockingReasons, nextRecommendedAction };
}

function safeString(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 500) return '';
  return /[|&;`$><\n\r]/.test(text) ? '' : text;
}

function workActionFromActionType(actionType) {
  return String(actionType ?? '').startsWith('create-') ? 'create' : 'update';
}

function templateFieldMapping(template, targetEntity) {
  const sourceEntity = template?.sourceEntity || 'source';
  const sourceFields = Array.isArray(template?.sourceFields) ? template.sourceFields : [];
  const targetFields = Array.isArray(template?.targetFields) ? template.targetFields : [];
  const pairCount = Math.min(sourceFields.length, targetFields.length);
  const pairs = [];
  for (let index = 0; index < pairCount; index += 1) {
    pairs.push({
      source: `${sourceEntity}.${sourceFields[index]}`,
      target: `${targetEntity}.${targetFields[index]}`,
    });
  }
  const unmappedSourceFields = [
    ...sourceFields.slice(pairCount),
    ...(Array.isArray(template?.additionalSourceFields) ? template.additionalSourceFields : []),
  ];
  const mappingLine = pairs.length
    ? `Map template fields: ${pairs.map((pair) => `${pair.source} -> ${pair.target}`).join('; ')}.`
    : null;
  const additionalLine = unmappedSourceFields.length
    ? `Additional source field${unmappedSourceFields.length === 1 ? '' : 's'} available from template: ${unmappedSourceFields.join(', ')}. No target mapping is defined.`
    : null;
  return { pairs, unmappedSourceFields, mappingLine, additionalLine };
}

function buildTaskFullContext(task, customerDevDefaults) {
  const detail = safeTaskDetail(task);
  detail.implementationReadiness = computeImplementationReadiness(task);
  if (customerDevDefaults) detail.customerDevDefaults = customerDevDefaults;
  const workKind = task.crmDeveloperWorkflow?.detectedWorkKind || task.workflowSetup?.devTargetKind;
  if (workKind === 'script' || workKind === 'ribbon') {
    const naming = computeScriptNaming(matchTaskTemplate(task.title || '', taskTextForInference(task)), customerDevDefaults, task.workflowSetup);
    if (naming) detail.developerWorkPacket = { scriptNaming: naming };
  }
  return detail;
}

/**
 * Scans all available task text for CRM source→target field mapping work indicators.
 * Returns { required, mappings, validationFields, sources }:
 *   required         – text clearly indicates field mapping work is needed
 *   mappings         – extracted {source,target} pairs if safely parseable, otherwise []
 *   validationFields – field refs identified as read-only (source-only, no target write)
 *   sources          – list of text source names that were scanned and non-empty (for debug)
 */
function detectAndExtractFieldMappings(task) {
  const stripHtml = (s) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, ' ') : '');
  const workflow = asObject(task.crmDeveloperWorkflow);
  const plan = asObject(
    workflow.technicalPlan && typeof workflow.technicalPlan === 'object' ? workflow.technicalPlan : null
  );
  const joinArray = (arr) =>
    Array.isArray(arr)
      ? arr.map((x) => (typeof x === 'string' ? x : (x?.description || x?.step || x?.risk || x?.text || JSON.stringify(x)))).join('\n')
      : '';

  // Gather text from every stored text source in priority order.
  const textSources = {
    originalMessage: stripHtml(task.originalMessage),
    description: stripHtml(task.description),
    analysisEn: stripHtml(task.analysisResult?.summaryEn ?? ''),
    analysis: stripHtml(task.analysisResult?.summary ?? ''),
    requirements: joinArray(task.analysisResult?.requirements),
    planSummary: stripHtml(typeof plan.summary === 'string' ? plan.summary : ''),
    planSteps: joinArray(plan.implementationSteps),
    planRisks: joinArray(plan.risks),
  };

  const sources = Object.entries(textSources)
    .filter(([, v]) => v.trim().length > 0)
    .map(([k]) => k);

  const rawText = Object.values(textSources).join('\n').trim();
  if (!rawText) return { required: false, mappings: [], validationFields: [], sources };

  // Detect source/target entity context — English, Czech full form, Czech abbreviated
  const hasSourceContext =
    /\b(?:source|src)\s+entit/i.test(rawText) ||
    /\bzdroj(?:ov[aá])?\s+entit/i.test(rawText) ||
    /\bzdroj\s*[:/]/i.test(rawText);
  const hasTargetContext =
    /\b(?:target|destination)\s+entit/i.test(rawText) ||
    /\bc[íi]lov[aá]\s+entit/i.test(rawText) ||
    /\bc[íi]l\s*[:/]/i.test(rawText);

  // Count unique CRM-style logical names (entity_field or field_name pattern)
  const crmNames = rawText.toLowerCase().match(/\b[a-z][a-z0-9]*_[a-z][a-z0-9_]+\b/g) || [];
  const uniqueCrmNames = new Set(crmNames);

  // Detect when plan text itself signals incomplete field mapping work.
  // Czech variants are added because plan steps/risks may be generated in Czech.
  const planSignalsIncomplete =
    (
      /field\s+mappings?\s+(?:are\s+)?not\s+defined|define\s+field\s+mappings?/i.test(rawText) ||
      /field\s+mappings?\s+nejsou\s+definov/i.test(rawText) ||
      /mapov[aá]n[íi]\s+mus[íi]\s+b[ýy]t\s+dopl/i.test(rawText) ||
      /doplnění\s+(?:konkrétn[íi]ch\s+)?field\s+mappings?/i.test(rawText) ||
      /připravit\s+todo\s+komentáře/i.test(rawText) ||
      /todo.*map.*field/i.test(rawText) ||
      /field.*map.*todo/i.test(rawText) ||
      /todo[^\n]{0,80}field\s+map/i.test(rawText) ||
      /field\s+map[^\n]{0,80}todo/i.test(rawText)
    ) && uniqueCrmNames.size >= 2;

  const detected = ((hasSourceContext || hasTargetContext) && uniqueCrmNames.size >= 3) || planSignalsIncomplete;
  if (!detected) return { required: false, mappings: [], validationFields: [], sources };

  // --- Extraction attempt 1: explicit entity.field -> entity.field arrows ---
  const arrowRe =
    /\b([a-z][a-z0-9]*_[a-z][a-z0-9_]*\.[a-z][a-z0-9_]+)\s*(?:->|→|=>)\s*([a-z][a-z0-9]*_[a-z][a-z0-9_]*\.[a-z][a-z0-9_]+)\b/gi;
  const arrowMatches = [...rawText.matchAll(arrowRe)];
  if (arrowMatches.length >= 2) {
    const seen = new Set();
    const mappings = [];
    for (const m of arrowMatches) {
      const key = `${m[1].toLowerCase()}=>${m[2].toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); mappings.push({ source: m[1].toLowerCase(), target: m[2].toLowerCase() }); }
    }
    return { required: true, mappings, validationFields: [], sources };
  }

  // --- Extraction attempt 2: "Source entity: X / Source fields: a,b,c / Target entity: Y / Target fields: d,e,f" ---
  const srcEntityM = rawText.match(/\b(?:source\s+entity|zdrojov[aá]\s+entit[ay]?|zdroj(?:ov[aá]\s+entit[ay]?)?)\s*[:/]\s*([a-z][a-z0-9_]+)/i);
  const tgtEntityM = rawText.match(/\b(?:target\s+entity|c[íi]lov[aá]\s+entit[ay]?|c[íi]l)\s*[:/]\s*([a-z][a-z0-9_]+)/i);
  const srcFieldsM = rawText.match(/\b(?:source\s+fields?|zdrojov[aá]\s+pol[ei]|pole\s+zdroje?)\s*[:/]\s*([^\n\r]{3,200})/i);
  const tgtFieldsM = rawText.match(/\b(?:target\s+fields?|c[íi]lov[aá]\s+pol[ei]|pole\s+c[íi]le?)\s*[:/]\s*([^\n\r]{3,200})/i);

  if (srcEntityM && tgtEntityM && srcFieldsM && tgtFieldsM) {
    const srcEntity = srcEntityM[1].toLowerCase();
    const tgtEntity = tgtEntityM[1].toLowerCase();
    const parseFields = (str) =>
      str
        .split(/[,;\s]+/)
        .map((f) => f.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''))
        .filter((f) => /^[a-z][a-z0-9_]+$/.test(f) && f.length > 2);
    const srcFields = parseFields(srcFieldsM[1]);
    const tgtFields = parseFields(tgtFieldsM[1]);

    if (srcFields.length >= 2 && tgtFields.length >= 2) {
      const pairCount = Math.min(srcFields.length, tgtFields.length);
      const mappings = [];
      for (let i = 0; i < pairCount; i++) {
        mappings.push({ source: `${srcEntity}.${srcFields[i]}`, target: `${tgtEntity}.${tgtFields[i]}` });
      }
      const validationFields = srcFields.slice(pairCount).map((f) => `${srcEntity}.${f}`);
      return { required: true, mappings, validationFields, sources };
    }
  }

  // Detected mapping work but extraction not safe — block without specific pairs
  return { required: true, mappings: [], validationFields: [], sources };
}

/**
 * Returns true when a script task requires field mappings that have not been defined.
 * Used by computeContinueWorkflowStep to prevent advancement to testing on scaffold code.
 */
function isScaffoldOnlyTask(task) {
  const workflow = asObject(task.crmDeveloperWorkflow);
  const plan = sanitizeTechnicalPlan(workflow.technicalPlan);
  const emptyFieldMappings = !plan?.fieldMappings || plan.fieldMappings.length === 0;
  if (!emptyFieldMappings) return false;
  const template = matchTaskTemplate(task.title || '', taskTextForInference(task));
  const setup = asObject(task.workflowSetup);
  const implementationPattern = setup.implementationPattern || template?.implementationPattern || null;
  // UI/business-rule and ribbon-action scripts have no fieldMappings by design — an explicit
  // pattern/override is authoritative and skips the legacy heuristics below, which would
  // otherwise misread a stale plan.unmappedSourceFields as "still needs field mappings".
  if (implementationPattern === 'ui-business-rule' || implementationPattern === 'ribbon-action') return false;
  if (typeof setup.requiresFieldMappings === 'boolean') return setup.requiresFieldMappings;
  if (typeof template?.requiresFieldMappings === 'boolean') return template.requiresFieldMappings;
  if (template && Array.isArray(template.sourceFields) && template.sourceFields.length > 0) return true;
  if (Array.isArray(plan?.unmappedSourceFields) && plan.unmappedSourceFields.length > 0) return true;
  const detection = detectAndExtractFieldMappings(task);
  return detection.required && detection.mappings.length === 0;
}

// Bump when the packet shape or guard logic changes so callers can detect a stale MCP runtime.
const DEVELOPER_WORK_PACKET_VERSION = '4';

function buildDeveloperWorkPacket(task, customerDevDefaults = null) {
  const setup = asObject(task.workflowSetup);
  const workflow = asObject(task.crmDeveloperWorkflow);
  const plan = sanitizeTechnicalPlan(workflow.technicalPlan);
  const readiness = computeImplementationReadiness(task);
  const template = matchTaskTemplate(task.title || '', taskTextForInference(task));
  const workKind = workflow.detectedWorkKind || setup.devTargetKind || plan?.workKind || 'unknown';
  const isScript = workKind === 'script' || workKind === 'ribbon' || setup.devTargetKind === 'script';
  const targetEntity = setup.primaryEntityLogicalName || plan?.target?.entityLogicalName || template?.targetEntity || '';
  const scriptNaming = isScript ? computeScriptNaming(template, customerDevDefaults, setup) : null;
  const verification = latestVerification(task);
  const approval = approvalSummary(workflow.planApproval);
  const next = nextRecommendedStep(task);

  const blockers = [...(Array.isArray(readiness.blockers) ? readiness.blockers : [])];
  const planApprovalRequired = !!plan && !approval.approved;
  const emptyFieldMappings = !plan?.fieldMappings || plan.fieldMappings.length === 0;
  const templateNeedsMapping = !!(template && Array.isArray(template.sourceFields) && template.sourceFields.length > 0);
  const planHasUnmappedWithNoMapped = !!(
    Array.isArray(plan?.unmappedSourceFields) && plan.unmappedSourceFields.length > 0 && emptyFieldMappings
  );
  // Third path: if neither template nor plan signals mappings, scan original assignment text.
  // Handles tasks where the plan was saved without fieldMappings/unmappedSourceFields
  // even though the original assignment clearly describes source→target field work.
  let textExtractedMappings = [];
  let textExtractedValidation = [];
  let textDetectedRequired = false;
  let textDetectionSources = [];
  if (emptyFieldMappings && !templateNeedsMapping && !planHasUnmappedWithNoMapped) {
    const textResult = detectAndExtractFieldMappings(task);
    textDetectedRequired = textResult.required;
    textExtractedMappings = textResult.mappings;
    textExtractedValidation = textResult.validationFields;
    textDetectionSources = textResult.sources || [];
  }
  // Script implementation pattern: 'field-mapping' (source→target copy/prefill, needs
  // fieldMappings), 'ui-business-rule' (form UI logic — required level, visibility,
  // notifications, locking, option filtering — no fieldMappings by design), or
  // 'ribbon-action'. workflowSetup override wins over the template.
  const implementationPattern =
    setup.implementationPattern ||
    template?.implementationPattern ||
    (templateNeedsMapping ? 'field-mapping' : null);
  const isNonMappingPattern = implementationPattern === 'ui-business-rule' || implementationPattern === 'ribbon-action';
  // An explicit requiresFieldMappings (workflowSetup override, then template) is authoritative:
  // it overrides the heuristic signals below in both directions. This matters because
  // planHasUnmappedWithNoMapped/textDetectedRequired are heuristics derived from legacy/stale
  // plan data or a text scan — without an explicit override, a UI/business-rule script with no
  // field-mapping needs could still get incorrectly flagged as requiring mappings by a stale
  // plan.unmappedSourceFields left over from an earlier save, blocking approval for a task that
  // was never a field-mapping task to begin with.
  const explicitRequiresFieldMappings =
    typeof setup.requiresFieldMappings === 'boolean' ? setup.requiresFieldMappings :
    typeof template?.requiresFieldMappings === 'boolean' ? template.requiresFieldMappings :
    null;
  const heuristicRequiresFieldMappings = templateNeedsMapping || planHasUnmappedWithNoMapped || textDetectedRequired;
  const requiresFieldMappings = isNonMappingPattern
    ? false
    : (explicitRequiresFieldMappings !== null ? explicitRequiresFieldMappings : heuristicRequiresFieldMappings);
  // UI/business-rule and ribbon-action script context — workflowSetup (persisted by
  // prepareDeveloperTaskInMemory when a template applies) wins over the template, so these
  // survive even once the task text no longer re-matches the template that originally set them.
  const referencedFields = Array.isArray(setup.referencedFields) ? setup.referencedFields : (Array.isArray(template?.referencedFields) ? template.referencedFields : []);
  const triggerFields = Array.isArray(setup.triggerFields) ? setup.triggerFields : (Array.isArray(template?.triggerFields) ? template.triggerFields : []);
  const affectedFields = Array.isArray(setup.affectedFields) ? setup.affectedFields : (Array.isArray(template?.affectedFields) ? template.affectedFields : []);
  const uiRules = Array.isArray(setup.uiRules) ? setup.uiRules : (Array.isArray(template?.uiRules) ? template.uiRules : []);
  const optionSetValues = (setup.optionSetValues && typeof setup.optionSetValues === 'object') ? setup.optionSetValues : (template?.optionSetValues && typeof template.optionSetValues === 'object' ? template.optionSetValues : {});
  const notificationIds = Array.isArray(setup.notificationIds) ? setup.notificationIds : (Array.isArray(template?.notificationIds) ? template.notificationIds : []);
  const forbiddenOperations = Array.isArray(setup.forbiddenOperations) ? setup.forbiddenOperations : (Array.isArray(template?.forbiddenOperations) ? template.forbiddenOperations : []);
  // Template path: auto-derive fieldMappings from template sourceFields/targetFields when plan is empty
  const templateDerivedMappings = (templateNeedsMapping && emptyFieldMappings && template && template.sourceEntity && targetEntity)
    ? (() => {
        const sourceFields = Array.isArray(template.sourceFields) ? template.sourceFields : [];
        const targetFields = Array.isArray(template.targetFields) ? template.targetFields : [];
        const pairCount = Math.min(sourceFields.length, targetFields.length);
        return Array.from({ length: pairCount }, (_, i) => ({
          source: `${template.sourceEntity}.${sourceFields[i]}`,
          target: `${targetEntity}.${targetFields[i]}`,
        }));
      })()
    : [];
  // fieldMappingsMissing: requires mappings AND none available from any path
  const fieldMappingsMissing = requiresFieldMappings && emptyFieldMappings && textExtractedMappings.length === 0 && templateDerivedMappings.length === 0;
  // Use let so the consistency guard below can override if needed.
  let canWriteCode = readiness.isImplementationReady && !planApprovalRequired && !fieldMappingsMissing;

  let decisionReason;
  let blockingUserAction = null;
  if (canWriteCode) {
    decisionReason = 'Task Workbench says implementation is ready. Use this packet as the working contract.';
  } else if (planApprovalRequired) {
    decisionReason = 'Technical plan approval is required in Task Workbench before code changes.';
    blockingUserAction = 'Review and approve the technical implementation plan in Task Workbench.';
  } else if (fieldMappingsMissing) {
    decisionReason = textDetectedRequired
      ? 'Field mapping work is indicated in the original assignment but field mappings have not been defined in the technical plan. Complete the technical plan before implementation.'
      : 'Field mappings are missing. Complete the technical plan before implementation.';
    blockingUserAction = 'Run prepare_developer_task to regenerate the technical plan with field mappings.';
  } else {
    // Use the first blocker as the primary reason so callers see the concrete issue, not just a generic step.
    decisionReason = blockers[0] || readiness.recommendedNextStep || 'Task Workbench says implementation is not ready yet.';
    if (!plan) {
      blockingUserAction = 'Run prepare_developer_task to create/refresh setup and the technical plan.';
    } else if (blockers[0]?.includes('has not been saved to task setup')) {
      blockingUserAction = 'Run prepare_developer_task or call set_task_developer_target to save the target path.';
    } else if (blockers.length > 0) {
      blockingUserAction = 'Resolve the listed blockers in Task Workbench.';
    }
  }

  // ── Guard 1: requiresFieldMappings consistency ───────────────────────────
  // A packet with requiresFieldMappings=true and empty final fieldMappings MUST NOT
  // have canWriteCode=true. Apply as a safety net regardless of how prior detection ran.
  // Priority: text-extracted > template-derived > plan
  const finalFieldMappings = textExtractedMappings.length > 0
    ? textExtractedMappings
    : (templateDerivedMappings.length > 0 ? templateDerivedMappings : (plan?.fieldMappings || []));
  if (requiresFieldMappings && finalFieldMappings.length === 0 && canWriteCode) {
    canWriteCode = false;
    decisionReason =
      'Required field mappings are missing. Packet consistency guard blocked code writing. ' +
      'The task requires source→target field assignments that have not been defined.';
    blockingUserAction =
      'Define source→target field mappings in the technical plan using prepare_developer_task or save_technical_plan.';
  }

  // ── Guard 2: scaffold signal detection (diagnostic) ──────────────────────
  // Scans plan steps and risks for TODO/scaffold/mapping-incomplete signals when
  // canWriteCode is still true and fieldMappings is empty. DIAGNOSTIC ONLY: sets
  // scaffoldSignalDetected and scaffoldSignalSources. Enforcement is by the final
  // packet invariant below, which operates on the actually-assembled packet values.
  let scaffoldSignalDetected = false;
  let scaffoldSignalSources = [];
  const matchScaffoldText = (t) =>
    /\btodo\b|\bscaffold\b|\bplaceholder\b/i.test(t) ||
    /field\s+mappings?\s+(?:are\s+)?not\s+defined/i.test(t) ||
    /field\s+mappings?\s+nejsou\s+definov/i.test(t) ||
    /mapov[aá]n[íi].*(?:doplnit|musí\s+b[ýy]t\s+dopl)/i.test(t) ||
    /doplnění.*field\s+mappings?/i.test(t) ||
    /připravit\s+todo/i.test(t);
  if (canWriteCode && finalFieldMappings.length === 0) {
    const scaffoldCheckTexts = [
      ...(plan?.implementationSteps || []).map((s) => (typeof s === 'string' ? s : JSON.stringify(s))),
      ...(plan?.risks || []).map((r) => (typeof r === 'string' ? r : JSON.stringify(r))),
      typeof plan?.summary === 'string' ? plan.summary : '',
    ];
    scaffoldSignalSources = scaffoldCheckTexts.filter(matchScaffoldText);
    if (scaffoldSignalSources.length > 0) {
      scaffoldSignalDetected = true;
    }
  }

  // ── Sanitize scaffold steps/risks when mappings are available ─────────────
  // When canWriteCode=true and real fieldMappings were extracted, remove any scaffold-only
  // steps/risks (e.g. "Připravit TODO komentáře") so the packet never instructs the AI
  // to create TODO comments while also indicating code may be written.
  const SCAFFOLD_ITEM_RE = /\btodo\b|\bscaffold\b|\bplaceholder\b|field\s+mappings?\s+(?:are\s+)?not\s+defined|field\s+mappings?\s+nejsou\s+definov|doplnění.*field\s+mapping|připravit\s+todo/i;
  const sanitizedSteps = canWriteCode && finalFieldMappings.length > 0
    ? (plan?.implementationSteps || []).filter((s) => !SCAFFOLD_ITEM_RE.test(typeof s === 'string' ? s : JSON.stringify(s)))
    : (plan?.implementationSteps || []);
  const sanitizedRisks = canWriteCode && finalFieldMappings.length > 0
    ? (plan?.risks || []).filter((r) => !SCAFFOLD_ITEM_RE.test(typeof r === 'string' ? r : JSON.stringify(r)))
    : (plan?.risks || []);

  // ── Final packet invariant ────────────────────────────────────────────────
  // Runs on the ACTUAL assembled packet values (sanitizedSteps, sanitizedRisks).
  // canWriteCode=true with empty fieldMappings and scaffold/TODO text in the final
  // steps or risks is an impossible state: enforce it here regardless of whether
  // prior guards fired. This catches stale runtimes and any detection path gaps.
  let finalConsistencyGuardApplied = false;
  if (canWriteCode && finalFieldMappings.length === 0) {
    const finalPacketTexts = [
      ...sanitizedSteps.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))),
      ...sanitizedRisks.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))),
    ];
    const packetHasScaffold = finalPacketTexts.some(matchScaffoldText);
    if (packetHasScaffold) {
      finalConsistencyGuardApplied = true;
      canWriteCode = false;
      decisionReason =
        'Packet invariant violation: implementation steps or risks contain TODO/scaffold/placeholder ' +
        'guidance while field mappings are empty. Required source→target field assignments must be ' +
        'defined before code can be written.';
      blockingUserAction =
        'Define source→target field mappings in the technical plan using prepare_developer_task or save_technical_plan.';
    }
  }

  const writeTarget = isScript
    ? {
        kind: 'script',
        repositoryRoot: setup.repositoryRoot || customerDevDefaults?.repositoryRoot || null,
        artifactPath: setup.artifactPath || setup.scriptPath || plan?.target?.scriptPath || scriptNaming?.scriptPath || null,
        absolutePath: setup.absoluteScriptPath || scriptNaming?.absoluteScriptPath || null,
        targetEntity: targetEntity || null,
        actionType: setup.actionType || template?.actionType || null,
        eventName: setup.eventName || plan?.target?.eventName || template?.scriptTarget?.eventName || null,
        eventFieldName: setup.eventFieldName || plan?.target?.eventFieldName || template?.scriptTarget?.eventFieldName || null,
        handlers: {
          onLoad: setup.onLoadFunctionName || scriptNaming?.onLoadFunctionName || null,
          onChange: setup.onChangeFunctionName || scriptNaming?.onChangeFunctionName || null,
        },
        helperSuggestion: setup.mainHelperSuggestion || scriptNaming?.mainHelperSuggestion || null,
      }
    : {
        kind: workKind === 'plugin' ? 'plugin' : workKind,
        repositoryRoot: setup.repositoryRoot || customerDevDefaults?.repositoryRoot || null,
        artifactPath: setup.pluginProject || plan?.target?.pluginProject || null,
        targetEntity: targetEntity || null,
        actionType: setup.actionType || template?.actionType || null,
        pluginProject: setup.pluginProject || plan?.target?.pluginProject || null,
        message: plan?.target?.message || template?.pluginTarget?.messages?.[0] || null,
        stage: plan?.target?.stage || template?.pluginTarget?.stage || null,
        mode: plan?.target?.mode || template?.pluginTarget?.mode || null,
        filteringAttributes: plan?.target?.filteringAttributes || template?.pluginTarget?.filteringAttributes || [],
      };

  const conventionSources = [
    setup.conventionsSource,
    isScript ? customerDevDefaults?.conventionsSource || customerDevDefaults?.jsConventionsSource : customerDevDefaults?.pluginConventionsSource,
  ].filter(Boolean);

  const fieldMappingsSource = textExtractedMappings.length > 0 ? 'text-extracted'
    : (templateDerivedMappings.length > 0 ? 'template'
    : (plan?.fieldMappings?.length > 0 ? 'plan' : 'none'));

  const packet = {
    taskId: task.id,
    packetGeneratorVersion: DEVELOPER_WORK_PACKET_VERSION,
    status: canWriteCode ? 'ready_to_code' : 'not_ready',
    canWriteCode,
    decisionReason,
    blockingUserAction,
    blockers,
    warnings: Array.isArray(readiness.warnings) ? readiness.warnings : [],
    recommendedNextAction: canWriteCode ? 'Implement only the work described in this packet.' : (blockingUserAction || next.reason || readiness.recommendedNextStep),
    writeTarget,
    implementation: {
      workKind,
      implementationPattern,
      summary: plan?.summary || summarize(task.analysisResult?.summaryEn ?? task.analysisResult?.summary ?? task.title),
      steps: sanitizedSteps,
      requiresFieldMappings,
      // Prefer text-extracted mappings when structured plan mappings are absent.
      fieldMappings: finalFieldMappings,
      unmappedSourceFields: plan?.unmappedSourceFields || [],
      // UI/business-rule and ribbon-action script context — workflowSetup first, then template.
      // Not used for field-mapping scripts, which use fieldMappings above instead.
      referencedFields,
      triggerFields,
      affectedFields,
      uiRules,
      optionSetValues,
      notificationIds,
      forbiddenOperations,
      // Read-only context fields: from template additionalSourceFields, referenced/affected
      // fields (ui-business-rule/ribbon-action scripts), or text extraction.
      validationFields: [
        ...(Array.isArray(template?.additionalSourceFields)
          ? template.additionalSourceFields.map((f) => `${template.sourceEntity || 'source'}.${f}`)
          : []),
        ...(isNonMappingPattern && targetEntity
          ? [...new Set([...referencedFields, ...affectedFields])].map((f) => `${targetEntity}.${f}`)
          : []),
        ...textExtractedValidation,
      ],
      // When requiresFieldMappings is true and fieldMappings is empty, lists what must be defined.
      missingRequiredMappings: fieldMappingsMissing
        ? (templateNeedsMapping
            ? templateFieldMapping(template, targetEntity).pairs.map((p) => `${p.source} -> ${p.target}`)
            : textDetectedRequired
              ? ['Field mapping work detected in original assignment but target field assignments could not be safely extracted. Define field mappings in the technical plan using prepare_developer_task.']
              : (plan?.unmappedSourceFields || []).map((f) => `${f} (no target field defined in plan)`)
          )
        : [],
      // true when canWriteCode is blocked because required mappings are absent.
      scaffoldOnly: fieldMappingsMissing || (requiresFieldMappings && finalFieldMappings.length === 0) || scaffoldSignalDetected || finalConsistencyGuardApplied,
      // Diagnostic fields — always present so callers can detect stale MCP runtimes and trace guard logic.
      detectionSources: textDetectionSources,
      scaffoldSignalDetected,
      scaffoldSignalSources,
      finalConsistencyGuardApplied,
      fieldMappingsSource,
      fieldMappingsCount: finalFieldMappings.length,
      forbiddenAssumptions: (plan?.unmappedSourceFields || []).map(
        (f) => `Do not map ${f} unless a target field is explicitly present in fieldMappings.`
      ),
      risks: sanitizedRisks,
      businessRules: Array.isArray(template?.businessRules) ? template.businessRules : [],
      acceptanceCriteria: Array.isArray(template?.acceptanceCriteria) ? template.acceptanceCriteria : [],
    },
    conventions: {
      sources: conventionSources,
      relatedFiles: Array.isArray(setup.relatedExistingFiles) ? setup.relatedExistingFiles : [],
      rules: isScript
        ? ['Inspect existing form scripts before editing.', 'Use the handler/helper names from writeTarget.', 'Do not register or upload web resources from MCP.']
        : ['Inspect the existing plugin project conventions before editing.', 'Respect message/stage/filtering attributes from writeTarget.', 'Do not register plugins from MCP.'],
    },
    dataverse: {
      verificationStatus: verification.verdict,
      report: verification,
      instruction: isScript
        ? 'Dataverse Metadata Check for script/ribbon files runs automatically via run_implementation_verification (Primarch, when configured) after implementation. Use the stored report here if already present.'
        : 'Use the stored Dataverse verification report. If missing or failing, resolve before implementation.',
    },
    aiKit: {
      available: false,
      mustInspectBeforeWriting: true,
      rulesFiles: [],
      mandatoryRulesSummary: [
        'No TODO comments, placeholder methods, or stub implementations in production code.',
        'Do not create placeholder or stub handlers.',
        'Do not add early returns unless existing scripts in the repository use them.',
        'Implement only exact fields and entities from the work packet.',
        'Do not invent fields, mappings, or web resource names.',
      ],
      reviewRequiredAfterImplementation: true,
      reviewNote: isScript
        ? 'Run AI Kit review for the created/updated script before upload or registration.'
        : 'Run AI Kit review for the created/updated plugin before registration.',
    },
    reviewTestCommit: {
      beforeCoding: [
        'Use this work packet as the source of truth.',
        'Do not call low-level setup tools unless this packet explicitly says setup is incomplete.',
      ],
      localValidation: plan?.testChecklist || [],
      afterImplementation: [
        'After writing implementation files: re-read the file and verify every businessRule and acceptanceCriteria in the packet is satisfied.',
        'Call record_ai_implementation_completed with taskId, filesChanged, and a short summary. This records the implementation and advances the workflow.',
        'Call continue_developer_workflow after record_ai_implementation_completed. If it returns nextAction=run_implementation_verification, call run_implementation_verification.',
        'If run_implementation_verification returns fixableFindings, fix the code and repeat: record_ai_implementation_completed, continue_developer_workflow, run_implementation_verification.',
        'Stop only when continue_developer_workflow returns wait_for_user — report the required manual action and wait.',
        'Do not call record_local_test for script tasks — use record_ai_implementation_completed instead.',
        'Do not perform Dataverse upload, plugin registration, GitHub/ADO writes, or deployment without explicit approval.',
      ],
      commit: [
        'Use Task Workbench git tools only after implementation and validation are complete.',
        'Commit only files related to this task.',
        'Push only through the guarded task branch flow; no force push and no direct main/master push.',
      ],
    },
    internalStateSummary: {
      currentStep: workflow.currentStep || null,
      planApproved: approval.approved,
      nextRecommendedStep: next.step,
    },
    task: safeTaskSummary(task),
  };
  // Post-packet filter: remove risks mentioning CRM entity names absent from the trusted packet.
  // Applied after full assembly so writeTarget (targetEntity, eventFieldName) is available.
  // Only runs when canWriteCode with concrete field mappings — the same condition as sanitizedRisks.
  if (canWriteCode && finalFieldMappings.length > 0) {
    const allowed = buildAllowedLogicalNames(packet);
    packet.implementation.risks = (packet.implementation.risks ?? []).filter(
      (r) => !riskMentionsUnknownEntity(typeof r === 'string' ? r : JSON.stringify(r), allowed)
    );
  }
  return packet;
}

function deterministicPlanDraft(task, template) {
  const setup = asObject(task.workflowSetup);
  const workflow = asObject(task.crmDeveloperWorkflow);
  const workKind = workflow.detectedWorkKind || setup.devTargetKind || template?.workKind || 'unknown';
  const actionType = setup.actionType || template?.actionType || '';
  const entity = setup.primaryEntityLogicalName || template?.targetEntity || template?.scriptTarget?.entityLogicalName || template?.pluginTarget?.entityLogicalName || '';
  if (!entity || !['script', 'plugin', 'ribbon'].includes(workKind)) return null;

  const isScript = workKind === 'script' || workKind === 'ribbon';
  const mapping = templateFieldMapping(template, entity);
  const summary = isScript
    ? `Create/update a Dataverse form script for ${entity}${setup.eventName ? ` (${setup.eventName})` : ''}.`
    : `Create/update a Dataverse plugin for ${entity}.`;
  const implementationSteps = [
    isScript ? `Use the selected script target ${setup.artifactPath || setup.scriptPath || 'the configured script path'}.` : `Use the selected plugin project ${setup.pluginProject || 'the configured plugin project'}.`,
    `Implement ${actionType || 'the requested change'} for ${entity}.`,
    mapping.mappingLine,
    mapping.additionalLine,
    'Keep external Dataverse registration/upload as a manual approved action outside this setup step.',
  ].filter(Boolean);
  const testPlan = isScript
    ? ['Validate the form event wiring manually in the model-driven app.', 'Test the happy path and empty/null source values.']
    : ['Run/build the plugin project locally.', 'Verify message/stage/filtering attributes before manual registration.'];
  const risks = ['Dataverse metadata and runtime registration still require separate verification before implementation.'];
  const target = isScript
    ? {
        entityLogicalName: entity,
        scriptPath: setup.artifactPath || setup.scriptPath || '',
        eventName: setup.eventName || template?.scriptTarget?.eventName || '',
        eventFieldName: setup.eventFieldName || template?.scriptTarget?.eventFieldName || '',
        functionName: setup.onChangeFunctionName || setup.onLoadFunctionName || '',
      }
    : {
        entityLogicalName: entity,
        pluginProject: setup.pluginProject || '',
        message: template?.pluginTarget?.messages?.[0] || '',
        stage: template?.pluginTarget?.stage || '',
        mode: template?.pluginTarget?.mode || '',
        filteringAttributes: template?.pluginTarget?.filteringAttributes || [],
      };
  return {
    workKind,
    summary,
    implementationSteps,
    dataverseFindings: [entity, mapping.mappingLine, mapping.additionalLine].filter(Boolean),
    risks,
    testChecklist: testPlan,
    target,
    fieldMappings: mapping.pairs,
    unmappedSourceFields: mapping.unmappedSourceFields,
  };
}

function planHasTemplateMapping(plan, template) {
  if (!template?.sourceFields?.length && !template?.targetFields?.length) return true;
  const entity = plan?.target?.entityLogicalName || template?.targetEntity || template?.scriptTarget?.entityLogicalName || '';
  const expected = templateFieldMapping(template, entity).pairs;
  if (!expected.length) return true;
  const actual = Array.isArray(plan?.fieldMappings) ? plan.fieldMappings : [];
  return expected.every((pair) => actual.some((item) => item?.source === pair.source && item?.target === pair.target));
}

// nvr_ tokens that are field/UI names, not entity logical names. Mirrors
// src/lib/scriptAssistant.ts NVR_FIELD_EXCLUSIONS (kept in sync manually — this file is plain
// Node ESM and cannot import the TS module directly).
const GENERIC_NVR_FIELD_EXCLUSIONS = new Set([
  'nvr_company', 'nvr_name', 'nvr_type', 'nvr_status', 'nvr_state', 'nvr_date', 'nvr_amount',
  'nvr_note', 'nvr_description', 'nvr_reference', 'nvr_code', 'nvr_value', 'nvr_flag',
  'nvr_enabled', 'nvr_active', 'nvr_class', 'nvr_group', 'nvr_owner', 'nvr_user', 'nvr_email',
  'nvr_phone', 'nvr_address', 'nvr_city', 'nvr_country', 'nvr_zip', 'nvr_region', 'nvr_category',
  'nvr_priority', 'nvr_order', 'nvr_price', 'nvr_quantity', 'nvr_unit', 'nvr_currency',
]);

/**
 * Extracts the first explicit nvr_<entity> logical name from text, skipping known field-name
 * tokens and trigger/event suffixes (e.g. nvr_x_OnLoad). An explicit custom table name named in
 * the text always wins over a generic keyword guess — this function never falls back to a
 * translated/keyword guess (e.g. Czech "případ" -> "incident"), so it cannot misidentify a task
 * the way title-only guessing used to.
 */
function extractExplicitNvrEntity(text) {
  const lower = String(text || '').toLowerCase();
  for (const m of lower.matchAll(/\bnvr_([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\b/g)) {
    const bare = m[1].replace(/_(onchange|onload|onsave|handler|events)$/i, '');
    const full = `nvr_${bare}`;
    if (GENERIC_NVR_FIELD_EXCLUSIONS.has(full)) continue;
    if (bare.split('_').length > 3) continue;
    return full;
  }
  return null;
}

/**
 * Best-effort setup inference for script tasks that do not match any built-in template. Used as
 * a fallback so an explicit assignment (explicit table name, event/field, target file, handler
 * names) does not force a hard "set it manually" blocker. Returns null when the text does not
 * look like a script task, or no explicit nvr_ target entity is present in the text — this
 * function never guesses a generic entity like 'account'/'incident' from title wording alone.
 */
function genericScriptSetupInference(task) {
  const text = taskTextForInference(task);
  if (!/\b(javascript|jscript|form\s*script|web\s*resource|on[-\s]?load|on[-\s]?change|on[-\s]?save)\b/i.test(text)) {
    return null;
  }

  const targetEntity = extractExplicitNvrEntity(text);
  if (!targetEntity) return null;

  const assumptions = [`Target entity inferred from explicit logical name "${targetEntity}" named in the task description.`];

  const filePathMatch = text.match(/([A-Za-z0-9_]+[\\/][A-Za-z0-9_]+\.js)\b/);
  const bareFileMatch = text.match(/\b([A-Za-z0-9_]+\.js)\b/);
  let desiredScriptFile;
  let scriptsFolderRelative = 'Scripts';
  if (filePathMatch) {
    const parts = filePathMatch[1].split(/[\\/]/);
    desiredScriptFile = parts.pop();
    if (parts.length > 0) scriptsFolderRelative = parts.join('/');
    assumptions.push(`Target script file inferred from explicit path "${filePathMatch[1]}" in the task description.`);
  } else if (bareFileMatch) {
    desiredScriptFile = bareFileMatch[1];
    assumptions.push(`Target script file inferred from explicit file name "${desiredScriptFile}" in the task description.`);
  } else {
    desiredScriptFile = `${targetEntity}_events.js`;
    assumptions.push(`Target script file name defaulted from the target entity: ${desiredScriptFile}.`);
  }

  const onLoadHandlerMatch = text.match(/\b([A-Za-z][A-Za-z0-9_]*_OnLoad)\b/);
  const onChangeHandlerMatch = text.match(/\b([A-Za-z][A-Za-z0-9_]*_OnChange)\b/);
  if (onLoadHandlerMatch || onChangeHandlerMatch) {
    assumptions.push('Handler function names taken literally from the task description.');
  }

  const hasOnLoad = /\bon[-\s]?load\b/i.test(text);
  const eventFieldMatch =
    text.match(/on[-\s]?change\s+of\s+`?([A-Za-z][A-Za-z0-9_]*)`?/i) ||
    text.match(/`?([A-Za-z][A-Za-z0-9_]*)`?\s+on[-\s]?change/i);
  const eventFieldName = eventFieldMatch ? eventFieldMatch[1] : null;
  const eventName = eventFieldName ? 'onChange' : (hasOnLoad ? 'onLoad' : null);

  const onLoadFunctionName = onLoadHandlerMatch ? onLoadHandlerMatch[1] : (hasOnLoad ? `${targetEntity}_OnLoad` : null);
  const onChangeFunctionName = onChangeHandlerMatch ? onChangeHandlerMatch[1] : (eventFieldName ? `${eventFieldName}_OnChange` : null);

  const actionType = /\b(update|modify|extend)\s+(the\s+)?existing\s+script\b/i.test(text)
    ? 'update-existing-script'
    : 'create-new-script';

  return {
    workKind: 'script',
    actionType,
    targetEntity,
    eventName,
    eventFieldName,
    scriptsFolderRelative,
    desiredScriptFile,
    onLoadFunctionName,
    onChangeFunctionName,
    confidence: (onLoadHandlerMatch || onChangeHandlerMatch) ? 'high' : 'medium',
    assumptions,
  };
}

/** Snapshot of the setup fields relevant to the caller-facing proposedSetup/appliedSetup summary. */
function snapshotProposedSetup(setup) {
  return {
    workKind: setup.devTargetKind ?? null,
    actionType: setup.actionType ?? null,
    targetEntity: setup.primaryEntityLogicalName ?? null,
    eventName: setup.eventName ?? null,
    eventField: setup.eventFieldName ?? null,
    targetFile: setup.artifactPath ?? setup.desiredScriptFile ?? null,
    handlers: {
      onLoad: setup.onLoadFunctionName ?? null,
      onChange: setup.onChangeFunctionName ?? null,
    },
  };
}

function prepareDeveloperTaskInMemory(task, { customerDevDefaults = null, confirmSetup = true, createTechnicalPlan = true } = {}) {
  const appliedActions = [];
  const skippedActions = [{
    action: 'run_dataverse_check_for_task',
    reason: 'Dataverse Metadata Check for JS/TS runs automatically after implementation via run_implementation_verification (Primarch, when configured) — not during setup, since no artifact exists yet.',
  }];
  const hardBlockers = [];
  const warnings = [];
  const missingInputs = [];
  const approvalGates = [];
  const assumptions = [];
  let confidence = 'none';
  const template = matchTaskTemplate(task.title || '', taskTextForInference(task));
  const now = new Date().toISOString();

  if (template) {
    task.taskMode = template.mode || 'developer';
    if (!task.workflowSetup || typeof task.workflowSetup !== 'object') task.workflowSetup = {};
    if (!task.crmDeveloperWorkflow || typeof task.crmDeveloperWorkflow !== 'object') task.crmDeveloperWorkflow = { createdAt: now };
    task.workflowSetup.devTargetKind = template.workKind === 'plugin' ? 'plugin' : template.workKind === 'script' || template.workKind === 'ribbon' ? 'script' : task.workflowSetup.devTargetKind;
    task.workflowSetup.workIntent = workActionFromActionType(template.actionType);
    task.workflowSetup.actionType = template.actionType;
    task.workflowSetup.primaryEntityLogicalName = template.targetEntity;
    if (template.scriptTarget) {
      task.workflowSetup.eventName = template.scriptTarget.eventName;
      task.workflowSetup.eventFieldName = template.scriptTarget.eventFieldName;
    }
    if (template.scriptNaming) {
      task.workflowSetup.namingSource = template.scriptNaming.namingSource;
      task.workflowSetup.desiredScriptFile = template.scriptNaming.desiredScriptFile;
      task.workflowSetup.onLoadFunctionName = template.scriptNaming.onLoadFunctionName;
      task.workflowSetup.onChangeFunctionName = template.scriptNaming.onChangeFunctionName;
      task.workflowSetup.mainHelperSuggestion = template.scriptNaming.mainHelperSuggestion;
    }
    if (template.pluginTarget?.entityLogicalName) task.workflowSetup.primaryEntityLogicalName = template.pluginTarget.entityLogicalName;
    // Persist the template's implementation-pattern semantics into workflowSetup itself, so a
    // later readiness/packet build does not depend on re-matching this template — it survives a
    // title/description edit, and buildDeveloperWorkPacket reads these setup fields first anyway.
    if (template.implementationPattern) task.workflowSetup.implementationPattern = template.implementationPattern;
    if (typeof template.requiresFieldMappings === 'boolean') task.workflowSetup.requiresFieldMappings = template.requiresFieldMappings;
    if (Array.isArray(template.referencedFields)) task.workflowSetup.referencedFields = template.referencedFields;
    if (Array.isArray(template.triggerFields)) task.workflowSetup.triggerFields = template.triggerFields;
    if (Array.isArray(template.affectedFields)) task.workflowSetup.affectedFields = template.affectedFields;
    if (Array.isArray(template.uiRules)) task.workflowSetup.uiRules = template.uiRules;
    if (template.optionSetValues && typeof template.optionSetValues === 'object') task.workflowSetup.optionSetValues = template.optionSetValues;
    if (Array.isArray(template.notificationIds)) task.workflowSetup.notificationIds = template.notificationIds;
    if (Array.isArray(template.forbiddenOperations)) task.workflowSetup.forbiddenOperations = template.forbiddenOperations;
    task.crmDeveloperWorkflow.detectedWorkKind = template.workKind;
    task.crmDeveloperWorkflow.updatedAt = now;
    appliedActions.push('applied_template', 'set_task_mode', 'set_task_work_classification');
    confidence = 'high';
    assumptions.push(`Setup proposed from built-in template "${template.id}" matched against the task title/description.`);
  } else {
    // No built-in template matched. Fall back to a best-effort inference from explicit facts
    // in the task text (explicit nvr_ table name, event/field, target file, handler names),
    // so an explicit assignment does not force a hard "set it manually" blocker. Never applied
    // over an already-set value.
    const inferred = genericScriptSetupInference(task);
    if (inferred) {
      task.taskMode = 'developer';
      if (!task.workflowSetup || typeof task.workflowSetup !== 'object') task.workflowSetup = {};
      if (!task.crmDeveloperWorkflow || typeof task.crmDeveloperWorkflow !== 'object') task.crmDeveloperWorkflow = { createdAt: now };
      const s = task.workflowSetup;
      if (!s.devTargetKind) s.devTargetKind = 'script';
      if (!s.workIntent) s.workIntent = workActionFromActionType(inferred.actionType);
      if (!s.actionType) s.actionType = inferred.actionType;
      if (!s.primaryEntityLogicalName) s.primaryEntityLogicalName = inferred.targetEntity;
      if (!s.eventName && inferred.eventName) s.eventName = inferred.eventName;
      if (!s.eventFieldName && inferred.eventFieldName) s.eventFieldName = inferred.eventFieldName;
      if (!s.scriptPath) s.scriptPath = inferred.scriptsFolderRelative;
      if (!s.desiredScriptFile) s.desiredScriptFile = inferred.desiredScriptFile;
      if (!s.namingSource) s.namingSource = 'Scripts_Naming';
      if (!s.onLoadFunctionName && inferred.onLoadFunctionName) s.onLoadFunctionName = inferred.onLoadFunctionName;
      if (!s.onChangeFunctionName && inferred.onChangeFunctionName) s.onChangeFunctionName = inferred.onChangeFunctionName;
      if (!task.crmDeveloperWorkflow.detectedWorkKind) task.crmDeveloperWorkflow.detectedWorkKind = 'script';
      task.crmDeveloperWorkflow.updatedAt = now;
      appliedActions.push('applied_generic_inference', 'set_task_mode', 'set_task_work_classification');
      confidence = inferred.confidence;
      assumptions.push(...inferred.assumptions);
    }
  }

  if (customerDevDefaults) {
    if (!task.workflowSetup || typeof task.workflowSetup !== 'object') task.workflowSetup = {};
    if (customerDevDefaults.repositoryRoot && !task.workflowSetup.repositoryRoot) task.workflowSetup.repositoryRoot = safeString(customerDevDefaults.repositoryRoot);
    if (customerDevDefaults.scriptDirectory && task.workflowSetup.devTargetKind === 'script' && !task.workflowSetup.scriptPath) {
      const repo = String(customerDevDefaults.repositoryRoot || '').replace(/[/\\]+$/, '');
      const dir = String(customerDevDefaults.scriptDirectory);
      if (repo && dir.toLowerCase().startsWith(repo.toLowerCase())) {
        task.workflowSetup.scriptPath = dir.slice(repo.length).replace(/^[/\\]+/, '') || dir;
      } else {
        task.workflowSetup.scriptPath = dir.replace(/\\/g, '/').split('/').filter(Boolean).pop() || dir;
      }
    }
    if (customerDevDefaults.pluginProjectPath && task.workflowSetup.devTargetKind === 'plugin' && !task.workflowSetup.pluginProject) task.workflowSetup.pluginProject = safeString(customerDevDefaults.pluginProjectPath);
    appliedActions.push('applied_customer_defaults');
  }

  const naming = computeScriptNaming(template, customerDevDefaults, task.workflowSetup);
  if (task.workflowSetup?.actionType === 'create-new-script' && task.workflowSetup.repositoryRoot && naming) {
    task.workflowSetup.desiredScriptFile = naming.desiredScriptFile;
    task.workflowSetup.artifactPath = naming.scriptPath;
    task.workflowSetup.absoluteScriptPath = naming.absoluteScriptPath;
    task.workflowSetup.namingSource = naming.namingSource;
    task.workflowSetup.onLoadFunctionName = naming.onLoadFunctionName;
    if (naming.onChangeFunctionName) task.workflowSetup.onChangeFunctionName = naming.onChangeFunctionName;
    if (naming.mainHelperSuggestion) task.workflowSetup.mainHelperSuggestion = naming.mainHelperSuggestion;
    appliedActions.push('saved_developer_target');
  }

  const hasStaleTemplateQuestions = /\b(open questions?|which specific fields|fields from the asset|should be prefilled)\b/i.test(
    `${task.analysisResult?.summary ?? ''} ${task.analysisResult?.summaryEn ?? ''}`,
  );
  if ((template && hasStaleTemplateQuestions) || (!task.analysisResult?.summary && (template || task.title))) {
    const summary = template?.notes || `Developer task setup prepared for: ${task.title || task.id}.`;
    task.analysisResult = { ...(asObject(task.analysisResult)), summary, summaryEn: summary, confidence: template ? 90 : 60, suggestedActions: [] };
    appliedActions.push('saved_task_analysis');
  }

  const setup = asObject(task.workflowSetup);
  const workKind = task.crmDeveloperWorkflow?.detectedWorkKind || setup.devTargetKind;
  if (setup.devTargetKind === 'script' || workKind === 'script' || workKind === 'ribbon') {
    warnings.push('Dataverse metadata verification for JS/TS runs automatically after implementation via run_implementation_verification (Primarch, when configured) — not before.');
  }
  if (!setup.repositoryRoot) missingInputs.push('repositoryRoot');
  if (!workKind || workKind === 'unknown') missingInputs.push('workKind');
  if (!setup.actionType) missingInputs.push('actionType');
  if (!setup.primaryEntityLogicalName) missingInputs.push('targetEntity');
  if (setup.devTargetKind === 'script' && setup.actionType === 'create-new-script') {
    // Mirrors computeImplementationReadiness's OR-based script-target check below: a specific
    // artifactPath alone is sufficient, it does not also require the separate bare scriptPath
    // (folder) field. A customer without an explicit scriptFolder (only crmBaseDirectory +
    // folderName) never populates workflowSetup.scriptPath, even once artifactPath/desiredScriptFile
    // are correctly resolved from the template/naming step — the old AND-of-three-fields check
    // treated that as a hard blocker despite the target already being fully known.
    const isSpecificFile = (p) => !!p && /\.[jt]sx?$/.test(p);
    const hasDir = !!(setup.scriptPath || setup.artifactPath);
    const hasFileName = isSpecificFile(setup.artifactPath) || isSpecificFile(setup.scriptPath) || !!setup.desiredScriptFile;
    if (!hasDir || !hasFileName) missingInputs.push('script target path');
  }
  if (setup.devTargetKind === 'plugin' && !setup.pluginProject) missingInputs.push('plugin project');
  if (missingInputs.length) hardBlockers.push(`Missing required setup input(s): ${missingInputs.join(', ')}.`);

  const hasPlan = !!task.crmDeveloperWorkflow?.technicalPlan;
  const planNeedsTemplateMapping = hasPlan && template && !planHasTemplateMapping(task.crmDeveloperWorkflow.technicalPlan, template);
  if (createTechnicalPlan && (!hasPlan || planNeedsTemplateMapping) && hardBlockers.length === 0) {
    const plan = deterministicPlanDraft(task, template);
    if (plan) {
      if (!task.crmDeveloperWorkflow || typeof task.crmDeveloperWorkflow !== 'object') task.crmDeveloperWorkflow = { createdAt: now };
      task.crmDeveloperWorkflow.technicalPlan = { generatedAt: now, ...plan, externalActionPreview: [] };
      task.crmDeveloperWorkflow.planApproval = null;
      task.crmDeveloperWorkflow.currentStep = 'technical-plan';
      task.crmDeveloperWorkflow.updatedAt = now;
      appliedActions.push('saved_technical_plan', 'marked_technical_plan_ready');
      approvalGates.push({ type: 'technical-plan-approval', message: 'Review and approve the technical implementation plan.' });
    } else {
      warnings.push('Technical plan was not created because the task context is not specific enough.');
    }
  } else if (task.crmDeveloperWorkflow?.technicalPlan && !approvalSummary(task.crmDeveloperWorkflow.planApproval).approved) {
    approvalGates.push({ type: 'technical-plan-approval', message: 'Review and approve the technical implementation plan.' });
  }

  if (confirmSetup && hardBlockers.length === 0 && !setup.confirmedAt) {
    task.workflowSetup.confirmedAt = now;
    if (task.status === 'new') task.status = 'analyzed';
    appliedActions.push('confirmed_setup');
  }

  const readiness = computeImplementationReadiness(task);
  const status = hardBlockers.length
    ? 'blocked'
    : approvalGates.length
      ? 'stopped_at_approval_gate'
      : readiness.isImplementationReady ? 'ready_for_implementation' : 'blocked';
  const appliedSetup = snapshotProposedSetup(asObject(task.workflowSetup));
  const wasInferredThisCall = appliedActions.includes('applied_template') || appliedActions.includes('applied_generic_inference');
  return {
    taskId: task.id,
    status,
    appliedActions: [...new Set(appliedActions)],
    skippedActions,
    hardBlockers,
    approvalGates,
    warnings,
    missingInputs,
    implementationReadiness: readiness,
    // proposedSetup and appliedSetup are the same snapshot here — inference is applied
    // directly to task.workflowSetup in-memory before this point, there is no separate
    // draft-vs-applied state. Both are returned so callers/tests have a stable contract
    // even if a future change introduces a draft-only proposal step.
    proposedSetup: appliedSetup,
    appliedSetup,
    confidence,
    assumptions,
    requiresUserConfirmation: wasInferredThisCall,
    businessRules: Array.isArray(template?.businessRules) ? template.businessRules : [],
  };
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
    const corpus = `${taskTextForInference(task)} ${task.classificationLabel ?? ''}`.toLowerCase();
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
    if (isScript) {
      warnings.push('Dataverse metadata verification for JS/TS runs automatically after implementation via run_implementation_verification (Primarch, when configured) — not before.');
    } else {
      blockers.push('Dataverse metadata verification has not been completed or explicitly skipped.');
    }
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
    // Only persisted setup fields count — derived naming-contract preview is not sufficient.
    const persistedTargetPath = setup.artifactPath || setup.scriptPath || '';
    if (!persistedTargetPath) {
      blockers.push('Target script/artifact path has not been saved to task setup. Run prepare_developer_task or set_task_developer_target first.');
    } else {
      const actionType = setup.actionType ?? '';
      const isSpecificFile = (p) => p && /\.[jt]sx?$/.test(p);

      if (actionType === 'create-new-script') {
        const hasDir      = !!(setup.scriptPath || setup.artifactPath);
        const hasFileName = isSpecificFile(setup.artifactPath) || isSpecificFile(setup.scriptPath) || !!(setup.desiredScriptFile);
        if (!hasDir || !hasFileName) {
          blockers.push('Script creation requires a known target directory and file name. Set script path and desired file name.');
        }
      } else if (actionType === 'update-existing-script') {
        const hasSpecific = isSpecificFile(setup.artifactPath) || isSpecificFile(setup.scriptPath);
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
    else if (first.includes('Target script/artifact path has not been saved')) recommendedNextStep = 'Run prepare_developer_task or call set_task_developer_target to persist the target path.';
    else if (first.includes('Target script'))           recommendedNextStep = 'Set the target script path via Developer Target Setup.';
    else if (first.includes('Form/event'))              recommendedNextStep = 'Add form/event details to the technical plan, or mark form registration as manual-later.';
    else                                                recommendedNextStep = 'Resolve all blockers before proceeding with implementation.';
  }

  return { isImplementationReady: isReady, blockers, warnings, recommendedNextStep };
}

/**
 * continue_developer_workflow nextAction values that mean "the task is now (or already) in the
 * Deployment & Testing phase" — used by the tool dispatcher (not this pure function) to decide
 * whether to persist the Development -> Deployment & Testing waitingState transition. Kept in sync
 * with DEPLOYMENT_TESTING_NEXT_ACTIONS in src-tauri/src/lib.rs.
 */
const DEPLOYMENT_TESTING_NEXT_ACTIONS = new Set(['wait_for_manual_deployment', 'wait_for_deployment_test', 'fix_code_or_redeploy']);

function computeContinueWorkflowStep(task) {
  // 0. Scaffold/TODO guard — block all workflow advancement if required field mappings are absent.
  // This prevents AI from calling record_local_test or proceeding to verification on stub code.
  if (isScaffoldOnlyTask(task)) {
    return {
      nextAction: 'define_field_mappings',
      canProceed: false,
      requiresUserApproval: false,
      blockingUserAction: 'Define required field mappings in the technical plan. Run prepare_developer_task to regenerate the plan with mappings, or update the plan directly via save_technical_plan.',
      recommendedTool: 'prepare_developer_task',
      instructionForAI: 'This task requires field mappings that have not been defined. The current implementation is scaffold or TODO code — do not record test results, do not proceed to Dataverse verification or AI Kit review. Stop immediately. Report missingRequiredMappings to the user and wait for explicit guidance before any further action.',
      allowedWrites: ['prepare_developer_task'],
      forbiddenWrites: ['record_local_test', 'commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
    };
  }

  // isScript here means "routes through the mcpVerification-based branch below" — script, ribbon,
  // AND plugin tasks all use run_implementation_verification now. Genuinely non-verifiable work
  // kinds (repo-only, bugfix, review, general, unknown) fall through to the separate
  // run_dataverse_check_for_task branch further down.
  const isScript = isVerifiableDevTask(task);

  // 1. Dataverse verification. (Local Test is NOT part of Implementation Verification — the
  // legacy localTestRecord/implementationVerification.localTest fields are never read as a gate
  // here; see computeDeploymentTestingGate below for the canonical post-deployment test gate.)
  const dvCheck = asObject(asObject(task.implementationVerification).dataverseCheck);
  const crmReports = Array.isArray(task.crmVerificationReports) ? task.crmVerificationReports : [];
  const dvDone = !!dvCheck.skippedAt || !!dvCheck.manuallyVerifiedAt
    || dvCheck.status === 'skipped' || dvCheck.status === 'done' || dvCheck.status === 'manually-verified'
    || READINESS_VERIFIED_VERDICTS.has(crmReports[0]?.verdict ?? '');
  if (!dvDone) {
    if (isScript) {
      const mcpVerification = asObject(asObject(task.implementationVerification).mcpVerification);
      if (!mcpVerification.ranAt) {
        return {
          nextAction: 'run_implementation_verification',
          canProceed: true,
          requiresUserApproval: false,
          blockingUserAction: null,
          recommendedTool: 'run_implementation_verification',
          instructionForAI: 'Run run_implementation_verification. It automatically runs Dataverse Metadata Check (when Primarch is configured) and reports whether AI Kit review is still needed — only the final manual upload/register/browser Local Test step requires waiting for the user.',
          allowedWrites: ['run_implementation_verification'],
          forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
        };
      }
      if (mcpVerification.status === 'failed' && (mcpVerification.fixableFindings || []).length > 0) {
        return {
          nextAction: 'fix_code',
          canProceed: true,
          requiresUserApproval: false,
          blockingUserAction: null,
          recommendedTool: 'record_ai_implementation_completed',
          instructionForAI: 'Fix the fixable findings from run_implementation_verification, then call record_ai_implementation_completed and run_implementation_verification again.',
          allowedWrites: ['record_ai_implementation_completed', 'run_implementation_verification'],
          forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
        };
      }
      if (mcpVerification.status === 'pending_ai_kit_review') {
        return {
          nextAction: 'run_ai_kit_review',
          canProceed: true,
          requiresUserApproval: false,
          blockingUserAction: null,
          recommendedTool: 'record_ai_kit_review_result',
          instructionForAI: 'Dataverse Metadata Check is resolved. Read the applicable AI Kit rules and the target file yourself, then call record_ai_kit_review_result with your verdict, then call run_implementation_verification again.',
          allowedWrites: ['record_ai_kit_review_result', 'run_implementation_verification'],
          forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
        };
      }
      if (mcpVerification.status === 'needs_configuration') {
        const reason = (mcpVerification.checks || []).find((c) => c.status === 'needs_configuration')?.findings?.[0]
          ?? 'Dataverse Metadata Check is not configured.';
        return {
          nextAction: 'needs_configuration',
          canProceed: false,
          requiresUserApproval: true,
          blockingUserAction: reason,
          recommendedTool: null,
          instructionForAI: `${reason} This cannot be resolved by the AI agent — ask the user to configure it, then call continue_developer_workflow again.`,
          allowedWrites: [],
          forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
        };
      }
      if (mcpVerification.status === 'warnings_unaccepted') {
        const reason = 'Dataverse Metadata Check completed with warnings that have not been explicitly accepted yet.';
        return {
          nextAction: 'review_dataverse_warnings',
          canProceed: false,
          requiresUserApproval: true,
          blockingUserAction: reason,
          recommendedTool: null,
          instructionForAI: `${reason} This requires the user: ask them to review the warnings in the Implementation Verification modal and either accept them and continue, or send the task back for you to fix the code and rerun the check.`,
          allowedWrites: [],
          forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
        };
      }
      if (mcpVerification.status === 'needs_manual_action') {
        const manualStep = composeManualVerificationStep(buildModalVerificationSummary(task));
        return {
          nextAction: 'wait_for_user',
          canProceed: false,
          requiresUserApproval: true,
          blockingUserAction: manualStep,
          recommendedTool: null,
          instructionForAI: `Script File Readiness and local static/business-rule verification are complete, but some Implementation Verification modal rows are still not-run. ${manualStep} Call continue_developer_workflow again after the user completes it.`,
          allowedWrites: [],
          forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
        };
      }
      // Fallback (should be rare): Dataverse Metadata Check ran but did not resolve. Re-run
      // run_implementation_verification rather than pointing at the in-app modal — the automated
      // check can be retried directly.
      return {
        nextAction: 'run_implementation_verification',
        canProceed: true,
        requiresUserApproval: false,
        blockingUserAction: null,
        recommendedTool: 'run_implementation_verification',
        instructionForAI: 'Dataverse Metadata Check has not resolved yet. Call run_implementation_verification again.',
        allowedWrites: ['run_implementation_verification'],
        forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
      };
    }
    return {
      nextAction: 'verify_dataverse',
      canProceed: true,
      requiresUserApproval: false,
      blockingUserAction: null,
      recommendedTool: 'run_dataverse_check_for_task',
      instructionForAI: 'Run Dataverse metadata verification using run_dataverse_check_for_task, then call continue_developer_workflow again.',
      allowedWrites: ['run_dataverse_check_for_task'],
      forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
    };
  }

  // 3. AI Kit review — hard gate. Reads implementationVerification.aiCodeReview (the canonical
  // field the modal reads), NOT the looser task.aiKitReview.completedAt flag: recording ANY
  // verdict (including "failed") always sets completedAt, so gating on completedAt alone would
  // let a failed/incomplete review through. aiKitReviewGate resolves via either an automated
  // status=="passed" review with fixableFindings empty AND reviewedFiles/rulesFiles/
  // checklistFiles/knownPrReviewFiles all non-empty, OR an explicit manual UI override
  // (status=="manually-verified" or "skipped", which record_ai_kit_review_result itself cannot
  // set — see its inputSchema status enum).
  const aiReview = asObject(asObject(task.implementationVerification).aiCodeReview);
  const [aiGate, aiMissing] = aiKitReviewGate(aiReview);
  if (aiGate !== 'passed') {
    const instruction = aiGate === 'failed'
      ? "AI Kit review found fixable findings or has an explicit 'failed' verdict. Fix the code, then call record_ai_kit_review_result again with status='passed' and full review details, then call continue_developer_workflow again."
      : aiGate === 'incomplete'
        ? `AI Kit review was recorded as 'passed' but is missing required details: ${aiMissing.join(', ')}. Call record_ai_kit_review_result again including reviewedFiles, rulesFiles, checklistFiles, and knownPrReviewFiles, then call continue_developer_workflow again.`
        : aiGate === 'pending'
          ? "AI Kit review verdict is 'warnings' — resolve the warnings, then call record_ai_kit_review_result again with status='passed', then call continue_developer_workflow again."
          : 'AI Kit review is required before branch creation. Read the applicable AI Kit rules, the CRM code review checklist, known PR review comments, and the target file yourself, then call record_ai_kit_review_result with your verdict and full review details, then call continue_developer_workflow again.';
    return {
      nextAction: 'run_ai_kit_review',
      canProceed: true,
      requiresUserApproval: false,
      blockingUserAction: null,
      recommendedTool: 'record_ai_kit_review_result',
      instructionForAI: instruction,
      allowedWrites: ['record_ai_kit_review_result', 'record_ai_implementation_completed'],
      forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
    };
  }

  // 4. Deployment & Testing — local Task Workbench state only (record_manual_deployment /
  // record_deployment_test never call Dataverse/Git/PAC CLI). Resolved only via the canonical
  // deploymentTesting field — never the legacy localTestRecord/implementationVerification.
  // localTest/consultantTestRecord fields. Mirrors computeDeploymentTestingGate above.
  const deploymentGate = computeDeploymentTestingGate(task);
  if (!deploymentGate.canProceedToCommit) {
    if (deploymentGate.nextRecommendedAction === 'wait_for_manual_deployment') {
      return {
        nextAction: 'wait_for_manual_deployment',
        canProceed: false,
        requiresUserApproval: true,
        blockingUserAction: 'Ask the user to manually deploy the CRM artifact (Dataverse/Power Apps import, web resource publish, form registration, etc.), then record it with record_manual_deployment.',
        recommendedTool: null,
        instructionForAI: 'Implementation Verification passed, but this is a local-only code/metadata gate — the artifact has not been deployed yet. Stop and ask the user to deploy it manually. Never call record_manual_deployment speculatively or because static verification passed; only after the user confirms the deployment actually happened, with meaningful notes describing what was done.',
        allowedWrites: ['record_manual_deployment'],
        forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes', 'record_deployment_test'],
      };
    }
    if (deploymentGate.nextRecommendedAction === 'fix_code_or_redeploy') {
      return {
        nextAction: 'fix_code_or_redeploy',
        canProceed: true,
        requiresUserApproval: false,
        blockingUserAction: null,
        recommendedTool: null,
        instructionForAI: 'The deployment test was recorded as failed. Fix the code, or ask the user to redeploy, then wait for a new test result via record_deployment_test — do not proceed to commit/push.',
        allowedWrites: [],
        forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
      };
    }
    return {
      nextAction: 'wait_for_deployment_test',
      canProceed: false,
      requiresUserApproval: true,
      blockingUserAction: 'Ask the user to perform a real browser/model-driven app test of the deployed artifact, then record it with record_deployment_test.',
      recommendedTool: null,
      instructionForAI: 'Manual deployment is recorded. Stop and ask the user to test the deployed artifact in the browser/model-driven app. Never call record_deployment_test unless the user confirms a real test was actually performed.',
      allowedWrites: ['record_deployment_test'],
      forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
    };
  }

  // 5. Commit verified? Push verified? Pull request created/recorded? Each is a separate,
  // explicit user approval — approving one is never approval for the next. Mirrors
  // computeCodeReviewReadinessGate above.
  const reviewReadiness = computeCodeReviewReadinessGate(task);
  if (reviewReadiness.commitVerified && reviewReadiness.pushVerified && reviewReadiness.prRecorded) {
    return {
      nextAction: 'wait_for_colleague_code_review',
      canProceed: true,
      requiresUserApproval: true,
      blockingUserAction: 'Waiting for a colleague to review the pull request.',
      recommendedTool: null,
      instructionForAI: 'Commit, push, and pull request are all verified. Stop and report that the task is waiting for colleague code review. This is independent of any AI/Claude review performed earlier (record_ai_kit_review_result) — never call your own review an independent colleague review.',
      allowedWrites: [],
      forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes', 'record_pull_request_created'],
    };
  }
  if (reviewReadiness.commitVerified && reviewReadiness.pushVerified) {
    return {
      nextAction: 'prepare_pull_request',
      canProceed: true,
      requiresUserApproval: true,
      blockingUserAction: 'Ask the user for a SEPARATE explicit approval before creating or recording a pull request — approval to commit/push is not approval to create a PR.',
      recommendedTool: 'prepare_pull_request_for_task',
      instructionForAI: 'Commit and push are verified. Call prepare_pull_request_for_task to preview the PR (branches, title, description, detected existing PR). Ask the user for a separate explicit approval before creating or recording a pull request. If automatic creation is unavailable for this provider, give manual instructions and record the result with record_pull_request_created only with a real PR URL the user (or you, after approval) actually created — never fabricate one.',
      allowedWrites: ['prepare_pull_request_for_task', 'record_pull_request_created'],
      forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
    };
  }
  if (reviewReadiness.commitVerified) {
    return {
      nextAction: 'commit_and_push',
      canProceed: true,
      requiresUserApproval: true,
      blockingUserAction: 'Ask the user for a SEPARATE explicit approval before pushing.',
      recommendedTool: 'push_task_branch',
      instructionForAI: 'A commit is verified locally but not yet pushed. Ask the user for a separate explicit approval, then call push_task_branch or commit_and_push_task_changes.',
      allowedWrites: ['push_task_branch', 'commit_and_push_task_changes'],
      forbiddenWrites: [],
    };
  }

  // 6. Propose/confirm branch, then commit — each step requires its OWN explicit user
  // approval. Confirming a branch name does not imply the commit is approved, and vice versa.
  // Mirrors Rust task_mcp_compute_continue_workflow_step's "6. Propose/confirm branch" section
  // in src-tauri/src/lib.rs — keep in sync.
  const confirmedBranch = asObject(task.gitWorkflow).confirmedBranch;
  if (typeof confirmedBranch === 'string' && confirmedBranch !== '') {
    return {
      nextAction: 'prepare_commit',
      canProceed: true,
      requiresUserApproval: true,
      blockingUserAction: 'Ask the user to confirm the commit (files + message) before committing.',
      recommendedTool: 'prepare_commit_for_task',
      instructionForAI: `Branch '${confirmedBranch}' was already created/checked out and confirmed. Call prepare_commit_for_task to show the user exactly what would be committed (changed files, ignored/gitignored files, suggested message), then ask for a SEPARATE explicit approval of the commit itself before calling commit_task_changes. Do not call push_task_branch or commit_and_push_task_changes without a further separate approval to push.`,
      allowedWrites: ['prepare_commit_for_task', 'commit_task_changes'],
      forbiddenWrites: ['push_task_branch', 'commit_and_push_task_changes'],
    };
  }

  return {
    nextAction: 'propose_branch',
    canProceed: true,
    requiresUserApproval: true,
    blockingUserAction: 'Ask the user to confirm the proposed branch name before creating/checking it out.',
    recommendedTool: 'create_or_checkout_task_branch',
    instructionForAI: "Implementation, verification, and AI Kit review are complete. Call prepare_commit_for_task to get a suggested branch name (proposedBranchName) and see whether it already exists (branchExists), propose that name to the user, and ask them to confirm the exact branch name. Once the user approves, call create_or_checkout_task_branch with mode='create_if_missing_and_checkout' to actually create/check out the branch — prepare_commit_for_task alone never creates or checks out anything. Do not call commit_task_changes, push_task_branch, or commit_and_push_task_changes until a SEPARATE explicit approval of the commit itself, after the branch exists.",
    allowedWrites: ['prepare_commit_for_task', 'create_or_checkout_task_branch'],
    forbiddenWrites: ['commit_task_changes', 'push_task_branch', 'commit_and_push_task_changes'],
  };
}

/**
 * Sets the canonical UI-visible status/waitingState/attentionState fields for a workflow phase.
 * Mirrors Rust's task_mcp_set_status_phase (src-tauri/src/lib.rs) so headless fallback writes
 * (--data-dir mode, no live app) never diverge from the bridge-mode implementation used by the
 * running Task Workbench app.
 */
function setStatusPhase(task, phase) {
  switch (phase) {
    case 'new':
      task.status = 'new';
      task.waitingState = null;
      task.attentionState = null;
      break;
    case 'analyzed':
      task.status = 'analyzed';
      task.waitingState = null;
      task.attentionState = null;
      break;
    case 'development':
      task.status = 'in-progress';
      task.waitingState = null;
      task.attentionState = null;
      break;
    case 'testing':
      task.status = 'in-progress';
      task.waitingState = 'consultant-testing';
      task.attentionState = null;
      break;
    case 'review':
      task.status = 'ready-for-review';
      task.waitingState = 'code-review';
      task.attentionState = null;
      break;
    case 'done':
      task.status = 'done';
      task.waitingState = null;
      task.attentionState = null;
      task.completedAt = new Date().toISOString();
      break;
    default:
      break;
  }
}

/**
 * Task fields representing generated analysis, setup confirmation, approvals, implementation,
 * verification, testing, PR/review, external-action, or workflow-progression state. Cleared by a
 * full reset to NEW (see resetTaskWorkflowToNew below). Deliberately excludes status/
 * waitingState/attentionState/suggestedActions — those are unconditionally reset to their
 * NEW-equivalent value regardless of whether any of the keys below are set.
 * Mirrors RESETTABLE_WORKFLOW_KEYS in src/lib/taskWorkflowReset.ts and
 * TASK_MCP_RESETTABLE_WORKFLOW_KEYS in src-tauri/src/lib.rs — keep all three in sync.
 */
const RESETTABLE_WORKFLOW_KEYS = [
  'completedAt',
  'estimatedEffort',
  'planningBucket',
  'suggestedPlanningBucket',
  'priorityScore',
  'priorityReason',
  'isPlanningLocked',
  'analysisResult',
  'generatedReply',
  'scriptAnalysis',
  'selectedPluginProject',
  'aiFileReviews',
  'crmSkeletons',
  'crmVerificationReports',
  'crmDeveloperWorkflow',
  'workflowSetup',
  'taskMode',
  'implementationVerification',
  'deploymentTesting',
  'localTestRecord',
  'consultantTestRecord',
  'mcpChecklistOverrides',
  'mcpNextStep',
  'gitWorkflow',
];

/** True for any value that represents real, meaningful workflow state worth warning about —
 *  false for undefined/null and for empty arrays/objects (nothing was actually recorded there). */
function isNonEmptyWorkflowValue(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * True when the task carries any generated/derived workflow state that a reset to NEW would
 * discard. Used to decide whether resetting requires explicit confirmation (set_task_phase's
 * confirmReset) — a task with none of this state is already effectively clean, and resetting it
 * is a safe no-op. Mirrors Rust task_mcp_task_has_resettable_workflow_state.
 */
function taskHasResettableWorkflowState(task) {
  return RESETTABLE_WORKFLOW_KEYS.some((key) => isNonEmptyWorkflowValue(task[key]));
}

/**
 * Resets a task's local workflow/execution state to the equivalent of a fresh NEW task, in place.
 * Preserves identity, original assignment, user notes, and import/tracking metadata — only
 * status/waitingState/attentionState/suggestedActions and the RESETTABLE_WORKFLOW_KEYS fields are
 * touched. Deletes (rather than nulling) the resettable keys so no stale nested object/array
 * lingers in the persisted JSON. Never touches the filesystem, Git, Dataverse, or any external
 * system — this is a pure in-memory mutation of the parsed task object.
 * Mirrors Rust task_mcp_reset_task_workflow_to_new.
 */
function resetTaskWorkflowToNew(task) {
  task.status = 'new';
  task.waitingState = null;
  task.attentionState = null;
  task.suggestedActions = [];
  for (const key of RESETTABLE_WORKFLOW_KEYS) delete task[key];
}

/**
 * Canonical developer workflow transition service — fallback-mode mirror of Rust's
 * task_mcp_apply_developer_workflow_transition. MCP write tools must call this instead of
 * writing status/waitingState/helper fields ad hoc, so the app-visible phase (NEW/ANALYZED/
 * DEVELOPMENT/TESTING/CODE REVIEW/DONE) never drifts from what MCP recorded, even when the task
 * is later opened in the live Task Workbench app.
 */
function applyDeveloperWorkflowTransition(task, transition, payload = {}) {
  switch (transition) {
    case 'technical_plan_approved':
      // Leaving NEW/Analyze: a plan can only be approved once the task has been analyzed.
      if (task.status === 'new') setStatusPhase(task, 'analyzed');
      // If code can now be written (all other gates satisfied), move straight into
      // DEVELOPMENT so the UI does not show a stale NEW/Analyze or Analyzed phase.
      if (payload.canWriteCode && task.status !== 'in-progress') setStatusPhase(task, 'development');
      break;
    case 'ai_implementation_completed':
      // Implementation files were written by AI. This is DEVELOPMENT / Verify Implementation —
      // do not set a testing waitingState here; the manual CRM upload + in-app Verify
      // Implementation step still has to happen first.
      if (task.status !== 'in-progress') setStatusPhase(task, 'development');
      break;
    case 'manual_crm_verification_completed':
      // Manual CRM upload/registration + Verify Implementation is done — hand off to
      // consultant testing.
      setStatusPhase(task, 'testing');
      break;
    default:
      break;
  }
  task.crmDeveloperWorkflow = asObject(task.crmDeveloperWorkflow);
  task.crmDeveloperWorkflow.updatedAt = new Date().toISOString();
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
      let devDefaults = null;
      const customerId = task.customerId || task.workflowSetup?.customerId;
      if (customerId) {
        const [customers, settings] = await Promise.all([loadCustomers(), loadSettings()]);
        const customer = customers.find((c) => c.id === customerId);
        const crmBaseDir = settings?.crmBaseDirectory ?? '';
        devDefaults = computeCustomerDevDefaults(customer, crmBaseDir);
        if (devDefaults) detail.customerDevDefaults = devDefaults;
      }
      // Compute developerWorkPacket.scriptNaming for script/ribbon tasks
      const workKindVal =
        task.crmDeveloperWorkflow?.detectedWorkKind || task.workflowSetup?.devTargetKind;
      if (workKindVal === 'script' || workKindVal === 'ribbon') {
        const template = matchTaskTemplate(task.title || '', taskTextForInference(task));
        const scriptNaming = computeScriptNaming(template, devDefaults, task.workflowSetup);
        if (scriptNaming) detail.developerWorkPacket = { scriptNaming };
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
    case 'get_developer_work_packet': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const task = getTaskById(tasks, taskId);
      if (!task) return { ...common, error: `Task not found: ${taskId}` };
      let devDefaults = null;
      const customerId = task.customerId || task.workflowSetup?.customerId;
      if (customerId) {
        const [customers, settings] = await Promise.all([loadCustomers(), loadSettings()]);
        const customer = customers.find((c) => c.id === customerId);
        devDefaults = computeCustomerDevDefaults(customer, settings?.crmBaseDirectory ?? '');
      }
      return { ...common, ...buildDeveloperWorkPacket(task, devDefaults) };
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
        statusMessage: valid ? 'Valid kit â€” all required files found.' : `Invalid kit: missing ${missingFiles.join(', ')}`,
      };
    }
    case 'get_task_templates': {
      let matchedTemplate = null;
      if (args.taskId) {
        const task = getTaskById(tasks, args.taskId);
        if (task) matchedTemplate = matchTaskTemplate(task.title, taskTextForInference(task));
      }
      return {
        ...common,
        templates: TASK_TEMPLATES,
        matchedTemplate: matchedTemplate ?? undefined,
      };
    }
    case 'set_task_phase': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const phase = String(args.phase ?? '').trim();
      const allowedPhases = ['new', 'analyzed', 'development', 'testing', 'review', 'done'];
      if (!allowedPhases.includes(phase)) {
        return { ...common, error: `Invalid phase '${phase}'. Allowed: ${allowedPhases.join(', ')}` };
      }
      const index = tasks.findIndex((t) => t.id === taskId);
      if (index < 0) return { ...common, error: `Task not found: ${taskId}` };
      const task = tasks[index];

      if (phase === 'new') {
        const confirmReset = args.confirmReset === true;
        if (taskHasResettableWorkflowState(task) && !confirmReset) {
          return {
            ...common,
            error:
              `Resetting task '${taskId}' to NEW will clear saved analysis, developer setup, technical plans and ` +
              'approvals, implementation verification, AI reviews, test/checklist results, next-step state, and local ' +
              'Git workflow tracking. The original assignment, customer, notes, tracking links, and repository files ' +
              'will not be changed — this does not touch Git or any external system. Explicit user approval is ' +
              'required before this reset can proceed. Ask the user to confirm, then retry with confirmReset=true.',
          };
        }
        resetTaskWorkflowToNew(task);
        appendMcpAuditNote(task, 'set_task_phase -> new (workflow reset to NEW)');
      } else {
        setStatusPhase(task, phase);
        appendMcpAuditNote(task, `set_task_phase -> ${phase}`);
      }
      await saveTasks(tasks);
      return { ...common, task: safeTaskSummary(task) };
    }
    case 'prepare_developer_task': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const mode = args.mode ?? 'setup-until-approval-gate';
      if (mode !== 'setup-until-approval-gate') return { ...common, error: `Unsupported mode: ${mode}` };
      const index = tasks.findIndex((task) => task && String(task.id) === taskId);
      if (index < 0) return { ...common, error: `Task not found: ${taskId}` };

      const task = tasks[index];
      let devDefaults = null;
      const customerId = task.customerId || task.workflowSetup?.customerId;
      if (customerId) {
        const [customers, settings] = await Promise.all([loadCustomers(), loadSettings()]);
        const customer = customers.find((c) => c.id === customerId);
        devDefaults = computeCustomerDevDefaults(customer, settings?.crmBaseDirectory ?? '');
      }

      const result = prepareDeveloperTaskInMemory(task, {
        customerDevDefaults: devDefaults,
        confirmSetup: args.confirmSetup !== false,
        createTechnicalPlan: args.createTechnicalPlan !== false,
      });
      appendMcpAuditNote(task, 'prepare_developer_task');
      await saveTasks(tasks);
      return {
        ...common,
        ...result,
        task: buildTaskFullContext(task, devDefaults),
      };
    }
    case 'continue_developer_workflow': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const index = tasks.findIndex((t) => t.id === taskId);
      if (index < 0) return { ...common, error: `Task not found: ${taskId}` };
      const task = tasks[index];
      const step = computeContinueWorkflowStep(task);

      // Persist the Development -> Deployment & Testing transition the first time verification
      // has resolved and the task is waiting on manual deployment/testing — this is the SAME
      // local-only mutation the "Continue to Deployment & Testing" UI button performs
      // (waitingState='consultant-testing', status untouched). Local write only: no Git,
      // filesystem, Dataverse, deployment, commit, push, or PR operation. Idempotent — once
      // waitingState is already set, later calls (including fix_code_or_redeploy) do not re-fire it.
      const transitioned = DEPLOYMENT_TESTING_NEXT_ACTIONS.has(step.nextAction) && task.waitingState !== 'consultant-testing';
      if (transitioned) {
        task.waitingState = 'consultant-testing';
        task.attentionState = null;
        appendMcpAuditNote(task, `continue_developer_workflow -> transitioned to Deployment & Testing (${step.nextAction})`);
        await saveTasks(tasks);
      }

      return { ...common, taskId, ...step, transitionedToDeploymentTesting: transitioned };
    }
    case 'approve_technical_plan_if_safe': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const index = tasks.findIndex((t) => t.id === taskId);
      if (index < 0) return { ...common, error: `Task not found: ${taskId}` };

      const task = tasks[index];
      let devDefaults = null;
      const customerId = task.customerId || task.workflowSetup?.customerId;
      if (customerId) {
        const [customers, settings] = await Promise.all([loadCustomers(), loadSettings()]);
        const customer = customers.find((c) => c.id === customerId);
        devDefaults = computeCustomerDevDefaults(customer, settings?.crmBaseDirectory ?? '');
      }

      const packet = buildDeveloperWorkPacket(task, devDefaults);
      const reasons = planApprovalSafetyCheck(task, packet);

      // Safe plan refresh path: if the ONLY blocker is stale scaffold/TODO text in the plan
      // steps/risks, and the packet already has trusted concrete field mappings, replace the
      // stale plan text with deterministic steps derived from the work packet — then approve.
      const isOnlyScaffoldBlocker = reasons.length === 1
        && (reasons[0].toLowerCase().includes('todo') || reasons[0].toLowerCase().includes('scaffold') || reasons[0].toLowerCase().includes('placeholder'));
      const canRefresh = isOnlyScaffoldBlocker && canSafelyRefreshPlan(packet);

      if (reasons.length > 0 && !canRefresh) {
        return { ...common, canApprove: false, reasons };
      }

      const now = new Date().toISOString();
      task.crmDeveloperWorkflow = asObject(task.crmDeveloperWorkflow);

      if (canRefresh) {
        const plan = asObject(task.crmDeveloperWorkflow.technicalPlan);
        const existingRisks = Array.isArray(plan.risks) ? plan.risks : [];
        task.crmDeveloperWorkflow.technicalPlan = {
          ...plan,
          implementationSteps: generateConcreteStepsFromPacket(packet),
          risks: generateCleanRisksFromPacket(existingRisks, packet),
        };
        appendMcpAuditNote(task, 'approve_technical_plan_if_safe [safe plan refresh: stale scaffold steps/risks replaced from trusted work packet]');
      }

      task.crmDeveloperWorkflow.planApproval = { approved: true, approvedAt: now };
      task.crmDeveloperWorkflow.updatedAt = now;
      appendMcpAuditNote(task, 'approve_technical_plan_if_safe [AI safe auto-approval]');

      const refreshedPacket = buildDeveloperWorkPacket(task, devDefaults);
      // Advance the app-visible phase through the canonical transition, so the UI never stays
      // on NEW/Analyze once this packet would report canWriteCode=true.
      applyDeveloperWorkflowTransition(task, 'technical_plan_approved', { canWriteCode: !!refreshedPacket.canWriteCode });
      await saveTasks(tasks);

      return { ...common, canApprove: true, planRefreshed: canRefresh, approvedAt: now, workPacket: refreshedPacket };
    }
    case 'record_ai_implementation_completed': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const filesChanged = Array.isArray(args.filesChanged) ? args.filesChanged : [];
      if (filesChanged.length === 0) return { ...common, error: 'filesChanged must be a non-empty array' };
      const summary = String(args.summary ?? '').trim();
      if (!summary) return { ...common, error: 'Missing required argument: summary' };

      const index = tasks.findIndex((t) => t.id === taskId);
      if (index < 0) return { ...common, error: `Task not found: ${taskId}` };
      const task = tasks[index];

      if (task.taskMode !== 'developer') return { ...common, error: 'Task is not in developer mode.' };
      const planApproval = asObject(task.crmDeveloperWorkflow?.planApproval);
      if (!planApproval.approved || planApproval.invalidatedAt) {
        return { ...common, error: 'Technical plan is not approved. Approve the plan before recording implementation.' };
      }

      const now = new Date().toISOString();
      task.crmDeveloperWorkflow = asObject(task.crmDeveloperWorkflow);
      task.crmDeveloperWorkflow.lastAiImplementation = {
        filesChanged,
        summary,
        implementationChecks: Array.isArray(args.implementationChecks) ? args.implementationChecks : [],
        completedAt: now,
      };
      if (!task.mcpChecklistOverrides || typeof task.mcpChecklistOverrides !== 'object') {
        task.mcpChecklistOverrides = {};
      }
      task.mcpChecklistOverrides['implementation-done'] = 'done';
      task.localTestRecord = {
        status: 'not-needed',
        updatedAt: now,
        note: 'Script implementation completed by AI — no local test required before Dataverse upload.',
      };
      task.mcpChecklistOverrides['local-test-done'] = 'optional';

      // Also record the canonical modal-visible Local Test result so the Implementation
      // Verification modal, workflow overview, and run_implementation_verification all agree
      // with continue_developer_workflow's legacy localTestRecord gate.
      recordAiManagedLocalTestNotNeeded(task, now);

      let implementedArtifactPath = null;
      if (isScriptWorkflowTask(task)) {
        implementedArtifactPath = resolveImplementedScriptArtifact(task, filesChanged);
        applyImplementedScriptArtifactToWorkflowSetup(task, implementedArtifactPath);
      }
      // The implementation changed — any previous run_implementation_verification result is stale.
      if (task.implementationVerification && task.implementationVerification.mcpVerification) {
        delete task.implementationVerification.mcpVerification;
      }

      appendMcpAuditNote(task, `record_ai_implementation_completed: ${filesChanged.join(', ')}`);
      applyDeveloperWorkflowTransition(task, 'ai_implementation_completed', {});
      await saveTasks(tasks);
      return {
        ...common,
        recorded: true,
        implementedArtifactPath,
        nextStep: 'Call continue_developer_workflow, then run_implementation_verification before the manual Dataverse Upload / Verify Implementation step.',
        requiresManualCrmAction: true,
      };
    }
    case 'record_ai_kit_review_result': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };

      const index = tasks.findIndex((t) => t.id === taskId);
      if (index < 0) return { ...common, error: `Task not found: ${taskId}` };
      const task = tasks[index];
      const now = new Date().toISOString();

      try {
        applyAiKitReviewResult(task, args, now);
      } catch (e) {
        return { ...common, error: String(e?.message || e) };
      }
      const status = String(args.status ?? '').trim();
      appendMcpAuditNote(task, `record_ai_kit_review_result -> ${status}`);
      await saveTasks(tasks);

      const [gateStatus, missingDetails] = aiKitReviewGate(task.implementationVerification.aiCodeReview);
      const implementationVerification = buildModalVerificationSummary(task);
      const unresolvedRequiredRows = unresolvedModalRows(implementationVerification);
      const nextRecommendedStep = gateStatus === 'passed'
        ? 'Call run_implementation_verification again to confirm all automated checks are resolved.'
        : `AI Kit review does not satisfy the hard gate yet (gateStatus=${gateStatus}): ${missingDetails.length ? missingDetails.join('; ') : 'see findings/fixableFindings'}. Fix the findings and/or include the missing review details, then call record_ai_kit_review_result again.`;
      return {
        ...common,
        taskId,
        recorded: true,
        gateStatus,
        missingReviewDetails: missingDetails,
        implementationVerification,
        unresolvedRequiredRows,
        nextRecommendedStep,
      };
    }
    case 'run_implementation_verification': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const task = getTaskById(tasks, taskId);
      if (!task) return { ...common, error: `Task not found: ${taskId}` };
      if (task.taskMode !== 'developer') return { ...common, error: 'Task is not in developer mode.' };
      if (!isVerifiableDevTask(task)) {
        return { ...common, error: 'run_implementation_verification currently supports script/ribbon/plugin tasks only.' };
      }
      const isPlugin = isPluginDevTask(task);
      const readinessLabel = isPlugin ? 'Plugin File Readiness' : 'Script File Readiness';

      const requestedChecks = Array.isArray(args.checks) && args.checks.length > 0 ? new Set(args.checks) : null;
      const runCheck = (key) => !requestedChecks || requestedChecks.has(key);

      const [customers, settings] = await Promise.all([loadCustomers(), loadSettings()]);

      const checks = [];
      const fixableFindings = [];
      let readiness = null;
      let staticResult = null;
      let absoluteArtifactPath = null;

      if (runCheck('scriptFileReadiness')) {
        absoluteArtifactPath = isPlugin
          ? await resolvePluginArtifactPath(task, customers, settings)
          : resolveScriptAbsolutePath(task);
        readiness = await checkArtifactFileReadinessForVerification(absoluteArtifactPath, isPlugin);
        checks.push({ name: readinessLabel, status: readiness.status, findings: readiness.findings });
        if (readiness.fixable) {
          fixableFindings.push({ id: 'artifact-file-readiness', description: readiness.fixDescription || readiness.findings[0] });
        }
      }

      if (runCheck('localStaticVerification')) {
        if (isPlugin) {
          checks.push({ name: 'Local Static/Business-Rule Verification', status: 'skipped', findings: ['Not applicable — static rule templates currently cover JS/TS script tasks only.'] });
        } else if (readiness && readiness.fileContent) {
          const template = matchTaskTemplate(task.title, taskTextForInference(task));
          staticResult = runStaticBusinessRuleChecks(template, readiness.fileContent);
          checks.push({ name: staticResult.name, status: staticResult.status, findings: staticResult.findings });
          fixableFindings.push(...staticResult.fixableFindings);
        } else {
          checks.push({ name: 'Local Static/Business-Rule Verification', status: 'skipped', findings: ['Skipped — script file is not readable.'] });
        }
      }

      // Dataverse Metadata Check. Hard gate: "warnings" only counts as resolved once the user has
      // explicitly accepted them (implementationVerification.dataverseCheck.warningsAccepted) —
      // see normalizeDataverseGate. An environment mismatch between the task's expected customer
      // environment and the active Primarch connection blocks the check entirely rather than
      // reporting a result against the wrong environment.
      if (runCheck('dataverseMetadataCheck')) {
        task.implementationVerification = asObject(task.implementationVerification);
        task.implementationVerification.dataverseCheck = asObject(task.implementationVerification.dataverseCheck);
        // "needs_configuration" is only ever a transient override — clear a stale one from a
        // prior run before deciding this run's outcome, so a since-fixed configuration doesn't
        // leave the modal permanently stuck reporting needs_configuration.
        if (task.implementationVerification.dataverseCheck.status === 'needs_configuration') {
          delete task.implementationVerification.dataverseCheck.status;
        }
        const envMismatch = dataverseEnvironmentMismatch(task, customers, settings);
        const customer = (Array.isArray(customers) ? customers : []).find((c) => c && c.id === task.customerId);
        const expectedEnv = String(customer?.dataverseEnvironmentLabel ?? '').trim() || null;
        const activeEnvRaw = String(asObject(settings).primarchMcpEnvironmentLabel ?? '').trim();
        const activeEnv = activeEnvRaw || null;
        const environmentDetail = { expected: expectedEnv, active: activeEnv, mismatch: !!envMismatch };

        if (!absoluteArtifactPath) {
          checks.push({
            name: 'Dataverse Metadata Check', status: 'not_run',
            findings: ['Skipped — artifact file path is not resolved yet.'],
            environment: environmentDetail,
          });
        } else if (envMismatch) {
          const [expected, active] = envMismatch;
          const reason = `Active Primarch/Dataverse connection ('${active}') does not match this task's expected environment ('${expected}'). Switch the connection or update the task's customer environment label in Settings, then rerun the check. The check was NOT run against the wrong environment.`;
          task.implementationVerification.dataverseCheck.status = 'needs_configuration';
          task.implementationVerification.dataverseCheck.message = reason;
          checks.push({ name: 'Dataverse Metadata Check', status: 'needs_configuration', findings: [reason], environment: environmentDetail });
        } else {
          // This standalone MCP fallback (app not running) has no Primarch client of its own —
          // the real check runs through the Task Workbench app's local bridge (Rust). Fall back
          // to whatever status is already recorded (a previous real run, or a manual override);
          // only report "app must be running" when nothing is resolved yet.
          const resolvedStatus = deriveDataverseCheckStatusForVerification(task);
          if (IMPL_CHECK_RESOLVED_STATUSES.has(resolvedStatus)) {
            const report = (Array.isArray(task.crmVerificationReports) ? task.crmVerificationReports : [])[0] ?? {};
            const warningsAccepted = dataverseWarningsAccepted(task);
            const gateStatus = normalizeDataverseGate(resolvedStatus, warningsAccepted);
            const checkedReferences = buildVerifiedReferencesList(report);
            task.implementationVerification.dataverseCheck.environment = environmentDetail;
            checks.push({
              name: 'Dataverse Metadata Check', status: gateStatus, rawStatus: resolvedStatus,
              findings: [`Existing Dataverse Metadata Check status: ${resolvedStatus}.`],
              environment: environmentDetail,
              checkedReferences,
              warningsAccepted: task.implementationVerification.dataverseCheck.warningsAccepted ?? null,
            });
          } else {
            const reason = 'Automated Dataverse Metadata Check requires the Task Workbench app to be running (the MCP bridge runs Primarch verification). ' +
              'Start the app, then call run_implementation_verification again — or run Dataverse Metadata Check manually in the Implementation Verification modal.';
            task.implementationVerification.dataverseCheck.status = 'needs_configuration';
            task.implementationVerification.dataverseCheck.message = reason;
            checks.push({ name: 'Dataverse Metadata Check', status: 'needs_configuration', findings: [reason], environment: environmentDetail });
          }
        }
      }

      // AI Internal Code Review: Claude (the calling MCP agent) performs this review itself —
      // read the AI Kit rules and target file, then call record_ai_kit_review_result. Hard gate:
      // an automated "passed" review with missing details (reviewedFiles/rulesFiles/
      // checklistFiles/knownPrReviewFiles) is treated as incomplete, and any fixableFindings block
      // the gate regardless of status — OR an explicit manual UI override ("manually-verified" /
      // "skipped", which record_ai_kit_review_result itself cannot set) resolves the gate directly
      // — see aiKitReviewGate.
      if (runCheck('aiInternalCodeReview')) {
        const aiReview = asObject(asObject(task.implementationVerification).aiCodeReview);
        const [gateStatus, missingDetails] = aiKitReviewGate(aiReview);
        switch (gateStatus) {
          case 'passed': {
            const passedFinding = aiReview.status === 'manually-verified'
              ? 'AI Kit review gate resolved via explicit manual verification.'
              : aiReview.status === 'skipped'
                ? 'AI Kit review gate resolved via explicit manual skip.'
                : 'AI Kit review passed with full review details recorded.';
            checks.push({ name: 'AI Internal Code Review', status: 'passed', rawStatus: aiReview.status, findings: [passedFinding], review: aiReview });
            break;
          }
          case 'failed': {
            const aiFixable = Array.isArray(aiReview.fixableFindings) ? aiReview.fixableFindings : [];
            if (aiFixable.length === 0) {
              fixableFindings.push({ id: 'ai-kit-review-failed', description: "AI Kit review verdict is 'failed'. Address the findings and call record_ai_kit_review_result again." });
            } else {
              fixableFindings.push(...aiFixable);
            }
            checks.push({ name: 'AI Internal Code Review', status: 'failed', findings: ['AI Kit review found fixable issues.'], review: aiReview });
            break;
          }
          case 'incomplete':
            checks.push({
              name: 'AI Internal Code Review',
              status: 'needs_ai_kit_review',
              findings: [`AI Kit review was recorded as 'passed' but is missing required details (${missingDetails.join(', ')}). Re-run the review and include them.`],
              review: aiReview,
            });
            break;
          case 'pending':
            checks.push({
              name: 'AI Internal Code Review',
              status: 'needs_ai_kit_review',
              findings: ["AI Kit review verdict is 'warnings' — resolve the warnings (fix or justify) and call record_ai_kit_review_result again with a 'passed' verdict."],
              review: aiReview,
            });
            break;
          default:
            checks.push({
              name: 'AI Internal Code Review',
              status: 'needs_ai_kit_review',
              findings: ['Read the applicable AI Kit rules, the CRM code review checklist, known PR review comments, and the target file yourself (use get_power_platform_ai_kit_status and get_developer_work_packet for context), then call record_ai_kit_review_result with your verdict and full review details.'],
            });
        }
      }

      if (runCheck('localTest')) {
        const localTestCheck = localTestImplPassthrough(task);
        checks.push({ name: localTestCheck.name, status: localTestCheck.status, findings: localTestCheck.findings });
      }

      // Roll up the top-level status/nextAction. Priority: agent-actionable outcomes (fix code,
      // run the AI Kit review) come before needs_configuration — that requires the user to act, so
      // it must not block work the agent can already do right now. needs_configuration only wins
      // once there is nothing left for the agent itself to act on. warnings_unaccepted also
      // requires the user, but ranks below needs_configuration since a resolvable Dataverse
      // warning is a lesser blocker than a broken configuration. needs_manual_action/wait_for_user
      // is reserved for the genuinely manual rows (Local Test) plus rows that failed/were skipped/
      // never ran — never for Dataverse Check or AI Review merely because this is a JS/TS task.
      const hasNeedsConfiguration = checks.some((c) => c.status === 'needs_configuration');
      const hasNeedsAiReview = checks.some((c) => c.status === 'needs_ai_kit_review');
      const hasWarningsUnaccepted = checks.some((c) => c.status === 'warnings_unaccepted');
      let status;
      let nextAction;
      if (fixableFindings.length > 0) {
        status = 'failed';
        nextAction = 'fix_code';
      } else if (hasNeedsAiReview) {
        status = 'pending_ai_kit_review';
        nextAction = 'run_ai_kit_review';
      } else if (hasNeedsConfiguration) {
        status = 'needs_configuration';
        nextAction = 'needs_configuration';
      } else if (hasWarningsUnaccepted) {
        status = 'warnings_unaccepted';
        nextAction = 'review_dataverse_warnings';
      } else if (checks.some((c) => ['needs_manual_action', 'failed', 'skipped', 'not_run'].includes(c.status))) {
        status = 'needs_manual_action';
        nextAction = 'wait_for_user';
      } else {
        status = 'passed';
        nextAction = 'continue_workflow';
      }

      // Fail-fast: never tell the agent to call record_ai_kit_review_result if this MCP session
      // cannot actually reach it — that produces a confusing "tool not found"/"bridge not running"
      // error after the fact instead of one clear, actionable instruction now.
      const guarded = applyToolingAvailabilityGuard(status, nextAction, computeMcpCapabilities());
      status = guarded.status;
      nextAction = guarded.nextAction;
      const missingRequiredTools = guarded.missingRequiredTools;

      const now = new Date().toISOString();
      task.implementationVerification = asObject(task.implementationVerification);
      task.implementationVerification.mcpVerification = { status, checks, fixableFindings, nextAction, ranAt: now };
      // Mirror Artifact File Readiness into the UI-visible buildCheck field so the Implementation
      // Verification modal reflects this run without a redundant manual "Check Script File" click.
      if (readiness) {
        task.implementationVerification.buildCheck = {
          status: readiness.status,
          runAt: now,
          summary: readiness.findings[0],
          findings: readiness.findings.map((f) => `${readiness.status === 'passed' ? 'pass' : 'fail'}|${f}`),
        };
      }
      appendMcpAuditNote(task, `run_implementation_verification -> ${status}/${nextAction}`);
      await saveTasks(tasks);

      // Modal-truth summary, built from the SAME canonical fields ImplementationVerification
      // Modal reads (now including the buildCheck we just wrote above, and the real
      // crmVerificationReports/aiCodeReview state the checks above may have just written).
      const implementationVerification = buildModalVerificationSummary(task);
      if (staticResult) {
        implementationVerification.staticBusinessRules = {
          status: staticResult.status,
          label: staticResult.name,
          findings: staticResult.findings,
        };
      }
      const unresolvedRequiredRows = unresolvedModalRows(implementationVerification);
      const nextRecommendedStep = nextAction === 'reload_mcp_or_start_app'
        ? 'Stop. Ask the user to start Task Workbench and reload the MCP server. Do not claim AI Kit review must be done manually unless the tool capability check says AI review cannot be automated.'
        : nextAction === 'needs_configuration'
          ? (checks.find((c) => c.status === 'needs_configuration')?.findings?.[0]
            ?? 'Resolve the required configuration, then call run_implementation_verification again.')
          : nextAction === 'fix_code'
            ? 'Fix the fixable findings, then call record_ai_implementation_completed and run_implementation_verification again.'
            : nextAction === 'run_ai_kit_review'
              ? 'Read the applicable AI Kit rules and the target file, then call record_ai_kit_review_result with your verdict, then call run_implementation_verification again.'
              : nextAction === 'review_dataverse_warnings'
                ? 'Dataverse Metadata Check completed with warnings that are not yet accepted. This requires the user: ask them to review the warnings in the Implementation Verification modal and either accept them, or send the task back for you to fix the code, then rerun the check.'
                : nextAction === 'wait_for_user'
                  ? composeManualVerificationStep(implementationVerification)
                  : 'All Implementation Verification checks are resolved. Call continue_developer_workflow to proceed.';

      return {
        ...common, taskId, status, checks, fixableFindings, nextAction,
        implementationVerification, unresolvedRequiredRows, nextRecommendedStep,
        missingRequiredTools, instructionForAI: nextRecommendedStep,
        progressionGate: computeProgressionGate(task),
      };
    }
    case 'get_implementation_verification_summary': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const task = getTaskById(tasks, taskId);
      if (!task) return { ...common, error: `Task not found: ${taskId}` };

      const implementationVerification = buildModalVerificationSummary(task);
      const persistedMcp = asObject(asObject(task.implementationVerification).mcpVerification);
      const persistedChecks = Array.isArray(persistedMcp.checks) ? persistedMcp.checks : [];
      const staticCheck = persistedChecks.find((c) => c.name === 'Local Static/Business-Rule Verification');
      if (staticCheck) {
        implementationVerification.staticBusinessRules = {
          status: staticCheck.status, label: staticCheck.name, findings: staticCheck.findings || [],
        };
      }

      const unresolvedRequiredRows = unresolvedModalRows(implementationVerification);
      const fixableFindings = Array.isArray(persistedMcp.fixableFindings) ? persistedMcp.fixableFindings : [];
      // Reuse the nextAction persisted by run_implementation_verification when available, so this
      // read-only summary never diverges from the actual last run (needs_configuration/
      // run_ai_kit_review/etc.) — only fall back to the simple derivation when nothing has run yet.
      const nextAction = persistedMcp.nextAction
        || (fixableFindings.length > 0 ? 'fix_code' : (unresolvedRequiredRows.length > 0 ? 'wait_for_user' : 'continue_workflow'));
      const nextRecommendedStep = nextAction === 'needs_configuration'
        ? (persistedChecks.find((c) => c.status === 'needs_configuration')?.findings?.[0]
          ?? 'Resolve the required configuration, then call run_implementation_verification again.')
        : nextAction === 'fix_code'
          ? 'Fix the fixable findings, then call record_ai_implementation_completed and run_implementation_verification again.'
          : nextAction === 'run_ai_kit_review'
            ? 'Read the applicable AI Kit rules and the target file, then call record_ai_kit_review_result with your verdict, then call run_implementation_verification again.'
            : nextAction === 'review_dataverse_warnings'
              ? 'Dataverse Metadata Check completed with warnings that are not yet accepted. This requires the user: ask them to review the warnings in the Implementation Verification modal and either accept them, or send the task back for you to fix the code, then rerun the check.'
              : nextAction === 'wait_for_user'
                ? composeManualVerificationStep(implementationVerification)
                : 'All Implementation Verification checks are resolved. Call continue_developer_workflow to proceed.';

      return {
        ...common, taskId, implementationVerification, checks: persistedChecks,
        unresolvedRequiredRows, fixableFindings, nextAction, nextRecommendedStep,
        progressionGate: computeProgressionGate(task),
      };
    }
    case 'get_task_workbench_mcp_capabilities': {
      const capabilities = computeMcpCapabilities();
      return { ...common, ...capabilities };
    }
    case 'get_deployment_testing_state': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const task = getTaskById(tasks, taskId);
      if (!task) return { ...common, error: `Task not found: ${taskId}` };

      const gate = computeDeploymentTestingGate(task);
      return {
        ...common, taskId,
        deploymentStatus: gate.deploymentStatus,
        testStatus: gate.testStatus,
        unresolvedRequiredRows: gate.blockingChecks.map((c) => c.check),
        canProceedToCommit: gate.canProceedToCommit,
        nextRecommendedAction: gate.nextRecommendedAction,
        blockingChecks: gate.blockingChecks,
      };
    }
    case 'record_manual_deployment': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const status = String(args.status ?? '').trim();
      if (!['deployed', 'failed', 'not-needed'].includes(status)) {
        return { ...common, error: "status must be 'deployed', 'failed', or 'not-needed'" };
      }
      const notes = String(args.notes ?? '').trim();
      if (status === 'not-needed' && !notes) {
        return { ...common, error: `notes is required and must be meaningful when recording status='${status}'` };
      }
      const index = tasks.findIndex((t) => t.id === taskId);
      if (index < 0) return { ...common, error: `Task not found: ${taskId}` };
      const task = tasks[index];
      const now = new Date().toISOString();
      task.deploymentTesting = asObject(task.deploymentTesting);
      task.deploymentTesting.deployment = {
        status, recordedAt: now, recordedBy: 'ai',
        ...(notes ? { notes } : {}),
        ...(args.environmentId ? { environmentId: String(args.environmentId) } : {}),
        ...(args.environmentName ? { environmentName: String(args.environmentName) } : {}),
        ...(args.solutionUniqueName ? { solutionUniqueName: String(args.solutionUniqueName) } : {}),
        ...(args.artifactType ? { artifactType: String(args.artifactType) } : {}),
        ...(args.artifactPath ? { artifactPath: String(args.artifactPath) } : {}),
        ...(args.webResourceName ? { webResourceName: String(args.webResourceName) } : {}),
        ...(args.entityLogicalName ? { entityLogicalName: String(args.entityLogicalName) } : {}),
        ...(args.formName ? { formName: String(args.formName) } : {}),
      };
      task.deploymentTesting.updatedAt = now;
      if (status === 'failed') {
        task.waitingState = null;
        task.attentionState = null;
      }
      appendMcpAuditNote(task, `record_manual_deployment -> ${status}`);
      await saveTasks(tasks);
      const gate = computeDeploymentTestingGate(task);
      return { ...common, taskId, recorded: true, deploymentStatus: status, nextRecommendedAction: gate.nextRecommendedAction };
    }
    case 'record_deployment_test': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const status = String(args.status ?? '').trim();
      if (!['passed', 'failed', 'not-needed'].includes(status)) {
        return { ...common, error: "status must be 'passed', 'failed', or 'not-needed'" };
      }
      const notes = String(args.notes ?? '').trim();
      if (status === 'not-needed' && !notes) {
        return { ...common, error: `notes is required and must be meaningful when recording status='${status}'` };
      }
      const index = tasks.findIndex((t) => t.id === taskId);
      if (index < 0) return { ...common, error: `Task not found: ${taskId}` };
      const task = tasks[index];
      const preGate = computeDeploymentTestingGate(task);
      const deploymentResolved = preGate.deploymentStatus === 'deployed' || preGate.deploymentStatus === 'not-needed';
      if (!deploymentResolved) {
        return { ...common, error: 'Manual deployment must be recorded (record_manual_deployment) before a deployment test can be recorded.' };
      }
      const now = new Date().toISOString();
      task.deploymentTesting = asObject(task.deploymentTesting);
      task.deploymentTesting.test = {
        status, recordedAt: now, recordedBy: 'ai',
        ...(notes ? { notes } : {}),
        ...(args.testedEnvironment ? { testedEnvironment: String(args.testedEnvironment) } : {}),
        ...(Array.isArray(args.testedAcceptanceCriteria) ? { testedAcceptanceCriteria: args.testedAcceptanceCriteria } : {}),
      };
      task.deploymentTesting.updatedAt = now;
      if (status === 'failed') {
        task.waitingState = null;
        task.attentionState = null;
      }
      appendMcpAuditNote(task, `record_deployment_test -> ${status}`);
      await saveTasks(tasks);
      const gate = computeDeploymentTestingGate(task);
      return { ...common, taskId, recorded: true, testStatus: status, canProceedToCommit: gate.canProceedToCommit, nextRecommendedAction: gate.nextRecommendedAction };
    }
    case 'get_pull_request_state': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const task = getTaskById(tasks, taskId);
      if (!task) return { ...common, error: `Task not found: ${taskId}` };
      const readiness = computeCodeReviewReadinessGate(task);
      const tracking = asObject(asObject(task.crmDeveloperWorkflow).pullRequestTracking);
      return {
        ...common, taskId,
        prCreated: readiness.prRecorded,
        prUrl: tracking.prUrl ?? null,
        commitVerified: readiness.commitVerified,
        pushVerified: readiness.pushVerified,
        canEnterCodeReview: readiness.canEnterCodeReview,
        nextRecommendedAction: readiness.nextRecommendedAction,
      };
    }
    case 'record_pull_request_created': {
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ...common, error: 'Missing required argument: taskId' };
      const prUrl = String(args.prUrl ?? '').trim();
      if (!prUrl) return { ...common, error: 'Missing required argument: prUrl' };
      const index = tasks.findIndex((t) => t.id === taskId);
      if (index < 0) return { ...common, error: `Task not found: ${taskId}` };
      const task = tasks[index];
      const now = new Date().toISOString();
      task.crmDeveloperWorkflow = asObject(task.crmDeveloperWorkflow);
      task.crmDeveloperWorkflow.pullRequestTracking = {
        createdManually: true, createdAt: now, prUrl,
        ...(args.notes ? { notes: String(args.notes) } : {}),
      };
      const readiness = computeCodeReviewReadinessGate(task);
      if (readiness.canEnterCodeReview) {
        task.status = 'ready-for-review';
        task.waitingState = 'code-review';
        task.attentionState = null;
        task.mcpNextStep = { action: 'Wait for colleague code review', reason: 'Pull request created and recorded. Waiting for colleague review — independent of any AI/Claude review.', updatedAt: now };
      }
      appendMcpAuditNote(task, `record_pull_request_created -> ${prUrl}`);
      await saveTasks(tasks);
      return { ...common, taskId, recorded: true, canEnterCodeReview: readiness.canEnterCodeReview, nextRecommendedAction: readiness.nextRecommendedAction };
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
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (error) {
          // The bridge is reachable and responded, but the response body is not valid JSON — a
          // bridge protocol/response bug, not evidence the bridge is not running.
          reject(new BridgeProtocolError(
            `Bridge returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            error,
          ));
          return;
        }
        if (parsed?.ok === false) {
          // Clear cached token on auth failure so next call refetches
          if (String(parsed.error ?? '').toLowerCase().includes('token')) {
            cachedBridgeToken = null;
          }
          // The bridge is reachable and responded with a valid ok:false result — a normal
          // application/tool-level rejection (e.g. a safety-gate guard), not a transport failure.
          reject(new BridgeToolError(String(parsed.error ?? 'Bridge call failed.')));
          return;
        }
        resolve(parsed?.result ?? parsed);
      });
    });
    request.on('error', (error) => {
      if (error instanceof BridgeUnavailableError) { reject(error); return; }
      reject(new BridgeUnavailableError(
        `Bridge request failed: ${error instanceof Error ? error.message : String(error)}`, error,
      ));
    });
    request.on('timeout', () => {
      request.destroy(new BridgeUnavailableError('Bridge request timed out.'));
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
    // A reachable bridge that rejected the call with a business/tool error, or replied with a
    // malformed response, is not the same condition as "the bridge is not running" — surface it
    // directly with its original message instead of masking it as a bridge-unavailable fallback.
    if (error instanceof BridgeToolError || error instanceof BridgeProtocolError) {
      throw error;
    }

    // From here on, `error` is a genuine transport/unavailability failure (BridgeUnavailableError,
    // or an unclassified low-level error) — preserve the existing bridge-unavailable / capability-
    // fallback behavior unchanged.

    // get_task_workbench_mcp_capabilities must always be answerable, even with no bridge and no
    // --data-dir/--fallback-readonly flags — that is exactly the condition it exists to diagnose.
    // Erroring out here (like every other tool does) would defeat its purpose as a health check.
    if (name === 'get_task_workbench_mcp_capabilities') {
      const capabilities = await callToolFallback(name, args);
      return {
        ...capabilities,
        bridge: {
          mode: capabilities.bridgeMode === 'offline' ? 'offline' : 'fallback-readonly',
          reason: 'task-workbench bridge unavailable',
          bridgeError: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const fallbackAllowed = isFallbackReadOnlyEnabled() || !!getCliDataDir();
    const fallbackWriteAllowed = FALLBACK_WRITE_ALLOWED_TOOL_NAMES.has(name) && !!getCliDataDir();
    if (!fallbackAllowed || (!READ_ONLY_TOOL_NAMES.has(name) && !fallbackWriteAllowed)) {
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

if (!process.env.VITEST) {
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
}

// Named exports for unit tests. Does not affect runtime behaviour when executed as a script.
export {
  READ_ONLY_TOOL_NAMES, TOOL_DEFINITIONS, TASK_TEMPLATES, matchTaskTemplate, callToolFallback, applyDeveloperWorkflowTransition,
  REQUIRED_DEVELOPER_WORKFLOW_TOOLS, FALLBACK_WRITE_ALLOWED_TOOL_NAMES, computeMcpCapabilitiesFromToolNames,
  applyToolingAvailabilityGuard, callTool, bridgeRequestJson,
  BridgeUnavailableError, BridgeToolError, BridgeProtocolError,
};

