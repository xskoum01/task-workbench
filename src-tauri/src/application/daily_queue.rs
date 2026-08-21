//! Application service for the Daily Queue — the explicit, user-chosen
//! execution order for a calendar day. See `crate::domain::daily_queue` for
//! the Today-vs-Daily-Queue distinction and the pure ordering rules.

use super::{ApplicationError, WorkItemRepository};
use crate::domain::daily_queue::{is_valid_calendar_date, DailyQueue};

/// Port implemented by the SQLite adapter. Every mutation here is expected to
/// perform its own atomic read-check-write (matching `WorkItemRepository`'s
/// revision-checked `update`): read the current row (or the virtual
/// `revision: 0` empty queue for an unseen date), verify `expected_revision`,
/// compute the next entry list, and persist it — all under one transaction —
/// so two concurrent mutations against the same date can never both succeed
/// against the same revision.
pub trait DailyQueueRepository {
    /// Named `get_queue` rather than `get` because the same adapter struct
    /// (`SqliteWorkItemRepository`) also implements `WorkItemRepository::get`
    /// — a same-named method on both traits would make every call on a
    /// concrete value ambiguous (`error[E0034]`) for any caller with both
    /// traits in scope, which the storage-layer test module already is.
    fn get_queue(&self, date: &str) -> Result<DailyQueue, ApplicationError>;

    fn replace(
        &self,
        date: &str,
        work_item_ids: &[String],
        expected_revision: i64,
        at: &str,
    ) -> Result<DailyQueue, ApplicationError>;

    fn add(
        &self,
        date: &str,
        work_item_id: &str,
        position: Option<usize>,
        expected_revision: i64,
        at: &str,
    ) -> Result<DailyQueue, ApplicationError>;

    fn add_note(
        &self,
        date: &str,
        entry_id: &str,
        text: &str,
        position: Option<usize>,
        expected_revision: i64,
        at: &str,
    ) -> Result<DailyQueue, ApplicationError>;

    fn move_item(
        &self,
        date: &str,
        work_item_id: &str,
        position: usize,
        expected_revision: i64,
        at: &str,
    ) -> Result<DailyQueue, ApplicationError>;

    fn remove(
        &self,
        date: &str,
        work_item_id: &str,
        expected_revision: i64,
        at: &str,
    ) -> Result<DailyQueue, ApplicationError>;
}

pub struct DailyQueueApplicationService<'a> {
    pub queues: &'a dyn DailyQueueRepository,
    pub work_items: &'a dyn WorkItemRepository,
}

impl<'a> DailyQueueApplicationService<'a> {
    pub fn get(&self, date: &str) -> Result<DailyQueue, ApplicationError> {
        validate_date(date)?;
        self.queues.get_queue(date)
    }

    /// Atomically replaces the whole ordered list. Rejects duplicate ids and
    /// any id that is not an active (non-archived) WorkItem before touching
    /// storage — a failed validation must never partially apply.
    pub fn replace(
        &self,
        date: &str,
        work_item_ids: &[String],
        expected_revision: i64,
        at: &str,
    ) -> Result<DailyQueue, ApplicationError> {
        validate_date(date)?;
        if crate::domain::daily_queue::has_duplicates(work_item_ids) {
            return Err(ApplicationError::validation(
                "A daily queue cannot contain the same work item twice.",
            ));
        }
        for work_item_id in work_item_ids {
            self.require_active_work_item(work_item_id)?;
        }
        self.queues.replace(date, work_item_ids, expected_revision, at)
    }

    pub fn add(
        &self,
        date: &str,
        work_item_id: &str,
        position: Option<usize>,
        expected_revision: i64,
        at: &str,
    ) -> Result<DailyQueue, ApplicationError> {
        validate_date(date)?;
        self.require_active_work_item(work_item_id)?;
        self.queues.add(date, work_item_id, position, expected_revision, at)
    }

