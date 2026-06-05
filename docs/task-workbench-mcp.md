# task-workbench MCP Bridge

task-workbench now uses a Primarch-style local MCP bridge architecture:

- task-workbench app starts a localhost bridge (`127.0.0.1:38473`)
- `mcp/task-workbench-mcp.mjs` talks to that bridge
- reads/writes go through task-workbench app logic (not direct file writes from MCP script)

The MCP script still supports explicit read-only debug fallback (`--fallback-readonly` with `--data-dir`) when the app is not running.

## Start

Run task-workbench app first, then use:

```bash
node mcp/task-workbench-mcp.mjs
```

Optional bridge URL override:

```bash
node mcp/task-workbench-mcp.mjs --bridge-url http://127.0.0.1:38473
```

Optional fallback debug mode (read-only only):

```bash
node mcp/task-workbench-mcp.mjs --fallback-readonly --data-dir "/path/to/task-workbench-data"
```

## Tools

Read-only tools:

- `list_tasks`
- `get_task`
- `get_task_summary`
- `get_crm_workflow_state`
- `get_current_crm_workflow_step`
- `get_technical_plan`
- `get_pr_review_state`
- `get_next_recommended_step`

Local write tools:

- `append_task_note(taskId, note)`
- `set_task_status(taskId, status)`
- `set_task_attention_state(taskId, attentionState)`
- `set_task_waiting_state(taskId, waitingState)`

## Safety rules

- Bridge binds to `127.0.0.1` only
- No Dataverse/GitHub/ADO write tools
- No plugin registration/web resource upload/customization publish tools
- No repo file write tools
- No raw secrets/env/config responses
- No raw email HTML in task responses
- Write tools validate task IDs and enum values
- Write tools sanitize text and update only intended fields
- Write attempts are logged in app console
