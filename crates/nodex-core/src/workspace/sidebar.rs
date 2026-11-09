use std::collections::BTreeSet;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::workspace::{
    ProjectWorkspaceThreadMoveMetadataPatch, ProjectWorkspaceThreadPlacement,
    ProjectWorkspaceThreadWorkspaceTransition,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::session_mutation::{sqlite_now, validate_id};
use super::thread::apply_thread_mutation;

const MAX_PATH_BYTES: usize = 16 * 1024;

#[derive(Clone)]
struct ThreadOwner {
    project_id: Option<String>,
    session_id: String,
    session_project_id: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn move_thread(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    source_project_id: Option<&str>,
    target_project_id: Option<&str>,
    placement: &ProjectWorkspaceThreadPlacement,
    metadata: &ProjectWorkspaceThreadMoveMetadataPatch,
    workspace_transition: Option<&ProjectWorkspaceThreadWorkspaceTransition>,
    runtime_workspace_roots: Option<&[String]>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("thread_id", thread_id)?;
    if let Some(project_id) = source_project_id {
        validate_id("source_project_id", project_id)?;
    }
    if let Some(project_id) = target_project_id {
        validate_id("target_project_id", project_id)?;
        require_project(connection, library_id, project_id)?;
    }
    if let ProjectWorkspaceThreadPlacement::Before {
        thread_id: anchor_thread_id,
    }
    | ProjectWorkspaceThreadPlacement::After {
        thread_id: anchor_thread_id,
    } = placement
    {
        validate_id("placement.thread_id", anchor_thread_id)?;
        if anchor_thread_id == thread_id {
            return Err(invalid(
                "Thread placement anchor must reference another Thread",
            ));
        }
    }
    validate_move_metadata(metadata)?;
    if source_project_id == target_project_id && runtime_workspace_roots.is_some() {
        return Err(invalid(
            "Runtime workspace roots require a cross-Project Thread move",
        ));
    }

    let owner = require_thread_owner(connection, library_id, thread_id)?;
    let member = crate::infrastructure::actors::requesting_member(connection, context)?;
    if owner.project_id.as_deref() != source_project_id
        || owner.session_project_id.as_deref() != source_project_id
    {
        return Err(conflict(format!(
            "Thread {thread_id} is no longer in the expected Project"
        )));
    }

    let project_ids = [source_project_id, target_project_id]
        .into_iter()
        .flatten()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut session_summary_scopes =
        vec![super::mutation::project_session_scope(source_project_id)];
    let target_scope = super::mutation::project_session_scope(target_project_id);
    if !session_summary_scopes.contains(&target_scope) {
        session_summary_scopes.push(target_scope);
    }
    let session_ids = vec![owner.session_id.clone()];
    let thread_ids = vec![thread_id.to_owned()];
    apply_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "move_thread",
        None,
        session_summary_scopes,
        project_ids,
        session_ids,
        thread_ids,
        || {
            if let Some(transition) = workspace_transition {
                super::execution::prepare_workspace_transition_records(
                    connection,
                    thread_id,
                    source_project_id,
                    transition,
                )?;
            }

            if source_project_id != target_project_id {
                move_thread_membership(
                    connection,
                    thread_id,
                    source_project_id,
                    target_project_id,
                    &owner,
                    metadata,
                )?;
            }
            if let Some(roots) = runtime_workspace_roots {
                super::execution::replace_writable_roots_records(connection, thread_id, roots)?;
            }
            update_thread_lane_rank(
                connection,
                &member,
                thread_id,
                &owner.session_id,
                target_project_id,
                placement,
            )
        },
    )
}

fn require_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM projects \
             WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
            params![project_id, library_id],
            |_| Ok(()),
        )
        .optional()?;
    exists.ok_or_else(|| not_found("Target Project is unavailable in this Library"))
}

