import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const SERVER_NAME = 'task-workbench-mcp';
const SERVER_VERSION = '2.0.0';
const APP_IDENTIFIER = 'com.vskoumal.task-workbench';
const PRODUCT_NAME = 'Task Workbench';
const DEFAULT_BRIDGE_URL =
  process.env.TASK_WORKBENCH_BRIDGE_URL || 'http://127.0.0.1:38473';
const BRIDGE_CREDENTIAL_TARGET = 'com.vskoumal.task-workbench/bridge-token';

const WORK_ITEM_STATUS = [
  'planned',
  'ready',
  'in_progress',
  'waiting',
  'blocked',
  'review',
  'completed',
  'cancelled',
];

// The list-item projection shared by list_work_items and get_planning_today
// (canonical_summary in lib.rs) — kept in one place so both tool
// outputSchemas below stay identical to each other and to
// docs/openapi.yaml's WorkItemSummary schema.
const WORK_ITEM_SUMMARY_SCHEMA = {
  type: 'object',
  required: ['id', 'kind', 'title', 'status', 'priority', 'source', 'updatedAt', 'revision', 'archived'],
  properties: {
    id: { type: 'string' },
    kind: { enum: ['task', 'obligation'] },
    title: { type: 'string' },
    status: { type: 'string', enum: WORK_ITEM_STATUS },
    priority: { enum: ['low', 'normal', 'high', 'critical'] },
    planningBucket: {
      type: ['string', 'null'],
      description: 'Explicitly stored bucket; null when unset. Never inferred from dueAt/status.',
    },
    owner: {
      type: ['object', 'null'],
      properties: { id: { type: ['string', 'null'] }, displayName: { type: 'string' } },
    },
    area: {
      type: ['object', 'null'],
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    dueAt: { type: ['string', 'null'] },
    estimateMinutes: { type: ['integer', 'null'] },
    source: { type: 'string' },
    updatedAt: { type: 'string' },
    revision: { type: 'integer', minimum: 1 },
    archived: { type: 'boolean' },
  },
};

const DAILY_QUEUE_DATE_SCHEMA = {
  type: 'string',
  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
  description: 'Local calendar date, YYYY-MM-DD.',
};

// Shared response shape for get_daily_queue and every daily-queue mutation
// (they all return the full updated queue) — kept in one place so every
// tools' outputSchema stay identical to each other and to
// docs/openapi.yaml's DailyQueueResult / lib.rs's mcp_daily_queue_schema().
const DAILY_QUEUE_SCHEMA = {
  type: 'object',
  required: ['apiVersion', 'date', 'revision', 'generatedAt', 'entries'],
  properties: {
    apiVersion: { const: '1' },
    date: { type: 'string' },
    revision: { type: 'integer' },
    generatedAt: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'position', 'addedAt'],
        properties: {
          id: { type: 'string' },
          kind: { enum: ['work_item', 'note'] },
          position: { type: 'integer', minimum: 1 },
          workItem: WORK_ITEM_SUMMARY_SCHEMA,
          text: { type: 'string' },
          addedAt: { type: 'string' },
          completedAt: { type: ['string', 'null'] },
        },
      },
    },
  },
};

