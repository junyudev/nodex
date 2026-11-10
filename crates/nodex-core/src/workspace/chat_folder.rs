use nodex_core_contracts::{
    BoundModuleContext,
    workspace::{ChatFolder, ChatFolderOrigin, ProjectSource},
};
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::{
    ProjectWorkspaceApplyOutcome,
    chat_stewardship::{ChatControl, require},
    mutation::{
        FolderMutationResult, WorkspaceMutationEffects, finish_no_op_with_folder,
        project_session_scope, run_mutation_with_folder_result,
    },
    session_mutation::{require_session, sqlite_now, validate_id},
};

const FOLDER_COLUMNS: &str = "json_object('execution_host_id', folder.execution_host_id, \
    'path', folder.path, 'output_directory', folder.output_directory, 'origin', folder.origin)";
pub(super) const SUMMARY_COLUMN: &str = "(SELECT json_object( \
    'execution_host_id', folder.execution_host_id, 'path', folder.path, \
    'output_directory', folder.output_directory, 'origin', folder.origin) \
    FROM project_session_chat_folders folder WHERE folder.session_id = session.id)";

pub(super) fn decode_summary(row: &Row<'_>, column: usize) -> rusqlite::Result<Option<ChatFolder>> {
    row.get::<_, Option<String>>(column)?
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    column,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .transpose()
}

pub(super) fn read(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<ChatFolder>, StoreError> {
    Ok(connection.query_row(
        &format!("SELECT {FOLDER_COLUMNS} FROM project_session_chat_folders folder WHERE folder.session_id = ?1"),
        [session_id],
        |row| decode_summary(row, 0),
    ).optional()?.flatten())
}

/// A fork can still use a generated directory after its original Chat is deleted.
pub(super) fn still_referenced(
    connection: &Connection,
    folder: &ChatFolder,
) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_session_chat_folders WHERE execution_host_id = ?1 AND path = ?2)
             OR EXISTS(SELECT 1 FROM project_session_threads link JOIN codex_threads thread ON thread.thread_id = link.thread_id
                       WHERE thread.execution_host_id = ?1 AND thread.cwd = ?2)",
        params![folder.execution_host_id, folder.path],
        |row| row.get(0),
    )?)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn bind(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    session_id: &str,
    folder: &ChatFolder,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    super::agent_runtime_binding::require_host(context)?;
    validate_id("session_id", session_id)?;
    validate_id("execution_host_id", &folder.execution_host_id)?;
    for path in std::iter::once(folder.path.as_str()).chain(folder.output_directory.as_deref()) {
        if path.contains('\0') || !super::execution::valid_workspace_root(path) {
            return Err(StoreError::new(
                StoreErrorCode::InvalidInput,
                "Chat folder paths must be absolute",
                false,
            ));
        }
    }
    let authority = require_session(connection, library_id, session_id)?;
    if let Some(project_id) = &authority.project_id {
        let roots = connection
            .prepare("SELECT root FROM project_sources WHERE project_id = ?1")?
            .query_map([project_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if roots
            .into_iter()
            .any(|root| ProjectSource::from_identity(root, 0).local_path().is_some())
        {
            return Err(conflict("This chat uses its Project folder"));
        }
    }
    let existing = read(connection, session_id)?;
    if folder.origin == ChatFolderOrigin::Chosen {
        require(
            connection,
            library_id,
            context,
            session_id,
            ChatControl::Manage,
        )?;
        if authority.thread_id.is_some()
            || connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM project_session_execution_bindings WHERE session_id = ?1)",
                    [session_id], |row| row.get::<_, bool>(0),
                )?
        {
            return Err(conflict("Choose a Chat folder before the chat starts"));
        }
    }
    let now = sqlite_now(connection)?;
    let project_ids: Vec<_> = authority.project_id.iter().cloned().collect();
    let session_ids = vec![session_id.to_owned()];
    if let Some(existing) = existing {
        return finish_no_op_with_folder(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "bind_chat_folder",
            project_ids,
            session_ids,
            &now,
            Some(existing),
        );
    }
    let origin = match folder.origin {
        ChatFolderOrigin::Generated => "generated",
        ChatFolderOrigin::Chosen => "chosen",
    };
    connection.execute(
        "INSERT INTO project_session_chat_folders(session_id, execution_host_id, path, output_directory, origin) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![session_id, folder.execution_host_id, folder.path, folder.output_directory, origin],
    )?;
    run_mutation_with_folder_result(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        FolderMutationResult {
            bound: Some(folder.clone()),
            deleted: Vec::new(),
        },
        |_| {
            Ok(WorkspaceMutationEffects {
                operation_kind: "bind_chat_folder",
                project_catalog_change: None,
                change_project_id: authority.project_id.clone(),
                project_ids,
                session_detail_ids: session_ids.clone(),
                session_ids,
                thread_ids: Vec::new(),
                session_summary_scopes: vec![project_session_scope(
                    authority.project_id.as_deref(),
                )],
                block_ids: Vec::new(),
                document_ids: Vec::new(),
                database_ids: Vec::new(),
                page_ids: Vec::new(),
                data_source_ids: Vec::new(),
                view_ids: Vec::new(),
                document_heads: Vec::new(),
                committed_at: now.clone(),
            })
        },
    )
}

fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Conflict, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::{
        apply, context, create_project, read as read_workspace, request, seeded_workspace,
    };
    use nodex_core_contracts::workspace::{
        ProjectWorkspaceIntent as Intent, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
    };

    fn session(id: &str, project_id: Option<&str>) -> Intent {
        Intent::CreateSession {
            session_id: id.into(),
            project_id: project_id.map(str::to_owned),
            title: "Chat".into(),
            initial_page_ids: Vec::new(),
        }
    }

    fn folder(path: &str, origin: ChatFolderOrigin) -> ChatFolder {
        ChatFolder {
            execution_host_id: "local".into(),
            path: path.into(),
            output_directory: None,
            origin,
        }
    }

    fn binding(id: &str, folder: ChatFolder) -> Intent {
        Intent::BindChatFolder {
            session_id: id.into(),
            folder,
        }
    }

    #[test]
    fn chat_folder_bind_returns_the_winner_and_delete_returns_generated_cleanup() {
        let store = seeded_workspace();
        let module = &store.module;
        apply(module, "create", session("draft", None));
        let expected = folder("/Chats/2026-11-10/报告", ChatFolderOrigin::Generated);
        let first = module
            .apply(
                &context(),
                request("bind", binding("draft", expected.clone())),
            )
            .unwrap();
        let same = module
            .apply(
                &context(),
                request("same", binding("draft", expected.clone())),
            )
            .unwrap();
        let other = module
            .apply(
                &context(),
                request(
                    "other",
                    binding("draft", folder("/another", ChatFolderOrigin::Chosen)),
                ),
            )
            .unwrap();
        for result in [&first, &same, &other] {
            assert_eq!(result.committed.value.chat_folder.as_ref(), Some(&expected));
        }
        assert!(first.event.is_some());
        assert!(same.event.is_none() && other.event.is_none());
        let summary = read_workspace(
            module,
            ProjectWorkspaceRead::Session {
                session_id: "draft".into(),
            },
        );
        assert!(
            matches!(summary, ProjectWorkspaceReadValue::Session { session } if session.folder.as_ref() == Some(&expected))
        );
        let listing = read_workspace(
            module,
            ProjectWorkspaceRead::TaskWindow {
                project_id: None,
                include_archived: None,
                placement_scope: Default::default(),
                order: Default::default(),
                window: nodex_core_contracts::collection::CollectionWindowRequest {
                    first: Some(10),
                    after: None,
                },
            },
        );
        assert!(
            matches!(listing, ProjectWorkspaceReadValue::TaskWindow { tasks }
            if tasks.items.iter().any(|item| item.session.id == "draft" && item.session.folder.as_ref() == Some(&expected)))
        );
        let deleted = module
            .apply(
                &context(),
                request(
                    "delete",
                    Intent::DeleteSession {
                        session_id: "draft".into(),
                    },
                ),
            )
            .unwrap();
        assert_eq!(deleted.committed.value.deleted_chat_folders, vec![expected]);
        store
            .kernel
            .writer()
            .call(|connection| {
                assert!(super::read(connection, "draft")?.is_none());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn chat_folder_bind_checks_project_sources_paths_and_execution_binding() {
        let store = seeded_workspace();
        let module = &store.module;
        create_project(module, "create-project", "with-source");
        apply(
            module,
            "create",
            session("project-chat", Some("with-source")),
        );
        let chosen = folder("C:\\Users\\person\\Notes", ChatFolderOrigin::Chosen);
        let generated = folder("/Chats/new", ChatFolderOrigin::Generated);
        assert!(
            module
                .apply(
                    &context(),
                    request("project", binding("project-chat", generated.clone()))
                )
                .is_err()
        );
        apply(module, "create-other", session("draft", None));
        assert!(
            module
                .apply(
                    &context(),
                    request(
                        "relative",
                        binding("draft", folder("relative", ChatFolderOrigin::Generated))
                    )
                )
                .is_err()
        );
        apply(
            module,
            "execution",
            Intent::CreateAgentRuntimeSession {
                coordinator: false,
                session_id: "draft".into(),
                project_id: None,
                title: "Chat".into(),
                initial_page_ids: Vec::new(),
                agent_selection: None,
                runtime_id: "runtime".into(),
                runtime_thread_id: "thread".into(),
                launch_request_id: "launch".into(),
                side_chat_source_session_id: None,
            },
        );
        assert!(
            module
                .apply(
                    &context(),
                    request("late", binding("draft", chosen.clone()))
                )
                .is_err()
        );
        apply(module, "generated", binding("draft", generated));
        apply(module, "create-chosen", session("chosen-draft", None));
        apply(module, "choose", binding("chosen-draft", chosen));
        let deleted = module
            .apply(
                &context(),
                request(
                    "delete-chosen",
                    Intent::DeleteSession {
                        session_id: "chosen-draft".into(),
                    },
                ),
            )
            .unwrap();
        assert!(deleted.committed.value.deleted_chat_folders.is_empty());
    }
}
