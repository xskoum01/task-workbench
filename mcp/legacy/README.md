# Legacy developer-workflow archive

This directory preserves the pre-2.0 MCP implementation for migration research
and recovery of historical records only. Files in this directory are deliberately
not executable package entry points and are not included in the supported MCP
contract.

The active `../task-workbench-mcp.mjs` server exposes task, obligation, context,
history, and change-feed data only. It cannot run Git, deployment, coding-agent,
or workflow-orchestration operations.