const TOOL_DEFINITIONS = [
  {
    name: 'list_work_items',
    description:
      'List canonical tasks and obligations from Task Workbench. Filtering is performed by the ' +
      'authoritative Task Workbench query layer, not by the caller — always prefer the narrowest ' +
      'filter that answers the question (e.g. status="in_progress" for "what am I working on", ' +
      'planningBucket="now" or "today" for the Now/Today view, dueBefore for the nearest deadline, ' +
      'updatedAfter for "what changed since I last checked") instead of listing every item. ' +
      'Returns data only and never executes work.',
    inputSchema: {
      type: 'object',
      properties: {
        includeArchived: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        cursor: { type: 'string' },
        status: { type: 'string', enum: WORK_ITEM_STATUS },
        kind: { type: 'string', enum: ['task', 'obligation'] },
        owner: {
          type: 'string',
          description: 'Matches owner id exactly or owner displayName case-insensitively.',
        },
        area: { type: 'string', description: 'Matches areaId exactly.' },
        source: { type: 'string' },
        planningBucket: {
          type: 'string',
          description: 'Matches the explicitly stored planningBucket exactly; never inferred.',
        },
        dueBefore: { type: 'string', description: 'ISO 8601 timestamp; inclusive upper bound on dueAt.' },
        dueAfter: { type: 'string', description: 'ISO 8601 timestamp; inclusive lower bound on dueAt.' },
        updatedAfter: { type: 'string', description: 'ISO 8601 timestamp; exclusive lower bound on updatedAt.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: {
      type: 'object',
      required: ['apiVersion', 'generatedAt', 'snapshotRevision', 'items', 'nextCursor'],
      properties: {
        apiVersion: { const: '1' },
        generatedAt: { type: 'string' },
        snapshotRevision: { type: 'integer' },
        items: { type: 'array', items: WORK_ITEM_SUMMARY_SCHEMA },
        nextCursor: { type: ['string', 'null'] },
      },
    },
  },
  {
    name: 'get_work_item',
    description: 'Get one canonical task or obligation by stable id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_task_record',
    description:
      'Get one full Task Workbench task record for trusted local integrations. Includes canonical work item, UI-compatible task JSON, and derived workflow/status/link fields.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_work_item_changes',
    description: 'Read the ordered work-item change feed after a numeric cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        after: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_work_item',
    description:
      'Create a canonical task or obligation record. This records work; it does not perform it.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'object' },
        idempotencyKey: {
          type: 'string',
          description: 'Optional. Repeating a create with the same key returns the original record instead of creating a duplicate.',
        },
      },
      required: ['item'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'update_work_item',
    description: 'Update canonical work-item data using optimistic revision control.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        item: { type: 'object' },
        expectedRevision: { type: 'integer', minimum: 1 },
        actorName: { type: 'string' },
      },
      required: ['id', 'item', 'expectedRevision'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'patch_work_item',
    description:
      'Patch whitelisted Task Workbench work-item fields with optimistic revision control.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        patch: { type: 'object' },
        expectedRevision: { type: 'integer', minimum: 1 },
        actorName: { type: 'string' },
      },
      required: ['id', 'patch', 'expectedRevision'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'transition_work_item',
    description: 'Apply one validated lifecycle transition to a task or obligation.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        status: { type: 'string', enum: WORK_ITEM_STATUS },
        reason: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 },
        actorName: { type: 'string' },
      },
      required: ['id', 'status', 'expectedRevision'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'append_work_item_note',
    description: 'Append a context note to a task or obligation.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        text: { type: 'string', minLength: 1 },
        expectedRevision: { type: 'integer', minimum: 1 },
        actorName: { type: 'string' },
      },
      required: ['id', 'text', 'expectedRevision'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'get_planning_today',
    description:
      'Return the live deterministic Now and Today planning sections. Membership is an exact match ' +
      'against each work item\'s explicitly stored planningBucket — never inferred from dueAt, status, ' +
      'or the current date. `timezone` is echoed back on the response only; it does not change which ' +
      'items are returned.',
    inputSchema: {
      type: 'object',
      properties: { timezone: { type: 'string' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: {
      type: 'object',
      required: ['apiVersion', 'generatedAt', 'sourceRevision', 'timezone', 'sections'],
      properties: {
        apiVersion: { const: '1' },
        generatedAt: { type: 'string' },
        sourceRevision: { type: 'integer' },
        timezone: { type: 'string' },
        sections: {
          type: 'object',
          required: ['now', 'today'],
          properties: {
            now: { type: 'array', items: WORK_ITEM_SUMMARY_SCHEMA },
            today: { type: 'array', items: WORK_ITEM_SUMMARY_SCHEMA },
          },
        },
      },
    },
  },
  {
    name: 'get_daily_queue',
    description:
      'Read the explicit, user-chosen execution order for one calendar day — distinct from status ' +
      'and planningBucket. Never AI-ranked or inferred from priority/due date. When `date` is ' +
      'omitted, defaults to the app\'s local calendar today (the same "today" the desktop UI uses) — ' +
      'reading local today initializes it once by carrying forward unfinished entries from the latest ' +
      'earlier queue; completed/cancelled work items and completed notes stay historical. Call this ' +
      'first to learn the canonical date/revision before a mutation. If the queue is ' +
      'explicit and non-empty, treat it as the user-approved order rather than substituting your own ' +
      'ranking.',
    inputSchema: {
      type: 'object',
      properties: { date: DAILY_QUEUE_DATE_SCHEMA },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: DAILY_QUEUE_SCHEMA,
  },
  {
    name: 'replace_daily_queue',
    description:
      'Atomically set the complete ordered daily queue for `date` to exactly `workItemIds`, in that ' +
      'order — e.g. "set my queue to A, B, C". Rejects a duplicate id, an archived work item, or an ' +
      'id that does not exist; the whole call fails and nothing is partially applied. Call ' +
      'get_daily_queue first to resolve `date` and the current `expectedRevision`.',
    inputSchema: {
      type: 'object',
      properties: {
        date: DAILY_QUEUE_DATE_SCHEMA,
        workItemIds: { type: 'array', items: { type: 'string', minLength: 1 } },
        expectedRevision: { type: 'integer', minimum: 0 },
      },
      required: ['date', 'workItemIds', 'expectedRevision'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: DAILY_QUEUE_SCHEMA,
  },
  {
    name: 'add_to_daily_queue',
    description:
      'Add one work item to the daily queue for `date`. `position` is 1-based; omitted or ' +
      'out-of-range values append to the end. Rejects if the work item is already queued for that ' +
      'date, archived, or does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        date: DAILY_QUEUE_DATE_SCHEMA,
        workItemId: { type: 'string', minLength: 1 },
        position: { type: 'integer', minimum: 1 },
        expectedRevision: { type: 'integer', minimum: 0 },
      },
      required: ['date', 'workItemId', 'expectedRevision'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: DAILY_QUEUE_SCHEMA,
  },
  {
    name: 'move_daily_queue_item',
    description:
      'Move an entry already in the daily queue to a 1-based position. Pass the entry\'s `id` as ' +
      '`workItemId`; for work entries this is the work item id, while notes have a generated ' +
      'queue-local id. Never changes a WorkItem\'s status or planningBucket.',
    inputSchema: {
      type: 'object',
      properties: {
        date: DAILY_QUEUE_DATE_SCHEMA,
        workItemId: { type: 'string', minLength: 1 },
        position: { type: 'integer', minimum: 1 },
        expectedRevision: { type: 'integer', minimum: 0 },
      },
      required: ['date', 'workItemId', 'position', 'expectedRevision'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: DAILY_QUEUE_SCHEMA,
  },
  {
    name: 'add_note_to_daily_queue',
    description:
      'Add a lightweight text-only reminder to the daily queue without creating a WorkItem. ' +
      'Text is trimmed, required, and limited to 500 characters.',
    inputSchema: {
      type: 'object',
      properties: {
        date: DAILY_QUEUE_DATE_SCHEMA,
        text: { type: 'string', minLength: 1, maxLength: 500 },
        position: { type: 'integer', minimum: 1 },
        expectedRevision: { type: 'integer', minimum: 0 },
      },
      required: ['date', 'text', 'expectedRevision'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: DAILY_QUEUE_SCHEMA,
  },
  {
    name: 'remove_from_daily_queue',
    description:
      'Remove an entry from the daily queue by passing its `id` as `workItemId`. This never changes ' +
      'or deletes an underlying WorkItem.',
    inputSchema: {
      type: 'object',
      properties: {
        date: DAILY_QUEUE_DATE_SCHEMA,
        workItemId: { type: 'string', minLength: 1 },
        expectedRevision: { type: 'integer', minimum: 0 },
      },
      required: ['date', 'workItemId', 'expectedRevision'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: DAILY_QUEUE_SCHEMA,
  },
];

const PUBLIC_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
let cachedBridgeToken = null;

function dataDirCandidates() {
  const explicit =
    process.env.TASK_WORKBENCH_DATA_DIR || process.env.TASK_WORKBENCH_APP_DATA_DIR;
  const candidates = [explicit];
  const home = os.homedir();

  if (process.platform === 'win32') {
    for (const root of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
      candidates.push(
        root && path.join(root, APP_IDENTIFIER),
        root && path.join(root, PRODUCT_NAME),
        root && path.join(root, 'task-workbench'),
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', APP_IDENTIFIER),
      path.join(home, 'Library', 'Application Support', PRODUCT_NAME),
    );
  } else {
    const configRoot = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    candidates.push(
      path.join(configRoot, APP_IDENTIFIER),
      path.join(configRoot, 'task-workbench'),
    );
  }
  return [...new Set(candidates.filter(Boolean))];
}

async function loadBridgeToken() {
  if (cachedBridgeToken) return cachedBridgeToken;
  const vaultToken = readWindowsCredential(BRIDGE_CREDENTIAL_TARGET);
  if (vaultToken) {
    cachedBridgeToken = vaultToken;
    return vaultToken;
  }
  if (process.env.TASK_WORKBENCH_BRIDGE_TOKEN) {
    cachedBridgeToken = process.env.TASK_WORKBENCH_BRIDGE_TOKEN;
    return cachedBridgeToken;
  }
  for (const directory of dataDirCandidates()) {
    try {
      const token = (
        await fs.readFile(path.join(directory, 'mcp-bridge-token'), 'utf8')
      ).trim();
      if (token) {
        cachedBridgeToken = token;
        return token;
      }
    } catch {
      // Continue through known app-data locations.
    }
  }
  throw new Error(
    'Task Workbench bridge token was not found in Windows Credential Manager. Start the desktop app to migrate the deprecated legacy source.',
  );
}

function readWindowsCredential(targetName) {
  if (process.platform !== 'win32') return null;
  const script = String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr buffer);
}
"@
$ptr = [IntPtr]::Zero
if (-not [WinCred]::CredRead($args[0], 1, 0, [ref]$ptr)) { exit 2 }
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][WinCred+CREDENTIAL])
  $bytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
} finally {
  [WinCred]::CredFree($ptr)
}
`;
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, targetName],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    ).trim();
    return output.length >= 24 ? output : null;
  } catch {
    return null;
  }
}

function requestJson(baseUrl, route, body, token) {
  return new Promise((resolve, reject) => {
    const target = new URL(route, baseUrl);
    const encoded = body === undefined ? null : JSON.stringify(body);
    const request = http.request(
      target,
      {
        method: encoded === null ? 'GET' : 'POST',
        headers: {
          accept: 'application/json',
          ...(encoded === null
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(encoded),
              }),
          ...(token ? { 'x-task-workbench-bridge-token': token } : {}),
        },
        timeout: 5_000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let payload;
          try {
            payload = text ? JSON.parse(text) : {};
          } catch (error) {
            reject(new Error(`Task Workbench bridge returned invalid JSON: ${error.message}`));
            return;
          }
          if ((response.statusCode ?? 500) >= 400 || payload.ok === false) {
            const detail =
              typeof payload.error === 'string'
                ? payload.error
                : payload.error?.message || `HTTP ${response.statusCode}`;
            reject(new Error(detail));
            return;
          }
          resolve(payload.result ?? payload);
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('Task Workbench bridge timed out.')));
    request.on('error', reject);
    if (encoded !== null) request.write(encoded);
    request.end();
  });
}

async function callTool(name, args = {}, baseUrl = DEFAULT_BRIDGE_URL) {
  if (!PUBLIC_TOOL_NAMES.has(name)) {
    throw new Error(
      `Tool '${name}' is not part of the Task Workbench 2.x task-data interface.`,
    );
  }
  const token = await loadBridgeToken();
  return requestJson(baseUrl, '/mcp/tools/call', { name, args }, token);
}

function successResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRequest(message) {
  const { id = null, method, params = {} } = message ?? {};
  if (method === 'initialize') {
    return successResponse(id, {
      protocolVersion: params.protocolVersion || '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        'Task Workbench is the authoritative source of truth for tasks, obligations, status, priority, ' +
        'deadlines, planning buckets, daily execution order, context, and history. It can read and ' +
        'update these records, but it never performs the represented work, never orchestrates coding ' +
        'agents or other AI agents, and never executes Git, repository, or deployment operations — ' +
        'those are outside its product boundary. Prefer the narrowest read tool for a question instead ' +
        'of listing everything: use list_work_items with a ' +
        'status/kind/owner/area/source/planningBucket/dueBefore/dueAfter/updatedAfter filter, or ' +
        'get_planning_today for the live Now/Today view, before falling back to an unfiltered list. ' +
        'For "what should I work on / in what order today", use get_daily_queue — it is a distinct ' +
        'concept from status and planningBucket: the user\'s own explicit, chosen execution order for ' +
        'a calendar day, never AI-ranked or inferred from priority/due date. If it is explicit and ' +
        'non-empty, treat it as the user-approved plan rather than substituting your own ranking; only ' +
        'change it via replace_daily_queue/add_to_daily_queue/move_daily_queue_item/' +
        'remove_from_daily_queue, each of which requires the current expectedRevision from ' +
        'get_daily_queue.',
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return successResponse(id, {});
  if (method === 'tools/list') {
    return successResponse(id, { tools: TOOL_DEFINITIONS });
  }
  if (method === 'tools/call') {
    try {
      const result = await callTool(params.name, params.arguments ?? {});
      return successResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    } catch (error) {
      return successResponse(id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  }
  return errorResponse(id, -32601, `Method not found: ${method}`);
}

async function runStdioServer() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response;
    try {
      response = await handleRequest(JSON.parse(line));
    } catch (error) {
      response = errorResponse(
        null,
        -32700,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (!process.env.VITEST) {
  runStdioServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export {
  PUBLIC_TOOL_NAMES,
  TOOL_DEFINITIONS,
  callTool,
  dataDirCandidates,
  handleRequest,
  loadBridgeToken,
  requestJson,
};
