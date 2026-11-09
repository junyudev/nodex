//! Library-scoped people and the Profile's local person identity.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{
    BoundModuleContext,
    library::{Member, MemberLifecycle, PageAssignee, PageWork},
};
use rusqlite::{Connection, OptionalExtension, params};

pub(super) fn list(connection: &Connection, library: &str) -> Result<Vec<Member>, StoreError> {
        .query_map([library], |row| Ok(Member {
            id: row.get(0)?, library_id: row.get(1)?, display_name: row.get(2)?,
            lifecycle: match row.get::<_,String>(3)?.as_str() {
                "active" => MemberLifecycle::Active,
                "removed" => MemberLifecycle::Removed,
                _ => return Err(rusqlite::Error::InvalidQuery),
        }))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if members.len() > 1024 {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "Members exceed the Library read budget",
            false,
        ));
    }
    Ok(members)
}

    list(connection, library)?
        .into_iter()
}

pub(super) fn validate_work(
    connection: &Connection,
    library: &str,
    work: &PageWork,
) -> Result<(), StoreError> {
    require_member(connection, library, &work.owner)?;
    if let Some(PageAssignee::Member { member_id }) = &work.assignee {
        require_member(connection, library, member_id)?;
    }
    Ok(())
}
fn require_member(connection: &Connection, library: &str, id: &str) -> Result<(), StoreError> {
        return Ok(());
    }
    Err(invalid(
        "Page work requires an active Member in the same Library",
    ))
}

/// Attribution chooses the requester; caller-authored JSON cannot choose an actor.
pub(crate) fn initialize_owner(
    connection: &Connection,
    context: &BoundModuleContext,
    page_id: &str,
    source_page: Option<&str>,
) -> Result<(), StoreError> {
    let source = match (source_page, &context.agent_attribution) {
    };
    let Some(source) = source else {
        return Ok(());
    };
    connection.execute("UPDATE block_properties SET value_json=json_set(value_json,'$.owner',(SELECT json_extract(value_json,'$.owner') FROM block_properties WHERE block_id=?2 AND library_id=?3 AND property_key='work')) WHERE block_id=?1 AND property_key='work' AND EXISTS(SELECT 1 FROM block_properties WHERE block_id=?2 AND library_id=?3 AND property_key='work')",params![page_id,source,context.library_id.0])?;
    Ok(())
}
fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

/// Handing off work fills an empty assignment without granting automatic-start consent.
pub(crate) fn assign_agent_if_unassigned(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
    commit: &crate::infrastructure::local_commit::CommitContext,
    page: &str,
    selection: &nodex_core_contracts::library::AgentWorkSelection,
) -> Result<(), StoreError> {
    super::validate_agent_selection(selection)?;
    let (encoded, revision):(String,i64)=connection.query_row("SELECT value_json,revision FROM block_properties WHERE block_id=?1 AND library_id=?2 AND property_key='work'",params![page,library],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let mut work = super::parse_page_work(
        &serde_json::from_str(&encoded).map_err(|_| invalid("Page work JSON is invalid"))?,
    )?;
    let assignment = Some(PageAssignee::Agent {
        instance_id: selection.instance_id.clone(),
        model: selection.model.clone(),
        effort: selection.effort.clone(),
    });
    if work.assignee.is_some() {
        return Ok(());
    }
    work.assignee = assignment;
    work.auto_start = false;
    let operation =
        crate::domain::identity::stable_uuid_v7(commit.operation_id(), "chat-assignment", page);
    super::page_property_mutation::apply_collaborator(
        connection,
        context,
        commit,
        &operation,
    )
}
