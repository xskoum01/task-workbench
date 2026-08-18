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
| `get_daily_queue` | No | Read the explicit execution order for one calendar day |
| `replace_daily_queue` | Yes | Atomically set the whole ordered queue for a day |
| `add_to_daily_queue` | Yes | Add one work item to a day's queue |
| `move_daily_queue_item` | Yes | Reorder one work item within a day's queue |
| `remove_from_daily_queue` | Yes | Remove one work item from a day's queue |

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

### Daily Queue

The Daily Queue answers a different question than either `status` or
`planningBucket`:

| Concept | Question it answers |
|---|---|
| `status` | What workflow state is this work in? |
| `planningBucket` | Is this explicitly part of today's/now's planning? |
| **Daily Queue** | In what order do I actually intend to work through today's items? |

A work item can be `status=ready`, `planningBucket=today`, and have no
opinion at all about *when today* — the Daily Queue is that explicit,
user-chosen ordering for one calendar date. It is never generated
automatically from priority, due date, or status, and adding/reordering an
entry never changes the work item's `status` or `planningBucket` — those
remain independent fields, changed only through their own tools
(`transition_work_item`, `patch_work_item`).

**Date/timezone model.** The Daily Queue's "date" is the local calendar date
of the machine running the desktop app (this is a single-user, Windows-only
desktop application — there is no server/multi-timezone concern to resolve).
`get_daily_queue`'s `date` is optional and defaults to that local today
(`local_date_ymd()` in `src-tauri/src/lib.rs`, which reads the OS clock
directly); every mutation tool requires `date` explicitly, so a caller must
first read (or already know) the exact date it intends to mutate. The
frontend computes the same real-world quantity via `localTodayStr()` in
`src/lib/dates.ts`. No layer — including this JS MCP server, which is a pure
passthrough and computes no dates of its own — has a second, different
definition of "today".

**Revision semantics differ slightly from WorkItem.** A date that has never
been queued is not an error: `get_daily_queue` returns `revision: 0` with an
empty `entries` array (a virtual empty queue), and the first mutation for
that date is simply the one whose `expectedRevision` is `0`. This is why
`expectedRevision`'s minimum is `0` here, unlike WorkItem tools (minimum `1`,
since a WorkItem always exists with revision 1 by the time it can be
mutated).

**Typical Claude flows:**

- *"What's my queue today?"* → `get_daily_queue()` with no `date`.
- *"Put Neopharma before Orbit."* → `get_daily_queue()` to get the current
  `date`/`expectedRevision`/order, then `move_daily_queue_item` with that
  `expectedRevision`.
- *"Set today's order to Ptáček, Neopharma, Orbit."* → resolve the three work
  item IDs via `list_work_items`/`get_work_item`, `get_daily_queue()` for the
  current `date`/`expectedRevision`, then `replace_daily_queue`.
- *"What should I do now?"* → if `get_daily_queue()` returns a non-empty
  queue, treat it as the user's own approved plan — do not substitute a
  priority/due-date-based ranking instead.

**Completed/cancelled entries.** An entry stays in the persisted queue after
its work item transitions to `completed`/`cancelled` — the queue record is
historical and is not silently rewritten — but the projected `workItem` in
the response reflects the current status, so a client can (and the desktop
UI does) style it as done and skip it when picking "what's next", without
the backend needing special-case deletion logic. Removing it from the queue
view entirely is an explicit `remove_from_daily_queue` call.

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
