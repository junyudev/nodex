//! Person-owned execution policy. Holds compose by union; no child can waive a parent.
use super::{
    ProjectWorkspaceApplyOutcome,
    mutation::{WorkspaceMutationEffects, finish_mutation, finish_no_op},
    session_mutation::{sqlite_now, validate_id},
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{AdapterKind, BoundModuleContext, workspace::*};
use rusqlite::{Connection, params};

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn coordinates<'a>(scope: &'a ExecutionHoldScope, library: &'a str) -> (&'static str, &'a str) {
    match scope {
        ExecutionHoldScope::Page { page_id } => ("page", page_id),
        ExecutionHoldScope::Project { project_id } => ("project", project_id),
        ExecutionHoldScope::Space => ("space", library),
    }
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ExecutionHold> {
    let kind: String = r.get(0)?;
    let id = r.get(1)?;
    let scope = match kind.as_str() {
        "page" => ExecutionHoldScope::Page { page_id: id },
        "project" => ExecutionHoldScope::Project { project_id: id },
        "space" => ExecutionHoldScope::Space,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(ExecutionHold {
        scope,
        actor: r.get(2)?,
        revision: r.get(3)?,
        paused_at: r.get(4)?,
    })
}
/// Correlated with a Page expression. Project placement is resolved by Core, never by Main.
fn page_condition(page: &str) -> String {
    format!(
        "(hold.scope_kind='space' AND hold.scope_id=(SELECT library_id FROM blocks WHERE id={page})) OR (hold.scope_kind='page' AND hold.scope_id={page}) OR (hold.scope_kind='project' AND (EXISTS(SELECT 1 FROM page_workspaces w WHERE w.page_id={page} AND w.project_id=hold.scope_id) OR EXISTS(SELECT 1 FROM pages p JOIN data_sources s ON p.parent_kind='data_source' AND s.id=p.parent_id JOIN projects project ON project.id=hold.scope_id AND s.home_database_block_id=COALESCE(project.database_block_id,(SELECT database_block_id FROM project_database_bindings WHERE project_id=project.id AND lifecycle='active')) WHERE p.block_id={page})))"
    )
}
pub(crate) fn page_predicate(page: &str) -> String {
    format!(
        "EXISTS(SELECT 1 FROM execution_holds hold WHERE {})",
        page_condition(page)
    )
}
pub(crate) fn session_predicate(session: &str) -> String {
    let page = page_predicate("work.page_id");
    format!(
        "(EXISTS(SELECT 1 FROM execution_holds h WHERE (h.scope_kind='space' AND h.scope_id=(SELECT id FROM libraries LIMIT 1)) OR (h.scope_kind='project' AND h.scope_id=(SELECT project_id FROM project_sessions WHERE id={session}))) OR EXISTS(SELECT 1 FROM (SELECT session_id,page_id FROM page_active_chats UNION SELECT session_id,page_id FROM session_workspaces JOIN page_workspaces USING(workspace_id) UNION SELECT session_id,page_id FROM page_work_launches) work WHERE work.session_id={session} AND {page}))"
    )
}
pub(crate) fn event_predicate(page: &str, session: &str) -> String {
    format!(
        "(EXISTS(SELECT 1 FROM execution_holds WHERE scope_kind='space') OR {} OR {})",
        page_predicate(page),
        session_predicate(session)
    )
}
pub(crate) fn for_page(
    connection: &Connection,
    page: &str,
) -> Result<Vec<ExecutionHold>, StoreError> {
    let predicate = page_condition("?1");
    Ok(connection.prepare(&format!("SELECT hold.scope_kind,hold.scope_id,hold.actor,hold.revision,hold.paused_at FROM execution_holds hold WHERE {predicate} ORDER BY scope_kind,scope_id"))?.query_map([page], row)?.collect::<rusqlite::Result<Vec<_>>>()?)
}
/// Bounded Turn windows reuse the effective-policy predicate, without one read per card.
pub(crate) fn for_pages(
    connection: &Connection,
    pages: &[&str],
) -> Result<std::collections::BTreeMap<String, Vec<ExecutionHold>>, StoreError> {
    if pages.len() > 200 {
        return Err(invalid("Hold window is bounded to 200 Pages"));
    }
    let mut result = std::collections::BTreeMap::<String, Vec<ExecutionHold>>::new();
    if !connection.query_row("SELECT EXISTS(SELECT 1 FROM execution_holds)", [], |r| {
        r.get::<_, bool>(0)
    })? {
        return Ok(result);
    }
    let predicate = page_condition("selected.value");
    let values=connection.prepare(&format!("SELECT hold.scope_kind,hold.scope_id,hold.actor,hold.revision,hold.paused_at,selected.value FROM json_each(?1) selected JOIN execution_holds hold ON {predicate} ORDER BY selected.value,hold.scope_kind,hold.scope_id"))?.query_map([serde_json::json!(pages).to_string()], |r|Ok((r.get::<_,String>(5)?,row(r)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (page, hold) in values {
        result.entry(page).or_default().push(hold);
    }
    Ok(result)
}
pub(crate) fn for_session(
    connection: &Connection,
    session: &str,
) -> Result<Vec<ExecutionHold>, StoreError> {
    let pages = connection.prepare("SELECT page_id FROM page_active_chats WHERE session_id=?1 UNION SELECT page_id FROM session_workspaces JOIN page_workspaces USING(workspace_id) WHERE session_id=?1 UNION SELECT page_id FROM page_work_launches WHERE session_id=?1")?.query_map([session], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut holds = connection.prepare("SELECT scope_kind,scope_id,actor,revision,paused_at FROM execution_holds WHERE (scope_kind='space') OR (scope_kind='project' AND scope_id=(SELECT project_id FROM project_sessions WHERE id=?1))")?.query_map([session], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    for page in pages {
        holds.extend(for_page(connection, &page)?);
    }
    holds.sort_by(|a, b| coordinates(&a.scope, "").cmp(&coordinates(&b.scope, "")));
    holds.dedup();
    Ok(holds)
}
pub(crate) fn event_held(
    connection: &Connection,
    page: Option<&str>,
    session: Option<&str>,
) -> Result<bool, StoreError> {
    if let Some(page) = page
        && !for_page(connection, page)?.is_empty()
    {
        return Ok(true);
    }
    if let Some(session) = session
        && !for_session(connection, session)?.is_empty()
    {
        return Ok(true);
    }
    Ok(false)
}
pub(crate) fn routing_held(connection: &Connection, request: &str) -> Result<bool, StoreError> {
    let predicate = page_predicate("work.page_id");
    Ok(connection.query_row(&format!("SELECT EXISTS(SELECT 1 FROM execution_holds WHERE scope_kind='space') OR EXISTS(SELECT 1 FROM inbox_suggestion_request_pages work WHERE request_id=?1 AND {predicate}) OR EXISTS(SELECT 1 FROM execution_holds hold JOIN inbox_suggestion_requests request ON request.scope_project_id=hold.scope_id WHERE request.request_id=?1 AND hold.scope_kind='project')"),[request],|r|r.get(0))?)
}
/// Pause does not spend a routing request's retained deadline, including overlapping holds.
fn reconcile_routing_clocks(connection: &Connection) -> Result<(), StoreError> {
    let now: i64 = connection.query_row(
        "SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)",
        [],
        |r| r.get(0),
    )?;
    let requests=connection.prepare("SELECT delivery.request_id,delivery.generation FROM inbox_routing_deliveries delivery JOIN inbox_suggestion_requests request USING(request_id) WHERE request.state='pending' AND request.generation=delivery.generation")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (request, generation) in requests {
        if routing_held(connection, &request)? {
            connection.execute("INSERT INTO execution_hold_routing_clocks(request_id,generation,paused_at_ms) VALUES(?1,?2,?3) ON CONFLICT(request_id,generation) DO UPDATE SET paused_at_ms=COALESCE(paused_at_ms,excluded.paused_at_ms)",params![request,generation,now])?;
            continue;
        }
        connection.execute("UPDATE execution_hold_routing_clocks SET elapsed_ms=elapsed_ms+MAX(0,?3-paused_at_ms),paused_at_ms=NULL WHERE request_id=?1 AND generation=?2 AND paused_at_ms IS NOT NULL",params![request,generation,now])?;
    }
    Ok(())
}
pub(super) fn read(
    connection: &Connection,
    library: &str,
    request: ProjectWorkspaceRead,
) -> Result<ProjectWorkspaceReadValue, StoreError> {
    match request {
        ProjectWorkspaceRead::HeldSessionWindow {
            after_session_id,
            limit,
        } => {
            if !(1..=100).contains(&limit) {
                return Err(invalid("Hold read limit must be 1–100"));
            }
            let predicate = session_predicate("session.id");
            let session_ids=connection.prepare(&format!("SELECT session.id FROM project_sessions session WHERE session.archived=0 AND (?1 IS NULL OR session.id>?1) AND {predicate} ORDER BY session.id LIMIT ?2"))?.query_map(params![after_session_id,limit],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ProjectWorkspaceReadValue::HeldSessionWindow { session_ids })
        }
        ProjectWorkspaceRead::EffectiveExecutionHold { target } => {
            let holds = match target {
                ExecutionHoldTarget::Page { page_id } => {
                    validate_scope(
                        connection,
                        library,
                        &ExecutionHoldScope::Page {
                            page_id: page_id.clone(),
                        },
                    )?;
                    for_page(connection, &page_id)?
                }
                ExecutionHoldTarget::Session { session_id } => {
                    super::session_mutation::require_session(connection, library, &session_id)?;
                    for_session(connection, &session_id)?
                }
            };
            Ok(ProjectWorkspaceReadValue::EffectiveExecutionHold { holds })
        }
        ProjectWorkspaceRead::ExecutionHolds { after_key, limit } => {
            if !(1..=100).contains(&limit) {
                return Err(invalid("Hold read limit must be 1–100"));
            }
            let mut values = connection.prepare("SELECT scope_kind,scope_id,actor,revision,paused_at,scope_kind||':'||scope_id FROM execution_holds WHERE (?1 IS NULL OR scope_kind||':'||scope_id>?1) AND actor IN (SELECT id FROM members WHERE library_id=?2) ORDER BY scope_kind,scope_id LIMIT ?3")?.query_map(params![after_key,library,limit+1], |r| Ok((row(r)?,r.get::<_,String>(5)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let more = values.len() > limit as usize;
            values.truncate(limit as usize);
            let next_key = if more {
                values.last().map(|v| v.1.clone())
            } else {
                None
            };
            Ok(ProjectWorkspaceReadValue::ExecutionHolds {
                holds: values.into_iter().map(|v| v.0).collect(),
                next_key,
            })
        }
        _ => Err(invalid("Not a hold read")),
    }
}
fn validate_scope(
    connection: &Connection,
    library: &str,
    scope: &ExecutionHoldScope,
) -> Result<(), StoreError> {
    let (kind, id) = coordinates(scope, library);
    validate_id("scope_id", id)?;
    let valid = match kind { "page" => connection.query_row("SELECT EXISTS(SELECT 1 FROM pages p JOIN blocks b ON b.id=p.block_id WHERE p.block_id=?1 AND b.library_id=?2)",params![id,library],|r|r.get::<_,bool>(0))?, "project" => connection.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND library_id=?2)",params![id,library],|r|r.get(0))?, _ => true };
    if !valid {
        return Err(invalid("Hold scope is outside this Space"));
    }
    Ok(())
}
/// A Hold belongs to a Member: the person who paused, or the Member whose Agent paused for them.
fn hold_member(context: &BoundModuleContext) -> Result<String, StoreError> {
    let member = context.actor.member_id().filter(|_| {
        matches!(
            context.adapter,
            AdapterKind::ElectronHost
                | AdapterKind::NativeCli
                | AdapterKind::RemoteMember
                | AdapterKind::Test
        )
    });
    member.map(str::to_owned).ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::Unauthorized,
            "Pausing and resuming work act for a Member",
            false,
        )
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    library: &str,
    epoch: &str,
    operation: &str,
    hash: &str,
    intent: &ProjectWorkspaceIntent,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let member = hold_member(context)?;
    let (scope, pause) = match intent {
        ProjectWorkspaceIntent::PauseWork { scope } => (scope, true),
        ProjectWorkspaceIntent::ResumeWork { scope } => (scope, false),
        _ => return Err(invalid("Not a hold command")),
    };
    validate_scope(connection, library, scope)?;
    let (kind, id) = coordinates(scope, library);
    let now = sqlite_now(connection)?;
    let changed = if pause {
        let revision = crate::infrastructure::local_commit::head(connection)? + 1;
        connection.execute("INSERT INTO execution_holds(scope_kind,scope_id,actor,revision,paused_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING",params![kind,id,member,revision,now])?
    } else {
        connection.execute(
            "DELETE FROM execution_holds WHERE scope_kind=?1 AND scope_id=?2",
            params![kind, id],
        )?
    };
    if changed == 0 {
        return finish_no_op(
            connection,
            context,
            epoch,
            operation,
            hash,
            "execution_hold",
            vec![],
            vec![],
            &now,
        );
    }
    // The same scope predicate owns policy and Turn invalidation, including inherited holds.
    let predicate = page_condition("page.block_id");
    connection.execute(&format!("INSERT INTO page_turn_dirty SELECT page.block_id FROM pages page CROSS JOIN (SELECT ?1 AS scope_kind,?2 AS scope_id) hold WHERE {predicate} ON CONFLICT DO NOTHING"),params![kind,id])?;
    reconcile_routing_clocks(connection)?;
    // Frozen messages are immutable. Main reconciles acceptance before releasing their facts.
    if pause {
        connection.execute("UPDATE coordinator_event_batches SET invalidated_at=?1 WHERE accepted_at IS NULL AND discarded_at IS NULL",[&now])?;
    }
    let pages = match scope {
        ExecutionHoldScope::Page { page_id } => vec![page_id.clone()],
        _ => vec![],
    };
    finish_mutation(
        connection,
        context,
        epoch,
        operation,
        hash,
        WorkspaceMutationEffects {
            operation_kind: "execution_hold",
            project_catalog_change: None,
            change_project_id: None,
            project_ids: match scope {
                ExecutionHoldScope::Project { project_id } => vec![project_id.clone()],
                _ => vec![],
            },
            session_ids: vec![],
            thread_ids: vec![],
            session_summary_scopes: vec![ProjectSessionInvalidationScope::All],
            session_detail_ids: vec![],
            block_ids: pages.clone(),
            page_ids: pages,
            document_ids: vec![],
            database_ids: vec![],
            data_source_ids: vec![],
            view_ids: vec![],
            document_heads: vec![],
            committed_at: now,
        },
    )
}
