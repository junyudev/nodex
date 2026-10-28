use super::{
    ProjectWorkspaceApplyOutcome,
    agent_runtime_binding::require_host,
    session_lifecycle::finish_lifecycle_mutation,
    session_mutation::{sqlite_now, validate_id},
};
use crate::infrastructure::{
    collection_window::{WindowCandidate, assemble, normalize_request},
    cursor::{self, CollectionCursorSubject, CursorDirection, KeysetCoordinate},
    sqlite::{StoreError, StoreErrorCode},
};
use nodex_core_contracts::{
    BoundModuleContext,
    collection::{CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest},
    workspace::ProjectWorkspaceAgentRuntimeExecutionCleanup,
};
use rusqlite::{Connection, OptionalExtension, params};

pub(super) fn enqueue(
    connection: &Connection,
    library_id: &str,
    operation_id: &str,
    session_id: &str,
    project_id: Option<&str>,
) -> Result<(), StoreError> {
    connection.execute("INSERT INTO nodex_agent_runtime_execution_cleanups(cleanup_id, library_id, session_id, project_id, runtime_id, runtime_thread_id, created_at) SELECT ?1, ?2, ?3, ?4, runtime_id, runtime_thread_id, datetime('now') FROM project_session_execution_bindings WHERE session_id = ?3", params![operation_id, library_id, session_id, project_id])?;
    Ok(())
}

