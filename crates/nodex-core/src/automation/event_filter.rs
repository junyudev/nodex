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
    f: &AutomationEventFilter,
) -> Result<(), StoreError> {
    let invalid = |message| StoreError::new(StoreErrorCode::InvalidInput, message, false);
    if input.kind == AutomationExecutionKind::Heartbeat {
        return Err(invalid(
            "A heartbeat continues its Session on a clock trigger",
        ));
    }
    if input.cwds.as_ref().is_some_and(|roots| roots.len() > 1) {
        return Err(invalid(
            "An event trigger accepts at most one workspace root in cwds",
        ));
    }
    if input.model.as_deref().is_none_or(|v| v.trim().is_empty()) {
        return Err(invalid("An event trigger requires an exact Agent model"));
    }
    if input
        .project_id
        .as_deref()
        .is_none_or(|id| id.trim().is_empty())
    {
        return Err(invalid("An event trigger requires a project_id"));
    }
    if input.target_session_id.is_some() {
        return Err(invalid(
            "An event trigger starts a new Page and cannot set target_session_id",
        ));
    }
    if input
        .condition_text
        .as_deref()
        .is_none_or(|v| v.trim().is_empty())
        || input.prompt.as_deref().is_none_or(|v| v.trim().is_empty())
    {
        return Err(invalid(
            "An event trigger requires condition_text and a prompt",
        ));
    }
    if input
        .condition_text
        .as_ref()
        .is_some_and(|v| v.len() > 16384)
        || input.prompt.as_ref().is_some_and(|v| v.len() > 16384)
    {
        return Err(invalid(
            "An event trigger limits condition_text and prompt to 16 KiB each",
        ));
    }
    if serde_json::to_vec(input)
        .map_err(|_| invalid("Invalid event Automation"))?
        .len()
        > 48 * 1024
    {
        return Err(invalid("Event Automation configuration exceeds 48 KiB"));
    }
    validate_filter(f).map_err(invalid)?;
    if let Some(source) = &f.source_id {
        let present: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM sources WHERE id=?1 AND library_id=?2)",
            params![source, library],
            |r| r.get(0),
        )?;
        if !present {
            return Err(invalid(
                "An event trigger filter source_id must name a Source in this Space",
            ));
        }
    }
    Ok(())
}
pub(super) fn validate_filter(f: &AutomationEventFilter) -> Result<(), &'static str> {
    if f.events.is_empty()
        || f.events.len() > 8
        || f.repositories.len() > 100
        || f.labels.len() > 100
    {
        return Err(
            "An event trigger filter needs 1–8 events and at most 100 repositories and 100 labels",
        );
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
        return Err("An event trigger filter has invalid repositories or labels");
    }
    Ok(())
}

pub(crate) fn matches(
    f: &AutomationEventFilter,
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
        || (f.actor_class == AutomationActorFilter::Person
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
    if !f.events.contains(&kind) {
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
