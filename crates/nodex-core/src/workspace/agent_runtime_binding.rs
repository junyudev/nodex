//! Session identity and execution routing remain in Core; native execution belongs to the runtime.

use crate::infrastructure::{
    collection_window::{WindowCandidate, assemble, normalize_request},
    cursor::{self, CollectionCursorSubject, CursorDirection, KeysetCoordinate},
};
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::workspace::ProjectWorkspaceAgentRuntimeSessionBinding;
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::project_session_scope;
use super::session_lifecycle::{
    finish_lifecycle_mutation, insert_session_records, normalize_session_title, prepare_session,
    require_project,
};
use super::session_mutation::{require_session, sqlite_now, validate_id};

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
    replacement_default_session_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    // Agent adapters reach this function only after AgentCommand has verified Turn provenance.
    if !matches!(context.adapter, AdapterKind::Agent) {
        require_host(context)?;
    }
    validate_id("runtime_id", runtime_id)?;
    validate_id("runtime_thread_id", runtime_thread_id)?;
    validate_id("launch_request_id", launch_request_id)?;
    if is_runtime_bound(connection, session_id)? {
        let binding =
            read_binding(connection, context, library_id, session_id)?.ok_or_else(|| {
                StoreError::new(
                    StoreErrorCode::StoreCorrupt,
                    "Session binding vanished",
                    false,
                )
            })?;
        if binding.runtime_id != runtime_id
            || binding.runtime_thread_id != runtime_thread_id
            || binding.launch_request_id != launch_request_id
        {
            return Err(StoreError::new(
                StoreErrorCode::Conflict,
                "Session execution binding is immutable",
                false,
            ));
        }
        let session = require_session(connection, library_id, session_id)?;
        if session.archived {
            return Err(StoreError::new(
                StoreErrorCode::Conflict,
                "Archived Session execution cannot be relaunched",
                false,
            ));
        }
        return super::mutation::finish_no_op(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "create_agent_runtime_session",
            project_id.into_iter().map(str::to_owned).collect(),
            vec![session_id.to_owned()],
            &sqlite_now(connection)?,
        );
    }
    let conflicting_binding = connection
        .query_row(
            "SELECT session_id FROM project_session_execution_bindings \
             WHERE runtime_id = ?1 AND (runtime_thread_id = ?2 OR launch_request_id = ?3) LIMIT 1",
            params![runtime_id, runtime_thread_id, launch_request_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let deleted_execution: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM nodex_agent_runtime_execution_cleanups WHERE runtime_id=?1 AND runtime_thread_id=?2)", params![runtime_id,runtime_thread_id], |row| row.get(0))?;
    if conflicting_binding.is_some() || deleted_execution {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Agent Runtime Thread or launch identity already belongs to a Session",
            false,
        ));
    }
    validate_id("session_id", session_id)?;
    validate_id(
        "replacement_default_session_id",
        replacement_default_session_id,
    )?;
    let existing = connection
        .query_row(
            "SELECT 1 FROM project_sessions WHERE id = ?1",
            [session_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    let mut session_ids = vec![session_id.to_owned()];
    let now = if existing {
        let authority = require_session(connection, library_id, session_id)?;
        if authority.project_id.as_deref() != project_id
            || authority.archived
            || authority.thread_id.is_some()
        {
            return Err(StoreError::new(
                StoreErrorCode::Conflict,
                "Only an unstarted Session in the same Project can bind execution",
                false,
            ));
        }
        if is_runtime_bound(connection, session_id)? {
            return Err(StoreError::new(
                StoreErrorCode::Conflict,
                "Session execution binding is immutable",
                false,
            ));
        }
        if let Some(project_id) = project_id {
            require_project(connection, library_id, project_id, true)?;
        }
        super::page_chat::validate_initial_page_ids(connection, library_id, initial_page_ids)?;
        let title = normalize_session_title(title)?;
        let now = sqlite_now(connection)?;
        connection.execute("UPDATE project_sessions SET is_default_draft = 0, no_thread_fallback_title = ?1, updated_at = ?2 WHERE id = ?3", params![title, now, session_id])?;
        for page_id in initial_page_ids {
            connection.execute("INSERT OR IGNORE INTO project_session_pages(session_id, page_id, linked_at) VALUES (?1, ?2, ?3)", params![session_id, page_id, now])?;
        }
        if authority.is_default_draft {
            insert_session_records(
                connection,
                replacement_default_session_id,
                project_id,
                "New thread",
                true,
            )?;
            session_ids.push(replacement_default_session_id.to_owned());
        }
        now
    } else {
        prepare_session(
            connection,
            library_id,
            session_id,
            project_id,
            title,
            initial_page_ids,
            None,
        )?
    };
    connection.execute(
        "INSERT INTO project_session_execution_bindings(\
           session_id, runtime_id, runtime_thread_id, launch_request_id, bound_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            session_id,
            runtime_id,
            runtime_thread_id,
            launch_request_id,
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
        session_ids,
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
            "SELECT runtime_id, runtime_thread_id, launch_request_id, bound_at \
             FROM project_session_execution_bindings WHERE session_id = ?1",
            [session_id],
            |row| {
                Ok(ProjectWorkspaceAgentRuntimeSessionBinding {
                    session_id: session_id.to_owned(),
                    project_id: project_id.clone(),
                    runtime_id: row.get(0)?,
                    runtime_thread_id: row.get(1)?,
                    launch_request_id: row.get(2)?,
                    bound_at: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn require_host(context: &BoundModuleContext) -> Result<(), StoreError> {
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

pub(super) fn read_binding_window(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    commit_head: i64,
    runtime_id: &str,
    project_id: Option<&str>,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceAgentRuntimeSessionBinding>, StoreError> {
    require_host(context)?;
    validate_id("runtime_id", runtime_id)?;
    if let Some(project_id) = project_id {
        validate_id("project_id", project_id)?;
    }
    let normalized = normalize_request(request)?;
    let fingerprint =
        cursor::query_fingerprint(&("agent_runtime_session_binding_v1", runtime_id, project_id))?;
    let subject = CollectionCursorSubject {
        kind: "agent_runtime_session_binding",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || !coordinate.values.is_empty() {
                return Err(StoreError::new(
                    StoreErrorCode::InvalidInput,
                    "Execution binding cursor is incompatible",
                    false,
                ));
            }
            Ok(coordinate.stable_id)
        })
        .transpose()?;
    let rows = connection.prepare(
        "SELECT session.id, session.project_id, binding.runtime_id, binding.runtime_thread_id, binding.launch_request_id, binding.bound_at \
         FROM project_sessions session JOIN project_session_execution_bindings binding ON binding.session_id = session.id \
         WHERE session.project_id IS ?1 AND binding.runtime_id = ?2 AND session.id > ?3 \
           AND (session.project_id IS NULL OR EXISTS(SELECT 1 FROM projects project WHERE project.id = session.project_id AND project.library_id = ?4)) \
         ORDER BY session.id LIMIT ?5"
    )?.query_map(params![project_id, runtime_id, after.as_deref().unwrap_or(""), library_id, (normalized.first + 1) as i64], |row| Ok(ProjectWorkspaceAgentRuntimeSessionBinding {
        session_id: row.get(0)?, project_id: row.get(1)?, runtime_id: row.get(2)?, runtime_thread_id: row.get(3)?, launch_request_id: row.get(4)?, bound_at: row.get(5)?,
    }))?.collect::<rusqlite::Result<Vec<_>>>()?;
    assemble(
        rows.into_iter().map(|item| WindowCandidate {
            coordinate: KeysetCoordinate {
                values: Vec::new(),
                stable_id: item.session_id.clone(),
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

#[cfg(test)]
mod tests {
    use nodex_core_contracts::CoreErrorCode;
    use nodex_core_contracts::workspace::{
        ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
    };

    use super::super::test_support::{
        apply, context, create_library_page, create_project, read, request, seeded_workspace,
    };
    fn create_intent(session_id: &str) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            session_id: session_id.into(),
            replacement_default_session_id: format!("replacement:{session_id}"),
            project_id: Some("project:default".into()),
            title: "Task".into(),
            initial_page_ids: Vec::new(),
            runtime_id: "runtime:primary".into(),
            runtime_thread_id: format!("thread:{session_id}"),
            launch_request_id: format!("launch:{session_id}"),
        }
    }

    #[test]
    fn default_draft_promotion_keeps_links_and_replaces_default_atomically() {
        let workspace = seeded_workspace();
        create_library_page(&workspace, "page:linked", "project:default");
        apply(
            &workspace.module,
            "draft",
            ProjectWorkspaceIntent::EnsureDefaultDraftSession {
                session_id: "session:draft".into(),
                project_id: Some("project:default".into()),
                title: "New thread".into(),
            },
        );
        let mut intent = create_intent("session:draft");
        let ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            initial_page_ids, ..
        } = &mut intent
        else {
            unreachable!()
        };
        initial_page_ids.push("page:linked".into());
        let first = workspace
            .module
            .apply(&context(), request("promote", intent.clone()))
            .unwrap();
        let repeated = workspace
            .module
            .apply(&context(), request("promote", intent))
            .unwrap();
        assert_eq!(first.committed.commit_seq, repeated.committed.commit_seq);
        let state = workspace.kernel.writer().call(|connection| Ok((
            connection.query_row("SELECT is_default_draft FROM project_sessions WHERE id='session:draft'", [], |row| row.get::<_, i64>(0))?,
            connection.query_row("SELECT id FROM project_sessions WHERE project_id='project:default' AND is_default_draft=1", [], |row| row.get::<_, String>(0))?,
            connection.query_row("SELECT count(*) FROM project_session_pages WHERE session_id='session:draft' AND page_id='page:linked'", [], |row| row.get::<_, i64>(0))?,
            connection.query_row("SELECT count(*) FROM codex_threads", [], |row| row.get::<_, i64>(0))?,
        ))).unwrap();
        assert_eq!(state, (0, "replacement:session:draft".into(), 1, 0));
        let mut replacement = create_intent("session:draft");
        let ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            runtime_thread_id, ..
        } = &mut replacement
        else {
            unreachable!()
        };
        *runtime_thread_id = "replacement-thread".into();
        assert_eq!(
            workspace
                .module
                .apply(&context(), request("rebind", replacement))
                .unwrap_err()
                .code,
            CoreErrorCode::Conflict
        );
    }

    #[test]
    fn rejected_promotion_preserves_original_default_and_project_identity() {
        let workspace = seeded_workspace();
        create_project(&workspace.module, "other-project", "project:other");
        apply(
            &workspace.module,
            "draft",
            ProjectWorkspaceIntent::EnsureDefaultDraftSession {
                session_id: "session:draft".into(),
                project_id: Some("project:default".into()),
                title: "New thread".into(),
            },
        );
        let mut foreign = create_intent("session:draft");
        let ProjectWorkspaceIntent::CreateAgentRuntimeSession { project_id, .. } = &mut foreign
        else {
            unreachable!()
        };
        *project_id = Some("project:other".into());
        assert_eq!(
            workspace
                .module
                .apply(&context(), request("foreign", foreign))
                .unwrap_err()
                .code,
            CoreErrorCode::Conflict
        );
        workspace.kernel.writer().call(|connection| {
            connection.execute_batch("CREATE TRIGGER injected_promotion_failure BEFORE INSERT ON project_session_execution_bindings WHEN NEW.session_id='session:draft' BEGIN SELECT RAISE(ABORT, 'injected'); END;")?;
            Ok(())
        }).unwrap();
        assert!(
            workspace
                .module
                .apply(
                    &context(),
                    request("failed", create_intent("session:draft"))
                )
                .is_err()
        );
        let state = workspace.kernel.writer().call(|connection| Ok((
            connection.query_row("SELECT is_default_draft FROM project_sessions WHERE id='session:draft'", [], |row| row.get::<_, i64>(0))?,
            connection.query_row("SELECT count(*) FROM project_sessions WHERE id='replacement:session:draft'", [], |row| row.get::<_, i64>(0))?,
            connection.query_row("SELECT count(*) FROM project_session_execution_bindings", [], |row| row.get::<_, i64>(0))?,
        ))).unwrap();
        assert_eq!(state, (1, 0, 0));
    }

    #[test]
    fn session_creation_commits_links_and_launch_identity_once_without_execution_projections() {
        let workspace = seeded_workspace();
        create_library_page(&workspace, "page:context", "project:default");
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
        let ProjectWorkspaceReadValue::Session { session } = read(
            &workspace.module,
            ProjectWorkspaceRead::Session {
                session_id: binding.session_id.clone(),
            },
        ) else {
            panic!("Session summary");
        };
        let execution = session.execution_ref.expect("explicit runtime execution");
        assert_eq!(execution.runtime_id, binding.runtime_id);
        assert_eq!(execution.thread_id, binding.runtime_thread_id);
        assert!(session.thread_id.is_none());
        let ProjectWorkspaceReadValue::TaskWindow { tasks } = read(
            &workspace.module,
            ProjectWorkspaceRead::TaskWindow {
                project_id: binding.project_id.clone(),
                include_archived: Some(false),
                window: nodex_core_contracts::collection::CollectionWindowRequest {
                    first: Some(10),
                    after: None,
                },
            },
        ) else {
            panic!("Task window");
        };
        let task = tasks
            .items
            .iter()
            .find(|task| task.session.id == binding.session_id)
            .expect("bound task");
        assert_eq!(task.session.execution_ref.as_ref(), Some(&execution));
        assert!(task.thread.is_none());
        let counts = workspace.kernel.writer().call(|connection| {
            Ok((
                connection.query_row("SELECT count(*) FROM project_session_pages WHERE session_id='session:task' AND page_id='page:context'", [], |row| row.get::<_, i64>(0))?,
                connection.query_row("SELECT count(*) FROM codex_threads", [], |row| row.get::<_, i64>(0))?,
            ))
        }).unwrap();
        assert_eq!(counts, (1, 0));
        let ProjectWorkspaceIntent::CreateAgentRuntimeSession { title, .. } = &mut intent else {
            unreachable!()
        };
        *title = "Changed request".into();
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
    fn missing_pages_and_failed_binding_insert_roll_back_the_whole_session() {
        let workspace = seeded_workspace();
        create_project(&workspace.module, "other-project", "project:other");
        create_library_page(&workspace, "page:private", "project:other");
        let mut denied_intent = create_intent("session:denied");
        let ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            initial_page_ids, ..
        } = &mut denied_intent
        else {
            unreachable!()
        };
        initial_page_ids.push("page:missing".into());
        assert_eq!(
            workspace
                .module
                .apply(&context(), request("denied", denied_intent))
                .unwrap_err()
                .code,
            CoreErrorCode::NotFound
        );
        create_library_page(&workspace, "page:allowed", "project:default");
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
        apply(
            &workspace.module,
            "move",
            ProjectWorkspaceIntent::MoveSession {
                session_id: "session:first".into(),
                project_id: Some("project:other".into()),
            },
        );
        let ProjectWorkspaceReadValue::AgentRuntimeSessionBinding {
            binding: Some(moved),
        } = read(
            &workspace.module,
            ProjectWorkspaceRead::AgentRuntimeSessionBinding {
                session_id: "session:first".into(),
            },
        )
        else {
            panic!("moved binding")
        };
        assert_eq!(moved.project_id.as_deref(), Some("project:other"));
        assert_eq!(moved.runtime_thread_id, "thread:session:first");
        workspace.kernel.writer().call(|connection| {
            assert!(connection.execute("UPDATE project_session_execution_bindings SET runtime_thread_id = ?1 WHERE session_id='session:first'", ["b".repeat(64)]).is_err());
            assert!(connection.execute("INSERT INTO project_session_threads(session_id,thread_id,linked_at) VALUES ('session:first','native','today')", []).is_err());
            Ok(())
        }).unwrap();
    }
    #[test]
    fn a_new_epoch_retries_the_stable_launch_binding_without_creating_another_session() {
        let w = seeded_workspace();
        let intent = create_intent("session:stable");
        apply(&w.module, "stable-launch", intent.clone());
        w.kernel
            .writer()
            .call(|c| {
                c.execute_batch("DELETE FROM core_module_receipts; DELETE FROM module_receipt_retention_metadata")?;
                c.execute(
                    "UPDATE block_store_metadata SET store_epoch='epoch:new' WHERE id=1",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            w.module
                .apply(&context(), request("stable-launch", intent.clone()))
                .unwrap_err()
                .code,
            CoreErrorCode::StaleStoreEpoch
        );
        let mut current = request("stable-launch", intent);
        current.store_epoch = nodex_core_contracts::StoreEpoch("epoch:new".into());
        let first = w.module.apply(&context(), current.clone()).unwrap();
        assert!(first.event.is_none());
        assert!(
            w.module
                .apply(&context(), current)
                .unwrap()
                .committed
                .receipt
                .mutation
                .duplicate
        );
        let counts=w.kernel.writer().call(|c|Ok((c.query_row("SELECT count(*) FROM project_sessions WHERE id='session:stable'",[],|r|r.get::<_,i64>(0))?,c.query_row("SELECT count(*) FROM project_session_execution_bindings WHERE session_id='session:stable' AND runtime_thread_id='thread:session:stable'",[],|r|r.get::<_,i64>(0))?))).unwrap();
        assert_eq!(counts, (1, 1));
    }

    #[test]
    fn binding_windows_follow_current_placement_and_isolate_cursor_routes() {
        use nodex_core_contracts::collection::CollectionWindowRequest;
        use nodex_core_contracts::workspace::ProjectSessionIntent;
        use nodex_core_contracts::{ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION};
        let workspace = seeded_workspace();
        create_project(&workspace.module, "other-project", "project:other");
        for id in ["a", "b", "c"] {
            apply(
                &workspace.module,
                &format!("create:{id}"),
                create_intent(id),
            );
        }
        apply(
            &workspace.module,
            "move:b",
            ProjectWorkspaceIntent::MoveSession {
                session_id: "b".into(),
                project_id: Some("project:other".into()),
            },
        );
        apply(
            &workspace.module,
            "archive:c",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "c".into(),
                intent: ProjectSessionIntent::SetArchived { archived: true },
            },
        );
        let query = |project_id: Option<&str>, after: Option<String>| {
            ProjectWorkspaceRead::AgentRuntimeSessionBindingWindow {
                runtime_id: "runtime:primary".into(),
                project_id: project_id.map(str::to_owned),
                window: CollectionWindowRequest {
                    first: Some(1),
                    after,
                },
            }
        };
        let ProjectWorkspaceReadValue::AgentRuntimeSessionBindingWindow { bindings: first } =
            read(&workspace.module, query(Some("project:default"), None))
        else {
            panic!("window")
        };
        assert_eq!(
            first
                .items
                .iter()
                .map(|b| b.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a"]
        );
        let cursor = first.next_cursor.expect("second bound Session");
        let ProjectWorkspaceReadValue::AgentRuntimeSessionBindingWindow { bindings: second } = read(
            &workspace.module,
            query(Some("project:default"), Some(cursor.clone())),
        ) else {
            panic!("window")
        };
        assert_eq!(second.items[0].session_id, "c");
        assert!(second.next_cursor.is_none());
        let ProjectWorkspaceReadValue::AgentRuntimeSessionBindingWindow { bindings: moved } =
            read(&workspace.module, query(Some("project:other"), None))
        else {
            panic!("window")
        };
        assert_eq!(moved.items[0].session_id, "b");
        assert_eq!(moved.items[0].runtime_thread_id, "thread:b");
        let error = workspace
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: query(Some("project:other"), Some(cursor)),
                },
            )
            .unwrap_err();
        assert_eq!(error.code, CoreErrorCode::InvalidInput);
        apply(
            &workspace.module,
            "rootless:a",
            ProjectWorkspaceIntent::MoveSession {
                session_id: "a".into(),
                project_id: None,
            },
        );
        let ProjectWorkspaceReadValue::AgentRuntimeSessionBindingWindow { bindings: rootless } =
            read(&workspace.module, query(None, None))
        else {
            panic!("window")
        };
        assert_eq!(rootless.items[0].session_id, "a");
    }
}
