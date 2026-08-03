# Manual acceptance checklist

This checklist covers the few checks that require the real desktop runtime and
the user's actual data profile. Automated tests use temporary directories and
never touch this profile.

## 1. Before first launch

1. Close Task Workbench.
2. Locate its application-data directory. On Windows it is normally below
   `%APPDATA%\com.vskoumal.task-workbench`.
3. Copy that entire directory to a safe backup location.
4. Record the approximate counts visible in the old application, if available:
   active work, archived work, and Inbox items.

Do not delete or rename `tasks.json`; it is the migration source.

## 2. First launch and migration

1. Start Task Workbench normally.
2. Confirm that the application opens on Overview without a storage error.
3. Check that these files now exist in the application-data directory:
   - `task-workbench.sqlite3`
   - `tasks.pre-sqlite-backup.json`
   - `mcp-bridge-token`
4. Confirm the following UI counts:
   - Inbox contains only pending/analyzed/rejected intake records.
   - Work contains accepted work records.
   - Obligations contains responsibility, commitment, and follow-up records.
   - Archived records remain available from Work → Archive.
5. Open at least five representative records, including:
   - one with notes/history;
   - one with a deadline;
   - one archived record;
   - one responsibility or commitment;
   - one Outlook or Teams source record.
6. Verify title, description, owner, accountable party, deadline, notes, source
   context, history, and archive state.

If anything is missing, close the app and retain both the copied data directory
and `tasks.pre-sqlite-backup.json`. Do not use Reset.

## 3. Restart idempotence

1. Close and start Task Workbench again.
2. Confirm there are no duplicated records.
3. Confirm the same counts and sample records.
4. Confirm `tasks.pre-sqlite-backup.json` was not replaced by a new migration.

## 4. Basic mutations

Using a disposable test record:

1. Create a task with owner, accountable party, deadline, and description.
2. Edit its title and deadline.
3. Add a note and confirm it appears in Activity.
4. Mark it completed and confirm it appears in the Week Log.
5. Archive it, open Archive, and restore it.
6. Create a responsibility and confirm it appears in Obligations.
7. Import or choose one disposable Inbox item and promote it to Work.

Restart the app once more and confirm all changes remain.

## 5. MCP smoke check

1. Open Settings → CRM Metadata / MCP and confirm Bridge Active.
2. Reload the MCP integration in the chosen AI client.
3. Confirm its tool list contains exactly:
   - `list_work_items`
   - `get_work_item`
   - `get_task_record`
   - `list_work_item_changes`
   - `create_work_item`
   - `update_work_item`
   - `transition_work_item`
   - `append_work_item_note`
   - `get_planning_today`
4. Call `list_work_items` with a small limit.
5. Confirm the result contains `apiVersion: "1"` and does not expose Inbox-only
   records or developer/Git workflow tools.
6. Call `get_planning_today` and confirm that `sections.now` and
   `sections.today` contain only records explicitly assigned to those planning
   buckets; records without a planning bucket must not be inferred into them.
7. Call `get_task_record` for a representative work item and confirm the result
   contains `canonical`, `legacyTask`, and `derived` with notes, status label,
   workflow type, planning bucket, and external links.

## Completion

The migration is accepted when all sampled records and counts survive two
restarts, basic mutations remain durable, Inbox stays separate, and MCP exposes
only canonical work-item data tools.
