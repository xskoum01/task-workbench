use crate::application::{ApplicationError, MutationContext, WorkItemRepository};
use crate::domain::work_item::{
    ActorType, ObligationMode, PartyReference, WorkItem, WorkItemContextEntry, WorkItemEvent,
    WorkItemKind, WorkItemPriority, WorkItemStatus, WORK_ITEM_SCHEMA_VERSION,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const DATABASE_FILE: &str = "task-workbench.sqlite3";
const JSON_IMPORT_MARKER: &str = "json_tasks_import_v1";

/// Metadata keys that `project_legacy_task` derives fresh from the incoming
/// legacy JSON on every save. Kept in sync with that function's metadata
/// block and with the `_canonicalWorkItem` merge in the same function.
const LEGACY_MANAGED_METADATA_KEYS: [&str; 8] = [
    "legacyObligationKind",
    "ticketUrl",
    "devopsTaskUrl",
    "planningBucket",
    "estimateMinutes",
    "budgetHours",
    "budgetNote",
    "legacyWaitingState",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub database_path: String,
    pub imported: usize,
    pub skipped: usize,
    pub source_checksum: Option<String>,
    pub already_completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRecord {
    pub sequence: i64,
    pub work_item_id: String,
    pub revision: i64,
    pub changed_at: String,
    pub action: String,
}

pub struct SqliteWorkItemRepository {
    path: PathBuf,
}

impl SqliteWorkItemRepository {
    pub fn in_app_data(app_data_dir: &Path) -> Self {
        Self {
            path: app_data_dir.join(DATABASE_FILE),
        }
    }

    #[cfg(test)]
    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }

    fn connect(&self) -> Result<Connection, ApplicationError> {
        let connection = Connection::open(&self.path)
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        // NOTE: intentionally NOT WAL. WAL readers rely on a memory-mapped
        // shared index file (`-shm`) to decide which frames are visible;
        // on this desktop (single-writer, low-throughput) workload that
        // extra IPC/mmap surface bought no real concurrency benefit and was
        // the prime suspect behind a reproduced-in-production incident
        // where SqliteWorkItemRepository::list() observed zero rows in a
        // long-lived process while get(id) and a brand-new connection to
        // the same file both saw the data correctly. The rollback journal
        // (default) uses plain file locking with no shared-memory reader
        // path, which removes that entire failure class.
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;")
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        Ok(connection)
    }

    pub fn initialize(&self) -> Result<(), ApplicationError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| ApplicationError::storage(error.to_string()))?;
        }
        let connection = self.connect()?;
        connection
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS app_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS work_items (
                    id TEXT PRIMARY KEY,
                    schema_version INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    priority TEXT NOT NULL,
                    owner_name TEXT,
                    accountable_to_name TEXT,
                    area_id TEXT,
                    due_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK(revision >= 1),
                    archived_at TEXT,
                    payload_json TEXT NOT NULL,
                    legacy_json TEXT
                );
                CREATE TABLE IF NOT EXISTS intake_items (
                    id TEXT PRIMARY KEY,
                    classification_state TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK(revision >= 1),
                    payload_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_intake_items_state
                    ON intake_items(classification_state, updated_at);
                CREATE INDEX IF NOT EXISTS idx_work_items_updated
                    ON work_items(updated_at, id);
                CREATE INDEX IF NOT EXISTS idx_work_items_status
                    ON work_items(status, archived_at);
                CREATE INDEX IF NOT EXISTS idx_work_items_kind
                    ON work_items(kind, archived_at);
                CREATE INDEX IF NOT EXISTS idx_work_items_due
                    ON work_items(due_at, archived_at);
                CREATE TABLE IF NOT EXISTS work_item_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
                    event_id TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    actor_type TEXT NOT NULL,
                    action TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    UNIQUE(work_item_id, event_id)
                );
                CREATE TABLE IF NOT EXISTS work_item_changes (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL,
                    changed_at TEXT NOT NULL,
                    action TEXT NOT NULL
                );
                "#,
            )
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        connection
            .execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, 'schema-v1')",
                [],
            )
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        Ok(())
    }

    pub fn migrate_json_tasks(
        &self,
        tasks_path: &Path,
    ) -> Result<MigrationReport, ApplicationError> {
        self.initialize()?;
        let mut connection = self.connect()?;
        if let Some(raw_report) = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = ?1",
                [JSON_IMPORT_MARKER],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| ApplicationError::storage(error.to_string()))?
        {
            repartition_legacy_intake(&mut connection)?;
            let mut report: MigrationReport = serde_json::from_str(&raw_report)
                .map_err(|error| ApplicationError::storage(error.to_string()))?;
            report.already_completed = true;
            return Ok(report);
        }

        if !tasks_path.exists() {
            let report = MigrationReport {
                database_path: self.path.display().to_string(),
                imported: 0,
                skipped: 0,
                source_checksum: None,
                already_completed: false,
            };
            store_migration_report(&connection, &report)?;
            return Ok(report);
        }

        let raw =
            fs::read(tasks_path).map_err(|error| ApplicationError::storage(error.to_string()))?;
        let checksum = format!("{:x}", Sha256::digest(&raw));
        let tasks: Vec<Value> = serde_json::from_slice(&raw).map_err(|error| {
            ApplicationError::validation(format!("Invalid tasks.json: {error}"))
        })?;

        let backup_path = tasks_path.with_file_name("tasks.pre-sqlite-backup.json");
        if !backup_path.exists() {
            fs::copy(tasks_path, &backup_path).map_err(|error| {
                ApplicationError::storage(format!("Create migration backup: {error}"))
            })?;
        }

        let transaction = connection
            .transaction()
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        let mut imported = 0;
        let mut skipped = 0;
        for legacy in tasks {
            let was_inserted = if is_intake_legacy(&legacy) {
                insert_intake_item(&transaction, &legacy)?
            } else {
                let item = project_legacy_task(&legacy)?;
                insert_work_item(&transaction, &item, Some(&legacy), "migrated")?
            };
            if was_inserted {
                imported += 1;
            } else {
                skipped += 1;
            }
        }
        let stored_count: usize = transaction
            .query_row(
                "SELECT (SELECT COUNT(*) FROM work_items) + (SELECT COUNT(*) FROM intake_items)",
                [],
                |row| row.get(0),
            )
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        if stored_count < imported {
            return Err(ApplicationError::storage(
                "SQLite validation failed: stored item count is lower than imported count.",
            ));
        }

        let report = MigrationReport {
            database_path: self.path.display().to_string(),
            imported,
            skipped,
            source_checksum: Some(checksum),
            already_completed: false,
        };
        let report_json = serde_json::to_string(&report)
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        transaction
            .execute(
                "INSERT INTO app_meta(key, value) VALUES (?1, ?2)",
                params![JSON_IMPORT_MARKER, report_json],
            )
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        transaction
            .commit()
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        Ok(report)
    }

    pub fn list(
        &self,
        include_archived: bool,
        limit: usize,
    ) -> Result<Vec<WorkItem>, ApplicationError> {
        self.initialize()?;
        let mut connection = self.connect()?;
        let clamped_limit = limit.clamp(1, 500) as i64;
        let (list_sql, count_sql) = if include_archived {
            (
                "SELECT id, payload_json FROM work_items ORDER BY updated_at DESC, id ASC LIMIT ?1",
                "SELECT COUNT(*) FROM work_items",
            )
        } else {
            (
                "SELECT id, payload_json FROM work_items WHERE archived_at IS NULL ORDER BY updated_at DESC, id ASC LIMIT ?1",
                "SELECT COUNT(*) FROM work_items WHERE archived_at IS NULL",
            )
        };

        // Both queries run inside one read transaction so they observe the
        // exact same snapshot — list() and get() must never disagree about
        // how many rows exist. If they do, surface a loud storage error
        // instead of quietly handing back a short or empty page (see the
        // note on connect() for the incident this guards against).
        let transaction = connection
            .transaction()
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        let true_count: i64 = transaction
            .query_row(count_sql, [], |row| row.get(0))
            .map_err(|error| ApplicationError::storage(error.to_string()))?;

        let mut statement = transaction
            .prepare(list_sql)
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        let rows = statement
            .query_map([clamped_limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| ApplicationError::storage(error.to_string()))?;

        let mut items = Vec::new();
        for row in rows {
            let (id, raw) = row.map_err(|error| ApplicationError::storage(error.to_string()))?;
            let item: WorkItem = serde_json::from_str(&raw).map_err(|error| {
                ApplicationError::storage(format!(
                    "work_items row {id} failed to deserialize as WorkItem: {error}"
                ))
            })?;
            items.push(item);
        }

        let expected = (true_count as usize).min(clamped_limit as usize);
        if items.len() < expected {
            return Err(ApplicationError::storage(format!(
                "SqliteWorkItemRepository::list integrity check failed: COUNT(*) reports {true_count} matching rows but the list query only returned {}.",
                items.len()
            )));
        }

        Ok(items)
    }

    pub fn list_legacy_compatible(&self) -> Result<Vec<Value>, ApplicationError> {
        self.initialize()?;
        let connection = self.connect()?;
        let mut statement = connection
            .prepare(
                "SELECT payload_json, legacy_json FROM work_items ORDER BY created_at ASC, id ASC",
            )
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        let mut records: Vec<Value> = rows
            .map(|row| {
                let (payload, legacy) =
                    row.map_err(|error| ApplicationError::storage(error.to_string()))?;
                let item: WorkItem = serde_json::from_str(&payload)
                    .map_err(|error| ApplicationError::storage(error.to_string()))?;
                let legacy_value = legacy
                    .map(|raw| serde_json::from_str::<Value>(&raw))
                    .transpose()
                    .map_err(|error| ApplicationError::storage(error.to_string()))?;
                Ok(legacy_compatible_value(&item, legacy_value))
            })
            .collect::<Result<Vec<_>, ApplicationError>>()?;
        let mut intake_statement = connection
            .prepare("SELECT payload_json FROM intake_items ORDER BY created_at ASC, id ASC")
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        let intake_rows = intake_statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        for row in intake_rows {
            let raw = row.map_err(|error| ApplicationError::storage(error.to_string()))?;
            records.push(
                serde_json::from_str(&raw)
                    .map_err(|error| ApplicationError::storage(error.to_string()))?,
            );
        }
        Ok(records)
    }

    /**
     * Transitional adapter for the existing React context. SQLite remains authoritative:
     * JSON-shaped records are projected and committed in one transaction, while stale
     * revisions fail instead of silently overwriting a newer integration write.
     */
    pub fn sync_legacy_snapshot(&self, tasks: &[Value]) -> Result<(), ApplicationError> {
        self.initialize()?;
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction()
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        for legacy in tasks {
            if is_intake_legacy(legacy) {
                insert_or_update_intake_item(&transaction, legacy)?;
                continue;
            }
            let item = project_legacy_task(legacy)?;
            transaction
                .execute("DELETE FROM intake_items WHERE id = ?1", [&item.id])
                .map_err(|error| ApplicationError::storage(error.to_string()))?;
            let current_revision: Option<i64> = transaction
                .query_row(
                    "SELECT revision FROM work_items WHERE id = ?1",
                    [&item.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| ApplicationError::storage(error.to_string()))?;
            match current_revision {
                None => {
                    insert_work_item(&transaction, &item, Some(legacy), "created")?;
                }
                Some(current) if item.revision < current => {
                    return Err(ApplicationError::revision_conflict(item.revision, current));
                }
                Some(current) => {
                    let payload = serde_json::to_string(&item)
                        .map_err(|error| ApplicationError::storage(error.to_string()))?;
                    let legacy_json = serde_json::to_string(legacy)
                        .map_err(|error| ApplicationError::storage(error.to_string()))?;
                    transaction
                        .execute(
                            r#"UPDATE work_items SET
                                schema_version = ?2, kind = ?3, status = ?4, priority = ?5,
                                owner_name = ?6, accountable_to_name = ?7, area_id = ?8,
                                due_at = ?9, created_at = ?10, updated_at = ?11, revision = ?12,
                                archived_at = ?13, payload_json = ?14, legacy_json = ?15
                               WHERE id = ?1"#,
                            params![
                                item.id,
                                item.schema_version,
                                enum_json(&item.kind)?,
                                enum_json(&item.status)?,
                                enum_json(&item.priority)?,
                                item.owner.as_ref().map(|party| party.display_name.as_str()),
                                item.accountable_to
                                    .as_ref()
                                    .map(|party| party.display_name.as_str()),
                                item.area_id,
                                item.due_at,
                                item.created_at,
                                item.updated_at,
                                item.revision,
                                item.archived_at,
                                payload,
                                legacy_json,
                            ],
                        )
                        .map_err(|error| ApplicationError::storage(error.to_string()))?;
                    for event in &item.history {
                        transaction
                            .execute(
                                "INSERT OR IGNORE INTO work_item_events(
                                    work_item_id, event_id, occurred_at, actor_type, action, payload_json
                                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                                params![
                                    item.id,
                                    event.id,
                                    event.at,
                                    enum_json(&event.actor_type)?,
                                    event.action,
                                    serde_json::to_string(event).map_err(|error| {
                                        ApplicationError::storage(error.to_string())
                                    })?,
                                ],
                            )
                            .map_err(|error| ApplicationError::storage(error.to_string()))?;
                    }
                    if item.revision > current {
                        transaction
                            .execute(
                                "INSERT INTO work_item_changes(
                                    work_item_id, revision, changed_at, action
                                 ) VALUES (?1, ?2, ?3, 'ui_updated')",
                                params![item.id, item.revision, item.updated_at],
                            )
                            .map_err(|error| ApplicationError::storage(error.to_string()))?;
                    }
                }
            }
        }
        transaction
            .commit()
            .map_err(|error| ApplicationError::storage(error.to_string()))
    }

    pub fn get_legacy_snapshot(&self, id: &str) -> Result<Option<Value>, ApplicationError> {
        self.initialize()?;
        let connection = self.connect()?;
        let raw = connection
            .query_row(
                "SELECT legacy_json FROM work_items WHERE id = ?1",
                [id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| ApplicationError::storage(error.to_string()))?
            .flatten();
        raw.map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| ApplicationError::storage(error.to_string()))
        })
        .transpose()
    }

    pub fn clear_all(&self) -> Result<(), ApplicationError> {
        self.initialize()?;
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction()
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        transaction
            .execute("DELETE FROM work_items", [])
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        transaction
            .execute("DELETE FROM intake_items", [])
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        transaction
            .commit()
            .map_err(|error| ApplicationError::storage(error.to_string()))
    }

    pub fn create_idempotent(
        &self,
        item: &WorkItem,
        idempotency_key: &str,
    ) -> Result<WorkItem, ApplicationError> {
        self.initialize()?;
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction()
            .map_err(|e| ApplicationError::storage(e.to_string()))?;
        let marker_key = format!("idempotency:{idempotency_key}");
        if let Some(existing_id) = transaction
            .query_row(
                "SELECT value FROM app_meta WHERE key = ?1",
                [&marker_key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| ApplicationError::storage(e.to_string()))?
        {
            let payload = transaction
                .query_row(
                    "SELECT payload_json FROM work_items WHERE id = ?1",
                    [&existing_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| ApplicationError::storage(e.to_string()))?;
            return payload
                .map(|raw| {
                    serde_json::from_str(&raw).map_err(|e| ApplicationError::storage(e.to_string()))
                })
                .transpose()?
                .ok_or_else(|| {
                    ApplicationError::storage("Idempotency marker points to a missing work item.")
                });
        }
        item.validate().map_err(ApplicationError::validation)?;
        if !insert_work_item(&transaction, item, None, "created")? {
            return Err(ApplicationError::validation(format!(
                "Work item {} already exists.",
                item.id
            )));
        }
        transaction
            .execute(
                "INSERT INTO app_meta(key,value) VALUES (?1,?2)",
                params![marker_key, item.id],
            )
            .map_err(|e| ApplicationError::storage(e.to_string()))?;
        transaction
            .commit()
            .map_err(|e| ApplicationError::storage(e.to_string()))?;
        let created = item.clone();
        Ok(created)
    }

    pub fn changes_after(
        &self,
        after: i64,
        limit: usize,
    ) -> Result<Vec<ChangeRecord>, ApplicationError> {
        self.initialize()?;
        let connection = self.connect()?;
        let mut statement = connection
            .prepare(
                "SELECT sequence, work_item_id, revision, changed_at, action
                 FROM work_item_changes WHERE sequence > ?1 ORDER BY sequence ASC LIMIT ?2",
            )
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        let rows = statement
            .query_map(params![after.max(0), limit.clamp(1, 500) as i64], |row| {
                Ok(ChangeRecord {
                    sequence: row.get(0)?,
                    work_item_id: row.get(1)?,
                    revision: row.get(2)?,
                    changed_at: row.get(3)?,
                    action: row.get(4)?,
                })
            })
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        rows.map(|row| row.map_err(|error| ApplicationError::storage(error.to_string())))
            .collect()
    }
}

impl WorkItemRepository for SqliteWorkItemRepository {
    fn list(
        &self,
        include_archived: bool,
        limit: usize,
    ) -> Result<Vec<WorkItem>, ApplicationError> {
        SqliteWorkItemRepository::list(self, include_archived, limit)
    }

    fn get(&self, id: &str) -> Result<Option<WorkItem>, ApplicationError> {
        self.initialize()?;
        let connection = self.connect()?;
        let raw = connection
            .query_row(
                "SELECT payload_json FROM work_items WHERE id = ?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        raw.map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| ApplicationError::storage(error.to_string()))
        })
        .transpose()
    }

    fn create(&self, item: &WorkItem) -> Result<WorkItem, ApplicationError> {
        item.validate().map_err(ApplicationError::validation)?;
        self.initialize()?;
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction()
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        if !insert_work_item(&transaction, item, None, "created")? {
            return Err(ApplicationError::validation(format!(
                "Work item {} already exists.",
                item.id
            )));
        }
        transaction
            .commit()
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        Ok(item.clone())
    }

    fn update(
        &self,
        id: &str,
        item: &WorkItem,
        mutation: &MutationContext,
    ) -> Result<WorkItem, ApplicationError> {
        item.validate().map_err(ApplicationError::validation)?;
        self.initialize()?;
        let mut connection = self.connect()?;
        let transaction = connection
            .transaction()
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        let current_record: Option<(i64, Option<String>)> = transaction
            .query_row(
                "SELECT revision, legacy_json FROM work_items WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        let (current_revision, current_legacy_json) =
            current_record.ok_or_else(|| ApplicationError::not_found(id))?;
        if current_revision != mutation.expected_revision {
            return Err(ApplicationError::revision_conflict(
                mutation.expected_revision,
                current_revision,
            ));
        }

        let mut updated = item.clone();
        updated.id = id.to_string();
        updated.revision = current_revision + 1;
        let payload = serde_json::to_string(&updated)
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        let legacy_snapshot = current_legacy_json
            .map(|raw| {
                serde_json::from_str::<Value>(&raw)
                    .map_err(|error| ApplicationError::storage(error.to_string()))
            })
            .transpose()?;
        let legacy_payload =
            serde_json::to_string(&legacy_compatible_value(&updated, legacy_snapshot))
                .map_err(|error| ApplicationError::storage(error.to_string()))?;
        transaction
            .execute(
                r#"UPDATE work_items SET
                    schema_version = ?2, kind = ?3, status = ?4, priority = ?5,
                    owner_name = ?6, accountable_to_name = ?7, area_id = ?8,
                    due_at = ?9, updated_at = ?10, revision = ?11,
                    archived_at = ?12, payload_json = ?13, legacy_json = ?14
                   WHERE id = ?1"#,
                params![
                    id,
                    updated.schema_version,
                    enum_json(&updated.kind)?,
                    enum_json(&updated.status)?,
                    enum_json(&updated.priority)?,
                    updated
                        .owner
                        .as_ref()
                        .map(|party| party.display_name.as_str()),
                    updated
                        .accountable_to
                        .as_ref()
                        .map(|party| party.display_name.as_str()),
                    updated.area_id,
                    updated.due_at,
                    updated.updated_at,
                    updated.revision,
                    updated.archived_at,
                    payload,
                    legacy_payload,
                ],
            )
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        for event in &updated.history {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO work_item_events(
                        work_item_id, event_id, occurred_at, actor_type, action, payload_json
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        id,
                        event.id,
                        event.at,
                        enum_json(&event.actor_type)?,
                        event.action,
                        serde_json::to_string(event)
                            .map_err(|error| ApplicationError::storage(error.to_string()))?,
                    ],
                )
                .map_err(|error| ApplicationError::storage(error.to_string()))?;
        }
        let actor = mutation
            .actor_name
            .clone()
            .unwrap_or(enum_json(&mutation.actor_type)?);
        transaction
            .execute(
                "INSERT INTO work_item_changes(work_item_id, revision, changed_at, action)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    id,
                    updated.revision,
                    updated.updated_at,
                    format!("updated:{actor}")
                ],
            )
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        transaction
            .commit()
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        Ok(updated)
    }
}

