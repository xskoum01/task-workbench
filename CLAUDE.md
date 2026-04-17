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

## Working style
When given a feature request:
1. inspect current relevant files
2. summarize current state
3. propose a short implementation plan
4. implement directly
5. run checks
6. explain what changed, which files changed, and what remains