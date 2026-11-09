//! Stable Page Git ownership, independent of Runs and physical checkout lifetime.
use super::{
    ProjectWorkspaceApplyOutcome,
    session_mutation::{sqlite_now, validate_id},
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{AdapterKind, BoundModuleContext, workspace::*};
use rusqlite::{Connection, OptionalExtension, params};

pub(crate) const CLEANUP_STATUSES: &[&str] = &["done", "canceled"];
fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Conflict, message, false)
}
fn workspace(connection: &Connection, id: &str) -> Result<Option<PageWorkspace>, StoreError> {
    Ok(connection.query_row("SELECT workspace_id,page_id,project_id,repository_url,repository_root,branch_name,base_commit_oid,lifecycle,revision,allocation_operation_id,worktree_path,failure FROM page_workspaces WHERE workspace_id=?1", [id], |r| {
        let state: String = r.get(7)?;
        Ok(PageWorkspace { workspace_id:r.get(0)?,page_id:r.get(1)?,project_id:r.get(2)?,repository_url:r.get(3)?,repository_root:r.get(4)?,branch_name:r.get(5)?,base_commit_oid:r.get(6)?,lifecycle:serde_json::from_value(serde_json::Value::String(state)).map_err(|_|rusqlite::Error::InvalidQuery)?,revision:r.get(8)?,allocation_operation_id:r.get(9)?,worktree_path:r.get(10)?,failure:r.get(11)? })
    }).optional()?)
}
fn by_page(connection: &Connection, page: &str) -> Result<Option<PageWorkspace>, StoreError> {
    let id = connection
        .query_row(
            "SELECT workspace_id FROM page_workspaces WHERE page_id=?1",
            [page],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    id.map(|id| workspace(connection, &id))
        .transpose()
        .map(Option::flatten)
}
fn require_scope(
    connection: &Connection,
    library: &str,
    value: &PageWorkspace,
) -> Result<(), StoreError> {
    let valid: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND library_id=?2)",
        params![value.project_id, library],
        |r| r.get(0),
    )?;
    if !valid {
        return Err(invalid("Workspace is outside this Library"));
    }
    Ok(())
}
fn bind(connection: &Connection, value: &PageWorkspace, session: &str) -> Result<(), StoreError> {
    validate_id("session_id", session)?;
    let project: Option<Option<String>> = connection
        .query_row(
            "SELECT project_id FROM project_sessions WHERE id=?1",
            [session],
            |r| r.get(0),
        )
        .optional()?;
    if project.flatten().as_deref() != Some(value.project_id.as_str()) {
        return Err(conflict(
            "Session and Workspace must belong to the same Project",
        ));
    }
    let existing: Option<String> = connection
        .query_row(
            "SELECT workspace_id FROM session_workspaces WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )
        .optional()?;
    if existing
        .as_ref()
        .is_some_and(|id| id != &value.workspace_id)
    {
        return Err(conflict("Session already consumes another Workspace"));
    }
    connection.execute(
        "INSERT OR IGNORE INTO session_workspaces(session_id,workspace_id) VALUES(?1,?2)",
        params![session, value.workspace_id],
    )?;
    Ok(())
}
fn terminal(connection: &Connection, page: &str) -> Result<bool, StoreError> {
    let state: Option<String> = connection.query_row("SELECT json_extract(v.value_json,'$') FROM data_source_property_values v JOIN data_source_page_memberships m ON m.id=v.membership_id AND m.data_source_id=v.data_source_id WHERE m.page_block_id=?1 AND v.property_id='status'", [page], |r|r.get(0)).optional()?.flatten();
    Ok(state
        .as_deref()
        .is_some_and(|s| CLEANUP_STATUSES.contains(&s)))
}
/// Called by the Status writer in the same transaction as the stage change.
pub(crate) fn status_changed(
    connection: &Connection,
    membership: &str,
    status: &serde_json::Value,
) -> Result<(), StoreError> {
    if !status
        .as_str()
        .is_some_and(|s| CLEANUP_STATUSES.contains(&s))
    {
        return Ok(());
    }
    connection.execute("UPDATE page_workspaces SET lifecycle='cleanup_requested',revision=revision+1 WHERE page_id=(SELECT page_block_id FROM data_source_page_memberships WHERE id=?1) AND lifecycle IN ('preparing','ready','failed')", [membership])?;
    Ok(())
}
fn limit(value: u32) -> Result<u32, StoreError> {
    if !(1..=100).contains(&value) {
        return Err(invalid("Workspace read limit must be 1–100"));
    }
    Ok(value)
}

pub(super) fn read(
    connection: &Connection,
    library: &str,
    request: ProjectWorkspaceRead,
) -> Result<ProjectWorkspaceReadValue, StoreError> {
    match request {
        ProjectWorkspaceRead::PageWorkspace { page_id } => {
            validate_id("page_id", &page_id)?;
            let value = by_page(connection, &page_id)?;
            if let Some(ref value) = value {
                require_scope(connection, library, value)?;
            }
            let pull_request = connection.query_row("SELECT page_id,workspace_id,repository,number,url,state,observed_at FROM page_pull_requests WHERE page_id=?1",[&page_id],|r|Ok(PagePullRequest {page_id:r.get(0)?,workspace_id:r.get(1)?,repository:r.get(2)?,number:r.get(3)?,url:r.get(4)?,state:r.get(5)?,observed_at:r.get(6)?})).optional()?;
            let (title, has_agent_work): (String, bool) = connection.query_row("SELECT COALESCE(m.title,''), EXISTS(SELECT 1 FROM block_properties work WHERE work.block_id=p.block_id AND work.property_key='work' AND work.value_type='json' AND json_extract(work.value_json,'$.assignee.kind')='agent') FROM pages p JOIN blocks b ON b.id=p.block_id LEFT JOIN page_read_model m ON m.page_block_id=p.block_id WHERE p.block_id=?1 AND b.library_id=?2", params![page_id,library],|r|Ok((r.get(0)?,r.get(1)?)))?;
            let page = nodex_core_contracts::database::DatabaseWorkPage {
                page_id: page_id.clone(),
                page_key: crate::database::current_page_key_for_page(
                    connection, library, &page_id,
                )?,
                title,
                status: None,
            };
            Ok(ProjectWorkspaceReadValue::PageWorkspace {
                workspace: value,
                pull_request,
                page,
                has_agent_work,
            })
        }
        ProjectWorkspaceRead::SessionWorkPage { session_id } => {
            validate_id("session_id", &session_id)?;
            let bound = connection.query_row(
                "SELECT w.page_id FROM session_workspaces binding JOIN page_workspaces w USING(workspace_id) JOIN projects p ON p.id=w.project_id WHERE binding.session_id=?1 AND p.library_id=?2",
                params![session_id, library], |r| r.get::<_, String>(0),
            ).optional()?;
            if bound.is_some() {
                return Ok(ProjectWorkspaceReadValue::SessionWorkPage { page_id: bound });
            }
            let pages = connection.prepare(
                "SELECT active.page_id FROM page_active_chats active JOIN project_sessions session ON session.id=active.session_id JOIN projects p ON p.id=session.project_id JOIN blocks b ON b.id=active.page_id WHERE active.session_id=?1 AND session.archived=0 AND p.library_id=?2 AND b.library_id=?2 ORDER BY active.page_id LIMIT 2",
            )?.query_map(params![session_id, library], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            // A chat may work on several Pages. Only an explicit launch can disambiguate
            // that case; never choose a directory from related-page recency.
            let page_id = (pages.len() == 1).then(|| pages[0].clone());
            Ok(ProjectWorkspaceReadValue::SessionWorkPage { page_id })
        }
        ProjectWorkspaceRead::SessionWorkspace { session_id } => {
            validate_id("session_id", &session_id)?;
            let id: Option<String> = connection
                .query_row(
                    "SELECT workspace_id FROM session_workspaces WHERE session_id=?1",
                    [session_id],
                    |r| r.get(0),
                )
                .optional()?;
            let value = id
                .map(|id| workspace(connection, &id))
                .transpose()?
                .flatten();
            if let Some(ref value) = value {
                require_scope(connection, library, value)?;
            }
            Ok(ProjectWorkspaceReadValue::SessionWorkspace { workspace: value })
        }
        ProjectWorkspaceRead::PageWorkspaceWindow {
            after_workspace_id,
            limit: count,
        } => {
            let ids=connection.prepare("SELECT w.workspace_id FROM page_workspaces w JOIN projects p ON p.id=w.project_id WHERE p.library_id=?1 AND (?2 IS NULL OR w.workspace_id>?2) ORDER BY w.workspace_id LIMIT ?3")?.query_map(params![library,after_workspace_id,limit(count)?],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let workspaces = ids
                .iter()
                .map(|id| {
                    workspace(connection, id)?.ok_or_else(|| invalid("Workspace disappeared"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(ProjectWorkspaceReadValue::PageWorkspaceWindow { workspaces })
        }
        ProjectWorkspaceRead::PageWorkspaceConsumers {
            workspace_id,
            after_session_id,
            limit: count,
        } => {
            let value = workspace(connection, &workspace_id)?
                .ok_or_else(|| invalid("Workspace is absent"))?;
            require_scope(connection, library, &value)?;
            let session_ids=connection.prepare("SELECT session_id FROM session_workspaces WHERE workspace_id=?1 AND (?2 IS NULL OR session_id>?2) ORDER BY session_id LIMIT ?3")?.query_map(params![workspace_id,after_session_id,limit(count)?],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ProjectWorkspaceReadValue::PageWorkspaceConsumers { session_ids })
        }
        _ => Err(invalid("Not a Workspace read")),
    }
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
    if !matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) || context.agent_attribution.is_some()
    {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Page Workspace allocation belongs to the Desktop Host",
            false,
        ));
    }
    let id = match intent {
        ProjectWorkspaceIntent::ClaimPageWorkspace { workspace_id, .. }
        | ProjectWorkspaceIntent::BindPageWorkspace { workspace_id, .. }
        | ProjectWorkspaceIntent::RecordPageWorkspaceReady { workspace_id, .. }
        | ProjectWorkspaceIntent::RecordPageWorkspaceFailed { workspace_id, .. }
        | ProjectWorkspaceIntent::RequestPageWorkspaceCleanup { workspace_id }
        | ProjectWorkspaceIntent::MarkPageWorkspaceRemoved { workspace_id, .. }
        | ProjectWorkspaceIntent::UpsertPagePullRequest { workspace_id, .. } => workspace_id,
        _ => return Err(invalid("Not a Workspace command")),
    };
    validate_id("workspace_id", id)?;
    let mut sessions = Vec::new();
    if let ProjectWorkspaceIntent::ClaimPageWorkspace {
        page_id,
        project_id,
        session_id,
        repository_url,
        repository_root,
        branch_name,
        base_commit_oid,
        worktree_path,
        ..
    } = intent
    {
        validate_id("page_id", page_id)?;
        if worktree_path.is_empty()
            || worktree_path.len() > 4096
            || repository_root.is_empty()
            || repository_root.len() > 4096
            || branch_name.is_empty()
            || branch_name.len() > 256
            || !matches!(base_commit_oid.len(), 40 | 64)
            || !base_commit_oid.bytes().all(|b| b.is_ascii_hexdigit())
            || repository_url
                .as_ref()
                .is_some_and(|v| v.is_empty() || v.len() > 2048)
        {
            return Err(invalid("Invalid repository or branch identity"));
        }
        let exists: bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM pages p JOIN blocks b ON b.id=p.block_id WHERE p.block_id=?1 AND b.library_id=?2)",params![page_id,library],|r|r.get(0))?;
        if !exists || terminal(connection, page_id)? {
            return Err(conflict("Page is absent or finished"));
        }
        if let Some(value) = by_page(connection, page_id)? {
            if &value.project_id != project_id
                || &value.repository_url != repository_url
                || &value.repository_root != repository_root
            {
                return Err(conflict("Page Workspace repository cannot change"));
            }
            require_scope(connection, library, &value)?;
            bind(connection, &value, session_id)?;
            if matches!(
                value.lifecycle,
                PageWorkspaceLifecycle::Removed
                    | PageWorkspaceLifecycle::Failed
                    | PageWorkspaceLifecycle::CleanupRequested
            ) {
                connection.execute("UPDATE page_workspaces SET lifecycle='preparing',worktree_path=?2,failure=NULL,revision=revision+1 WHERE workspace_id=?1",params![value.workspace_id,worktree_path])?;
            }
        } else {
            connection.execute("INSERT INTO page_workspaces(workspace_id,page_id,project_id,repository_url,repository_root,branch_name,base_commit_oid,lifecycle,revision,allocation_operation_id,worktree_path) VALUES(?1,?2,?3,?4,?5,?6,?7,'preparing',1,?8,?9)",params![id,page_id,project_id,repository_url,repository_root,branch_name,base_commit_oid,operation,worktree_path])?;
            let value = workspace(connection, id)?.ok_or_else(|| invalid("Workspace is absent"))?;
            require_scope(connection, library, &value)?;
            bind(connection, &value, session_id)?;
        }
        sessions.push(session_id.clone());
    } else {
        let value = workspace(connection, id)?.ok_or_else(|| invalid("Workspace is absent"))?;
        require_scope(connection, library, &value)?;
        match intent {
            ProjectWorkspaceIntent::BindPageWorkspace { session_id, .. } => {
                if !matches!(
                    value.lifecycle,
                    PageWorkspaceLifecycle::Ready | PageWorkspaceLifecycle::Preparing
                ) || terminal(connection, &value.page_id)?
                {
                    return Err(conflict("Workspace is unavailable for execution"));
                }
                bind(connection, &value, session_id)?;
                sessions.push(session_id.clone());
            }
            ProjectWorkspaceIntent::RecordPageWorkspaceReady {
                allocation_operation_id,
                branch_name,
                worktree_path,
                ..
            } => {
                if allocation_operation_id != &value.allocation_operation_id
                    || !matches!(
                        value.lifecycle,
                        PageWorkspaceLifecycle::Preparing
                            | PageWorkspaceLifecycle::CleanupRequested
                    )
                {
                    return Err(conflict("Workspace allocation is no longer preparing"));
                }
                if branch_name.is_empty()
                    || branch_name.len() > 256
                    || worktree_path.is_empty()
                    || worktree_path.len() > 4096
                {
                    return Err(invalid("Invalid checkout identity"));
                }
                connection.execute("UPDATE page_workspaces SET branch_name=?2,worktree_path=?3,lifecycle=CASE WHEN lifecycle='cleanup_requested' THEN lifecycle ELSE 'ready' END,failure=NULL,revision=revision+1 WHERE workspace_id=?1",params![id,branch_name,worktree_path])?;
            }
            ProjectWorkspaceIntent::RecordPageWorkspaceFailed {
                allocation_operation_id,
                failure,
                ..
            } => {
                if allocation_operation_id != &value.allocation_operation_id
                    || !matches!(
                        value.lifecycle,
                        PageWorkspaceLifecycle::Preparing
                            | PageWorkspaceLifecycle::CleanupRequested
                    )
                {
                    return Err(conflict("Workspace allocation is no longer preparing"));
                }
                if failure.trim().is_empty() || failure.len() > 4096 {
                    return Err(invalid("Invalid allocation failure"));
                }
                connection.execute("UPDATE page_workspaces SET lifecycle=CASE WHEN lifecycle='cleanup_requested' THEN lifecycle ELSE 'failed' END,failure=?2,revision=revision+1 WHERE workspace_id=?1",params![id,failure])?;
            }
            ProjectWorkspaceIntent::RequestPageWorkspaceCleanup { .. } => {
                connection.execute("UPDATE page_workspaces SET lifecycle='cleanup_requested',revision=revision+1 WHERE workspace_id=?1 AND lifecycle NOT IN ('removed','cleanup_requested')",[id])?;
            }
            ProjectWorkspaceIntent::MarkPageWorkspaceRemoved {
                expected_revision, ..
            } => {
                if value.lifecycle != PageWorkspaceLifecycle::CleanupRequested
                    || value.revision != *expected_revision
                {
                    return Err(conflict("Workspace cleanup changed"));
                }
                connection.execute("UPDATE page_workspaces SET lifecycle='removed',worktree_path=NULL,revision=revision+1 WHERE workspace_id=?1",[id])?;
            }
            ProjectWorkspaceIntent::UpsertPagePullRequest {
                head_branch,
                repository,
                number,
                url,
                state,
                observed_at,
                ..
            } => {
                if head_branch != &value.branch_name
                    || value.repository_url.as_ref() != Some(repository)
                {
                    return Err(conflict(
                        "Pull request head must match the Workspace repository and branch",
                    ));
                }
                if *number < 1
                    || !url.starts_with("https://")
                    || url.len() > 2048
                    || !["OPEN", "CLOSED", "MERGED"].contains(&state.as_str())
                    || observed_at.is_empty()
                    || observed_at.len() > 128
                {
                    return Err(invalid("Invalid pull request"));
                }
                connection.execute("INSERT INTO page_pull_requests(page_id,workspace_id,repository,number,url,state,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,repository=excluded.repository,number=excluded.number,url=excluded.url,state=excluded.state,observed_at=excluded.observed_at WHERE excluded.observed_at>=page_pull_requests.observed_at",params![value.page_id,id,repository,number,url,state,observed_at])?;
            }
            _ => return Err(invalid("Not a Workspace command")),
        }
    }
    let value = match intent {
        ProjectWorkspaceIntent::ClaimPageWorkspace { page_id, .. } => by_page(connection, page_id)?,
        _ => workspace(connection, id)?,
    }
    .ok_or_else(|| invalid("Workspace is absent"))?;
    let now = sqlite_now(connection)?;
    let effects = super::mutation::WorkspaceMutationEffects {
        operation_kind: "page_workspace",
        project_catalog_change: None,
        change_project_id: None,
        project_ids: vec![value.project_id],
        session_detail_ids: sessions.clone(),
        session_ids: sessions,
        thread_ids: vec![],
        session_summary_scopes: vec![ProjectSessionInvalidationScope::All],
        block_ids: vec![value.page_id.clone()],
        page_ids: vec![value.page_id],
        document_ids: vec![],
        database_ids: vec![],
        data_source_ids: vec![],
        view_ids: vec![],
        document_heads: vec![],
        committed_at: now.clone(),
    };
    super::mutation::run_mutation(connection, context, epoch, operation, hash, &now, |_| {
        Ok(effects)
    })
}
