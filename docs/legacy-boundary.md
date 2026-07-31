# Legacy compatibility boundary

Task Workbench 2.x treats task and obligation data as its only supported product
surface.

## Active boundary

- React enters through `src/App.tsx` and exposes Overview, Inbox, Work,
  Obligations, Areas, Activity, and Settings.
- Rust registers data, context, Microsoft 365 intake, and read-only metadata
  commands only.
- The active MCP server exposes the seven canonical work-item tools.
- SQLite is the authoritative canonical store. `tasks.json` is an idempotent
  migration and recovery source.

## Archived or compatibility-only material

- `mcp/legacy/` contains the pre-2.0 developer-workflow MCP implementation as
  non-executable `.disabled` source.
- Legacy fields can remain inside imported record metadata so historical data is
  not discarded.
- Unreachable frontend components and unregistered Rust helpers are not product
  capabilities. They may be deleted in later cleanup changes after real user data
  has completed the SQLite migration.

## Forbidden active capabilities

The active UI, Tauri command registry, local REST API, and MCP tool list must not
offer Git mutation, deployment, code generation, coding-agent orchestration,
prompt policy, task execution, or pull-request creation.

This boundary is enforced by `src/lib/productBoundary.spec.ts` and
`mcp/task-workbench-mcp.spec.mjs`.