fn store_migration_report(
    connection: &Connection,
    report: &MigrationReport,
) -> Result<(), ApplicationError> {
    let report_json = serde_json::to_string(report)
        .map_err(|error| ApplicationError::storage(error.to_string()))?;
    connection
        .execute(
            "INSERT INTO app_meta(key, value) VALUES (?1, ?2)",
            params![JSON_IMPORT_MARKER, report_json],
        )
        .map_err(|error| ApplicationError::storage(error.to_string()))?;
    Ok(())
}

fn is_intake_legacy(value: &Value) -> bool {
    matches!(
        value.get("classificationState").and_then(Value::as_str),
        Some("pending" | "analyzed" | "rejected")
    )
}

fn repartition_legacy_intake(connection: &mut Connection) -> Result<(), ApplicationError> {
    let candidates: Vec<Value> = {
        let mut statement = connection
            .prepare("SELECT legacy_json FROM work_items WHERE legacy_json IS NOT NULL")
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
        rows.filter_map(|row| row.ok())
            .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
            .filter(is_intake_legacy)
            .collect()
    };
    if candidates.is_empty() {
        return Ok(());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| ApplicationError::storage(error.to_string()))?;
    for candidate in candidates {
        insert_or_update_intake_item(&transaction, &candidate)?;
    }
    transaction
        .commit()
        .map_err(|error| ApplicationError::storage(error.to_string()))
}

