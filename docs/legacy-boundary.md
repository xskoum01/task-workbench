# Legacy compatibility boundary

Task Workbench 2.x treats task and obligation data as its only supported product
surface.

## Active boundary

- React enters through `src/App.tsx` and exposes Overview, Inbox, Work,
  Obligations, Areas, Activity, and Settings.
- Rust registers data, context, Microsoft 365 intake, and read-only metadata
  commands only.
- The active MCP server exposes only the canonical work-item tools listed in
  [`task-workbench-mcp.md`](./task-workbench-mcp.md#supported-tools).
- SQLite is the authoritative canonical store. `tasks.json` is an idempotent
  migration and recovery source.

## Bridge dispatch is fail-closed

The authenticated localhost bridge (`POST /mcp/tools/call`, used by both the
canonical MCP server and `GET /api/v1/*`) executes a tool name only if it is
also published in `canonical_mcp_tool_definitions()` — the same list
`GET /mcp/tools` returns. That check
(`task_mcp_is_canonical_tool_name` in `src-tauri/src/lib.rs`) is the single
authoritative allowlist; nothing else decides what is executable. Any other
name — a legacy developer-workflow tool, a typo, or anything not on that
list — is rejected with a stable `unknown_tool` error before any other code
runs. There is no fallback: unpublished and legacy tool names are not
callable merely because their string name is known, and being listed in
`/mcp/tools` and being executable can never drift apart, because both read
from the same allowlist.

## Archived or compatibility-only material

- `mcp/legacy/` contains the pre-2.0 developer-workflow MCP implementation as
  non-executable `.disabled` source — it was never a runtime API and is not
  reachable by any process.
- The pre-2.0 developer-workflow dispatch logic also still exists inside
  `src-tauri/src/lib.rs`'s `task_mcp_execute_tool` (Git branch/commit/push, PR
  recording, deployment recording, and related "local task state" tools), kept
  only so historical task records it once produced stay readable/greppable.
  It sits after the fail-closed gate above and is unreachable through any live
  entry point. It must never be re-wired to execute — extending the allowlist
  check instead of this code is the only way archived tools become callable
  again.
- Legacy fields can remain inside imported record metadata so historical data is
  not discarded.
- Unreachable frontend components and unregistered Rust helpers are not product
  capabilities. They may be deleted in later cleanup changes after real user data
  has completed the SQLite migration.

## Forbidden active capabilities

The active UI, Tauri command registry, local REST API, and MCP tool list must not
offer Git mutation, deployment, code generation, coding-agent orchestration,
prompt policy, task execution, or pull-request creation. This is enforced at
both layers: no forbidden tool is *published* (the definitions list), and none
is *executable* (the bridge dispatch gate) — see "Bridge dispatch is
fail-closed" above.

This boundary is enforced by `src/lib/productBoundary.spec.mjs` (definitions
list + dispatcher fail-closed gate), `mcp/task-workbench-mcp.spec.mjs`
(the stdio MCP server never sends an unpublished tool name), and
`src-tauri/src/lib.rs`'s own `bridge_gate_rejects_*` unit tests (the allowlist
predicate itself, exhaustively).
