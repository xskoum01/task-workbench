# Task Workbench

Task Workbench is a local-first system of record for tasks, responsibilities, commitments,
deadlines, status, context, and change history.

The desktop app stores canonical work items in an embedded SQLite database with transactions,
revision checks, ordered changes, and an idempotent import from the guarded legacy JSON store.
Its MCP 2.x and local REST interfaces expose the same provider-neutral application layer.
Integrations may read or update records; Task Workbench never executes the work they represent.

## Canonical work item

Tasks and obligations share one versioned `WorkItem` contract:

- kind, description, expected outcome, status, and priority
- owner and accountable party
- area, deadline, next review, source references, and context
- created/updated timestamps and monotonically increasing revision
- structured history and an ordered integration change cursor

Legacy records are imported without discarding their original payload. The app keeps a recovery
copy and validates the import before marking it complete.

The primary navigation is Overview, Inbox, Work, Obligations, Areas, Activity, and Settings.

## Integrations

- [MCP 2.x](docs/task-workbench-mcp.md)
- [Local REST OpenAPI](docs/openapi.yaml)
- [WorkItem JSON Schema](docs/work-item.schema.json)
- [Legacy capability boundary](docs/legacy-boundary.md)
- [Manual desktop acceptance checklist](docs/manual-acceptance-checklist.md)

## Development

```sh
npm install
npm run dev
npm test
```

The desktop shell uses Tauri; the UI is React and TypeScript.