fn intake_fields(
    legacy: &Value,
) -> Result<(String, String, String, String, i64, String), ApplicationError> {
    let object = legacy
        .as_object()
        .ok_or_else(|| ApplicationError::validation("Every intake item must be an object."))?;
    let id = non_empty(object.get("id"))
        .ok_or_else(|| ApplicationError::validation("Intake item is missing id."))?;
    let state = non_empty(object.get("classificationState")).ok_or_else(|| {
        ApplicationError::validation(format!("Intake item {id} is missing state."))
    })?;
    let created_at = non_empty(object.get("createdAt"))
        .or_else(|| non_empty(object.get("receivedAt")))
        .ok_or_else(|| {
            ApplicationError::validation(format!("Intake item {id} is missing receivedAt."))
        })?;
    let updated_at = non_empty(object.get("updatedAt")).unwrap_or_else(|| created_at.clone());
    let revision = object
        .get("revision")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .max(1);
    let payload = serde_json::to_string(legacy)
        .map_err(|error| ApplicationError::storage(error.to_string()))?;
    Ok((id, state, created_at, updated_at, revision, payload))
}

fn insert_intake_item(
    transaction: &Transaction<'_>,
    legacy: &Value,
) -> Result<bool, ApplicationError> {
    let (id, state, created_at, updated_at, revision, payload) = intake_fields(legacy)?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO intake_items(
                id, classification_state, created_at, updated_at, revision, payload_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, state, created_at, updated_at, revision, payload],
        )
        .map(|count| count > 0)
        .map_err(|error| ApplicationError::storage(error.to_string()))
}

