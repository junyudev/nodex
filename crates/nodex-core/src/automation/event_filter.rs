//! Typed filters narrow assessment. The written condition remains the judgement policy.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::automation::*;
use nodex_core_contracts::sources::{
    ExternalThread, ExternalThreadKind, SourceActorClass, SourceTriggerInput,
};
use rusqlite::{Connection, params};

pub(super) fn validate(
    c: &Connection,
    library: &str,
    input: &AutomationInput,
    f: &AutomationSourceFilter,
) -> Result<(), StoreError> {
    let invalid = |message| StoreError::new(StoreErrorCode::InvalidInput, message, false);
    if input.cwds.as_ref().is_some_and(|roots| roots.len() > 1) {
        return Err(invalid("An event Automation selects one workspace root"));
    }
    if input.model.as_deref().is_none_or(|v| v.trim().is_empty()) {
        return Err(invalid("An event Automation requires an exact Agent model"));
    }
    if input.kind != AutomationExecutionKind::Cron
        || input.project_id.is_none()
        || input.target_session_id.is_some()
    {
        return Err(invalid(
            "An event Automation requires a Project and starts a new Page",
        ));
    }
    if input
        .condition_text
        .as_deref()
        .is_none_or(|v| v.trim().is_empty())
        || input.prompt.as_deref().is_none_or(|v| v.trim().is_empty())
    {
        return Err(invalid(
            "An event Automation requires its written condition and action",
        ));
    }
    if input
        .condition_text
        .as_ref()
        .is_some_and(|v| v.len() > 16384)
        || input.prompt.as_ref().is_some_and(|v| v.len() > 16384)
    {
        return Err(invalid(
            "Event condition and action are each limited to 16 KiB",
        ));
    }
    if serde_json::to_vec(input)
        .map_err(|_| invalid("Invalid event Automation"))?
        .len()
        > 48 * 1024
    {
        return Err(invalid("Event Automation configuration exceeds 48 KiB"));
    }
    if f.kinds.is_empty() || f.kinds.len() > 8 || f.repositories.len() > 100 || f.labels.len() > 100
    {
        return Err(invalid("Invalid event filter size"));
    }
    if f.repositories.iter().any(|v| {
        v.len() > 512
            || v.trim() != v
            || v.split('/').count() != 2
            || v.split('/').any(str::is_empty)
    }) || f
        .labels
        .iter()
        .any(|v| v.trim().is_empty() || v.len() > 100)
    {
        return Err(invalid("Invalid repository or label filter"));
    }
    if let Some(source) = &f.source_id {
        let present: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM sources WHERE id=?1 AND library_id=?2)",
            params![source, library],
            |r| r.get(0),
        )?;
        if !present {
            return Err(invalid("Source is outside this Space"));
        }
    }
    Ok(())
}
pub(super) fn save(
    c: &Connection,
    automation: &str,
    filter: Option<&AutomationSourceFilter>,
) -> Result<(), StoreError> {
    c.execute(
        "DELETE FROM automation_event_filters WHERE automation_id=?1",
        [automation],
    )?;
    let Some(filter) = filter else {
        return Ok(());
    };
    c.execute(
        "INSERT INTO automation_event_filters(automation_id,filter_json) VALUES(?1,?2)",
        params![
            automation,
            serde_json::to_string(filter).map_err(|_| StoreError::new(
                StoreErrorCode::InvalidInput,
                "Invalid filter",
                false
            ))?
        ],
    )?;
    c.execute(
        "UPDATE automations SET next_run_at=NULL WHERE automation_id=?1",
        [automation],
    )?;
    Ok(())
}
pub(crate) fn matches(
    f: &AutomationSourceFilter,
    source: &str,
    thread: &ExternalThread,
    event: &SourceTriggerInput,
) -> bool {
    if f.source_id.as_ref().is_some_and(|id| id != source)
        || (!f.repositories.is_empty()
            && !f
                .repositories
                .iter()
                .any(|r| r.eq_ignore_ascii_case(&thread.repository)))
        || (f.actor_class == Some(AutomationActorFilter::Person)
            && event.actor_class != SourceActorClass::Person)
    {
        return false;
    }
    let kind = match event.kind.as_str() {
        "opened" if thread.kind == ExternalThreadKind::Issue => AutomationSourceEventKind::NewIssue,
        "opened" => AutomationSourceEventKind::NewPr,
        "comment" | "review_comment" => AutomationSourceEventKind::Comment,
        "review" => AutomationSourceEventKind::Review,
        "check_failed" => AutomationSourceEventKind::CheckFailed,
        "check_passed" => AutomationSourceEventKind::CheckPassed,
        "check" | "status"
            if matches!(
                event.metadata["state"].as_str(),
                Some("failure" | "timed_out" | "cancelled" | "action_required" | "error")
            ) =>
        {
            AutomationSourceEventKind::CheckFailed
        }
        "check" | "status" if event.metadata["state"] == "success" => {
            AutomationSourceEventKind::CheckPassed
        }
        "labeled" => AutomationSourceEventKind::LabelAdded,
        "unlabeled" => AutomationSourceEventKind::LabelRemoved,
        _ => return false,
    };
    if !f.kinds.contains(&kind) {
        return false;
    }
    if f.labels.is_empty() {
        return true;
    }
    let label = event.metadata.get("label").and_then(|v| {
        v.as_str()
            .or_else(|| v.get("name").and_then(|v| v.as_str()))
    });
    let labels = event.metadata.get("labels").and_then(|v| v.as_array());
    if matches!(
        kind,
        AutomationSourceEventKind::LabelAdded | AutomationSourceEventKind::LabelRemoved
    ) {
        return f
            .labels
            .iter()
            .any(|wanted| label.is_some_and(|v| v.eq_ignore_ascii_case(wanted)));
    }
    f.labels.iter().any(|wanted| {
        labels.is_some_and(|values| {
            values.iter().any(|v| {
                v.as_str()
                    .or_else(|| v.get("name").and_then(|v| v.as_str()))
                    .is_some_and(|v| v.eq_ignore_ascii_case(wanted))
            })
        })
    })
}
