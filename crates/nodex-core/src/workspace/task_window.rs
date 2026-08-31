use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::workspace::{
    CodexThreadActiveFlag, CodexThreadStatusType, ProjectWorkspaceSessionSummary,
    ProjectWorkspaceTaskSummary, ProjectWorkspaceTaskThreadSummary, ProjectWorkspaceThreadStatus,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params, params_from_iter};

use crate::domain::agent_backend::binding_from_storage;
use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_PREVIEW_UTF16: usize = 240;
const MAX_PREVIEW_BYTES: usize = 1_024;

pub(super) fn read_task_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    project_id: Option<&str>,
    include_archived: bool,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceTaskSummary>, StoreError> {
    read_task_window_in_scope(
        connection,
        library_id,
        commit_head,
        project_id,
        false,
        include_archived,
        request,
    )
}

pub(super) fn read_pinned_task_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    include_archived: bool,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceTaskSummary>, StoreError> {
    read_task_window_in_scope(
        connection,
        library_id,
        commit_head,
        None,
        true,
        include_archived,
        request,
    )
}

#[allow(clippy::too_many_arguments)]
fn read_task_window_in_scope(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    project_id: Option<&str>,
    pinned_only: bool,
    include_archived: bool,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceTaskSummary>, StoreError> {
    if !pinned_only && let Some(project_id) = project_id {
        validate_id(project_id, "project_id")?;
        let exists = connection.query_row(
            "SELECT count(*) FROM projects \
             WHERE id = ?1 AND library_id = ?2 AND lifecycle <> 'archived'",
            params![project_id, library_id],
            |row| row.get::<_, i64>(0),
        )?;
        if exists != 1 {
            return Err(not_found("Project task lane is unavailable"));
        }
    }
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&(
        "workspace_task_window_v4",
        project_id,
        pinned_only,
        include_archived,
    ))?;
    let subject = CollectionCursorSubject {
        kind: if pinned_only {
            "workspace_pinned_tasks"
        } else {
            "workspace_tasks"
        },
        library_id,
        query_fingerprint: &fingerprint,
    };
    let coordinate = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 2 {
                return Err(invalid("Workspace task cursor is incompatible"));
            }
            let [
                KeysetValue::Integer { value: pin_bucket },
                KeysetValue::Integer { value: lane_order },
            ] = coordinate.values.as_slice()
            else {
                return Err(invalid("Workspace task cursor coordinate is invalid"));
            };
            Ok((*pin_bucket, *lane_order, coordinate.stable_id))
        })
        .transpose()?;
    let mut parameters = vec![
        project_id.map_or(SqlValue::Null, |value| SqlValue::Text(value.to_owned())),
        SqlValue::Text(library_id.to_owned()),
        SqlValue::Integer(i64::from(include_archived)),
        SqlValue::Integer(i64::from(pinned_only)),
    ];
    let cursor_predicate = coordinate
        .map(|(pin_bucket, lane_order, stable_id)| {
            parameters.extend([
                SqlValue::Integer(pin_bucket),
                SqlValue::Integer(lane_order),
                SqlValue::Text(stable_id),
            ]);
            "WHERE pin_bucket > ?5 \
               OR (pin_bucket = ?5 AND lane_order > ?6) \
               OR (pin_bucket = ?5 AND lane_order = ?6 AND session_id > ?7)"
        })
        .unwrap_or_default();
    parameters.push(SqlValue::Integer(
        i64::try_from(normalized.first + 1)
            .map_err(|_| invalid("Workspace task window size is invalid"))?,
    ));
    let limit_parameter = parameters.len();
    let sql = format!(
        "WITH task_rows AS (\
           SELECT session.id AS session_id, session.project_id, \
             session.no_thread_fallback_title, session.\"order\", session.pinned, \
             session.pinned_order, session.archived, session.archived_at, session.unread, \
             session.created_at, session.updated_at, \
             thread.thread_id, thread.project_id, thread.forked_from_id, \
             thread.parent_thread_id, thread.thread_name, thread.thread_source, \
             thread.service_name, thread.agent_nickname, thread.agent_role, thread.agent_path, \
             substr(thread.thread_preview, 1, 1024), thread.model_id, \
             thread.reasoning_effort, thread.service_tier, \
             thread.agent_backend_kind, thread.agent_backend_definition_id, \
             thread.agent_backend_instance_config_id, \
             thread.execution_host_id, thread.cwd, thread.managed_worktree_path, \
             thread.projectless_output_directory, thread.projectless_workspace_browser_root, \
             thread.status_type, \
             thread.status_active_flags_json, thread.archived, thread.created_at, \
             thread.updated_at, thread.recency_at, thread.linked_at, \
             CASE WHEN session.pinned = 1 THEN 0 ELSE 1 END AS pin_bucket, \
             CASE WHEN session.pinned = 1 \
               THEN COALESCE(session.pinned_order, 9223372036854775807) \
               WHEN lane.order_mode = 'manual' AND NOT EXISTS (\
                 SELECT 1 FROM workspace_sidebar_positions lane_position \
                 WHERE lane_position.scope_key = lane.scope_key\
               ) THEN session.\"order\" \
               WHEN lane.order_mode = 'manual' \
                 THEN COALESCE(position.rank_key, -COALESCE(thread.recency_at, session.\"order\")) \
               ELSE -COALESCE(\
                 thread.recency_at, \
                 session.\"order\"\
               ) END AS lane_order \
           FROM project_sessions session \
           LEFT JOIN project_session_threads link ON link.session_id = session.id \
           LEFT JOIN codex_threads thread ON thread.thread_id = link.thread_id \
           LEFT JOIN workspace_sidebar_lanes lane ON lane.scope_key = CASE \
             WHEN session.project_id IS NULL THEN 'projectless' \
             ELSE 'project:' || session.project_id END \
           LEFT JOIN workspace_sidebar_positions position \
             ON position.scope_key = lane.scope_key \
             AND position.thread_id = thread.thread_id \
           WHERE ((?4 = 1 AND session.pinned = 1) OR (?4 = 0 AND \
             ((?1 IS NULL AND session.project_id IS NULL) OR session.project_id = ?1))) \
             AND (session.project_id IS NULL OR EXISTS (\
               SELECT 1 FROM projects project \
               WHERE project.id = session.project_id AND project.library_id = ?2 \
                 AND project.lifecycle <> 'archived'\
             )) \
             AND (?3 = 1 OR session.archived = 0) \
             AND (thread.thread_id IS NULL OR thread.parent_thread_id IS NULL)\
         ) \
         SELECT * FROM task_rows {cursor_predicate} \
         ORDER BY pin_bucket, lane_order, session_id LIMIT ?{limit_parameter}"
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), task_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = rows
        .into_iter()
        .map(|(task, pin_bucket, lane_order)| WindowCandidate {
            coordinate: KeysetCoordinate {
                values: vec![
                    KeysetValue::Integer { value: pin_bucket },
                    KeysetValue::Integer { value: lane_order },
                ],
                stable_id: task.session.id.clone(),
            },
            item: task,
        });
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

