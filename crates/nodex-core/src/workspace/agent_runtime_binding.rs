//! Session identity and content authorization remain in Core; execution belongs to the runtime.

use nodex_core_contracts::workspace::ProjectWorkspaceAgentRuntimeSessionBinding;
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::project_session_scope;
use super::session_lifecycle::{finish_lifecycle_mutation, prepare_session};
use super::session_mutation::validate_id;

#[allow(clippy::too_many_arguments)]
pub(super) fn create_session(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    project_id: Option<&str>,
    title: &str,
    initial_page_ids: &[String],
    runtime_id: &str,
    runtime_thread_id: &str,
    launch_request_id: &str,
    launch_request_hash: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    // Agent adapters reach this function only after AgentCommand has verified Turn provenance.
    if !matches!(context.adapter, AdapterKind::Agent) {
        require_host(context)?;
    }
    validate_id("runtime_id", runtime_id)?;
    validate_id("runtime_thread_id", runtime_thread_id)?;
    validate_id("launch_request_id", launch_request_id)?;
    if launch_request_hash.len() != 64
        || !launch_request_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Agent Runtime launch requires a lowercase SHA-256 request hash",
            false,
        ));
    }
    let conflicting_binding = connection
        .query_row(
            "SELECT session_id FROM project_session_execution_bindings \
             WHERE runtime_id = ?1 AND (runtime_thread_id = ?2 OR launch_request_id = ?3) LIMIT 1",
            params![runtime_id, runtime_thread_id, launch_request_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if conflicting_binding.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Agent Runtime Thread or launch identity already belongs to a Session",
            false,
        ));
    }
    let now = prepare_session(
        connection,
        library_id,
        session_id,
        project_id,
        title,
        initial_page_ids,
        None,
    )?;
    connection.execute(
        "INSERT INTO project_session_execution_bindings(\
           session_id, runtime_id, runtime_thread_id, launch_request_id, launch_request_hash, bound_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            session_id,
            runtime_id,
            runtime_thread_id,
            launch_request_id,
            launch_request_hash,
            now
        ],
    )?;
    finish_lifecycle_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "create_agent_runtime_session",
        project_id.into_iter().map(str::to_owned).collect(),
        vec![session_id.to_owned()],
        Vec::new(),
        vec![project_session_scope(project_id)],
        project_id,
        now,
    )
}

