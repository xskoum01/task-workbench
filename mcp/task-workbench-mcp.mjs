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

const TOOL_DEFINITIONS = [
  {
    name: 'list_work_items',
    description:
      'List canonical tasks and obligations from Task Workbench. Returns data only and never executes work.',
    inputSchema: {
      type: 'object',
      properties: {
        includeArchived: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        cursor: { type: 'string' },
      },
      additionalProperties: false,
    },
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
  },
  {
    name: 'create_work_item',
    description:
      'Create a canonical task or obligation record. This records work; it does not perform it.',
    inputSchema: {
      type: 'object',
      properties: { item: { type: 'object' } },
      required: ['item'],
      additionalProperties: false,
    },
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
        'Task Workbench provides authoritative task, obligation, context, status, deadline, and history data. It does not execute tasks or orchestrate agents.',
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