fn insert_or_update_intake_item(
    transaction: &Transaction<'_>,
    legacy: &Value,
) -> Result<(), ApplicationError> {
    let (id, state, created_at, updated_at, revision, payload) = intake_fields(legacy)?;
    let current_revision: Option<i64> = transaction
        .query_row(
            "SELECT revision FROM intake_items WHERE id = ?1",
            [&id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| ApplicationError::storage(error.to_string()))?;
    if let Some(current) = current_revision {
        if revision < current {
            return Err(ApplicationError::revision_conflict(revision, current));
        }
        transaction
            .execute(
                "UPDATE intake_items SET classification_state = ?2, created_at = ?3,
                    updated_at = ?4, revision = ?5, payload_json = ?6 WHERE id = ?1",
                params![id, state, created_at, updated_at, revision, payload],
            )
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
    } else {
        transaction
            .execute(
                "INSERT INTO intake_items(
                    id, classification_state, created_at, updated_at, revision, payload_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, state, created_at, updated_at, revision, payload],
            )
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
    }
    transaction
        .execute("DELETE FROM work_items WHERE id = ?1", [&id])
        .map_err(|error| ApplicationError::storage(error.to_string()))?;
    Ok(())
}

fn insert_work_item(
    transaction: &Transaction<'_>,
    item: &WorkItem,
    legacy: Option<&Value>,
    action: &str,
) -> Result<bool, ApplicationError> {
    item.validate().map_err(ApplicationError::validation)?;
    let payload = serde_json::to_string(item)
        .map_err(|error| ApplicationError::storage(error.to_string()))?;
    let legacy_json = legacy
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| ApplicationError::storage(error.to_string()))?;
    let inserted = transaction
        .execute(
            r#"INSERT OR IGNORE INTO work_items(
                id, schema_version, kind, status, priority, owner_name,
                accountable_to_name, area_id, due_at, created_at, updated_at,
                revision, archived_at, payload_json, legacy_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"#,
            params![
                item.id,
                item.schema_version,
                enum_json(&item.kind)?,
                enum_json(&item.status)?,
                enum_json(&item.priority)?,
                item.owner.as_ref().map(|party| party.display_name.as_str()),
                item.accountable_to
                    .as_ref()
                    .map(|party| party.display_name.as_str()),
                item.area_id,
                item.due_at,
                item.created_at,
                item.updated_at,
                item.revision,
                item.archived_at,
                payload,
                legacy_json,
            ],
        )
        .map_err(|error| ApplicationError::storage(error.to_string()))?
        > 0;
    if inserted {
        for event in &item.history {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO work_item_events(
                        work_item_id, event_id, occurred_at, actor_type, action, payload_json
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        item.id,
                        event.id,
                        event.at,
                        enum_json(&event.actor_type)?,
                        event.action,
                        serde_json::to_string(event)
                            .map_err(|error| ApplicationError::storage(error.to_string()))?,
                    ],
                )
                .map_err(|error| ApplicationError::storage(error.to_string()))?;
        }
        transaction
            .execute(
                "INSERT INTO work_item_changes(work_item_id, revision, changed_at, action)
                 VALUES (?1, ?2, ?3, ?4)",
                params![item.id, item.revision, item.updated_at, action],
            )
            .map_err(|error| ApplicationError::storage(error.to_string()))?;
    }
    Ok(inserted)
}

fn enum_json<T: Serialize>(value: &T) -> Result<String, ApplicationError> {
    let json = serde_json::to_string(value)
        .map_err(|error| ApplicationError::storage(error.to_string()))?;
    Ok(json.trim_matches('"').to_string())
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

/// `WorkItemStatus::Waiting` collapses every legacy waiting sub-state (code
/// review, pricing/estimate approval, consultant testing, ...) into one
/// canonical enum value. The specific sub-state the legacy UI needs is kept
/// separately in `metadata["legacyWaitingState"]` (see `project_legacy_task`);
/// without reading it back here, every waiting task would render as
/// "code-review" after any SQLite round-trip, regardless of which sub-state
/// it actually was.
fn legacy_status(item: &WorkItem) -> (&'static str, Option<String>) {
    match item.status {
        WorkItemStatus::Planned => ("new", None),
        WorkItemStatus::Ready => ("analyzed", None),
        WorkItemStatus::InProgress => ("in-progress", None),
        WorkItemStatus::Waiting => (
            "in-progress",
            Some(
                item.metadata
                    .get("legacyWaitingState")
                    .and_then(Value::as_str)
                    .unwrap_or("code-review")
                    .to_string(),
            ),
        ),
        WorkItemStatus::Blocked => ("blocked", None),
        WorkItemStatus::Review => ("ready-for-review", None),
        WorkItemStatus::Completed | WorkItemStatus::Cancelled => ("done", None),
    }
}

pub(crate) fn legacy_compatible_value(item: &WorkItem, legacy: Option<Value>) -> Value {
    let mut object = legacy
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_else(Map::new);
    let (status, waiting_state) = legacy_status(item);
    object.insert("id".to_string(), Value::String(item.id.clone()));
    object.insert("title".to_string(), Value::String(item.title.clone()));
    object.insert("status".to_string(), Value::String(status.to_string()));
    object.insert("source".to_string(), Value::String(item.source.clone()));
    object.insert("revision".to_string(), Value::from(item.revision));
    object.insert(
        "createdAt".to_string(),
        Value::String(item.created_at.clone()),
    );
    object.insert(
        "updatedAt".to_string(),
        Value::String(item.updated_at.clone()),
    );
    object.insert(
        "receivedAt".to_string(),
        object
            .get("receivedAt")
            .cloned()
            .unwrap_or_else(|| Value::String(item.created_at.clone())),
    );
    object.insert(
        "customerId".to_string(),
        Value::String(item.area_id.clone().unwrap_or_default()),
    );
    object.insert(
        "taskType".to_string(),
        object
            .get("taskType")
            .cloned()
            .unwrap_or_else(|| Value::String("other".to_string())),
    );
    object.insert(
        "confidence".to_string(),
        object
            .get("confidence")
            .cloned()
            .unwrap_or_else(|| Value::from(100)),
    );
    object.insert(
        "originalMessage".to_string(),
        object
            .get("originalMessage")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    object.insert(
        "suggestedActions".to_string(),
        object
            .get("suggestedActions")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![])),
    );
    object.insert(
        "obligationKind".to_string(),
        item.metadata
            .get("legacyObligationKind")
            .cloned()
            .unwrap_or_else(|| {
                Value::String(
                    if item.kind == WorkItemKind::Obligation {
                        "responsibility"
                    } else {
                        "task"
                    }
                    .to_string(),
                )
            }),
    );
    for (key, value) in [
        ("description", item.description.clone()),
        (
            "responsibleParty",
            item.owner.as_ref().map(|party| party.display_name.clone()),
        ),
        (
            "accountableTo",
            item.accountable_to
                .as_ref()
                .map(|party| party.display_name.clone()),
        ),
        ("dueAt", item.due_at.clone()),
        ("completedAt", item.completed_at.clone()),
        ("archivedAt", item.archived_at.clone()),
        ("sourceUrl", item.source_url.clone()),
    ] {
        if let Some(value) = value {
            object.insert(key.to_string(), Value::String(value));
        } else {
            object.remove(key);
        }
    }
    // Keep provider-specific links in the canonical metadata as well as in
    // the compatibility-shaped JSON projection. This prevents the SQLite
    // migration from silently dropping DevOps/ticket links that the old UI
    // stored outside the provider-neutral WorkItem fields.
    for (key, value) in [
        ("ticketUrl", item.metadata.get("ticketUrl")),
        ("devopsTaskUrl", item.metadata.get("devopsTaskUrl")),
        ("budgetHours", item.metadata.get("budgetHours")),
        ("budgetNote", item.metadata.get("budgetNote")),
    ] {
        match value {
            Some(value)
                if value
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty())
                    || value.is_number() =>
            {
                object.insert(key.to_string(), value.clone());
            }
            _ => {
                object.remove(key);
            }
        }
    }
    if let Some(waiting_state) = waiting_state {
        object.insert("waitingState".to_string(), Value::String(waiting_state));
    } else {
        object.insert("waitingState".to_string(), Value::Null);
    }
    object.insert(
        "history".to_string(),
        serde_json::to_value(&item.history).unwrap_or_else(|_| Value::Array(vec![])),
    );
    object.insert(
        "_canonicalWorkItem".to_string(),
        serde_json::to_value(item).unwrap_or(Value::Null),
    );
    Value::Object(object)
}