    pub fn add_note(
        &self,
        date: &str,
        entry_id: &str,
        text: &str,
        position: Option<usize>,
        expected_revision: i64,
        at: &str,
    ) -> Result<DailyQueue, ApplicationError> {
        validate_date(date)?;
        let text = text.trim();
        if text.is_empty() {
            return Err(ApplicationError::validation("Queue note text cannot be empty."));
        }
        if text.chars().count() > 500 {
            return Err(ApplicationError::validation("Queue note text cannot exceed 500 characters."));
        }
        self.queues.add_note(date, entry_id, text, position, expected_revision, at)
    }

    pub fn move_item(
        &self,
        date: &str,
        work_item_id: &str,
        position: usize,
        expected_revision: i64,
        at: &str,
    ) -> Result<DailyQueue, ApplicationError> {
        validate_date(date)?;
        if position == 0 {
            return Err(ApplicationError::validation("position must be 1 or greater."));
        }
        self.queues.move_item(date, work_item_id, position, expected_revision, at)
    }

    pub fn remove(
        &self,
        date: &str,
        work_item_id: &str,
        expected_revision: i64,
        at: &str,
    ) -> Result<DailyQueue, ApplicationError> {
        validate_date(date)?;
        self.queues.remove(date, work_item_id, expected_revision, at)
    }

    /// Enforced for every id newly entering a queue (`add`, `replace`):
    /// existence and non-archived. Not re-checked by `move`/`remove`, which
    /// only need the id to currently be present in the queue itself.
    fn require_active_work_item(&self, work_item_id: &str) -> Result<(), ApplicationError> {
        let item = self
            .work_items
            .get(work_item_id)?
            .ok_or_else(|| ApplicationError::not_found(work_item_id))?;
        if item.archived_at.is_some() {
            return Err(ApplicationError::validation(format!(
                "Work item {work_item_id} is archived and cannot be added to a daily queue."
            )));
        }
        Ok(())
    }
}