fn require_thread_owner(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
) -> Result<ThreadOwner, StoreError> {
    let row = connection
        .query_row(
            "SELECT thread.project_id, link.session_id, session.project_id,
               project.library_id
             FROM codex_threads thread
             LEFT JOIN project_session_threads link ON link.thread_id = thread.thread_id
             LEFT JOIN project_sessions session ON session.id = link.session_id
             LEFT JOIN projects project ON project.id = thread.project_id
             WHERE thread.thread_id = ?1",
            [thread_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Codex Thread is unavailable"))?;
    if row.0.is_some() && row.3.as_deref() != Some(library_id) {
        return Err(not_found("Codex Thread is unavailable in this Library"));
    }
    let session_id = row
        .1
        .ok_or_else(|| not_found("Codex Thread has no Project Session"))?;
    Ok(ThreadOwner {
        project_id: row.0,
        session_id,
        session_project_id: row.2,
    })
}

fn validate_move_metadata(
    metadata: &ProjectWorkspaceThreadMoveMetadataPatch,
) -> Result<(), StoreError> {
    if let Some(host_id) = metadata.execution_host_id.as_deref() {
        validate_id("execution_host_id", host_id)?;
    }
    for (name, value) in [
        ("cwd", &metadata.cwd),
        ("managed_worktree_path", &metadata.managed_worktree_path),
        (
            "projectless_output_directory",
            &metadata.projectless_output_directory,
        ),
        (
            "projectless_workspace_browser_root",
            &metadata.projectless_workspace_browser_root,
        ),
    ] {
        let Some(Some(value)) = value else {
            continue;
        };
        if value.len() > MAX_PATH_BYTES {
            return Err(invalid(format!("{name} exceeds its Core bound")));
        }
    }
    Ok(())
}

fn move_thread_membership(
    connection: &Connection,
    thread_id: &str,
    source_project_id: Option<&str>,
    target_project_id: Option<&str>,
    owner: &ThreadOwner,
    metadata: &ProjectWorkspaceThreadMoveMetadataPatch,
) -> Result<(), StoreError> {
    let now = sqlite_now(connection)?;
    let moved = connection.execute(
        "UPDATE project_sessions
         SET project_id = ?1, manual_rank = NULL, updated_at = ?2
         WHERE id = ?3 AND project_id IS ?4",
        params![target_project_id, now, owner.session_id, source_project_id],
    )?;
    if moved != 1 {
        return Err(conflict("Project Session changed during Thread move"));
    }
    let updated = connection.execute(
        "UPDATE codex_threads SET
           project_id = ?1,
           execution_host_id = CASE WHEN ?2 = 1 THEN ?3 ELSE execution_host_id END,
           cwd = CASE WHEN ?4 = 1 THEN ?5 ELSE cwd END,
           managed_worktree_path = CASE WHEN ?6 = 1 THEN ?7 ELSE managed_worktree_path END,
           projectless_output_directory = CASE WHEN ?8 = 1 THEN ?9
             ELSE projectless_output_directory END,
           projectless_workspace_browser_root = CASE WHEN ?10 = 1 THEN ?11
             ELSE projectless_workspace_browser_root END
         WHERE thread_id = ?12 AND project_id IS ?13",
        params![
            target_project_id,
            i64::from(metadata.execution_host_id.is_some()),
            metadata.execution_host_id,
            i64::from(metadata.cwd.is_some()),
            metadata.cwd.as_ref().and_then(Clone::clone),
            i64::from(metadata.managed_worktree_path.is_some()),
            metadata
                .managed_worktree_path
                .as_ref()
                .and_then(Clone::clone),
            i64::from(metadata.projectless_output_directory.is_some()),
            metadata
                .projectless_output_directory
                .as_ref()
                .and_then(Clone::clone),
            i64::from(metadata.projectless_workspace_browser_root.is_some()),
            metadata
                .projectless_workspace_browser_root
                .as_ref()
                .and_then(Clone::clone),
            thread_id,
            source_project_id,
        ],
    )?;
    if updated != 1 {
        return Err(conflict("Codex Thread changed during Thread move"));
    }
    Ok(())
}

fn update_thread_lane_rank(
    connection: &Connection,
    member: &str,
    _moved_thread_id: &str,
    moved_session_id: &str,
    target_project_id: Option<&str>,
    placement: &ProjectWorkspaceThreadPlacement,
) -> Result<(), StoreError> {
    use nodex_core_contracts::workspace::ProjectWorkspaceSessionPlacement;
    let anchor = match placement {
        ProjectWorkspaceThreadPlacement::Before { thread_id }
        | ProjectWorkspaceThreadPlacement::After { thread_id } => Some(
            connection
                .query_row(
                    "SELECT session_id FROM project_session_threads WHERE thread_id = ?1",
                    [thread_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| conflict("Thread placement anchor is unavailable"))?,
        ),
        _ => None,
    };
    let relative = match placement {
        ProjectWorkspaceThreadPlacement::Before { .. } => {
            Some(ProjectWorkspaceSessionPlacement::Before {
                session_id: anchor.expect("anchor"),
            })
        }
        ProjectWorkspaceThreadPlacement::After { .. } => {
            Some(ProjectWorkspaceSessionPlacement::After {
                session_id: anchor.expect("anchor"),
            })
        }
        _ => None,
    };
    if let Some(relative) = relative {
        return super::session_order::place(
            connection,
            member,
            moved_session_id,
            target_project_id,
            &relative,
        );
    }
    if matches!(placement, ProjectWorkspaceThreadPlacement::Default) {
        connection.execute(
            "UPDATE project_sessions SET manual_rank = NULL WHERE id = ?1",
            [moved_session_id],
        )?;
        return Ok(());
    }
    super::session_order::place_at_edge(
        connection,
        member,
        moved_session_id,
        target_project_id,
        matches!(placement, ProjectWorkspaceThreadPlacement::Start),
    )
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::workspace::{
        ProjectWorkspaceIntent, ProjectWorkspaceThreadLane,
        ProjectWorkspaceThreadMoveMetadataPatch, ProjectWorkspaceThreadPlacement,
        ProjectWorkspaceThreadWorkspace, ProjectWorkspaceThreadWorkspaceTransition,
    };

    use super::super::test_support::{
        apply, create_project, create_session_thread, seeded_workspace,
    };

    #[test]
    fn workspace_transition_commit_preserves_newer_pending_revision() {
        let workspace = seeded_workspace();
        create_project(
            &workspace.module,
            "create-transition-source",
            "project:source",
        );
        create_project(
            &workspace.module,
            "create-transition-target",
            "project:target",
        );
        create_session_thread(
            &workspace.module,
            "transition-thread",
            "session:transition-thread",
            "thread:transition-thread",
            Some("project:source"),
            100,
        );
        let accepted = ProjectWorkspaceThreadWorkspace {
            project_sources: vec![
                nodex_platform::fixture_path!("/workspace/project:target").to_owned(),
            ],
            cwd: nodex_platform::fixture_path!("/workspace/project:target").to_owned(),
            runtime_workspace_roots: vec![
                nodex_platform::fixture_path!("/workspace/project:target").to_owned(),
            ],
        };
        apply(
            &workspace.module,
            "prepare-transition-r1",
            ProjectWorkspaceIntent::MoveThread {
                thread_id: "thread:transition-thread".to_owned(),
                source: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:source".to_owned(),
                },
                target: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:target".to_owned(),
                },
                placement: ProjectWorkspaceThreadPlacement::Default,
                metadata: ProjectWorkspaceThreadMoveMetadataPatch::default(),
                workspace_transition: Some(ProjectWorkspaceThreadWorkspaceTransition {
                    revision: "workspace:r1".to_owned(),
                    pending: Some(accepted.clone()),
                }),
                runtime_workspace_roots: None,
            },
        );
        let newer = ProjectWorkspaceThreadWorkspace {
            project_sources: vec![
                nodex_platform::fixture_path!("/workspace/project:target").to_owned(),
            ],
            cwd: nodex_platform::fixture_path!("/workspace/project:target/newer").to_owned(),
            runtime_workspace_roots: vec![
                nodex_platform::fixture_path!("/workspace/project:target/newer").to_owned(),
            ],
        };
        apply(
            &workspace.module,
            "prepare-transition-r2",
            ProjectWorkspaceIntent::MoveThread {
                thread_id: "thread:transition-thread".to_owned(),
                source: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:target".to_owned(),
                },
                target: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:target".to_owned(),
                },
                placement: ProjectWorkspaceThreadPlacement::Default,
                metadata: ProjectWorkspaceThreadMoveMetadataPatch::default(),
                workspace_transition: Some(ProjectWorkspaceThreadWorkspaceTransition {
                    revision: "workspace:r2".to_owned(),
                    pending: Some(newer.clone()),
                }),
                runtime_workspace_roots: None,
            },
        );
        apply(
            &workspace.module,
            "commit-stale-transition-r1",
            ProjectWorkspaceIntent::CommitThreadWorkspaceTransition {
                thread_id: "thread:transition-thread".to_owned(),
                revision: "workspace:r1".to_owned(),
                workspace: accepted.clone(),
            },
        );
        let stale_commit = workspace
            .kernel
            .writer()
            .call(|connection| {
                super::super::execution::read_thread_workspace_state(
                    connection,
                    "thread:transition-thread",
                )
            })
            .expect("workspace state after stale commit")
            .expect("workspace state exists");
        assert_eq!(stale_commit.revision, "workspace:r2");
        assert_eq!(stale_commit.applied, Some(accepted));
        assert_eq!(stale_commit.pending, Some(newer.clone()));

        apply(
            &workspace.module,
            "commit-current-transition-r2",
            ProjectWorkspaceIntent::CommitThreadWorkspaceTransition {
                thread_id: "thread:transition-thread".to_owned(),
                revision: "workspace:r2".to_owned(),
                workspace: newer.clone(),
            },
        );
        let current_commit = workspace
            .kernel
            .writer()
            .call(|connection| {
                super::super::execution::read_thread_workspace_state(
                    connection,
                    "thread:transition-thread",
                )
            })
            .expect("workspace state after current commit")
            .expect("workspace state exists");
        assert_eq!(current_commit.revision, "workspace:r2");
        assert_eq!(current_commit.applied, Some(newer));
        assert_eq!(current_commit.pending, None);
    }
}