pub(super) fn read_binding(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    session_id: &str,
) -> Result<Option<ProjectWorkspaceAgentRuntimeSessionBinding>, StoreError> {
    require_host(context)?;
    validate_id("session_id", session_id)?;
    let project_id = connection
        .query_row(
            "SELECT session.project_id FROM project_sessions session \
             WHERE session.id = ?1 AND (session.project_id IS NULL OR EXISTS(\
               SELECT 1 FROM projects project WHERE project.id = session.project_id AND project.library_id = ?2\
             ))",
            params![session_id, library_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::new(StoreErrorCode::NotFound, "Session is unavailable in this Library", false))?;
    connection
        .query_row(
            "SELECT runtime_id, runtime_thread_id, launch_request_id, launch_request_hash, bound_at \
             FROM project_session_execution_bindings WHERE session_id = ?1",
            [session_id],
            |row| {
                Ok(ProjectWorkspaceAgentRuntimeSessionBinding {
                    session_id: session_id.to_owned(),
                    project_id: project_id.clone(),
                    runtime_id: row.get(0)?,
                    runtime_thread_id: row.get(1)?,
                    launch_request_id: row.get(2)?,
                    launch_request_hash: row.get(3)?,
                    bound_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn require_host(context: &BoundModuleContext) -> Result<(), StoreError> {
    if matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::Unauthorized,
        "Agent Runtime execution bindings require the Desktop Host",
        false,
    ))
}

pub(super) fn read_binding_by_execution(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    runtime_id: &str,
    runtime_thread_id: &str,
) -> Result<Option<ProjectWorkspaceAgentRuntimeSessionBinding>, StoreError> {
    require_host(context)?;
    validate_id("runtime_id", runtime_id)?;
    validate_id("runtime_thread_id", runtime_thread_id)?;
    let session_id = connection.query_row(
        "SELECT session_id FROM project_session_execution_bindings WHERE runtime_id = ?1 AND runtime_thread_id = ?2",
        params![runtime_id, runtime_thread_id],
        |row| row.get::<_, String>(0),
    ).optional()?;
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    read_binding(connection, context, library_id, &session_id)
}

pub(super) fn is_runtime_bound(
    connection: &Connection,
    session_id: &str,
) -> Result<bool, StoreError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM project_session_execution_bindings WHERE session_id = ?1)",
            [session_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::CoreErrorCode;
    use nodex_core_contracts::workspace::{
        ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
    };

    use super::super::test_support::{
        apply, context, create_page_with_project_access, create_project, read, request,
        seeded_workspace,
    };
    fn create_intent(session_id: &str) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            session_id: session_id.into(),
            project_id: Some("project:default".into()),
            title: "Task".into(),
            initial_page_ids: Vec::new(),
            runtime_id: "runtime:primary".into(),
            runtime_thread_id: format!("thread:{session_id}"),
            launch_request_id: format!("launch:{session_id}"),
            launch_request_hash: "a".repeat(64),
        }
    }

    #[test]
    fn session_creation_commits_links_and_launch_identity_once_without_execution_projections() {
        let workspace = seeded_workspace();
        create_page_with_project_access(&workspace, "page:context", "project:default");
        let mut intent = create_intent("session:task");
        let ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            initial_page_ids, ..
        } = &mut intent
        else {
            unreachable!()
        };
        initial_page_ids.push("page:context".into());
        let first = workspace
            .module
            .apply(&context(), request("create-runtime", intent.clone()))
            .unwrap();
        let duplicate = workspace
            .module
            .apply(&context(), request("create-runtime", intent.clone()))
            .unwrap();
        assert!(!first.committed.receipt.mutation.duplicate);
        assert!(duplicate.committed.receipt.mutation.duplicate);
        assert_eq!(first.committed.commit_seq, duplicate.committed.commit_seq);
        assert!(duplicate.event.is_none());
        let ProjectWorkspaceReadValue::AgentRuntimeSessionBinding {
            binding: Some(binding),
        } = read(
            &workspace.module,
            ProjectWorkspaceRead::AgentRuntimeSessionBinding {
                session_id: "session:task".into(),
            },
        )
        else {
            panic!("runtime binding")
        };
        assert_eq!(binding.runtime_id, "runtime:primary");
        assert_eq!(binding.runtime_thread_id, "thread:session:task");
        assert_eq!(binding.project_id.as_deref(), Some("project:default"));
        let counts = workspace.kernel.writer().call(|connection| {
            Ok((
                connection.query_row("SELECT count(*) FROM project_session_pages WHERE session_id='session:task' AND page_id='page:context'", [], |row| row.get::<_, i64>(0))?,
                connection.query_row("SELECT count(*) FROM codex_threads", [], |row| row.get::<_, i64>(0))?,
            ))
        }).unwrap();
        assert_eq!(counts, (1, 0));
        let ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            launch_request_hash,
            ..
        } = &mut intent
        else {
            unreachable!()
        };
        *launch_request_hash = "b".repeat(64);
        assert_eq!(
            workspace
                .module
                .apply(&context(), request("create-runtime", intent))
                .unwrap_err()
                .code,
            CoreErrorCode::IdempotencyKeyReused
        );
    }

    #[test]
    fn unauthorized_pages_and_failed_binding_insert_roll_back_the_whole_session() {
        let workspace = seeded_workspace();
        create_project(&workspace.module, "other-project", "project:other");
        create_page_with_project_access(&workspace, "page:private", "project:other");
        let mut denied_intent = create_intent("session:denied");
        let ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            initial_page_ids, ..
        } = &mut denied_intent
        else {
            unreachable!()
        };
        initial_page_ids.push("page:private".into());
        assert_eq!(
            workspace
                .module
                .apply(&context(), request("denied", denied_intent))
                .unwrap_err()
                .code,
            CoreErrorCode::NotFound
        );
        create_page_with_project_access(&workspace, "page:allowed", "project:default");
        apply(
            &workspace.module,
            "prior-session",
            ProjectWorkspaceIntent::CreateSession {
                session_id: "session:prior".into(),
                project_id: Some("project:default".into()),
                title: "Prior".into(),
                initial_page_ids: Vec::new(),
            },
        );
        workspace.kernel.writer().call(|connection| {
            connection.execute_batch("CREATE TRIGGER injected_runtime_binding_failure BEFORE INSERT ON project_session_execution_bindings WHEN NEW.session_id = 'session:failed' BEGIN SELECT RAISE(ABORT, 'injected binding failure'); END;")?;
            Ok(())
        }).unwrap();
        let mut failed_intent = create_intent("session:failed");
        let ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            initial_page_ids, ..
        } = &mut failed_intent
        else {
            unreachable!()
        };
        initial_page_ids.push("page:allowed".into());
        assert!(
            workspace
                .module
                .apply(&context(), request("failed", failed_intent))
                .is_err()
        );
        let state = workspace.kernel.writer().call(|connection| {
            Ok((
                connection.query_row("SELECT count(*) FROM project_sessions WHERE id IN ('session:denied','session:failed')", [], |row| row.get::<_, i64>(0))?,
                connection.query_row("SELECT count(*) FROM project_session_pages WHERE session_id IN ('session:denied','session:failed')", [], |row| row.get::<_, i64>(0))?,
                connection.query_row("SELECT \"order\" FROM project_sessions WHERE id='session:prior'", [], |row| row.get::<_, i64>(0))?,
            ))
        }).unwrap();
        assert_eq!(state, (0, 0, 0));
    }

    #[test]
    fn runtime_thread_identity_is_unique_per_engine_and_bindings_cannot_switch_owners() {
        let workspace = seeded_workspace();
        apply(&workspace.module, "first", create_intent("session:first"));
        let mut duplicate = create_intent("session:duplicate");
        let ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            runtime_thread_id, ..
        } = &mut duplicate
        else {
            unreachable!()
        };
        *runtime_thread_id = "thread:session:first".into();
        assert_eq!(
            workspace
                .module
                .apply(&context(), request("duplicate", duplicate.clone()))
                .unwrap_err()
                .code,
            CoreErrorCode::Conflict
        );
        let ProjectWorkspaceIntent::CreateAgentRuntimeSession { runtime_id, .. } = &mut duplicate
        else {
            unreachable!()
        };
        *runtime_id = "runtime:another".into();
        apply(&workspace.module, "another-engine", duplicate);
        for (runtime, expected_session) in [
            ("runtime:primary", "session:first"),
            ("runtime:another", "session:duplicate"),
        ] {
            let ProjectWorkspaceReadValue::AgentRuntimeSessionBinding {
                binding: Some(binding),
            } = read(
                &workspace.module,
                ProjectWorkspaceRead::AgentRuntimeSessionBindingByExecution {
                    runtime_id: runtime.into(),
                    runtime_thread_id: "thread:session:first".into(),
                },
            )
            else {
                panic!("indexed execution binding")
            };
            assert_eq!(binding.session_id, expected_session);
        }
        create_project(&workspace.module, "other-project", "project:other");
        assert_eq!(
            workspace
                .module
                .apply(
                    &context(),
                    request(
                        "move",
                        ProjectWorkspaceIntent::MoveSession {
                            session_id: "session:first".into(),
                            project_id: Some("project:other".into())
                        }
                    )
                )
                .unwrap_err()
                .code,
            CoreErrorCode::Conflict
        );
        workspace.kernel.writer().call(|connection| {
            assert!(connection.execute("UPDATE project_session_execution_bindings SET launch_request_hash = ?1 WHERE session_id='session:first'", ["b".repeat(64)]).is_err());
            assert!(connection.execute("INSERT INTO project_session_threads(session_id,thread_id,linked_at) VALUES ('session:first','native','today')", []).is_err());
            Ok(())
        }).unwrap();
    }
}
