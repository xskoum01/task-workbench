# Task Workbench

## Product goal
Task Workbench is a local Tauri desktop app for a CRM/Dynamics/Dataverse developer.

Main goals:
- manage incoming tasks
- resolve customer repositories
- support planning and task prioritization
- later integrate official Microsoft sign-in + Outlook + Teams import
- create task drafts from imported Microsoft items

## Tech stack
- Tauri
- React
- TypeScript
- Vite
- local JSON persistence via Tauri commands

## Design direction
- dark
- compact
- professional internal desktop tool
- no flashy consumer-style UI
- no emoji
- prefer consistency with VS Code / internal admin tool feel

## Coding rules
- keep code practical and maintainable
- comments in English
- avoid overengineering
- prefer explicit readable code
- preserve current architecture unless there is a strong reason to refactor

## Current product direction
- repository workflow should prioritize detecting/linking existing repos
- template scaffolding is secondary
- Microsoft integration must be official only:
  - no hacks
  - no scraping
  - no fake auth
  - no manual email/password form
  - proper Microsoft sign-in and Graph only

## AI workflow: Claude Project vs. Task Workbench Copy Prompt
Stable CRM/Dynamics coding standards (JavaScript/plugin/ribbon conventions, Client API rules,
etc.) and Power Platform AI Kit context live in the **Claude Project Instructions**, not in
Task Workbench itself.

- **Claude Project Instructions**: coding style, naming conventions, Client API rules, AI Kit
  context. Stable across tasks — set up once, not regenerated per task.
- **Task Workbench "Copy AI Prompt" button** (`src/lib/aiWorkflowPrompt.ts`): generates a short,
  task-specific **workflow/task contract** — task identity, which MCP tool to call next, the
  canWriteCode gate, the post-implementation verification loop, and stop conditions. It
  deliberately does not repeat coding-standard text; it only points to the Claude Project
  Instructions and AI Kit rules for style.
- **AI Kit review** is one step inside the verification workflow (`continue_developer_workflow` /
  `run_implementation_verification` → `nextAction=run_ai_kit_review` — `run_implementation_verification`
  may also report `status=pending_ai_kit_review` — → Claude reviews the file against the AI Kit
  rules and calls `record_ai_kit_review_result`) — it is not pasted as a full rules document into
  every prompt.
- **The Task Workbench MCP tools must be connected in the Claude session** for any of this to
  work. The generated prompt distinguishes three failure modes: (1) the MCP toolset is not
  connected to the session at all (`get_developer_work_packet` doesn't exist — stop immediately
  and ask the user to connect/reload the MCP server, do not inspect files or implement anything);
  (2) the toolset is connected but the Task Workbench app/bridge is offline
  (`get_task_workbench_mcp_capabilities` reports `bridgeMode="offline"`); (3) the bridge is live
  but the running toolset is stale/missing a specific required tool (`missingRequiredTools` is
  non-empty). If MCP tools are missing entirely, the agent must stop and ask the user to
  connect/reload MCP — never fabricate a work packet or a tool call.

When editing `aiWorkflowPrompt.ts`, keep it a contract: task facts + MCP call sequence + gates.
Do not add generic coding-standard prose — that belongs in the Claude Project Instructions.

## Working style
When given a feature request:
1. inspect current relevant files
2. summarize current state
3. propose a short implementation plan
4. implement directly
5. run checks
6. explain what changed, which files changed, and what remains