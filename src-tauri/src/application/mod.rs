use crate::domain::lifecycle::validate_transition;
use crate::domain::work_item::{
    ActorType, WorkItem, WorkItemContextEntry, WorkItemEvent, WorkItemStatus,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<i64>,
}

impl ApplicationError {
    pub fn not_found(id: &str) -> Self {
        Self {
            code: "not_found".to_string(),
            message: format!("Work item {id} was not found."),
            current_revision: None,
        }
    }

    pub fn revision_conflict(expected: i64, actual: i64) -> Self {
        Self {
            code: "revision_conflict".to_string(),
            message: format!("Expected revision {expected}, but current revision is {actual}."),
            current_revision: Some(actual),
        }
    }

    pub fn storage(message: impl Into<String>) -> Self {
        Self {
            code: "storage_error".to_string(),
            message: message.into(),
            current_revision: None,
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            code: "validation_error".to_string(),
            message: message.into(),
            current_revision: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MutationContext {
    pub expected_revision: i64,
    pub actor_type: ActorType,
    pub actor_name: Option<String>,
}

pub trait WorkItemRepository {
    fn list(&self, include_archived: bool, limit: usize)
        -> Result<Vec<WorkItem>, ApplicationError>;
    fn get(&self, id: &str) -> Result<Option<WorkItem>, ApplicationError>;
    fn create(&self, item: &WorkItem) -> Result<WorkItem, ApplicationError>;
    fn update(
        &self,
        id: &str,
        item: &WorkItem,
        mutation: &MutationContext,
    ) -> Result<WorkItem, ApplicationError>;
}

#[derive(Debug, Clone, Default)]
pub struct WorkItemListQuery {
    pub include_archived: bool,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub owner: Option<String>,
    pub area: Option<String>,
    pub source: Option<String>,
    pub planning_bucket: Option<String>,
    pub due_before: Option<String>,
    pub due_after: Option<String>,
    pub updated_after: Option<String>,
    pub cursor: Option<String>,
    pub limit: usize,
}

pub struct WorkItemApplicationService<'a> {
    pub repository: &'a dyn WorkItemRepository,
}

impl<'a> WorkItemApplicationService<'a> {
    pub fn list(&self, query: &WorkItemListQuery) -> Result<Vec<WorkItem>, ApplicationError> {
        let mut items = self.repository.list(query.include_archived, 500)?;
        items.retain(|item| {
            let status = serde_json::to_value(item.status)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string));
            let kind = serde_json::to_value(item.kind)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string));
            let after_cursor = query.cursor.as_deref().map_or(true, |cursor| {
                let mut parts = cursor.splitn(2, '|');
                let updated = parts.next().unwrap_or_default();
                let id = parts.next().unwrap_or_default();
                item.updated_at.as_str() < updated
                    || (item.updated_at == updated && item.id.as_str() > id)
            });
            query
                .status
                .as_deref()
                .map_or(true, |v| status.as_deref() == Some(v))
                && query
                    .kind
                    .as_deref()
                    .map_or(true, |v| kind.as_deref() == Some(v))
                && query.owner.as_deref().map_or(true, |v| {
                    item.owner.as_ref().is_some_and(|p| {
                        p.id.as_deref() == Some(v) || p.display_name.eq_ignore_ascii_case(v)
                    })
                })
                && query
                    .area
                    .as_deref()
                    .map_or(true, |v| item.area_id.as_deref() == Some(v))
                && query.source.as_deref().map_or(true, |v| item.source == v)
                && query
                    .due_before
                    .as_deref()
                    .map_or(true, |v| item.due_at.as_deref().is_some_and(|d| d <= v))
                && query
                    .due_after
                    .as_deref()
                    .map_or(true, |v| item.due_at.as_deref().is_some_and(|d| d >= v))
                && query
                    .updated_after
                    .as_deref()
                    .map_or(true, |v| item.updated_at > v.to_string())
                && query.planning_bucket.as_deref().map_or(true, |v| {
                    item.planning_bucket.as_deref() == Some(v)
                        || item.metadata.get("planningBucket").and_then(|x| x.as_str()) == Some(v)
                })
                && after_cursor
        });
        items.truncate(query.limit.clamp(1, 500));
        Ok(items)
    }

    pub fn get(&self, id: &str) -> Result<WorkItem, ApplicationError> {
        self.repository
            .get(id)?
            .ok_or_else(|| ApplicationError::not_found(id))
    }

    pub fn transition(
        &self,
        id: &str,
        status: WorkItemStatus,
        reason: Option<&str>,
        expected_revision: i64,
        at: &str,
        actor_name: Option<String>,
    ) -> Result<WorkItem, ApplicationError> {
        let current = self.get(id)?;
        validate_transition(current.status, status, reason)
            .map_err(|e| ApplicationError::validation(e.message))?;
        let mut next = current.clone();
        next.status = status;
        next.updated_at = at.to_string();
        if status == WorkItemStatus::Completed {
            next.completed_at = Some(at.to_string());
        }
        next.history.push(WorkItemEvent {
            id: format!("event-{at}-{id}"),
            sequence: None,
            at: at.to_string(),
            actor_type: ActorType::User,
            actor_name: actor_name.clone(),
            action: "status_changed".to_string(),
            summary: format!("Status changed to {:?}", status),
            changes: vec![],
        });
        self.repository.update(
            id,
            &next,
            &MutationContext {
                expected_revision,
                actor_type: ActorType::User,
                actor_name,
            },
        )
    }

    pub fn append_note(
        &self,
        id: &str,
        text: &str,
        expected_revision: i64,
        at: &str,
        actor_name: Option<String>,
    ) -> Result<WorkItem, ApplicationError> {
        if text.trim().is_empty() {
            return Err(ApplicationError::validation("Note text must not be empty."));
        }
        let current = self.get(id)?;
        let mut next = current.clone();
        next.updated_at = at.to_string();
        next.context.push(WorkItemContextEntry {
            id: format!("note-{at}"),
            entry_type: "note".to_string(),
            text: Some(text.to_string()),
            url: None,
            created_at: at.to_string(),
            actor_type: ActorType::User,
            actor_name: actor_name.clone(),
        });
        self.repository.update(
            id,
            &next,
            &MutationContext {
                expected_revision,
                actor_type: ActorType::User,
                actor_name,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::work_item::{
        ObligationMode, PartyReference, WorkItemKind, WorkItemPriority, WORK_ITEM_SCHEMA_VERSION,
    };
    use crate::storage::sqlite::SqliteWorkItemRepository;
    use std::collections::HashMap;
    use tempfile::tempdir;

    fn sample_item(id: &str) -> WorkItem {
        WorkItem {
            schema_version: WORK_ITEM_SCHEMA_VERSION,
            id: id.to_string(),
            kind: WorkItemKind::Task,
            obligation_mode: None,
            title: format!("Task {id}"),
            description: None,
            expected_outcome: None,
            status: WorkItemStatus::Planned,
            priority: WorkItemPriority::Normal,
            owner: None,
            accountable_to: None,
            area_id: None,
            parent_id: None,
            start_at: None,
            due_at: None,
            completed_at: None,
            next_review_at: None,
            blocker_reason: None,
            source: "manual".to_string(),
            source_url: None,
            planning_bucket: None,
            estimate_minutes: None,
            external_references: vec![],
            tags: vec![],
            context: vec![],
            created_at: "2026-08-01T08:00:00Z".to_string(),
            updated_at: "2026-08-01T08:00:00Z".to_string(),
            revision: 1,
            archived_at: None,
            history: vec![],
            metadata: HashMap::new(),
        }
    }

    fn repo_with(items: &[WorkItem]) -> SqliteWorkItemRepository {
        // Leaking the tempdir keeps the backing file alive for the life of
        // the test; each test gets its own directory so there is no
        // cross-test interference.
        let directory = Box::leak(Box::new(tempdir().unwrap()));
        let repository = SqliteWorkItemRepository::at(directory.path().join("test.sqlite3"));
        for item in items {
            repository.create(item).unwrap();
        }
        repository
    }

    /// Canonical planning membership is decided *only* by the explicitly
    /// stored `planningBucket` value — never inferred from `dueAt`,
    /// `status`, or "today". A task due today with no explicit bucket must
    /// not show up in "today", and one explicitly locked to "now" must show
    /// up there regardless of its due date. This is decision "A" from the
    /// Planning read-model unification: src/lib/planning.ts's
    /// `effectiveBucket` mirrors this exact rule so REST/MCP/Tauri and the
    /// UI can never disagree about Now/Today membership.
    #[test]
    fn planning_bucket_filter_matches_only_the_explicit_value_never_inferred() {
        let mut due_today_but_unbucketed = sample_item("unbucketed-due-today");
        due_today_but_unbucketed.due_at = Some("2026-08-02T00:00:00Z".to_string());

        let mut locked_now = sample_item("locked-now");
        locked_now.planning_bucket = Some("now".to_string());
        locked_now.due_at = Some("2026-12-31T00:00:00Z".to_string()); // far away, doesn't matter

        let mut locked_today = sample_item("locked-today");
        locked_today.planning_bucket = Some("today".to_string());

        let repository = repo_with(&[due_today_but_unbucketed, locked_now, locked_today]);
        let service = WorkItemApplicationService {
            repository: &repository,
        };

        let now_bucket = service
            .list(&WorkItemListQuery {
                planning_bucket: Some("now".to_string()),
                limit: 500,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(now_bucket.len(), 1);
        assert_eq!(now_bucket[0].id, "locked-now");

        let today_bucket = service
            .list(&WorkItemListQuery {
                planning_bucket: Some("today".to_string()),
                limit: 500,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(today_bucket.len(), 1);
        assert_eq!(today_bucket[0].id, "locked-today");
    }

    #[test]
    fn status_kind_and_source_filters_are_exact_match() {
        let mut a = sample_item("a");
        a.status = WorkItemStatus::InProgress;
        a.kind = WorkItemKind::Task;
        a.source = "outlook".to_string();
        let mut b = sample_item("b");
        b.status = WorkItemStatus::Planned;
        b.kind = WorkItemKind::Obligation;
        b.obligation_mode = Some(ObligationMode::Ongoing);
        b.source = "manual".to_string();

        let repository = repo_with(&[a, b]);
        let service = WorkItemApplicationService {
            repository: &repository,
        };

        let by_status = service
            .list(&WorkItemListQuery {
                status: Some("in_progress".to_string()),
                limit: 500,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(by_status.len(), 1);
        assert_eq!(by_status[0].id, "a");

        let by_kind = service
            .list(&WorkItemListQuery {
                kind: Some("obligation".to_string()),
                limit: 500,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(by_kind.len(), 1);
        assert_eq!(by_kind[0].id, "b");

        let by_source = service
            .list(&WorkItemListQuery {
                source: Some("outlook".to_string()),
                limit: 500,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(by_source.len(), 1);
        assert_eq!(by_source[0].id, "a");
    }

    #[test]
    fn due_date_range_filters_are_inclusive() {
        let mut early = sample_item("early");
        early.due_at = Some("2026-08-01T00:00:00Z".to_string());
        let mut mid = sample_item("mid");
        mid.due_at = Some("2026-08-05T00:00:00Z".to_string());
        let mut late = sample_item("late");
        late.due_at = Some("2026-08-10T00:00:00Z".to_string());

        let repository = repo_with(&[early, mid, late]);
        let service = WorkItemApplicationService {
            repository: &repository,
        };

        let window = service
            .list(&WorkItemListQuery {
                due_after: Some("2026-08-01T00:00:00Z".to_string()),
                due_before: Some("2026-08-05T00:00:00Z".to_string()),
                limit: 500,
                ..Default::default()
            })
            .unwrap();
        let ids: Vec<_> = window.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"early"));
        assert!(ids.contains(&"mid"));
        assert!(!ids.contains(&"late"));
    }

    #[test]
    fn owner_filter_matches_id_or_display_name_case_insensitively() {
        let mut owned = sample_item("owned");
        owned.owner = Some(PartyReference {
            id: None,
            display_name: "Jan Kvicala".to_string(),
        });
        let unowned = sample_item("unowned");

        let repository = repo_with(&[owned, unowned]);
        let service = WorkItemApplicationService {
            repository: &repository,
        };

        let result = service
            .list(&WorkItemListQuery {
                owner: Some("jan kvicala".to_string()),
                limit: 500,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "owned");
    }

    #[test]
    fn archived_items_are_excluded_by_default_and_included_on_request() {
        let mut archived = sample_item("archived");
        archived.archived_at = Some("2026-08-01T00:00:00Z".to_string());
        let active = sample_item("active");

        let repository = repo_with(&[archived, active]);
        let service = WorkItemApplicationService {
            repository: &repository,
        };

        let default_query = service
            .list(&WorkItemListQuery {
                limit: 500,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(default_query.len(), 1);
        assert_eq!(default_query[0].id, "active");

        let with_archived = service
            .list(&WorkItemListQuery {
                include_archived: true,
                limit: 500,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(with_archived.len(), 2);
    }
}
