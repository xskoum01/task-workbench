use super::work_item::WorkItemStatus;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionError {
    pub code: &'static str,
    pub from: WorkItemStatus,
    pub to: WorkItemStatus,
    pub message: String,
}

pub fn can_transition(from: WorkItemStatus, to: WorkItemStatus) -> bool {
    use WorkItemStatus::*;
    if from == to {
        return true;
    }
    matches!(
        (from, to),
        (Planned, Ready | InProgress | Waiting | Blocked | Cancelled)
            | (Ready, Planned | InProgress | Waiting | Blocked | Cancelled)
            | (
                InProgress,
                Waiting | Blocked | Review | Completed | Cancelled
            )
            | (Waiting, Ready | InProgress | Blocked | Cancelled)
            | (Blocked, Planned | Ready | InProgress | Cancelled)
            | (
                Review,
                InProgress | Waiting | Blocked | Completed | Cancelled
            )
            | (Completed | Cancelled, Planned)
    )
}

pub fn validate_transition(
    from: WorkItemStatus,
    to: WorkItemStatus,
    reason: Option<&str>,
) -> Result<(), TransitionError> {
    if !can_transition(from, to) {
        return Err(TransitionError {
            code: "invalid_transition",
            from,
            to,
            message: format!("Transition from {:?} to {:?} is not allowed.", from, to),
        });
    }
    if matches!(to, WorkItemStatus::Blocked | WorkItemStatus::Cancelled)
        && reason.map(str::trim).unwrap_or_default().is_empty()
    {
        return Err(TransitionError {
            code: "reason_required",
            from,
            to,
            message: format!("Transition to {:?} requires a reason.", to),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_work_reopens_through_planned() {
        assert!(
            validate_transition(WorkItemStatus::Completed, WorkItemStatus::Planned, None).is_ok()
        );
        assert!(
            validate_transition(WorkItemStatus::Completed, WorkItemStatus::InProgress, None)
                .is_err()
        );
    }

    #[test]
    fn blocked_requires_reason() {
        assert!(
            validate_transition(WorkItemStatus::InProgress, WorkItemStatus::Blocked, None).is_err()
        );
        assert!(validate_transition(
            WorkItemStatus::InProgress,
            WorkItemStatus::Blocked,
            Some("Waiting for customer")
        )
        .is_ok());
    }
}