pub(super) fn task_summary_from_row(
    row: &rusqlite::Row<'_>,
    offset: usize,
) -> rusqlite::Result<ProjectWorkspaceTaskSummary> {
    let thread_id = row.get::<_, Option<String>>(offset + 11)?;
    let thread = thread_id
        .map(
            |thread_id| -> rusqlite::Result<ProjectWorkspaceTaskThreadSummary> {
                let status_type = match row.get::<_, String>(offset + 33)?.as_str() {
                    "notLoaded" => Ok(CodexThreadStatusType::NotLoaded),
                    "idle" => Ok(CodexThreadStatusType::Idle),
                    "systemError" => Ok(CodexThreadStatusType::SystemError),
                    "active" => Ok(CodexThreadStatusType::Active),
                    _ => Err(rusqlite::Error::InvalidQuery),
                }?;
                let active_flags = serde_json::from_str::<Vec<CodexThreadActiveFlag>>(
                    &row.get::<_, String>(offset + 34)?,
                )
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
                Ok(ProjectWorkspaceTaskThreadSummary {
                    thread_id,
                    project_id: row.get(offset + 12)?,
                    session_id: row.get(offset)?,
                    forked_from_id: row.get(offset + 13)?,
                    parent_thread_id: row.get(offset + 14)?,
                    thread_name: row.get(offset + 15)?,
                    thread_source: row.get(offset + 16)?,
                    service_name: row.get(offset + 17)?,
                    agent_nickname: row.get(offset + 18)?,
                    agent_role: row.get(offset + 19)?,
                    agent_path: row.get(offset + 20)?,
                    thread_preview: bounded_preview(&row.get::<_, String>(offset + 21)?),
                    model_id: row.get(offset + 22)?,
                    reasoning_effort: row.get(offset + 23)?,
                    service_tier: row.get(offset + 24)?,
                    backend_binding: binding_from_storage(
                        row.get::<_, String>(offset + 25)?.as_str(),
                        row.get(offset + 26)?,
                        row.get(offset + 27)?,
                    )
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    execution_host_id: row.get(offset + 28)?,
                    cwd: row.get(offset + 29)?,
                    managed_worktree_path: row.get(offset + 30)?,
                    projectless_output_directory: row.get(offset + 31)?,
                    projectless_workspace_browser_root: row.get(offset + 32)?,
                    status: ProjectWorkspaceThreadStatus {
                        status_type,
                        active_flags,
                    },
                    archived: row.get::<_, i64>(offset + 35)? == 1,
                    created_at: row.get(offset + 36)?,
                    updated_at: row.get(offset + 37)?,
                    recency_at: row.get(offset + 38)?,
                    linked_at: row.get(offset + 39)?,
                })
            },
        )
        .transpose()?;
    let fallback_title = row.get::<_, String>(offset + 2)?;
    let display_title = super::read::project_session_display_title(
        thread
            .as_ref()
            .and_then(|thread| thread.thread_name.as_deref()),
        thread.as_ref().map(|thread| thread.thread_preview.as_str()),
        &fallback_title,
    );
    let task = ProjectWorkspaceTaskSummary {
        session: ProjectWorkspaceSessionSummary {
            id: row.get(offset)?,
            project_id: row.get(offset + 1)?,
            no_thread_fallback_title: fallback_title,
            display_title,
            order: row.get(offset + 3)?,
            pinned: row.get::<_, i64>(offset + 4)? == 1,
            pinned_order: row.get(offset + 5)?,
            archived: row.get::<_, i64>(offset + 6)? == 1,
            archived_at: row.get(offset + 7)?,
            unread: row.get::<_, i64>(offset + 8)? == 1,
            thread_id: row.get(offset + 11)?,
            created_at: row.get(offset + 9)?,
            updated_at: row.get(offset + 10)?,
        },
        thread,
    };
    Ok(task)
}

