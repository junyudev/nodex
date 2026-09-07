use super::task_window::{TASK_SUMMARY_COLUMNS, task_summary_from_row};
use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::workspace::ProjectWorkspaceSessionListingItem;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params_from_iter};

pub(super) fn read_session_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    archived: bool,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceSessionListingItem>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&("workspace_session_listing_v1", archived))?;
    let subject = CollectionCursorSubject {
        kind: "workspace_session_listing",
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
        SqlValue::Text(library_id.to_owned()),
        SqlValue::Integer(i64::from(archived)),
    ];
    let cursor_predicate = coordinate
        .map(|(pin_bucket, lane_order, stable_id)| {
            parameters.extend([
                SqlValue::Integer(pin_bucket),
                SqlValue::Integer(lane_order),
                SqlValue::Text(stable_id),
            ]);
            "WHERE pin_bucket > ?3 \
               OR (pin_bucket = ?3 AND lane_order > ?4) \
               OR (pin_bucket = ?3 AND lane_order = ?4 AND session_id > ?5)"
        })
        .unwrap_or_default();
    parameters.push(SqlValue::Integer(
        i64::try_from(normalized.first + 1)
            .map_err(|_| invalid("Workspace task window size is invalid"))?,
    ));
    let limit_parameter = parameters.len();
    let sql = format!(
        "WITH task_rows AS (SELECT {TASK_SUMMARY_COLUMNS},
           project.name AS project_name,
           direct_section.section_id AS direct_section_id,
           project_section.section_id AS project_section_id,
           pinned_project.project_id IS NOT NULL AS project_pinned,
           CASE WHEN session.pinned = 1 THEN 0 ELSE 1 END AS pin_bucket,
           -COALESCE(thread.recency_at, unixepoch(session.created_at) * 1000,
             session.\"order\") AS lane_order
         FROM project_sessions session
         LEFT JOIN project_session_threads link ON link.session_id = session.id
         LEFT JOIN codex_threads thread ON thread.thread_id = link.thread_id
         LEFT JOIN projects project ON project.id = session.project_id
         LEFT JOIN pinned_project_order pinned_project ON pinned_project.project_id = project.id
         LEFT JOIN workspace_sidebar_section_items direct_item
           ON direct_item.session_id = session.id AND direct_item.library_id = ?1
         LEFT JOIN workspace_sidebar_sections direct_section
           ON direct_section.section_id = direct_item.section_id
           AND direct_section.library_id = ?1 AND direct_section.lifecycle = 'active'
         LEFT JOIN workspace_sidebar_section_items project_item
           ON project_item.project_id = project.id AND project_item.library_id = ?1
         LEFT JOIN workspace_sidebar_sections project_section
           ON project_section.section_id = project_item.section_id
           AND project_section.library_id = ?1 AND project_section.lifecycle = 'active'
         WHERE session.archived = ?2
           AND (session.project_id IS NULL OR (project.library_id = ?1
             AND (?2 = 1 OR project.lifecycle <> 'archived')))
           AND (thread.thread_id IS NULL OR thread.parent_thread_id IS NULL))
         SELECT * FROM task_rows {cursor_predicate}
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
                stable_id: task.task.session.id.clone(),
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

fn task_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(ProjectWorkspaceSessionListingItem, i64, i64)> {
    Ok((
        ProjectWorkspaceSessionListingItem {
            task: task_summary_from_row(row, 0)?,
            project_name: row.get("project_name")?,
            direct_section_id: row.get("direct_section_id")?,
            project_section_id: row.get("project_section_id")?,
            project_pinned: row.get("project_pinned")?,
        },
        row.get("pin_bucket")?,
        row.get("lane_order")?,
    ))
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::{
        apply, create_project, create_session_thread, read, seeded_workspace,
    };
    use nodex_core_contracts::workspace::{
        ProjectSessionIntent, ProjectWorkspaceIntent, ProjectWorkspaceRead,
        ProjectWorkspaceReadValue, ProjectWorkspaceSidebarSectionItemRef,
    };

    #[test]
    fn discovery_pages_across_projects_and_projectless_with_exact_archive_scope_and_placement() {
        let workspace = seeded_workspace();
        create_project(&workspace.module, "project", "project:a");
        for (index, project) in [Some("project:a"), Some("project:default"), None]
            .into_iter()
            .enumerate()
        {
            create_session_thread(
                &workspace.module,
                &format!("create:{index}"),
                &format!("session:{index}"),
                &format!("thread:{index}"),
                project,
                index as i64,
            );
        }
        apply(
            &workspace.module,
            "pin-project",
            ProjectWorkspaceIntent::SetProjectPinned {
                project_id: "project:a".into(),
                pinned: true,
            },
        );
        apply(
            &workspace.module,
            "section",
            ProjectWorkspaceIntent::CreateSidebarSection {
                section_id: "section:a".into(),
                name: "Work".into(),
                initial_item: Some(ProjectWorkspaceSidebarSectionItemRef::Session {
                    session_id: "session:2".into(),
                }),
            },
        );
        apply(
            &workspace.module,
            "archive",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:1".into(),
                intent: ProjectSessionIntent::SetArchived { archived: true },
            },
        );
        let fetch = |archived, after, first| {
            let ProjectWorkspaceReadValue::SessionWindow { sessions } = read(
                &workspace.module,
                ProjectWorkspaceRead::SessionWindow {
                    archived,
                    window: CollectionWindowRequest {
                        after,
                        first: Some(first),
                    },
                },
            ) else {
                panic!("Session window expected")
            };
            sessions
        };
        let first = fetch(false, None, 1);
        let second = fetch(false, first.next_cursor.clone(), 1);
        assert_eq!(first.items.len(), 1);
        assert_eq!(second.items.len(), 1);
        assert_ne!(
            first.items[0].task.session.id,
            second.items[0].task.session.id
        );
        let all = fetch(false, None, 100);
        let pinned = all
            .items
            .iter()
            .find(|item| item.task.session.id == "session:0")
            .expect("other Project visible");
        assert!(pinned.project_pinned);
        assert!(pinned.project_name.is_some());
        let direct = all
            .items
            .iter()
            .find(|item| item.task.session.id == "session:2")
            .expect("projectless visible");
        assert_eq!(direct.direct_section_id.as_deref(), Some("section:a"));
        assert!(direct.task.session.project_id.is_none());
        assert!(
            !all.items
                .iter()
                .any(|item| item.task.session.id == "session:1")
        );
        let archived = fetch(true, None, 100);
        assert_eq!(archived.items.len(), 1);
        assert_eq!(archived.items[0].task.session.id, "session:1");
        workspace
            .kernel
            .writer()
            .call(move |connection| {
                let error = read_session_window(
                    connection,
                    "library-1",
                    0,
                    true,
                    &CollectionWindowRequest {
                        after: first.next_cursor,
                        first: Some(1),
                    },
                )
                .expect_err("active cursor cannot enumerate archive");
                assert_eq!(error.code, StoreErrorCode::InvalidInput);
                Ok(())
            })
            .expect("cursor scope assertion");
    }
}
