# Task Workbench MCP 2.x

Task Workbench MCP exposes authoritative task, obligation, context, deadline,
status, revision, and history data. It never executes the represented work and
does not orchestrate AI agents.

## Start

The desktop app must be running because it owns the authoritative SQLite store
and the authenticated localhost bridge.

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
| `transition_work_item` | Yes | Apply a validated lifecycle transition |
| `append_work_item_note` | Yes | Append contextual information |
| `get_planning_today` | No | Read the live Now and Today planning model |

Every mutation other than create requires `expectedRevision`. A stale revision
returns `revision_conflict` and the current revision.

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

## Explicit exclusions

The server does not expose Git, file generation, deployment, testing, coding,
prompt-policy, agent-management, task-execution, commit, push, or pull-request
tools. The pre-2.0 source is retained under `mcp/legacy/` as a disabled migration
archive only.