fn project_legacy_task(legacy: &Value) -> Result<WorkItem, ApplicationError> {
    let object = legacy
        .as_object()
        .ok_or_else(|| ApplicationError::validation("Every legacy task must be an object."))?;
    let id = non_empty(object.get("id"))
        .ok_or_else(|| ApplicationError::validation("Legacy task is missing id."))?;
    let title = non_empty(object.get("title"))
        .ok_or_else(|| ApplicationError::validation(format!("Task {id} is missing title.")))?;
    let received_at = non_empty(object.get("receivedAt"))
        .or_else(|| non_empty(object.get("createdAt")))
        .ok_or_else(|| ApplicationError::validation(format!("Task {id} is missing receivedAt.")))?;
    let created_at = non_empty(object.get("createdAt")).unwrap_or_else(|| received_at.clone());
    let updated_at = non_empty(object.get("updatedAt")).unwrap_or_else(|| created_at.clone());
    let obligation_kind =
        non_empty(object.get("obligationKind")).unwrap_or_else(|| "task".to_string());
    let kind = if obligation_kind == "task" {
        WorkItemKind::Task
    } else {
        WorkItemKind::Obligation
    };
    let status = if object
        .get("waitingState")
        .is_some_and(|value| !value.is_null())
    {
        WorkItemStatus::Waiting
    } else if non_empty(object.get("attentionState")).as_deref() == Some("pr-comments") {
        WorkItemStatus::Review
    } else {
        match non_empty(object.get("status")).as_deref() {
            Some("analyzed") => WorkItemStatus::Ready,
            Some("in-progress") => WorkItemStatus::InProgress,
            Some("ready-for-review") => WorkItemStatus::Review,
            Some("done") => WorkItemStatus::Completed,
            Some("blocked") => WorkItemStatus::Blocked,
            _ => WorkItemStatus::Planned,
        }
    };
    let score = object
        .get("priorityScore")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let priority = match score {
        85.. => WorkItemPriority::Critical,
        65..=84 => WorkItemPriority::High,
        1..=29 => WorkItemPriority::Low,
        _ => WorkItemPriority::Normal,
    };
    let mut context = Vec::new();
    if let Some(notes) = non_empty(object.get("notes")) {
        context.push(WorkItemContextEntry {
            id: format!("legacy-note-{id}"),
            entry_type: "note".to_string(),
            text: Some(notes),
            url: None,
            created_at: updated_at.clone(),
            actor_type: ActorType::User,
            actor_name: None,
        });
    }
    if let Some(message) = non_empty(object.get("originalMessage")) {
        context.push(WorkItemContextEntry {
            id: format!("legacy-source-{id}"),
            entry_type: "source".to_string(),
            text: Some(message),
            url: non_empty(object.get("sourceUrl")),
            created_at: received_at,
            actor_type: ActorType::Integration,
            actor_name: None,
        });
    }
    let history = object
        .get("history")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| serde_json::from_value::<WorkItemEvent>(entry.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    let mut metadata = HashMap::new();
    metadata.insert(
        "legacyObligationKind".to_string(),
        Value::String(obligation_kind.clone()),
    );
    for key in ["ticketUrl", "devopsTaskUrl"] {
        if let Some(value) = non_empty(object.get(key)) {
            metadata.insert(key.to_string(), Value::String(value));
        }
    }
    if let Some(value) = non_empty(object.get("planningBucket")) {
        metadata.insert("planningBucket".to_string(), Value::String(value));
    }
    if let Some(hours) = object.get("estimatedEffort").and_then(Value::as_f64) {
        metadata.insert(
            "estimateMinutes".to_string(),
            Value::from((hours * 60.0).round() as i64),
        );
    }
    if let Some(hours) = object.get("budgetHours").and_then(Value::as_f64) {
        metadata.insert("budgetHours".to_string(), Value::from(hours));
    }
    if let Some(note) = non_empty(object.get("budgetNote")) {
        metadata.insert("budgetNote".to_string(), Value::String(note));
    }
    if let Some(state) = non_empty(object.get("waitingState")) {
        metadata.insert("legacyWaitingState".to_string(), Value::String(state));
    }

    let projected = WorkItem {
        schema_version: WORK_ITEM_SCHEMA_VERSION,
        id,
        kind,
        obligation_mode: match obligation_kind.as_str() {
            "responsibility" => Some(ObligationMode::Ongoing),
            "commitment" | "follow-up" => Some(ObligationMode::OneOff),
            _ => None,
        },
        title,
        description: non_empty(object.get("description")),
        expected_outcome: non_empty(object.get("expectedOutcome"))
            .or_else(|| non_empty(object.get("description"))),
        status,
        priority,
        owner: non_empty(object.get("responsibleParty")).map(|display_name| PartyReference {
            id: None,
            display_name,
        }),
        accountable_to: non_empty(object.get("accountableTo")).map(|display_name| PartyReference {
            id: None,
            display_name,
        }),
        area_id: non_empty(object.get("customerId")),
        parent_id: None,
        start_at: None,
        due_at: non_empty(object.get("dueAt")),
        completed_at: non_empty(object.get("completedAt")),
        next_review_at: None,
        blocker_reason: None,
        source: non_empty(object.get("source")).unwrap_or_else(|| "other".to_string()),
        source_url: non_empty(object.get("sourceUrl")),
        planning_bucket: non_empty(object.get("planningBucket")),
        estimate_minutes: object
            .get("estimatedEffort")
            .and_then(Value::as_f64)
            .map(|hours| (hours * 60.0).round() as i64),
        external_references: Vec::new(),
        tags: vec![],
        context,
        created_at,
        updated_at,
        revision: object
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .max(1),
        archived_at: non_empty(object.get("archivedAt")),
        history,
        metadata,
    };
    let item = object
        .get("_canonicalWorkItem")
        .and_then(|value| serde_json::from_value::<WorkItem>(value.clone()).ok())
        .map(|base| {
            let mut preserved_context: Vec<WorkItemContextEntry> = base
                .context
                .into_iter()
                .filter(|entry| {
                    entry.id != format!("legacy-note-{}", projected.id)
                        && entry.id != format!("legacy-source-{}", projected.id)
                })
                .collect();
            preserved_context.extend(projected.context.clone());
            // Start from the previously stored canonical metadata — this is what
            // keeps canonical-only keys set outside the legacy UI (e.g. via
            // patch_work_item) alive across a legacy-path save. Then sync just the
            // keys this save derives from the legacy JSON to whatever `projected`
            // says now (present -> overwrite, absent -> remove), instead of
            // blanket-copying `base.metadata` over `projected.metadata`: doing
            // that reverted every edit to these fields (budget, waiting sub-state,
            // ticket/DevOps links, planning bucket, estimate) back to its
            // pre-edit value on every save after the first, because `base` here
            // is only ever the snapshot from the *last load*, not this edit.
            let mut preserved_metadata = base.metadata;
            for key in LEGACY_MANAGED_METADATA_KEYS {
                match projected.metadata.get(key) {
                    Some(value) => {
                        preserved_metadata.insert(key.to_string(), value.clone());
                    }
                    None => {
                        preserved_metadata.remove(key);
                    }
                }
            }
            WorkItem {
                expected_outcome: base.expected_outcome,
                parent_id: base.parent_id,
                start_at: base.start_at,
                next_review_at: base.next_review_at,
                blocker_reason: base.blocker_reason,
                tags: base.tags,
                context: preserved_context,
                metadata: preserved_metadata,
                // Fresh value from *this* save wins, same reasoning as metadata
                // above: `base.planning_bucket`/`base.estimate_minutes` is only
                // ever the snapshot from the last load, so preferring it here
                // silently reverted a bucket move or an estimate edit on every
                // save after the first. Falls back to `base` only when this
                // save's legacy JSON has no opinion at all (e.g. set solely via
                // patch_work_item, with no legacy-UI field to carry it).
                planning_bucket: projected.planning_bucket.clone().or(base.planning_bucket),
                estimate_minutes: projected.estimate_minutes.or(base.estimate_minutes),
                external_references: if base.external_references.is_empty() {
                    projected.external_references.clone()
                } else {
                    base.external_references
                },
                ..projected.clone()
            }
        })
        .unwrap_or(projected);
    item.validate().map_err(ApplicationError::validation)?;
    Ok(item)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn legacy_task(id: &str) -> Value {
        serde_json::json!({
            "id": id,
            "title": "Confirm renewal",
            "description": "Confirm the renewal date.",
            "source": "manual",
            "customerId": "customer-1",
            "taskType": "other",
            "obligationKind": "responsibility",
            "responsibleParty": "Viktor",
            "status": "in-progress",
            "originalMessage": "Original request",
            "ticketUrl": "https://support.example.test/tickets/42",
            "devopsTaskUrl": "https://dev.azure.com/example/project/_workitems/edit/123",
            "notes": "Important context",
            "receivedAt": "2026-07-01T08:00:00Z",
            "updatedAt": "2026-07-29T08:00:00Z",
            "revision": 4,
            "history": []
        })
    }

    #[test]
    fn migrates_json_once_and_keeps_a_recovery_copy() {
        let directory = tempdir().unwrap();
        let tasks_path = directory.path().join("tasks.json");
        fs::write(
            &tasks_path,
            serde_json::to_vec(&vec![legacy_task("task-1")]).unwrap(),
        )
        .unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));

        let first = repository.migrate_json_tasks(&tasks_path).unwrap();
        let second = repository.migrate_json_tasks(&tasks_path).unwrap();
        assert_eq!(first.imported, 1);
        assert!(!first.already_completed);
        assert!(second.already_completed);
        assert!(directory
            .path()
            .join("tasks.pre-sqlite-backup.json")
            .exists());

        let item = repository.get("task-1").unwrap().unwrap();
        assert_eq!(item.kind, WorkItemKind::Obligation);
        assert_eq!(item.obligation_mode, Some(ObligationMode::Ongoing));
        assert_eq!(item.context.len(), 2);
        assert_eq!(
            item.metadata.get("ticketUrl").and_then(Value::as_str),
            Some("https://support.example.test/tickets/42")
        );
        assert_eq!(
            item.metadata.get("devopsTaskUrl").and_then(Value::as_str),
            Some("https://dev.azure.com/example/project/_workitems/edit/123")
        );
        assert_eq!(repository.changes_after(0, 20).unwrap().len(), 1);
    }

    #[test]
    fn idempotency_key_returns_the_original_create_without_a_duplicate() {
        let directory = tempdir().unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));
        let item = project_legacy_task(&legacy_task("task-idempotent")).unwrap();
        let first = repository.create_idempotent(&item, "external-42").unwrap();
        let second = repository.create_idempotent(&item, "external-42").unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(repository.list(false, 50).unwrap().len(), 1);
    }

    #[test]
    fn rejects_stale_revisions_transactionally() {
        let directory = tempdir().unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));
        let item = project_legacy_task(&legacy_task("task-1")).unwrap();
        repository.create(&item).unwrap();

        let context = MutationContext {
            expected_revision: 3,
            actor_type: ActorType::User,
            actor_name: None,
        };
        let error = repository.update("task-1", &item, &context).unwrap_err();
        assert_eq!(error.code, "revision_conflict");
        assert_eq!(error.current_revision, Some(4));
    }

    #[test]
    fn legacy_ui_round_trip_preserves_canonical_only_context() {
        let directory = tempdir().unwrap();
        let tasks_path = directory.path().join("tasks.json");
        fs::write(
            &tasks_path,
            serde_json::to_vec(&vec![legacy_task("task-1")]).unwrap(),
        )
        .unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));
        repository.migrate_json_tasks(&tasks_path).unwrap();

        let mut canonical = repository.get("task-1").unwrap().unwrap();
        canonical.tags = vec!["renewal".to_string()];
        canonical.context.push(WorkItemContextEntry {
            id: "decision-1".to_string(),
            entry_type: "decision".to_string(),
            text: Some("Renew for one year.".to_string()),
            url: None,
            created_at: canonical.updated_at.clone(),
            actor_type: ActorType::User,
            actor_name: None,
        });
        canonical.updated_at = "2026-07-29T09:00:00Z".to_string();
        canonical = repository
            .update(
                "task-1",
                &canonical,
                &MutationContext {
                    expected_revision: 4,
                    actor_type: ActorType::User,
                    actor_name: None,
                },
            )
            .unwrap();

        let mut ui_records = repository.list_legacy_compatible().unwrap();
        ui_records[0]["title"] = Value::String("Renew support agreement".to_string());
        ui_records[0]["revision"] = Value::from(canonical.revision + 1);
        ui_records[0]["updatedAt"] = Value::String("2026-07-29T10:00:00Z".to_string());
        repository.sync_legacy_snapshot(&ui_records).unwrap();

        let round_trip = repository.get("task-1").unwrap().unwrap();
        assert_eq!(round_trip.title, "Renew support agreement");
        assert_eq!(round_trip.tags, vec!["renewal"]);
        assert!(round_trip
            .context
            .iter()
            .any(|entry| entry.id == "decision-1"));
    }

    // Regression coverage for a reported bug: budget entered through the
    // legacy UI (TaskForm) survived only in memory for the running session —
    // it was silently dropped on the very first save because
    // `project_legacy_task` never extracted budgetHours/budgetNote into
    // canonical metadata, so a reload (e.g. app restart) showed it as gone.
    #[test]
    fn budget_set_through_the_legacy_form_survives_a_reload_and_a_later_unrelated_save() {
        let directory = tempdir().unwrap();
        let tasks_path = directory.path().join("tasks.json");
        fs::write(
            &tasks_path,
            serde_json::to_vec(&vec![legacy_task("task-1")]).unwrap(),
        )
        .unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));
        repository.migrate_json_tasks(&tasks_path).unwrap();

        // Simulates the user filling in budget fields in TaskForm and saving.
        let mut ui_records = repository.list_legacy_compatible().unwrap();
        ui_records[0]["budgetHours"] = Value::from(6.5);
        ui_records[0]["budgetNote"] = Value::String("Fixed-price scope.".to_string());
        ui_records[0]["revision"] = Value::from(5);
        ui_records[0]["updatedAt"] = Value::String("2026-07-29T10:00:00Z".to_string());
        repository.sync_legacy_snapshot(&ui_records).unwrap();

        // Simulates an app restart: fresh read from SQLite.
        let after_restart = repository.list_legacy_compatible().unwrap();
        assert_eq!(after_restart[0]["budgetHours"], Value::from(6.5));
        assert_eq!(after_restart[0]["budgetNote"], "Fixed-price scope.");

        // Simulates a later, unrelated save (e.g. editing notes) made from
        // that reloaded state — must not wipe the previously saved budget.
        let mut second_edit = after_restart;
        second_edit[0]["notes"] = Value::String("Some follow-up note.".to_string());
        second_edit[0]["revision"] = Value::from(6);
        second_edit[0]["updatedAt"] = Value::String("2026-07-29T11:00:00Z".to_string());
        repository.sync_legacy_snapshot(&second_edit).unwrap();

        let final_state = repository.list_legacy_compatible().unwrap();
        assert_eq!(final_state[0]["budgetHours"], Value::from(6.5));
        assert_eq!(final_state[0]["budgetNote"], "Fixed-price scope.");
    }

    // Regression coverage for a reported bug: setting a task to a waiting
    // sub-state other than code review (e.g. "waiting for pricing
    // confirmation") flipped to "waiting for code review" after an app
    // restart, because the canonical WorkItemStatus enum only has one
    // `Waiting` value and the reverse mapping hard-coded "code-review".
    #[test]
    fn waiting_sub_state_other_than_code_review_survives_a_reload() {
        let directory = tempdir().unwrap();
        let tasks_path = directory.path().join("tasks.json");
        fs::write(
            &tasks_path,
            serde_json::to_vec(&vec![legacy_task("task-1")]).unwrap(),
        )
        .unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));
        repository.migrate_json_tasks(&tasks_path).unwrap();

        let mut ui_records = repository.list_legacy_compatible().unwrap();
        ui_records[0]["waitingState"] = Value::String("pricing-approval".to_string());
        ui_records[0]["revision"] = Value::from(5);
        ui_records[0]["updatedAt"] = Value::String("2026-07-29T10:00:00Z".to_string());
        repository.sync_legacy_snapshot(&ui_records).unwrap();

        let after_restart = repository.list_legacy_compatible().unwrap();
        assert_eq!(after_restart[0]["waitingState"], "pricing-approval");

        // Clearing the wait must clear the stored sub-state too, so it can't
        // resurface if the task later waits on something else.
        let mut cleared = after_restart;
        cleared[0]["waitingState"] = Value::Null;
        cleared[0]["status"] = Value::String("in-progress".to_string());
        cleared[0]["revision"] = Value::from(6);
        cleared[0]["updatedAt"] = Value::String("2026-07-29T11:00:00Z".to_string());
        repository.sync_legacy_snapshot(&cleared).unwrap();
        let canonical = repository.get("task-1").unwrap().unwrap();
        assert!(!canonical.metadata.contains_key("legacyWaitingState"));

        let mut waiting_again = repository.list_legacy_compatible().unwrap();
        waiting_again[0]["waitingState"] = Value::String("consultant-testing".to_string());
        waiting_again[0]["revision"] = Value::from(7);
        waiting_again[0]["updatedAt"] = Value::String("2026-07-29T12:00:00Z".to_string());
        repository.sync_legacy_snapshot(&waiting_again).unwrap();
        let final_state = repository.list_legacy_compatible().unwrap();
        assert_eq!(final_state[0]["waitingState"], "consultant-testing");
    }

    // Regression coverage for the same stale-`_canonicalWorkItem`-wins pattern
    // as the budget/waiting-state bugs, but on the canonical WorkItem struct
    // fields consumed by MCP/REST/get_task_record (list_work_items,
    // get_work_item, task_record_detail's "derived.planningBucket") rather
    // than by the desktop UI, which reads its own legacy planningBucket key
    // untouched. A second planning-bucket move or estimate edit — made from a
    // freshly reloaded state, exactly like a real session after restart —
    // must land in the canonical row, not silently revert to the value from
    // before the edit.
    #[test]
    fn planning_bucket_and_estimate_moved_on_an_existing_task_are_not_reverted_by_the_next_save() {
        let directory = tempdir().unwrap();
        let tasks_path = directory.path().join("tasks.json");
        fs::write(
            &tasks_path,
            serde_json::to_vec(&vec![legacy_task("task-1")]).unwrap(),
        )
        .unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));
        repository.migrate_json_tasks(&tasks_path).unwrap();

        let mut ui_records = repository.list_legacy_compatible().unwrap();
        ui_records[0]["planningBucket"] = Value::String("today".to_string());
        ui_records[0]["estimatedEffort"] = Value::from(3.0);
        ui_records[0]["revision"] = Value::from(5);
        ui_records[0]["updatedAt"] = Value::String("2026-07-29T10:00:00Z".to_string());
        repository.sync_legacy_snapshot(&ui_records).unwrap();

        let canonical = repository.get("task-1").unwrap().unwrap();
        assert_eq!(canonical.planning_bucket, Some("today".to_string()));
        assert_eq!(canonical.estimate_minutes, Some(180));

        // A later save from a freshly reloaded state moves the bucket again
        // and revises the estimate — this must not fall back to "today"/180.
        let mut moved = repository.list_legacy_compatible().unwrap();
        moved[0]["planningBucket"] = Value::String("now".to_string());
        moved[0]["estimatedEffort"] = Value::from(5.0);
        moved[0]["revision"] = Value::from(6);
        moved[0]["updatedAt"] = Value::String("2026-07-29T11:00:00Z".to_string());
        repository.sync_legacy_snapshot(&moved).unwrap();

        let final_canonical = repository.get("task-1").unwrap().unwrap();
        assert_eq!(final_canonical.planning_bucket, Some("now".to_string()));
        assert_eq!(final_canonical.estimate_minutes, Some(300));
    }

    #[test]
    fn intake_is_separate_until_promoted_to_a_work_item() {
        let directory = tempdir().unwrap();
        let tasks_path = directory.path().join("tasks.json");
        let mut intake = legacy_task("message-1");
        intake["classificationState"] = Value::String("analyzed".to_string());
        fs::write(&tasks_path, serde_json::to_vec(&vec![intake]).unwrap()).unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));
        repository.migrate_json_tasks(&tasks_path).unwrap();

        assert!(repository.list(true, 20).unwrap().is_empty());
        let mut ui_records = repository.list_legacy_compatible().unwrap();
        assert_eq!(ui_records[0]["classificationState"], "analyzed");

        ui_records[0]["classificationState"] = Value::String("created".to_string());
        ui_records[0]["revision"] = Value::from(2);
        ui_records[0]["updatedAt"] = Value::String("2026-07-29T11:00:00Z".to_string());
        repository.sync_legacy_snapshot(&ui_records).unwrap();

        assert_eq!(repository.list(true, 20).unwrap().len(), 1);
        assert_eq!(repository.list_legacy_compatible().unwrap().len(), 1);
    }

    #[test]
    fn failed_import_leaves_source_and_database_uncommitted() {
        let directory = tempdir().unwrap();
        let tasks_path = directory.path().join("tasks.json");
        let invalid = serde_json::json!([{
            "title": "Missing stable id",
            "source": "manual",
            "receivedAt": "2026-07-29T08:00:00Z"
        }]);
        let original = serde_json::to_vec(&invalid).unwrap();
        fs::write(&tasks_path, &original).unwrap();
        let database_path = directory.path().join(DATABASE_FILE);
        let repository = SqliteWorkItemRepository::at(database_path.clone());

        let error = repository.migrate_json_tasks(&tasks_path).unwrap_err();
        assert_eq!(error.code, "validation_error");
        assert_eq!(fs::read(&tasks_path).unwrap(), original);

        let connection = Connection::open(database_path).unwrap();
        let item_count: i64 = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM work_items) + (SELECT COUNT(*) FROM intake_items)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let marker_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM app_meta WHERE key = ?1",
                [JSON_IMPORT_MARKER],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(item_count, 0);
        assert_eq!(marker_count, 0);
    }

    #[test]
    fn stale_item_rolls_back_the_entire_legacy_ui_transaction() {
        let directory = tempdir().unwrap();
        let tasks_path = directory.path().join("tasks.json");
        fs::write(
            &tasks_path,
            serde_json::to_vec(&vec![legacy_task("task-1"), legacy_task("task-2")]).unwrap(),
        )
        .unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));
        repository.migrate_json_tasks(&tasks_path).unwrap();
        let mut stale_snapshot = repository.list_legacy_compatible().unwrap();

        let mut externally_updated = repository.get("task-2").unwrap().unwrap();
        externally_updated.title = "External authoritative update".to_string();
        externally_updated.updated_at = "2026-07-29T12:00:00Z".to_string();
        repository
            .update(
                "task-2",
                &externally_updated,
                &MutationContext {
                    expected_revision: 4,
                    actor_type: ActorType::Integration,
                    actor_name: Some("acceptance-test".to_string()),
                },
            )
            .unwrap();

        stale_snapshot[0]["title"] = Value::String("Must roll back".to_string());
        stale_snapshot[0]["revision"] = Value::from(5);
        stale_snapshot[0]["updatedAt"] = Value::String("2026-07-29T13:00:00Z".to_string());
        let error = repository
            .sync_legacy_snapshot(&stale_snapshot)
            .unwrap_err();
        assert_eq!(error.code, "revision_conflict");

        assert_eq!(
            repository.get("task-1").unwrap().unwrap().title,
            "Confirm renewal"
        );
        assert_eq!(
            repository.get("task-2").unwrap().unwrap().title,
            "External authoritative update"
        );
    }

    #[test]
    fn change_cursor_is_monotonic_across_create_and_update() {
        let directory = tempdir().unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));
        let mut item = project_legacy_task(&legacy_task("task-1")).unwrap();
        repository.create(&item).unwrap();
        let first_page = repository.changes_after(0, 10).unwrap();
        assert_eq!(first_page.len(), 1);

        item.title = "Updated title".to_string();
        item.updated_at = "2026-07-29T14:00:00Z".to_string();
        repository
            .update(
                "task-1",
                &item,
                &MutationContext {
                    expected_revision: 4,
                    actor_type: ActorType::Integration,
                    actor_name: None,
                },
            )
            .unwrap();
        let second_page = repository
            .changes_after(first_page[0].sequence, 10)
            .unwrap();
        assert_eq!(second_page.len(), 1);
        assert!(second_page[0].sequence > first_page[0].sequence);
        assert_eq!(second_page[0].revision, 5);
    }

    // ── Regression coverage for the list()-returns-empty incident ──────────
    // A production instance observed SqliteWorkItemRepository::list()
    // returning zero rows for a database that get(id) and a fresh external
    // connection both confirmed held 27 rows. The suspect mechanism was
    // WAL's memory-mapped shared reader index; connect() now uses the
    // plain rollback journal instead. These tests pin the behavior list()
    // and get() must always agree on, and make any future silent
    // under-return a hard test failure rather than a quiet empty result.

    #[test]
    fn list_returns_every_row_of_a_twenty_seven_item_fixture() {
        let directory = tempdir().unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));
        for n in 0..27 {
            let item = project_legacy_task(&legacy_task(&format!("task-{n:02}"))).unwrap();
            repository.create(&item).unwrap();
        }
        assert_eq!(repository.list(false, 500).unwrap().len(), 27);
        assert_eq!(repository.list(true, 500).unwrap().len(), 27);
    }

    #[test]
    fn get_and_list_never_disagree_about_which_rows_exist() {
        let directory = tempdir().unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));
        let ids: Vec<String> = (0..10).map(|n| format!("task-{n:02}")).collect();
        for id in &ids {
            let item = project_legacy_task(&legacy_task(id)).unwrap();
            repository.create(&item).unwrap();
        }

        let listed = repository.list(false, 500).unwrap();
        assert_eq!(listed.len(), ids.len());
        let listed_ids: std::collections::HashSet<_> =
            listed.iter().map(|item| item.id.clone()).collect();

        for id in &ids {
            assert!(
                repository.get(id).unwrap().is_some(),
                "get({id}) must find a row that list() also returned"
            );
            assert!(
                listed_ids.contains(id),
                "list() must include every row get() can find ({id})"
            );
        }
    }

    #[test]
    fn corrupt_payload_json_fails_list_loudly_instead_of_being_dropped() {
        let directory = tempdir().unwrap();
        let database_path = directory.path().join(DATABASE_FILE);
        let repository = SqliteWorkItemRepository::at(database_path.clone());
        let good = project_legacy_task(&legacy_task("task-good")).unwrap();
        repository.create(&good).unwrap();
        let other_good = project_legacy_task(&legacy_task("task-good-2")).unwrap();
        repository.create(&other_good).unwrap();

        // Simulate on-disk corruption directly, bypassing the repository API.
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute(
                "UPDATE work_items SET payload_json = ? WHERE id = ?",
                params!["{ not valid json", "task-good"],
            )
            .unwrap();

        let error = repository
            .list(true, 50)
            .expect_err("a corrupt row must fail the whole list(), not silently shrink it");
        assert!(
            error.message.contains("task-good"),
            "error should name the offending row: {}",
            error.message
        );

        // The other, uncorrupted row must still be reachable individually —
        // proving the corruption is isolated and not a whole-database issue.
        assert!(repository.get("task-good-2").unwrap().is_some());
    }

    #[test]
    fn archived_filter_is_explicit_in_both_directions() {
        let directory = tempdir().unwrap();
        let repository = SqliteWorkItemRepository::at(directory.path().join(DATABASE_FILE));
        let active = project_legacy_task(&legacy_task("task-active")).unwrap();
        repository.create(&active).unwrap();
        let mut to_archive = project_legacy_task(&legacy_task("task-archived")).unwrap();
        repository.create(&to_archive).unwrap();
        to_archive.archived_at = Some("2026-08-01T00:00:00Z".to_string());
        to_archive.updated_at = "2026-08-01T00:00:00Z".to_string();
        repository
            .update(
                "task-archived",
                &to_archive,
                &MutationContext {
                    expected_revision: 4,
                    actor_type: ActorType::User,
                    actor_name: None,
                },
            )
            .unwrap();

        let active_only = repository.list(false, 50).unwrap();
        assert_eq!(active_only.len(), 1);
        assert_eq!(active_only[0].id, "task-active");

        let with_archived = repository.list(true, 50).unwrap();
        assert_eq!(with_archived.len(), 2);
        assert!(with_archived.iter().any(|item| item.id == "task-archived"));
    }
}
