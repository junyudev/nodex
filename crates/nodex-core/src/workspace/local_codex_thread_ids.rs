use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use rusqlite::{Connection, params};

use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

/// Native home continuity includes every local Codex binding, including archived children.
pub(super) fn read_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<String>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&"workspace_local_codex_thread_ids_v1")?;
    let subject = CollectionCursorSubject {
        kind: "workspace_local_codex_thread_ids",
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
                    "Local Codex Thread cursor is incompatible",
                    false,
                ));
            }
            Ok(coordinate.stable_id)
        })
        .transpose()?;
    let rows = connection
        .prepare(
            "SELECT thread.thread_id FROM codex_threads thread \
             LEFT JOIN projects project ON project.id = thread.project_id \
             WHERE thread.agent_backend_kind = 'codex' AND thread.execution_host_id = 'local' \
               AND (thread.project_id IS NULL OR project.library_id = ?1) \
               AND (?2 IS NULL OR thread.thread_id > ?2) \
             ORDER BY thread.thread_id LIMIT ?3",
        )?
        .query_map(
            params![
                library_id,
                after,
                i64::try_from(normalized.first + 1).map_err(|_| StoreError::new(
                    StoreErrorCode::InvalidInput,
                    "Codex Thread ID window size is invalid",
                    false
                ))?
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = rows
        .into_iter()
        .map(|item| WindowCandidate {
            coordinate: KeysetCoordinate {
                values: vec![],
                stable_id: item.clone(),
            },
            item,
        })
        .collect::<Vec<_>>();
    assemble(
        candidates,
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
    use super::*;
    use crate::workspace::test_support::{apply, read, seeded_workspace};
    use nodex_core_contracts::agent::AgentBackendBinding;
    use nodex_core_contracts::workspace::{
        ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
        ProjectWorkspaceThreadPatch,
    };

    #[test]
    fn local_codex_history_pages_include_archived_children_and_projectless_roots() {
        let workspace = seeded_workspace();
        for (thread_id, project_id, parent_id, archived, binding, host) in [
            (
                "a-root",
                Some("project:default"),
                None,
                false,
                AgentBackendBinding::Codex,
                "local",
            ),
            (
                "b-child",
                Some("project:default"),
                Some("a-root"),
                true,
                AgentBackendBinding::Codex,
                "local",
            ),
            (
                "c-projectless",
                None,
                None,
                false,
                AgentBackendBinding::Codex,
                "local",
            ),
            (
                "d-remote",
                Some("project:default"),
                None,
                false,
                AgentBackendBinding::Codex,
                "ssh:other",
            ),
            (
                "e-claude",
                Some("project:default"),
                None,
                false,
                AgentBackendBinding::Claude {
                    instance_config_id: "claude:default".to_owned(),
                },
                "local",
            ),
        ] {
            apply(
                &workspace.module,
                &format!("create-{thread_id}"),
                ProjectWorkspaceIntent::UpsertThread {
                    thread_id: thread_id.to_owned(),
                    patch: Box::new(ProjectWorkspaceThreadPatch {
                        project_id: Some(project_id.map(str::to_owned)),
                        parent_thread_id: Some(parent_id.map(str::to_owned)),
                        archived: Some(archived),
                        backend_binding: Some(binding),
                        execution_host_id: Some(host.to_owned()),
                        ..ProjectWorkspaceThreadPatch::default()
                    }),
                },
            );
        }
        let ProjectWorkspaceReadValue::LocalCodexThreadIds { thread_ids: first } = read(
            &workspace.module,
            ProjectWorkspaceRead::LocalCodexThreadIds {
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(2),
                },
            },
        ) else {
            panic!("local Codex IDs");
        };
        assert_eq!(first.items, ["a-root", "b-child"]);
        let ProjectWorkspaceReadValue::LocalCodexThreadIds { thread_ids: second } = read(
            &workspace.module,
            ProjectWorkspaceRead::LocalCodexThreadIds {
                window: CollectionWindowRequest {
                    after: first.next_cursor,
                    first: Some(2),
                },
            },
        ) else {
            panic!("continued local Codex IDs");
        };
        assert_eq!(second.items, ["c-projectless"]);
        assert!(second.next_cursor.is_none());
    }
}
