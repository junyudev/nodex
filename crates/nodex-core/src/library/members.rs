//! Library-scoped people and the Profile's local person identity.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{
    BoundModuleContext,
    library::{Member, MemberLifecycle, PageAssignee, PageWork},
};
use rusqlite::{Connection, OptionalExtension, params};

pub(super) fn list(connection: &Connection, library: &str) -> Result<Vec<Member>, StoreError> {
    let members = connection.prepare("SELECT id,library_id,display_name,lifecycle,revision,role FROM members WHERE library_id=?1 ORDER BY display_name COLLATE NOCASE,id LIMIT 1025")?
        .query_map([library], |row| Ok(Member {
            id: row.get(0)?, library_id: row.get(1)?, display_name: row.get(2)?,
            lifecycle: match row.get::<_,String>(3)?.as_str() {
                "active" => MemberLifecycle::Active,
                "removed" => MemberLifecycle::Removed,
                _ => return Err(rusqlite::Error::InvalidQuery),
            }, revision: row.get(4)?, role: match row.get::<_,String>(5)?.as_str() {
                "owner" => nodex_core_contracts::library::MemberRole::Owner,
                "member" => nodex_core_contracts::library::MemberRole::Member,
                _ => return Err(rusqlite::Error::InvalidQuery),
            },
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

pub(super) fn requesting(
    connection: &Connection,
    context: &BoundModuleContext,
    library: &str,
) -> Result<Member, StoreError> {
    let id = crate::infrastructure::actors::requesting_member(connection, context)?;
    list(connection, library)?
        .into_iter()
        .find(|member| member.id == id && member.lifecycle == MemberLifecycle::Active)
        .ok_or_else(|| invalid("Requesting Member is unavailable"))
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
    if is_active(connection, library, id)? {
        return Ok(());
    }
    Err(invalid(
        "Page work requires an active Member in the same Library",
    ))
}

/// Shared transactional membership check; credentials and transport identity stay in Library.
pub(crate) fn is_active(
    connection: &Connection,
    library: &str,
    id: &str,
) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM members WHERE id=?1 AND library_id=?2 AND lifecycle='active')",
        params![id, library],
        |r| r.get::<_, bool>(0),
    )?)
}

/// Attribution chooses the requester; caller-authored JSON cannot choose an actor.
pub(crate) fn initialize_owner(
    connection: &Connection,
    context: &BoundModuleContext,
    page_id: &str,
    source_page: Option<&str>,
) -> Result<(), StoreError> {
    let source = match (source_page, &context.agent_attribution) {
        (Some(id), _) => Some(id.to_owned()),
        (None, Some(actor)) => requester_page(connection, &actor.session_id)?,
        (None, None) => None,
    };
    let Some(source) = source else {
        if let Some(member) = context
            .actor
            .member_id()
            .or(context.authorizing_member_id.as_deref())
        {
            connection.execute("UPDATE block_properties SET value_json=json_set(value_json,'$.owner',?2) WHERE block_id=?1 AND property_key='work'",params![page_id,member])?;
        }
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
        vec![
            nodex_core_contracts::library::LibraryBlockPropertyFieldMutation::IntrinsicSet {
                block_id: page.to_owned(),
                property_key: "work".into(),
                expected_revision: revision,
                value: serde_json::to_value(&work)
                    .map_err(|_| invalid("Page work cannot be encoded"))?,
            },
        ],
    )
}

/// Automation admission carries a person-authorized assignment. The Automation's dispatch
/// owns execution, so Page readiness must not enqueue a second launch.
pub(crate) fn initialize_automation_work(
    connection: &Connection,
    library: &str,
    page: &str,
    owner: &str,
    selection: &nodex_core_contracts::library::AgentWorkSelection,
    now: &str,
) -> Result<(), StoreError> {
    super::validate_agent_selection(selection)?;
    let work = PageWork {
        owner: owner.to_owned(),
        assignee: Some(PageAssignee::Agent {
            instance_id: selection.instance_id.clone(),
            model: selection.model.clone(),
            effort: selection.effort.clone(),
        }),
        auto_start: false,
    };
    validate_work(connection, library, &work)?;
    connection.execute("UPDATE block_properties SET value_json=?2,revision=revision+1,updated_at=?3 WHERE block_id=?1 AND property_key='work'",params![page,serde_json::to_string(&work).map_err(|_|invalid("Automation work cannot be encoded"))?,now])?;
    super::mutation::refresh_page_intrinsic_projection(connection, page, now)
}

pub(crate) fn initialize_automation_owner(
    connection: &Connection,
    library: &str,
    page: &str,
    owner: &str,
    now: &str,
) -> Result<(), StoreError> {
    require_member(connection, library, owner)?;
    let changed = connection.execute("UPDATE block_properties SET value_json=json_set(value_json,'$.owner',?2),revision=revision+1,updated_at=?3 WHERE block_id=?1 AND property_key='work' AND json_extract(value_json,'$.owner') IS NOT ?2",params![page,owner,now])?;
    if changed == 0 {
        return Ok(());
    }
    super::mutation::refresh_page_intrinsic_projection(connection, page, now)
}

fn requester_page(connection: &Connection, session: &str) -> Result<Option<String>, StoreError> {
    Ok(connection
        .query_row(
            &format!("SELECT {}", requester_page_sql("?1")),
            [session],
            |r| r.get(0),
        )
        .optional()?
        .flatten())
}

/// The Page whose work a Session does: the Page it was launched for, else its only active Page.
fn requester_page_sql(session: &str) -> String {
    format!(
        "(SELECT page_id FROM (SELECT page_id,0 AS priority,created_at AS linked_at FROM page_work_launches WHERE session_id={session} \
         UNION ALL SELECT page_id,1 AS priority,set_at FROM page_active_chats WHERE session_id={session} \
           AND (SELECT count(*) FROM page_active_chats single WHERE single.session_id={session})=1) \
         ORDER BY priority,linked_at,page_id LIMIT 1)"
    )
}

/// [`requester_owner_for_session`] as an SQL expression over a Session and Library expression.
pub(crate) fn session_page_owner_sql(session: &str, library: &str) -> String {
    format!(
        "(SELECT json_extract(work.value_json,'$.owner') FROM block_properties work \
         WHERE work.block_id={} AND work.library_id={library} AND work.property_key='work')",
        requester_page_sql(session)
    )
}
/// Managed work carries its requesting Member through new standing records.
pub(crate) fn requester_owner(
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
) -> Result<String, StoreError> {
    if let Some(principal) = &context.principal {
        return Ok(principal.member_id.clone());
    }
    if let Some(actor) = &context.agent_attribution
        && let Some(page) = requester_page(connection, &actor.session_id)?
            && let Some(owner)=connection.query_row("SELECT json_extract(value_json,'$.owner') FROM block_properties WHERE block_id=?1 AND library_id=?2 AND property_key='work'",params![page,library],|r|r.get::<_,String>(0)).optional()? {return Ok(owner);}
    connection
        .query_row(
            "SELECT member_id FROM local_profile_members WHERE library_id=?1",
            [library],
            |r| r.get(0),
        )
        .map_err(Into::into)
}

pub(crate) fn requester_owner_for_session(
    connection: &Connection,
    library: &str,
    session: &str,
) -> Result<Option<String>, StoreError> {
    Ok(connection.query_row(
        &format!("SELECT {}", session_page_owner_sql("?1", "?2")),
        params![session, library],
        |r| r.get(0),
    )?)
}
