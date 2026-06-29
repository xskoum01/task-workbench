# task-workbench MCP Bridge

task-workbench uses a Primarch-style local MCP bridge architecture:

- task-workbench app starts a localhost bridge (`127.0.0.1:38473`)
- `mcp/task-workbench-mcp.mjs` talks to that bridge
- reads/writes go through task-workbench app logic (not direct file writes from MCP script)

The MCP script also supports an explicit debug fallback (`--fallback-readonly` with
`--data-dir`) when the app is not running. Most fallback tools are read-only; the
`prepare_developer_task` fallback may update only local `tasks.json` setup state.

## Start

Run the task-workbench app first, then:

```bash
node mcp/task-workbench-mcp.mjs
```

Optional bridge URL override:

```bash
node mcp/task-workbench-mcp.mjs --bridge-url http://127.0.0.1:38473
```

Optional fallback debug mode (no Primarch):

```bash
node mcp/task-workbench-mcp.mjs --fallback-readonly --data-dir "/path/to/task-workbench-data"
```

## Tool groups

### Read-only

These tools never write to Dataverse, GitHub, Azure DevOps, or the local filesystem
(except `run_dataverse_check_for_task`, which persists a report to local task state).

| Tool | Purpose |
|------|---------|
| `list_tasks` | List sanitized tasks with optional status/mode filter |
| `get_task` | Get one sanitized task by ID (no raw email HTML) |
| `get_task_summary` | Compact task summary by ID |
| `get_task_full_context` | Phase, mode, setup, estimate, checklist, notes, PR state, next step |
| `get_task_workflow_overview` | Display phase, waiting state, checklist rows, recommended next step |
| `get_task_original_message` | Sanitized original email/Teams/DevOps message body |
| `get_task_developer_setup` | Mode, work kind, work action, repo root, plugin/script target |
| `get_crm_workflow_state` | Full sanitized CRM Developer Workflow state |
| `get_current_crm_workflow_step` | Current step + approval gate summary |
| `get_technical_plan` | Persisted local technical implementation plan |
| `get_pr_review_state` | PR proposal, tracking, review, analysis, fix proposal |
| `get_next_recommended_step` | Conservative next recommended workflow step |
| `prepare_commit_for_task` | Read-only Git diff preview: branch, files, commit message suggestion |
| `get_power_platform_ai_kit_status` | AI Kit configuration and required file presence check |
| `run_dataverse_check_for_task` | Trigger read-only Primarch metadata check; persists report locally |
| `get_dataverse_verification_report` | Return the stored Dataverse verification report (no new check) |
| `get_external_action_proposal` | Return externalActionPreview, approval gate, execution tracking |
| `get_implementation_verification_state` | Build check, Dataverse check override, AI code review, local test, consultant testing |
| `get_implementation_readiness` | isImplementationReady, blockers, warnings, recommendedNextStep for plugin/script tasks |
| `get_developer_work_packet` | AI-facing work packet: canWriteCode, why, target path, implementation instructions, conventions, verification, review/test/commit guidance |
| `continue_developer_workflow` | Next required post-implementation step: record results, Dataverse verification, AI Kit review, or branch creation. Call after every file write. |
| `get_task_templates` | Built-in setup templates and matched template for a task title |

AI clients should use `get_developer_work_packet` as the default first read for
developer work. It hides Task Workbench internal workflow state and returns a
single decision: whether code may be written and what to do next.

### Local-write

These tools update only local task-workbench state. No external system is called.

**Task lifecycle**

| Tool | Purpose |
|------|---------|
| `create_task` | Create a new task with full field validation |
| `append_task_note` | Append a note to task.notes |
| `update_task_summary` | Update compact summary and optional next-step text |
| `save_task_analysis` | Save AI analysis: summary, requirements, assumptions, questions, risks |
| `set_task_status` | Set status (enum validated). Prefer `set_task_phase` for workflow consistency |
| `set_task_attention_state` | Set or clear attentionState (enum validated) |
| `set_task_waiting_state` | Set or clear waitingState (enum validated) |
| `set_task_phase` | Set phase: new / analyzed / development / testing / review / done |
| `set_task_estimate` | Set effort estimate in hours |
| `set_task_next_step` | Set AI-recommended next action and reason |
| `update_task_checklist_item` | Set status of a workflow checklist item |

**Developer workflow setup**

| Tool | Purpose |
|------|---------|
| `set_task_mode` | Set mode: developer or general |
| `set_task_work_classification` | Set work kind (`plugin`, `script`, `ribbon`, `repo-only`, `bugfix`, `review`, `general`, `unknown`) and work action |
| `set_task_developer_target` | Set repo root, plugin project, script path, customer |
| `prepare_developer_task` | Apply safe template/default setup, derive target, draft a technical plan, and stop at approval gate/blocker |
| `confirm_task_setup` | Record setup confirmation; advance new → analyzed |

**CRM workflow**

| Tool | Purpose |
|------|---------|
| `save_technical_plan` | Save plan: summary, steps, entities, test plan, risks, pluginTarget, scriptTarget |
| `mark_technical_plan_ready_for_approval` | Mark plan ready for in-app user review |
| `record_external_action_completed` | Record that the developer manually completed an external action (plugin registration, web resource upload, etc.) |
| `record_local_test` | Record local test result |
| `record_consultant_testing` | Record consultant testing status |
| `mark_testing_confirmed_prepare_commit` | Mark consultant testing confirmed; set next step to prepare commit |

**PR workflow**

| Tool | Purpose |
|------|---------|
| `record_manual_pr` | Record a PR created manually outside task-workbench |
| `save_pr_review_analysis` | Save PR review analysis: summary, action items, warnings |
| `save_pr_fix_proposal` | Save PR fix proposal: summary and proposed changes |

### Git-write (3 tools)

These tools modify the local Git repository. No PR is created. No GitHub/Azure DevOps API is called.

| Tool | Safety constraints |
|------|-------------------|
| `prepare_commit_for_task` | Read-only preview — does not stage, commit, or push |
| `commit_task_changes` | Stages files and creates a commit. Rejects noise files. Does NOT push. |
| `push_task_branch` | Pushes current branch. Push to main/master blocked. No force push. |
| `commit_and_push_task_changes` | Commit + push in one step. Same guards. Optional phase advance. |

### Guarded / test-only (2 tools)

| Tool | Guard |
|------|-------|
| `create_test_task` | Creates a task flagged with `mcpTestTask=true` for smoke testing |
| `delete_test_task` | Deletes only tasks where `mcpTestTask=true`. Cannot delete real tasks. |

## Safety rules

- Bridge binds to `127.0.0.1` only (localhost, not network-accessible)
- No Dataverse write tools
- No GitHub / Azure DevOps write tools
- No plugin registration, web resource upload, or customization publish tools
- No repo file write tools (only Git stage/commit/push with strict guards)
- `prepare_developer_task` writes only local task setup/plan metadata; it never writes code, registers plugins, uploads web resources, or calls external systems
- No raw secrets, env vars, bridge tokens, or raw email HTML in tool responses
- Write tools validate task IDs and enum values before modifying state
- Write tools sanitize free-text fields (length limits, HTML stripping)
- `record_external_action_completed` records completion locally — it does not call any external system
- Git push to main/master is blocked; no force push
- `delete_test_task` is scoped to `mcpTestTask=true` tasks only

## Tool count summary (v0.6.0)

- Tool counts are published dynamically by `tools/list`.
- High-level setup should prefer `prepare_developer_task`; low-level setup tools remain available for manual or corrective updates.