fn task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(ProjectWorkspaceTaskSummary, i64, i64)> {
    Ok((
        task_summary_from_row(row, 0)?,
        row.get("pin_bucket")?,
        row.get("lane_order")?,
    ))
}

pub(crate) fn bounded_preview(value: &str) -> String {
    let mut utf16 = 0;
    let mut bytes = 0;
    value
        .chars()
        .take_while(|character| {
            let next_utf16 = utf16 + character.len_utf16();
            let next_bytes = bytes + character.len_utf8();
            if next_utf16 > MAX_PREVIEW_UTF16 || next_bytes > MAX_PREVIEW_BYTES {
                return false;
            }
            utf16 = next_utf16;
            bytes = next_bytes;
            true
        })
        .collect()
}

fn validate_id(value: &str, label: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.trim() == value && value.len() <= 512 {
        return Ok(());
    }
    Err(invalid(&format!("{label} is invalid")))
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::collection::{
        CollectionWindowRequest, MAX_COLLECTION_WINDOW_JSON_BYTES,
    };
    use nodex_core_contracts::workspace::{
        ProjectSessionIntent, ProjectWorkspaceIntent, ProjectWorkspaceRead,
        ProjectWorkspaceReadValue, ProjectWorkspaceThreadLane,
        ProjectWorkspaceThreadMoveMetadataPatch, ProjectWorkspaceThreadPatch,
        ProjectWorkspaceThreadPlacement,
    };

    use super::*;
    use crate::workspace::test_support::{
        apply, create_project, create_session_thread, read, seeded_workspace,
    };

    fn task_window(
        workspace: &crate::workspace::test_support::TestWorkspace,
        project_id: Option<&str>,
        after: Option<String>,
        first: u32,
    ) -> CollectionWindow<ProjectWorkspaceTaskSummary> {
        let ProjectWorkspaceReadValue::TaskWindow { tasks } = read(
            &workspace.module,
            ProjectWorkspaceRead::TaskWindow {
                project_id: project_id.map(str::to_owned),
                include_archived: Some(false),
                window: CollectionWindowRequest {
                    after,
                    first: Some(first),
                },
            },
        ) else {
            panic!("task window read");
        };
        tasks
    }

    #[test]
    fn manual_session_order_includes_the_default_draft_and_survives_first_thread_link() {
        let workspace = seeded_workspace();
        create_session_thread(
            &workspace.module,
            "manual-a",
            "session:a",
            "thread:a",
            Some("project:default"),
            300,
        );
        create_session_thread(
            &workspace.module,
            "manual-b",
            "session:b",
            "thread:b",
            Some("project:default"),
            200,
        );
        apply(
            &workspace.module,
            "ensure-manual-default-draft",
            ProjectWorkspaceIntent::EnsureDefaultDraftSession {
                session_id: "session:draft".to_owned(),
                project_id: Some("project:default".to_owned()),
                title: "New chat".to_owned(),
            },
        );
        apply(
            &workspace.module,
            "reorder-with-manual-default-draft",
            ProjectWorkspaceIntent::ReorderSessions {
                project_id: Some("project:default".to_owned()),
                session_ids: vec![
                    "session:b".to_owned(),
                    "session:draft".to_owned(),
                    "session:a".to_owned(),
                ],
            },
        );

        let reordered = task_window(&workspace, Some("project:default"), None, 10);
        assert_eq!(
            reordered
                .items
                .iter()
                .map(|task| task.session.id.as_str())
                .collect::<Vec<_>>(),
            ["session:b", "session:draft", "session:a"],
        );

        apply(
            &workspace.module,
            "materialize-default-draft-thread",
            ProjectWorkspaceIntent::UpsertThread {
                thread_id: "thread:draft".to_owned(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    project_id: Some(Some("project:default".to_owned())),
                    thread_name: Some(Some("New chat".to_owned())),
                    thread_preview: Some("first prompt".to_owned()),
                    created_at: Some(400),
                    updated_at: Some(400),
                    ..ProjectWorkspaceThreadPatch::default()
                }),
            },
        );
        apply(
            &workspace.module,
            "link-default-draft-thread",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:draft".to_owned(),
                intent: ProjectSessionIntent::LinkThread {
                    thread_id: "thread:draft".to_owned(),
                    expected_project_id: Some("project:default".to_owned()),
                    thread_patch: None,
                    execution_location: None,
                },
            },
        );

        let linked = task_window(&workspace, Some("project:default"), None, 10);
        assert_eq!(
            linked
                .items
                .iter()
                .map(|task| task.session.id.as_str())
                .collect::<Vec<_>>(),
            ["session:b", "session:draft", "session:a"],
        );
    }

    #[test]
    fn moving_a_chat_into_a_session_ordered_lane_preserves_the_default_draft_position() {
        let workspace = seeded_workspace();
        create_project(
            &workspace.module,
            "create-session-order-source",
            "project:source",
        );
        create_session_thread(
            &workspace.module,
            "session-order-a",
            "session:a",
            "thread:a",
            Some("project:default"),
            300,
        );
        create_session_thread(
            &workspace.module,
            "session-order-b",
            "session:b",
            "thread:b",
            Some("project:default"),
            200,
        );
        apply(
            &workspace.module,
            "ensure-session-order-draft",
            ProjectWorkspaceIntent::EnsureDefaultDraftSession {
                session_id: "session:draft".to_owned(),
                project_id: Some("project:default".to_owned()),
                title: "New chat".to_owned(),
            },
        );
        apply(
            &workspace.module,
            "reorder-target-session-lane",
            ProjectWorkspaceIntent::ReorderSessions {
                project_id: Some("project:default".to_owned()),
                session_ids: vec![
                    "session:b".to_owned(),
                    "session:draft".to_owned(),
                    "session:a".to_owned(),
                ],
            },
        );
        create_session_thread(
            &workspace.module,
            "session-order-moved",
            "session:moved",
            "thread:moved",
            Some("project:source"),
            400,
        );

        apply(
            &workspace.module,
            "move-chat-into-session-lane",
            ProjectWorkspaceIntent::MoveThread {
                thread_id: "thread:moved".to_owned(),
                source: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:source".to_owned(),
                },
                target: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:default".to_owned(),
                },
                placement: ProjectWorkspaceThreadPlacement::After {
                    thread_id: "thread:b".to_owned(),
                },
                metadata: ProjectWorkspaceThreadMoveMetadataPatch::default(),
                runtime_workspace_roots: None,
                project_access_grant: None,
            },
        );

        let target = task_window(&workspace, Some("project:default"), None, 10);
        assert_eq!(
            target
                .items
                .iter()
                .map(|task| task.session.id.as_str())
                .collect::<Vec<_>>(),
            ["session:b", "session:moved", "session:draft", "session:a"],
        );
    }

    #[test]
    fn task_windows_seek_with_an_opaque_cursor_and_exact_projectless_scope() {
        let workspace = seeded_workspace();
        create_project(&workspace.module, "create-project", "project:a");
        for index in 0..5 {
            create_session_thread(
                &workspace.module,
                &format!("project-{index}"),
                &format!("session:project:{index}"),
                &format!("thread:project:{index}"),
                Some("project:a"),
                index,
            );
            create_session_thread(
                &workspace.module,
                &format!("chat-{index}"),
                &format!("session:chat:{index}"),
                &format!("thread:chat:{index}"),
                None,
                index,
            );
        }

        let first = task_window(&workspace, None, None, 2);
        assert_eq!(first.items.len(), 2);
        assert!(
            first
                .items
                .iter()
                .all(|task| task.session.project_id.is_none())
        );
        let next = task_window(&workspace, None, first.next_cursor.clone(), 2);
        assert_eq!(next.items.len(), 2);
        assert!(first.items.iter().all(|left| {
            next.items
                .iter()
                .all(|right| left.session.id != right.session.id)
        }));
        assert!(
            first
                .next_cursor
                .as_deref()
                .is_some_and(|cursor| cursor.starts_with("nxc1."))
        );

        // A workspace write between windows must not invalidate the cursor.
        create_session_thread(
            &workspace.module,
            "chat-live",
            "session:chat:live",
            "thread:chat:live",
            None,
            9,
        );
        let continued = task_window(&workspace, None, first.next_cursor.clone(), 2);
        assert_eq!(continued.items.len(), 2);
        assert!(first.items.iter().all(|left| {
            continued
                .items
                .iter()
                .all(|right| left.session.id != right.session.id)
        }));
    }

    #[test]
    fn task_windows_defensively_exclude_legacy_child_thread_sessions() {
        let workspace = seeded_workspace();
        create_session_thread(
            &workspace.module,
            "root-chat",
            "session:root",
            "thread:root",
            None,
            1,
        );
        create_session_thread(
            &workspace.module,
            "leaked-child-chat",
            "session:child",
            "thread:child",
            None,
            2,
        );
        workspace
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE codex_threads SET parent_thread_id = 'thread:root' \
                     WHERE thread_id = 'thread:child'",
                    [],
                )?;
                Ok(())
            })
            .expect("seed legacy child sidebar Session");

        let window = task_window(&workspace, None, None, 50);
        assert_eq!(window.items.len(), 1);
        assert_eq!(window.items[0].session.id, "session:root");
        assert_eq!(
            window.items[0]
                .thread
                .as_ref()
                .map(|thread| thread.thread_id.as_str()),
            Some("thread:root")
        );
    }

    #[test]
    fn task_window_observes_relative_same_lane_moves_at_the_commit_revision() {
        let workspace = seeded_workspace();
        create_project(&workspace.module, "create-project", "project:a");
        for (index, thread_id) in ["thread:a", "thread:b", "thread:c", "thread:d"]
            .iter()
            .enumerate()
        {
            create_session_thread(
                &workspace.module,
                &format!("create-thread-{index}"),
                &format!("session:{index}"),
                thread_id,
                Some("project:a"),
                400 - i64::try_from(index).expect("small index"),
            );
        }

        let before = task_window(&workspace, Some("project:a"), None, 3);
        apply(
            &workspace.module,
            "move-after-visible-anchor",
            ProjectWorkspaceIntent::MoveThread {
                thread_id: "thread:a".to_owned(),
                source: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:a".to_owned(),
                },
                target: ProjectWorkspaceThreadLane::Project {
                    project_id: "project:a".to_owned(),
                },
                placement: ProjectWorkspaceThreadPlacement::After {
                    thread_id: "thread:c".to_owned(),
                },
                metadata: ProjectWorkspaceThreadMoveMetadataPatch::default(),
                runtime_workspace_roots: None,
                project_access_grant: None,
            },
        );
        let after = task_window(&workspace, Some("project:a"), None, 4);
        let thread_ids = after
            .items
            .iter()
            .filter_map(|task| task.thread.as_ref().map(|thread| thread.thread_id.as_str()))
            .collect::<Vec<_>>();

        assert!(after.authority.projection_revision > before.authority.projection_revision);
        assert_eq!(thread_ids, ["thread:b", "thread:c", "thread:a", "thread:d"]);
    }

    #[test]
    fn task_summary_preview_and_encoded_window_stay_within_semantic_budgets() {
        let workspace = seeded_workspace();
        create_project(&workspace.module, "create-project", "project:a");
        for index in 0..200 {
            create_session_thread(
                &workspace.module,
                &format!("task-{index}"),
                &format!("session:{index:03}"),
                &format!("thread:{index:03}"),
                Some("project:a"),
                index,
            );
        }
        workspace
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE codex_threads SET thread_preview = ?1",
                    ["🧭".repeat(2_000)],
                )?;
                Ok(())
            })
            .expect("seed oversized legacy previews");

        let window = task_window(&workspace, Some("project:a"), None, 200);
        assert_eq!(window.items.len(), 200);
        let mut linked_count = 0;
        for thread in window.items.iter().filter_map(|task| task.thread.as_ref()) {
            linked_count += 1;
            assert!(
                thread.thread_preview.encode_utf16().count() <= MAX_PREVIEW_UTF16
                    && thread.thread_preview.len() <= MAX_PREVIEW_BYTES,
                "{} has {} UTF-16 units and {} UTF-8 bytes",
                thread.thread_id,
                thread.thread_preview.encode_utf16().count(),
                thread.thread_preview.len(),
            );
        }
        assert!(linked_count >= 199);
        assert!(
            serde_json::to_vec(&window)
                .expect("encode task window")
                .len()
                <= MAX_COLLECTION_WINDOW_JSON_BYTES
        );
    }
}