fn validate_date(date: &str) -> Result<(), ApplicationError> {
    if is_valid_calendar_date(date) {
        Ok(())
    } else {
        Err(ApplicationError::validation(format!(
            "'{date}' is not a valid YYYY-MM-DD calendar date."
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::daily_queue::DailyQueueEntry;
    use crate::domain::work_item::{
        ObligationMode, PartyReference, WorkItem, WorkItemKind, WorkItemPriority, WorkItemStatus,
        WORK_ITEM_SCHEMA_VERSION,
    };
    use std::cell::RefCell;
    use std::collections::HashMap;

    fn work_item(id: &str, archived: bool) -> WorkItem {
        WorkItem {
            schema_version: WORK_ITEM_SCHEMA_VERSION,
            id: id.to_string(),
            kind: WorkItemKind::Task,
            obligation_mode: None::<ObligationMode>,
            title: format!("Task {id}"),
            description: None,
            expected_outcome: None,
            status: WorkItemStatus::Ready,
            priority: WorkItemPriority::Normal,
            owner: None::<PartyReference>,
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
            archived_at: if archived { Some("2026-08-02T00:00:00Z".to_string()) } else { None },
            history: vec![],
            metadata: HashMap::new(),
        }
    }

    struct FakeWorkItems {
        items: Vec<WorkItem>,
    }
    impl WorkItemRepository for FakeWorkItems {
        fn list(&self, _include_archived: bool, _limit: usize) -> Result<Vec<WorkItem>, ApplicationError> {
            Ok(self.items.clone())
        }
        fn get(&self, id: &str) -> Result<Option<WorkItem>, ApplicationError> {
            Ok(self.items.iter().find(|item| item.id == id).cloned())
        }
        fn create(&self, item: &WorkItem) -> Result<WorkItem, ApplicationError> {
            Ok(item.clone())
        }
        fn update(&self, _id: &str, item: &WorkItem, _mutation: &super::super::MutationContext) -> Result<WorkItem, ApplicationError> {
            Ok(item.clone())
        }
    }

    /// In-memory stand-in for the SQLite adapter, mirroring its exact
    /// read-check-write contract (including the `revision: 0` virtual empty
    /// queue for unseen dates) so the application-layer tests exercise real
    /// optimistic-concurrency behavior without touching a database.
    struct FakeQueues {
        rows: RefCell<HashMap<String, DailyQueue>>,
    }
    impl FakeQueues {
        fn new() -> Self {
            Self { rows: RefCell::new(HashMap::new()) }
        }
        fn current(&self, date: &str) -> DailyQueue {
            self.rows.borrow().get(date).cloned().unwrap_or_else(|| DailyQueue::empty(date))
        }
        fn check_and_write(
            &self,
            date: &str,
            expected_revision: i64,
            next_entries: Vec<DailyQueueEntry>,
            at: &str,
        ) -> Result<DailyQueue, ApplicationError> {
            let current = self.current(date);
            if current.revision != expected_revision {
                return Err(ApplicationError::revision_conflict(expected_revision, current.revision));
            }
            let next = DailyQueue {
                date: date.to_string(),
                revision: current.revision + 1,
                updated_at: at.to_string(),
                entries: next_entries,
            };
            self.rows.borrow_mut().insert(date.to_string(), next.clone());
            Ok(next)
        }
    }
    impl DailyQueueRepository for FakeQueues {
        fn get_queue(&self, date: &str) -> Result<DailyQueue, ApplicationError> {
            Ok(self.current(date))
        }
        fn replace(&self, date: &str, work_item_ids: &[String], expected_revision: i64, at: &str) -> Result<DailyQueue, ApplicationError> {
            let current = self.current(date);
            let next = crate::domain::daily_queue::apply_replace(&current.entries, work_item_ids, at);
            self.check_and_write(date, expected_revision, next, at)
        }
        fn add(&self, date: &str, work_item_id: &str, position: Option<usize>, expected_revision: i64, at: &str) -> Result<DailyQueue, ApplicationError> {
            let current = self.current(date);
            let next = crate::domain::daily_queue::apply_add(&current.entries, work_item_id, position, at)
                .map_err(|_| ApplicationError::validation(format!("Work item {work_item_id} is already in the daily queue for {date}.")))?;
            self.check_and_write(date, expected_revision, next, at)
        }
        fn add_note(&self, date: &str, entry_id: &str, text: &str, position: Option<usize>, expected_revision: i64, at: &str) -> Result<DailyQueue, ApplicationError> {
            let current = self.current(date);
            let next = crate::domain::daily_queue::apply_add_note(&current.entries, entry_id, text, position, at)
                .map_err(|_| ApplicationError::validation(format!("Entry {entry_id} is already in the daily queue for {date}.")))?;
            self.check_and_write(date, expected_revision, next, at)
        }
        fn move_item(&self, date: &str, work_item_id: &str, position: usize, expected_revision: i64, at: &str) -> Result<DailyQueue, ApplicationError> {
            let current = self.current(date);
            let next = crate::domain::daily_queue::apply_move(&current.entries, work_item_id, position)
                .map_err(|_| ApplicationError::validation(format!("Work item {work_item_id} is not in the daily queue for {date}.")))?;
            self.check_and_write(date, expected_revision, next, at)
        }
        fn remove(&self, date: &str, work_item_id: &str, expected_revision: i64, at: &str) -> Result<DailyQueue, ApplicationError> {
            let current = self.current(date);
            let next = crate::domain::daily_queue::apply_remove(&current.entries, work_item_id)
                .map_err(|_| ApplicationError::validation(format!("Work item {work_item_id} is not in the daily queue for {date}.")))?;
            self.check_and_write(date, expected_revision, next, at)
        }
    }

    fn service<'a>(work_items: &'a FakeWorkItems, queues: &'a FakeQueues) -> DailyQueueApplicationService<'a> {
        DailyQueueApplicationService { queues, work_items }
    }

    #[test]
    fn empty_queue_for_an_unseen_date_has_revision_zero() {
        let work_items = FakeWorkItems { items: vec![] };
        let queues = FakeQueues::new();
        let queue = service(&work_items, &queues).get("2026-08-17").unwrap();
        assert_eq!(queue.revision, 0);
        assert!(queue.entries.is_empty());
    }

    #[test]
    fn add_first_task_creates_the_queue_at_revision_one() {
        let work_items = FakeWorkItems { items: vec![work_item("a", false)] };
        let queues = FakeQueues::new();
        let queue = service(&work_items, &queues).add("2026-08-17", "a", None, 0, "t1").unwrap();
        assert_eq!(queue.revision, 1);
        assert_eq!(queue.entries.len(), 1);
        assert_eq!(queue.entries[0].work_item_id, "a");
    }

    #[test]
    fn add_task_at_end() {
        let work_items = FakeWorkItems { items: vec![work_item("a", false), work_item("b", false)] };
        let queues = FakeQueues::new();
        let svc = service(&work_items, &queues);
        svc.add("2026-08-17", "a", None, 0, "t1").unwrap();
        let queue = svc.add("2026-08-17", "b", None, 1, "t2").unwrap();
        assert_eq!(
            queue.entries.iter().map(|e| e.work_item_id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn insert_task_at_position_one() {
        let work_items = FakeWorkItems { items: vec![work_item("a", false), work_item("b", false)] };
        let queues = FakeQueues::new();
        let svc = service(&work_items, &queues);
        svc.add("2026-08-17", "a", None, 0, "t1").unwrap();
        let queue = svc.add("2026-08-17", "b", Some(1), 1, "t2").unwrap();
        assert_eq!(
            queue.entries.iter().map(|e| e.work_item_id.as_str()).collect::<Vec<_>>(),
            vec!["b", "a"]
        );
    }

    #[test]
    fn move_task_reorders() {
        let work_items = FakeWorkItems { items: vec![work_item("a", false), work_item("b", false)] };
        let queues = FakeQueues::new();
        let svc = service(&work_items, &queues);
        svc.add("2026-08-17", "a", None, 0, "t1").unwrap();
        svc.add("2026-08-17", "b", None, 1, "t2").unwrap();
        let queue = svc.move_item("2026-08-17", "b", 1, 2, "t3").unwrap();
        assert_eq!(
            queue.entries.iter().map(|e| e.work_item_id.as_str()).collect::<Vec<_>>(),
            vec!["b", "a"]
        );
        assert_eq!(queue.revision, 3);
    }

    #[test]
    fn remove_task() {
        let work_items = FakeWorkItems { items: vec![work_item("a", false)] };
        let queues = FakeQueues::new();
        let svc = service(&work_items, &queues);
        svc.add("2026-08-17", "a", None, 0, "t1").unwrap();
        let queue = svc.remove("2026-08-17", "a", 1, "t2").unwrap();
        assert!(queue.entries.is_empty());
        assert_eq!(queue.revision, 2);
    }

    #[test]
    fn replace_full_queue_atomically() {
        let work_items = FakeWorkItems {
            items: vec![work_item("a", false), work_item("b", false), work_item("c", false)],
        };
        let queues = FakeQueues::new();
        let svc = service(&work_items, &queues);
        let queue = svc
            .replace("2026-08-17", &["a".to_string(), "b".to_string(), "c".to_string()], 0, "t1")
            .unwrap();
        assert_eq!(
            queue.entries.iter().map(|e| e.work_item_id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
        assert_eq!(queue.revision, 1);
    }

    #[test]
    fn duplicate_work_item_in_replace_is_rejected() {
        let work_items = FakeWorkItems { items: vec![work_item("a", false)] };
        let queues = FakeQueues::new();
        let error = service(&work_items, &queues)
            .replace("2026-08-17", &["a".to_string(), "a".to_string()], 0, "t1")
            .unwrap_err();
        assert_eq!(error.code, "validation_error");
    }

    #[test]
    fn duplicate_add_is_rejected() {
        let work_items = FakeWorkItems { items: vec![work_item("a", false)] };
        let queues = FakeQueues::new();
        let svc = service(&work_items, &queues);
        svc.add("2026-08-17", "a", None, 0, "t1").unwrap();
        let error = svc.add("2026-08-17", "a", None, 1, "t2").unwrap_err();
        assert_eq!(error.code, "validation_error");
    }

    #[test]
    fn stale_expected_revision_is_rejected_and_nothing_changes() {
        let work_items = FakeWorkItems { items: vec![work_item("a", false), work_item("b", false)] };
        let queues = FakeQueues::new();
        let svc = service(&work_items, &queues);
        svc.add("2026-08-17", "a", None, 0, "t1").unwrap();
        let error = svc.add("2026-08-17", "b", None, 0, "t2").unwrap_err();
        assert_eq!(error.code, "revision_conflict");
        assert_eq!(error.current_revision, Some(1));
        // Nothing changed — the queue still has exactly the first entry.
        let queue = svc.get("2026-08-17").unwrap();
        assert_eq!(queue.entries.len(), 1);
        assert_eq!(queue.revision, 1);
    }

    #[test]
    fn unknown_work_item_is_rejected() {
        let work_items = FakeWorkItems { items: vec![] };
        let queues = FakeQueues::new();
        let error = service(&work_items, &queues).add("2026-08-17", "ghost", None, 0, "t1").unwrap_err();
        assert_eq!(error.code, "not_found");
    }

    #[test]
    fn archived_work_item_is_rejected() {
        let work_items = FakeWorkItems { items: vec![work_item("a", true)] };
        let queues = FakeQueues::new();
        let error = service(&work_items, &queues).add("2026-08-17", "a", None, 0, "t1").unwrap_err();
        assert_eq!(error.code, "validation_error");
    }

    #[test]
    fn moving_an_item_not_in_the_queue_is_rejected() {
        let work_items = FakeWorkItems { items: vec![work_item("a", false)] };
        let queues = FakeQueues::new();
        let error = service(&work_items, &queues).move_item("2026-08-17", "a", 1, 0, "t1").unwrap_err();
        assert_eq!(error.code, "validation_error");
    }

    #[test]
    fn invalid_date_is_rejected_for_every_operation() {
        let work_items = FakeWorkItems { items: vec![work_item("a", false)] };
        let queues = FakeQueues::new();
        let svc = service(&work_items, &queues);
        assert_eq!(svc.get("not-a-date").unwrap_err().code, "validation_error");
        assert_eq!(svc.add("not-a-date", "a", None, 0, "t1").unwrap_err().code, "validation_error");
        assert_eq!(
            svc.replace("not-a-date", &["a".to_string()], 0, "t1").unwrap_err().code,
            "validation_error"
        );
        assert_eq!(svc.move_item("not-a-date", "a", 1, 0, "t1").unwrap_err().code, "validation_error");
        assert_eq!(svc.remove("not-a-date", "a", 0, "t1").unwrap_err().code, "validation_error");
    }

    #[test]
    fn queue_for_one_date_is_independent_of_another_date() {
        let work_items = FakeWorkItems { items: vec![work_item("a", false), work_item("b", false)] };
        let queues = FakeQueues::new();
        let svc = service(&work_items, &queues);
        svc.add("2026-08-17", "a", None, 0, "t1").unwrap();
        svc.add("2026-08-18", "b", None, 0, "t2").unwrap();
        let day17 = svc.get("2026-08-17").unwrap();
        let day18 = svc.get("2026-08-18").unwrap();
        assert_eq!(day17.entries.iter().map(|e| e.work_item_id.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(day18.entries.iter().map(|e| e.work_item_id.as_str()).collect::<Vec<_>>(), vec!["b"]);
    }
}
