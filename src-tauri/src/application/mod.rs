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
            status
                .as_deref()
                .map_or(true, |v| Some(v) == query.status.as_deref())
                && kind
                    .as_deref()
                    .map_or(true, |v| Some(v) == query.kind.as_deref())
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
