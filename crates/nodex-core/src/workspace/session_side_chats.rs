use crate::infrastructure::{
    collection_window::{WindowCandidate, assemble, normalize_request},
    cursor::{self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue},
    sqlite::{StoreError, StoreErrorCode},
};
use nodex_core_contracts::{
    collection::{CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest},
    workspace::ProjectWorkspaceSessionSideChatSummary,
};
use rusqlite::{Connection, params};

use super::{read::read_session_summary, session_mutation::validate_id};

/// Capture the whole attachment tree before deleting edges or moving any Session.
/// UNION also terminates safely if a damaged Store contains an attachment cycle.
pub(super) fn attached_session_ids(
    connection: &Connection,
    source_session_id: &str,
) -> Result<Vec<String>, StoreError> {
    let ids = connection
        .prepare(
            "WITH RECURSIVE attached(id) AS (\
           SELECT ?1 UNION SELECT side.session_id FROM project_session_side_chats side \
           JOIN attached ON side.source_session_id = attached.id\
         ) SELECT id FROM attached",
        )?
        .query_map([source_session_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(ids)
}

pub(super) fn read_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    member: &str,
    source_session_id: &str,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceSessionSideChatSummary>, StoreError> {
    validate_id("source_session_id", source_session_id)?;
    let source = read_session_summary(connection, library_id, source_session_id, member)?
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::NotFound,
                "Source Session is unavailable in this Library",
                false,
            )
        })?;
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&(
        "session_side_chats_v1",
        source_session_id,
        &source.project_id,
    ))?;
    let subject = CollectionCursorSubject {
        kind: "session_side_chats",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            let [KeysetValue::Text { value }] = coordinate.values.as_slice() else {
                return Err(invalid("Side chat cursor is incompatible"));
            };
            if direction != CursorDirection::Forward {
                return Err(invalid("Side chat cursor is incompatible"));
            }
            Ok((value.clone(), coordinate.stable_id))
        })
        .transpose()?;
    let (after_created, after_id) = after.unzip();
    let rows = connection.prepare(
        "SELECT session.id, session.no_thread_fallback_title, session.created_at, session.updated_at, session.archived \
         FROM project_session_side_chats side JOIN project_sessions session ON session.id = side.session_id \
         WHERE side.source_session_id = ?1 AND session.project_id IS ?2 \
           AND (?3 IS NULL OR session.created_at < ?3 OR (session.created_at = ?3 AND session.id > ?4)) \
         ORDER BY session.created_at DESC, session.id LIMIT ?5",
    )?.query_map(params![source_session_id, source.project_id, after_created, after_id, (normalized.first + 1) as i64], |row| {
        Ok(ProjectWorkspaceSessionSideChatSummary {
            session_id: row.get(0)?, display_title: row.get(1)?, created_at: row.get(2)?,
            updated_at: row.get(3)?, archived: row.get(4)?,
        })
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    assemble(
        rows.into_iter().map(|item| WindowCandidate {
            coordinate: KeysetCoordinate {
                values: vec![KeysetValue::Text {
                    value: item.created_at.clone(),
                }],
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

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::{
        self, TestWorkspace, apply, context, request, seeded_workspace,
    };
    use nodex_core_contracts::{
        AdapterKind, CoreErrorCode, ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION,
        workspace::{
            ProjectSessionIntent, ProjectWorkspaceIntent, ProjectWorkspaceRead,
            ProjectWorkspaceReadValue,
        },
    };

    fn create(workspace: &TestWorkspace, id: &str, source: Option<&str>) {
        apply(
            &workspace.module,
            &format!("create:{id}"),
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                agent_selection: None,
                coordinator: false,
                session_id: id.into(),
                project_id: Some("project:default".into()),
                title: format!("Title {id}"),
                initial_page_ids: Vec::new(),
                runtime_id: "runtime".into(),
                runtime_thread_id: format!("thread:{id}"),
                launch_request_id: format!("launch:{id}"),
                side_chat_source_session_id: source.map(str::to_owned),
            },
        );
    }

    fn tree(workspace: &TestWorkspace) {
        create(workspace, "source", None);
        create(workspace, "child", Some("source"));
        create(workspace, "grandchild", Some("child"));
        create(workspace, "sibling", Some("source"));
        create(workspace, "unrelated", None);
    }

    fn delete(id: &str) -> ProjectWorkspaceIntent {
        ProjectWorkspaceIntent::DeleteSession {
            session_id: id.into(),
        }
    }

    fn archive(workspace: &TestWorkspace, id: &str) {
        apply(
            &workspace.module,
            &format!("archive:{id}"),
            ProjectWorkspaceIntent::MutateSession {
                session_id: id.into(),
                intent: ProjectSessionIntent::SetArchived { archived: true },
            },
        );
    }

    fn list_request(source: &str, after: Option<String>, first: u32) -> ProjectWorkspaceRead {
        ProjectWorkspaceRead::SessionSideChats {
            source_session_id: source.into(),
            window: CollectionWindowRequest {
                after,
                first: Some(first),
            },
        }
    }

    fn list(
        workspace: &TestWorkspace,
        source: &str,
        after: Option<String>,
        first: u32,
    ) -> CollectionWindow<ProjectWorkspaceSessionSideChatSummary> {
        // The human-facing read must not inherit the execution binding's Host-only gate.
        let mut caller = context();
        caller.adapter = AdapterKind::LoopbackHttp;
        caller.project_id = None;
        let value = workspace
            .module
            .read(
                &caller,
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: list_request(source, after, first),
                },
            )
            .unwrap()
            .value;
        let ProjectWorkspaceReadValue::SessionSideChats { side_chats } = value else {
            panic!("side chats")
        };
        side_chats
    }

    fn counts(workspace: &TestWorkspace) -> (i64, i64, i64) {
        workspace
            .kernel
            .writer()
            .call(|connection| {
                Ok((
                    connection.query_row("SELECT count(*) FROM project_sessions", [], |row| {
                        row.get(0)
                    })?,
                    connection.query_row(
                        "SELECT count(*) FROM project_session_side_chats",
                        [],
                        |row| row.get(0),
                    )?,
                    connection.query_row(
                        "SELECT count(*) FROM nodex_agent_runtime_execution_cleanups",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .unwrap()
    }

    #[test]
    fn deleting_source_cascades_recursively_with_each_cleanup_and_invalidation() {
        let workspace = seeded_workspace();
        tree(&workspace);
        let outcome = workspace
            .module
            .apply(&context(), request("delete:source", delete("source")))
            .unwrap();
        assert_eq!(counts(&workspace), (1, 0, 4));
        let mut affected = outcome.committed.value.affected_session_ids.clone();
        affected.sort();
        assert_eq!(affected, ["child", "grandchild", "sibling", "source"]);
        let cleanups = test_support::read(
            &workspace.module,
            ProjectWorkspaceRead::AgentRuntimeExecutionCleanupWindow {
                runtime_id: "runtime".into(),
                window: CollectionWindowRequest::default(),
            },
        );
        let ProjectWorkspaceReadValue::AgentRuntimeExecutionCleanupWindow { cleanups } = cleanups
        else {
            panic!("cleanup")
        };
        let mut cleaned = cleanups
            .items
            .iter()
            .map(|item| (item.session_id.clone(), item.runtime_thread_id.clone()))
            .collect::<Vec<_>>();
        cleaned.sort();
        assert_eq!(
            cleaned,
            affected
                .iter()
                .map(|id| (id.clone(), format!("thread:{id}")))
                .collect::<Vec<_>>()
        );
        let nodex_core_contracts::CoreModuleEventPayload::ProjectWorkspace(event) =
            outcome.event.unwrap().payload
        else {
            panic!("workspace event")
        };
        let mut details = event.session_detail_ids;
        details.sort();
        assert_eq!(details, affected);
        let replay = workspace
            .module
            .apply(&context(), request("delete:source", delete("source")))
            .unwrap();
        assert_eq!(replay.committed.commit_seq, outcome.committed.commit_seq);
        assert_eq!(counts(&workspace), (1, 0, 4));
    }

    #[test]
    fn deleting_side_chat_keeps_source_and_siblings() {
        let workspace = seeded_workspace();
        tree(&workspace);
        apply(&workspace.module, "delete:child", delete("child"));
        assert_eq!(counts(&workspace), (3, 1, 2));
        assert_eq!(
            list(&workspace, "source", None, 50).items[0].session_id,
            "sibling"
        );
    }

    #[test]
    fn failed_cascade_rolls_back_children_edges_and_cleanup_receipts() {
        let workspace = seeded_workspace();
        tree(&workspace);
        workspace.kernel.writer().call(|connection| {
            connection.execute_batch("CREATE TRIGGER reject_source_delete BEFORE DELETE ON project_sessions WHEN OLD.id='source' BEGIN SELECT RAISE(ABORT, 'injected'); END;")?;
            Ok(())
        }).unwrap();
        assert!(
            workspace
                .module
                .apply(&context(), request("failed-delete", delete("source")))
                .is_err()
        );
        assert_eq!(counts(&workspace), (5, 3, 0));
    }

    #[test]
    fn archiving_source_keeps_children_attached_and_readable() {
        let workspace = seeded_workspace();
        tree(&workspace);
        archive(&workspace, "source");
        assert_eq!(counts(&workspace), (5, 3, 0));
        let children = list(&workspace, "source", None, 50);
        assert_eq!(children.items.len(), 2);
        assert!(children.items.iter().all(|item| !item.archived));
        assert_eq!(
            list(&workspace, "child", None, 50).items[0].session_id,
            "grandchild"
        );
    }

    #[test]
    fn moving_source_moves_entire_tree_and_cannot_detach_a_child() {
        let workspace = seeded_workspace();
        tree(&workspace);
        let moved = workspace
            .module
            .apply(
                &context(),
                request(
                    "move:source",
                    ProjectWorkspaceIntent::MoveSession {
                        session_id: "source".into(),
                        project_id: None,
                        placement: None,
                    },
                ),
            )
            .unwrap();
        assert_eq!(moved.committed.value.affected_session_ids.len(), 4);
        let projects = workspace
            .kernel
            .writer()
            .call(|connection| {
                Ok(connection
                    .prepare("SELECT id, project_id FROM project_sessions ORDER BY id")?
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .unwrap();
        assert!(projects.iter().all(|(id, project)| if id == "unrelated" {
            project.as_deref() == Some("project:default")
        } else {
            project.is_none()
        }));
        assert_eq!(list(&workspace, "source", None, 50).items.len(), 2);
        assert_eq!(
            workspace
                .module
                .apply(
                    &context(),
                    request(
                        "detach:child",
                        ProjectWorkspaceIntent::MoveSession {
                            session_id: "child".into(),
                            project_id: Some("project:default".into()),
                            placement: None,
                        }
                    )
                )
                .unwrap_err()
                .code,
            CoreErrorCode::InvalidInput
        );
    }

    #[test]
    fn listing_orders_creation_with_stable_ties_and_paginates_after_deleted_rows() {
        let workspace = seeded_workspace();
        tree(&workspace);
        create(&workspace, "older", Some("source"));
        create(&workspace, "deleted", Some("source"));
        workspace.kernel.writer().call(|connection| {
            connection.execute("UPDATE project_sessions SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = 'older'", [])?;
            connection.execute("UPDATE project_sessions SET created_at = '2021-01-01T00:00:00.000Z' WHERE id IN ('child', 'sibling')", [])?;
            Ok(())
        }).unwrap();
        archive(&workspace, "sibling");
        apply(&workspace.module, "delete:deleted", delete("deleted"));
        let first = list(&workspace, "source", None, 1);
        assert_eq!(first.items[0].session_id, "child");
        assert_eq!(first.items[0].display_title, "Title child");
        assert!(!first.items[0].updated_at.is_empty());
        let cursor = first.next_cursor.unwrap();
        apply(&workspace.module, "delete:first", delete("child"));
        let second = list(&workspace, "source", Some(cursor.clone()), 1);
        assert_eq!(second.items[0].session_id, "sibling");
        assert!(second.items[0].archived);
        let third = list(&workspace, "source", second.next_cursor, 1);
        assert_eq!(third.items[0].session_id, "older");
        assert!(third.next_cursor.is_none());
        assert_eq!(
            workspace
                .module
                .read(
                    &context(),
                    ModuleReadRequest {
                        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: list_request("unrelated", Some(cursor), 1),
                    }
                )
                .unwrap_err()
                .code,
            CoreErrorCode::InvalidInput
        );
    }

    #[test]
    fn listing_rejects_missing_and_foreign_library_sources_and_filters_project_mismatch() {
        let workspace = seeded_workspace();
        tree(&workspace);
        test_support::create_project(&workspace.module, "create:other-project", "project:other");
        workspace
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE project_sessions SET project_id = 'project:other' WHERE id = 'child'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            list(&workspace, "source", None, 50)
                .items
                .iter()
                .map(|item| item.session_id.as_str())
                .collect::<Vec<_>>(),
            ["sibling"]
        );
        workspace.kernel.writer().call(|connection| {
            connection.execute("INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile:other', ?1, ?1)", [test_support::NOW])?;
            connection.execute("INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library:other', 'profile:other', ?1, ?1)", [test_support::NOW])?;
            connection.execute("UPDATE projects SET library_id = 'library:other' WHERE id = 'project:default'", [])?;
            Ok(())
        }).unwrap();
        for source in ["missing", "source"] {
            assert_eq!(
                workspace
                    .module
                    .read(
                        &context(),
                        ModuleReadRequest {
                            contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                            read: list_request(source, None, 50),
                        }
                    )
                    .unwrap_err()
                    .code,
                CoreErrorCode::NotFound
            );
        }
    }
}
