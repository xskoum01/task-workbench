# Task Workbench MCP 2.x

Task Workbench MCP exposes authoritative task, obligation, context, deadline,
status, revision, and history data. It never executes the represented work and
does not orchestrate AI agents.

## Start

The desktop app must be running because it owns the authoritative SQLite store
and the authenticated localhost bridge.

Run it directly with `npm run mcp`, or point any generic MCP-capable client at
the same stdio command:

```json
{
  "mcpServers": {
    "task-workbench": {
      "command": "node",
      "args": ["C:/path/to/task-workbench/mcp/task-workbench-mcp.mjs"]
    }
  }
}
```

`npm run mcp:readonly` is a **deprecated** alias kept only for backward
compatibility with existing client configuration; it starts the identical
server, mutations included — despite the name, the server has never been
read-only. New configuration should use `npm run mcp`.

The Node process loads the bridge session token from Windows Credential Manager
target `com.vskoumal.task-workbench/bridge-token`. The desktop app creates or
migrates that target on startup and exposes only safe credential status metadata
through `/mcp/status`.

Legacy plaintext sources are read only as migration fallbacks when the vault
entry is missing: the previous application-data `mcp-bridge-token` file and
`TASK_WORKBENCH_BRIDGE_TOKEN`. They are not deleted automatically, are no longer
created by the bridge, and are not returned by status responses.

## Supported tools

| Tool | Mutation | Purpose |
|---|---:|---|
| `list_work_items` | No | List canonical tasks and obligations |
| `get_work_item` | No | Read one record by stable ID |
| `get_task_record` | No | Read the full trusted-local Task Workbench record for integrations |
| `list_work_item_changes` | No | Read ordered changes after a cursor |
| `create_work_item` | Yes | Create a canonical record |
| `update_work_item` | Yes | Replace record data with revision checking |
| `patch_work_item` | Yes | Patch whitelisted record fields with revision checking |
| `transition_work_item` | Yes | Apply a validated lifecycle transition |
| `append_work_item_note` | Yes | Append contextual information |
| `get_planning_today` | No | Read the live Now and Today planning model |

Every mutation other than create requires `expectedRevision`. A stale revision
returns `revision_conflict` and the current revision. Task Workbench never
auto-resolves a stale revision by overwriting newer data — the caller must
re-read the record and retry with the current revision.

Read tools carry MCP `annotations` (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) so a well-behaved client can distinguish
safe reads from mutations without parsing descriptions.

### Filtering `list_work_items`

`list_work_items` supports the same filter contract as
`GET /api/v1/work-items`, applied server-side by the authoritative query
layer — the caller never has to fetch every item and filter locally:

| Filter | Notes |
|---|---|
| `status` | Exact match against one lifecycle state |
| `kind` | `task` or `obligation` |
| `owner` | Matches owner id exactly, or owner display name case-insensitively |
| `area` | Matches `areaId` exactly |
| `source` | Exact match |
| `planningBucket` | Matches the explicitly stored bucket only — never inferred from `dueAt`/`status`/date |
| `dueBefore` / `dueAfter` | Inclusive ISO 8601 bounds on `dueAt` |
| `updatedAfter` | Exclusive ISO 8601 lower bound on `updatedAt` — use for "what changed since I last checked" |
| `includeArchived`, `limit`, `cursor` | Pagination and archive visibility |

Examples: "What am I working on?" → `status=in_progress`. "What's blocked?" →
`status=blocked`. "What do I have in Today?" → `planningBucket=today` (or call
`get_planning_today`, which returns the Now and Today sections in one call).
"What's due soonest?" → `dueBefore` with a near-term cutoff, or page through
results sorted by the list's natural order. "What changed since last time?" →
`updatedAfter` with the last-seen timestamp.

### Search

There is no bounded full-text/fuzzy `search_work_items` tool. The canonical
application layer (`WorkItemApplicationService::list` in
`src-tauri/src/application/mod.rs`) only supports the exact-match filters
above — it has no text-search capability to expose. Adding fuzzy or
LLM-driven search purely at the MCP layer would bypass the authoritative
query layer, so it is intentionally not implemented; use the filters above
(narrowed by `updatedAfter`/`status`/`planningBucket`/etc.) instead of a
free-text search until canonical search exists.

The lifecycle states are:

```text
planned, ready, in_progress, waiting, blocked, review, completed, cancelled
```

Transitions to `blocked` or `cancelled` require a reason. Completed and cancelled
records can only be reopened into `planned`.

## Machine-readable contracts

- JSON Schema: [`work-item.schema.json`](./work-item.schema.json)
- Local REST OpenAPI: [`openapi.yaml`](./openapi.yaml)
- Legacy boundary: [`legacy-boundary.md`](./legacy-boundary.md)

`get_task_record` and `GET /api/v1/task-records/{id}` intentionally expose a
more complete local record than the provider-neutral `WorkItem`: canonical data,
the UI-compatible task JSON, and derived workflow/status/link fields for trusted
local clients such as Jarvis.

For trusted local writes, integrations should prefer the narrowest operation:
`append_work_item_note` for notes, `transition_work_item` for lifecycle changes,
`patch_work_item` / `POST /api/v1/work-items/{id}/patch` for small field edits,
and `update_work_item` only when replacing the complete canonical record.

## Explicit exclusions

The server does not expose Git, file generation, deployment, testing, coding,
prompt-policy, agent-management, task-execution, commit, push, or pull-request
tools. The pre-2.0 source is retained under `mcp/legacy/` as a disabled migration
archive only.

This is enforced fail-closed at the bridge, not just by omission from this
list: `POST /mcp/tools/call` executes a tool name only if it is also published
in the bridge's own canonical tool list (`GET /mcp/tools`) — anything else,
including a historical developer-workflow tool name called by exact string,
is rejected with `unknown_tool` before any other code runs. Knowing a legacy
tool's name is never sufficient to run it. See
[`legacy-boundary.md`](./legacy-boundary.md#bridge-dispatch-is-fail-closed).