pub(super) fn read_window(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    commit_head: i64,
    runtime_id: &str,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceAgentRuntimeExecutionCleanup>, StoreError> {
    require_host(context)?;
    validate_id("runtime_id", runtime_id)?;
    let normalized = normalize_request(request)?;
    let fingerprint =
        cursor::query_fingerprint(&("agent_runtime_execution_cleanup_v1", runtime_id))?;
    let subject = CollectionCursorSubject {
        kind: "agent_runtime_execution_cleanup",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || !coordinate.values.is_empty() {
                return Err(invalid("Execution cleanup cursor is incompatible"));
            }
            Ok(coordinate.stable_id)
        })
        .transpose()?;
    let rows = connection.prepare("SELECT cleanup_id,session_id,project_id,runtime_id,runtime_thread_id,created_at FROM nodex_agent_runtime_execution_cleanups WHERE runtime_id=?1 AND library_id=?2 AND acknowledged_at IS NULL AND cleanup_id>?3 ORDER BY cleanup_id LIMIT ?4")?.query_map(params![runtime_id,library_id,after.as_deref().unwrap_or(""),(normalized.first + 1) as i64], |row| Ok(ProjectWorkspaceAgentRuntimeExecutionCleanup { cleanup_id:row.get(0)?,session_id:row.get(1)?,project_id:row.get(2)?,runtime_id:row.get(3)?,runtime_thread_id:row.get(4)?,created_at:row.get(5)? }))?.collect::<rusqlite::Result<Vec<_>>>()?;
    assemble(
        rows.into_iter().map(|item| WindowCandidate {
            coordinate: KeysetCoordinate {
                values: Vec::new(),
                stable_id: item.cleanup_id.clone(),
            },
            item,
        }),
        normalized.first,
        CollectionWindowAuthority {
            projection_revision: commit_head,
        },
        |coordinate| {
            cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn acknowledge(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    cleanup_id: &str,
    runtime_id: &str,
    runtime_thread_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_host(context)?;
    validate_id("cleanup_id", cleanup_id)?;
    validate_id("runtime_id", runtime_id)?;
    validate_id("runtime_thread_id", runtime_thread_id)?;
    let proof = connection.query_row("SELECT runtime_id,runtime_thread_id FROM nodex_agent_runtime_execution_cleanups WHERE cleanup_id=?1 AND library_id=?2",params![cleanup_id,library_id],|row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).optional()?;
    if proof.as_ref() != Some(&(runtime_id.to_owned(), runtime_thread_id.to_owned())) {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Execution cleanup identity does not match the committed Session deletion",
            false,
        ));
    }
    let now = sqlite_now(connection)?;
    connection.execute("UPDATE nodex_agent_runtime_execution_cleanups SET acknowledged_at=?1 WHERE cleanup_id=?2 AND acknowledged_at IS NULL",params![now,cleanup_id])?;
    finish_lifecycle_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "acknowledge_agent_runtime_execution_cleanup",
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        None,
        now,
    )
}
fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::{apply, context, request, seeded_workspace};
    use nodex_core_contracts::{
        AdapterKind, CoreErrorCode, ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION,
        workspace::{ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue},
    };
    fn binding(session_id: &str, thread_id: &str) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            side_chat_source_session_id: None,
            session_id: session_id.into(),
            project_id: Some("project:default".into()),
            title: "Task".into(),
            initial_page_ids: Vec::new(),
            runtime_id: "runtime".into(),
            runtime_thread_id: thread_id.into(),
            launch_request_id: format!("launch:{session_id}"),
        }
    }
    fn read(
        workspace: &crate::workspace::test_support::TestWorkspace,
        runtime_id: &str,
        window: CollectionWindowRequest,
    ) -> CollectionWindow<ProjectWorkspaceAgentRuntimeExecutionCleanup> {
        let value = workspace
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::AgentRuntimeExecutionCleanupWindow {
                        runtime_id: runtime_id.into(),
                        window,
                    },
                },
            )
            .unwrap()
            .value;
        let ProjectWorkspaceReadValue::AgentRuntimeExecutionCleanupWindow { cleanups } = value
        else {
            panic!("cleanup window")
        };
        cleanups
    }
    fn ack(cleanup_id: &str, thread_id: &str) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::AcknowledgeAgentRuntimeExecutionCleanup {
            cleanup_id: cleanup_id.into(),
            runtime_id: "runtime".into(),
            runtime_thread_id: thread_id.into(),
        }
    }

    #[test]
    fn deleted_session_leaves_exact_durable_cleanup_and_acknowledged_execution_cannot_be_rebound() {
        let workspace = seeded_workspace();
        apply(&workspace.module, "create", binding("session", "thread"));
        apply(
            &workspace.module,
            "delete",
            ProjectWorkspaceIntent::DeleteSession {
                session_id: "session".into(),
            },
        );
        let cleanups = read(&workspace, "runtime", CollectionWindowRequest::default());
        assert_eq!(cleanups.items.len(), 1);
        let cleanup = &cleanups.items[0];
        assert_eq!(
            (
                &cleanup.cleanup_id,
                &cleanup.session_id,
                &cleanup.runtime_thread_id
            ),
            (
                &"delete".to_owned(),
                &"session".to_owned(),
                &"thread".to_owned()
            )
        );
        assert!(
            read(&workspace, "other", CollectionWindowRequest::default())
                .items
                .is_empty()
        );
        assert_eq!(
            workspace
                .module
                .apply(&context(), request("wrong-ack", ack("delete", "other")))
                .unwrap_err()
                .code,
            CoreErrorCode::Conflict
        );
        let mut agent = context();
        agent.adapter = AdapterKind::Agent;
        assert_eq!(
            workspace
                .module
                .apply(&agent, request("agent-ack", ack("delete", "thread")))
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        let first = workspace
            .module
            .apply(&context(), request("ack", ack("delete", "thread")))
            .unwrap();
        let replay = workspace
            .module
            .apply(&context(), request("ack", ack("delete", "thread")))
            .unwrap();
        assert_eq!(first.committed.commit_seq, replay.committed.commit_seq);
        assert!(
            read(&workspace, "runtime", CollectionWindowRequest::default())
                .items
                .is_empty()
        );
        assert_eq!(
            workspace
                .module
                .apply(
                    &context(),
                    request("reuse", binding("replacement", "thread"))
                )
                .unwrap_err()
                .code,
            CoreErrorCode::Conflict
        );
        apply(
            &workspace.module,
            "fresh",
            binding("replacement", "fresh-thread"),
        );
    }

    #[test]
    fn deletion_failure_rolls_back_cleanup_and_window_cursor_is_bound_to_runtime() {
        let workspace = seeded_workspace();
        apply(&workspace.module, "create", binding("one", "thread:one"));
        workspace.kernel.writer().call(|connection| {connection.execute_batch("CREATE TRIGGER reject_session_delete BEFORE DELETE ON project_sessions WHEN OLD.id='one' BEGIN SELECT RAISE(ABORT,'injected'); END;")?;Ok(())}).unwrap();
        assert!(
            workspace
                .module
                .apply(
                    &context(),
                    request(
                        "failed-delete",
                        ProjectWorkspaceIntent::DeleteSession {
                            session_id: "one".into()
                        }
                    )
                )
                .is_err()
        );
        assert!(
            read(&workspace, "runtime", CollectionWindowRequest::default())
                .items
                .is_empty()
        );
        workspace
            .kernel
            .writer()
            .call(|connection| {
                connection.execute_batch("DROP TRIGGER reject_session_delete")?;
                Ok(())
            })
            .unwrap();
        apply(
            &workspace.module,
            "delete-one",
            ProjectWorkspaceIntent::DeleteSession {
                session_id: "one".into(),
            },
        );
        apply(
            &workspace.module,
            "create-two",
            binding("two", "thread:two"),
        );
        apply(
            &workspace.module,
            "delete-two",
            ProjectWorkspaceIntent::DeleteSession {
                session_id: "two".into(),
            },
        );
        let first = read(
            &workspace,
            "runtime",
            CollectionWindowRequest {
                after: None,
                first: Some(1),
            },
        );
        assert_eq!(first.items.len(), 1);
        let cursor = first.next_cursor.unwrap();
        let second = read(
            &workspace,
            "runtime",
            CollectionWindowRequest {
                after: Some(cursor.clone()),
                first: Some(1),
            },
        );
        assert_eq!(second.items.len(), 1);
        assert_ne!(first.items[0].cleanup_id, second.items[0].cleanup_id);
        assert!(
            workspace
                .module
                .read(
                    &context(),
                    ModuleReadRequest {
                        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: ProjectWorkspaceRead::AgentRuntimeExecutionCleanupWindow {
                            runtime_id: "other".into(),
                            window: CollectionWindowRequest {
                                after: Some(cursor),
                                first: Some(1)
                            }
                        }
                    }
                )
                .is_err()
        );
    }
}
