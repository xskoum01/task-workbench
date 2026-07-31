# Task Workbench

## Product goal

Task Workbench is a local-first task and obligation management system. It is the authoritative
source of truth for tasks, responsibilities, commitments, deadlines, status, history, and related
context.

The product must be human-friendly and expose stable machine-readable task data to AI systems and
other applications.

## Product boundary

Task Workbench provides and updates task/context records only.

It must not:

- orchestrate AI agents or prescribe agent workflows;
- write implementation code or repository files;
- create branches, commits, pushes, or pull requests;
- deploy artifacts or call external systems to complete a task;
- report an external action as completed unless it is merely recording a user-supplied fact.

Legacy developer-workflow fields may remain in imported metadata or disabled archive sources for
backward-compatible data recovery, but they must not be reachable from the public UI, MCP tool
list, REST API, or registered Tauri command surface.

## Canonical data

Canonical `WorkItem` records use explicit responsibility, obligation, lifecycle, revision,
context, and structured history fields. New mutations go through the Rust application/repository
layer so revisions, lifecycle validation, completion timestamps, history, and the change cursor
remain consistent.

SQLite is the authoritative store. The legacy JSON file is an idempotent migration and recovery
source: never overwrite a failed or ambiguous JSON load, and never mark migration complete until
the imported records have been validated.

## Integration rules

- MCP tools must be task-data or context-data operations.
- Keep the MCP definitions, Rust bridge definitions, OpenAPI, and JSON Schema synchronized.
- Use optimistic revision checks for every integration mutation after create.
- Sanitize externally sourced text and never expose raw email HTML.
- Stable public schemas take precedence over legacy workflow compatibility.

## Tech stack

- Tauri
- React
- TypeScript
- Vite
- embedded SQLite persistence through a Rust repository/application layer

## Design direction

- dark, compact, professional desktop tool
- clear ownership, deadline, status, and history at a glance
- plain language instead of developer-workflow jargon
- accessible controls and explicit destructive-action confirmation

## Working style

When changing the product:

1. inspect current relevant files and stored-data compatibility;
2. connect the change to the product goal and boundary;
3. implement the complete user-visible path;
4. update the stable machine-readable interface when relevant;
5. run TypeScript, Rust, MCP, and regression checks in proportion to the change;
6. report what remains against the full product goal.
