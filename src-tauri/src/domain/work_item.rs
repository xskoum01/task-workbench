use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub const WORK_ITEM_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemKind {
    Task,
    Obligation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObligationMode {
    OneOff,
    Ongoing,
    Recurring,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemStatus {
    Planned,
    Ready,
    InProgress,
    Waiting,
    Blocked,
    Review,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemPriority {
    Low,
    Normal,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorType {
    User,
    System,
    Integration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartyReference {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemEvent {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<i64>,
    pub at: String,
    pub actor_type: ActorType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_name: Option<String>,
    pub action: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemContextEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub created_at: String,
    pub actor_type: ActorType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalReference {
    #[serde(rename = "type")]
    pub reference_type: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub schema_version: u32,
    pub id: String,
    pub kind: WorkItemKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub obligation_mode: Option<ObligationMode>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_outcome: Option<String>,
    pub status: WorkItemStatus,
    pub priority: WorkItemPriority,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<PartyReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accountable_to: Option<PartyReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_review_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocker_reason: Option<String>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub planning_bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate_minutes: Option<i64>,
    #[serde(default)]
    pub external_references: Vec<ExternalReference>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub context: Vec<WorkItemContextEntry>,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub history: Vec<WorkItemEvent>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, Value>,
}

impl WorkItem {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != WORK_ITEM_SCHEMA_VERSION {
            return Err(format!(
                "Unsupported work item schema version {}.",
                self.schema_version
            ));
        }
        if self.id.trim().is_empty() {
            return Err("Work item id must not be empty.".to_string());
        }
        if self.title.trim().is_empty() {
            return Err("Work item title must not be empty.".to_string());
        }
        if self.revision < 1 {
            return Err("Work item revision must be at least 1.".to_string());
        }
        if self.kind == WorkItemKind::Task && self.obligation_mode.is_some() {
            return Err("A task cannot define obligationMode.".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_provider_neutral_camel_case_contract() {
        let item = WorkItem {
            schema_version: WORK_ITEM_SCHEMA_VERSION,
            id: "work-1".to_string(),
            kind: WorkItemKind::Task,
            obligation_mode: None,
            title: "Confirm renewal".to_string(),
            description: None,
            expected_outcome: None,
            status: WorkItemStatus::InProgress,
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
            created_at: "2026-07-29T10:00:00Z".to_string(),
            updated_at: "2026-07-29T10:00:00Z".to_string(),
            revision: 1,
            archived_at: None,
            history: vec![],
            metadata: HashMap::new(),
        };

        item.validate().unwrap();
        let value = serde_json::to_value(item).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["status"], "in_progress");
        assert!(value.get("obligationMode").is_none());
    }
}
