use super::task_window::{TASK_SUMMARY_COLUMNS, task_summary_from_row};
use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::workspace::{
    ProjectWorkspaceSessionExecutionRef, ProjectWorkspaceSessionListingItem,
    ProjectWorkspaceSessionOpenStats, ProjectWorkspaceSessionOrder,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params_from_iter};

pub(super) struct SessionListingFilter<'a> {
    pub archived: bool,
    pub order: ProjectWorkspaceSessionOrder,
    pub projectless_only: bool,
    pub project_id: Option<&'a str>,
    pub query: Option<&'a str>,
    pub native_only: bool,
    pub execution_refs: Option<&'a [ProjectWorkspaceSessionExecutionRef]>,
    pub session_ids: Option<&'a [String]>,
}

pub(super) fn read_session_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    filter: SessionListingFilter<'_>,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceSessionListingItem>, StoreError> {
    let SessionListingFilter {
        archived,
        order,
        projectless_only,
        project_id,
        query,
        native_only,
        execution_refs,
        session_ids,
    } = filter;
    if let Some(project_id) = project_id {
        super::session_mutation::validate_id("project_id", project_id)?;
    }
    for reference in execution_refs.unwrap_or_default() {
        super::session_mutation::validate_id("runtime_id", &reference.runtime_id)?;
        super::session_mutation::validate_id("thread_id", &reference.thread_id)?;
    }
    for id in session_ids.unwrap_or_default() {
        super::session_mutation::validate_id("session_id", id)?;
    }
    if session_ids.is_some_and(|values| values.len() > 100) {
        return Err(invalid(
            "Session discovery accepts at most 100 Session identities",
        ));
    }
    let session_json = session_ids
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| invalid("Session identities are invalid"))?;
    let query = query.map(str::trim).filter(|value| !value.is_empty());
    if query.is_some_and(|value| value.chars().count() > 200) {
        return Err(invalid("Session discovery query exceeds 200 characters"));
    }
    if execution_refs.is_some_and(|values| values.len() > 100) {
        return Err(invalid(
            "Session discovery accepts at most 100 execution references",
        ));
    }
    let execution_json = execution_refs
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| invalid("Session execution references are invalid"))?;
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&(
        "workspace_session_listing_v5",
        order,
        archived,
        projectless_only,
        project_id,
        query,
        native_only,
        execution_refs,
        session_ids,
    ))?;
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
            if direction != CursorDirection::Forward || coordinate.values.len() != 1 {
                return Err(invalid("Session discovery cursor is incompatible"));
            }
            let [KeysetValue::Integer { value: lane_order }] = coordinate.values.as_slice() else {
                return Err(invalid("Session discovery cursor coordinate is invalid"));
            };
            Ok((*lane_order, coordinate.stable_id))
        })
        .transpose()?;
    let mut parameters = vec![
        SqlValue::Text(library_id.to_owned()),
        SqlValue::Integer(i64::from(archived)),
        project_id.map_or(SqlValue::Null, |value| SqlValue::Text(value.to_owned())),
        query.map_or(SqlValue::Null, |value| SqlValue::Text(value.to_owned())),
        SqlValue::Integer(i64::from(native_only)),
        execution_json.map_or(SqlValue::Null, SqlValue::Text),
        session_json.map_or(SqlValue::Null, SqlValue::Text),
    ];
    let cursor_predicate = coordinate
        .map(|(lane_order, stable_id)| {
            parameters.extend([SqlValue::Integer(lane_order), SqlValue::Text(stable_id)]);
            "WHERE lane_order > ?8 OR (lane_order = ?8 AND session_id > ?9)"
        })
        .unwrap_or_default();
    parameters.push(SqlValue::Integer(
        i64::try_from(normalized.first + 1)
            .map_err(|_| invalid("Workspace task window size is invalid"))?,
    ));
    let limit_parameter = parameters.len();
    // Exact Runtime candidates use the unique execution index before joining Session metadata.
    let execution_predicate = if execution_refs.is_some() {
        "AND session.id IN (SELECT execution.session_id FROM json_each(?6) wanted
           JOIN project_session_execution_bindings execution
             ON execution.runtime_id = json_extract(wanted.value, '$.runtime_id')
             AND execution.runtime_thread_id = json_extract(wanted.value, '$.thread_id'))"
    } else {
        ""
    };
    let projectless_predicate = if projectless_only {
        "AND session.project_id IS NULL"
    } else {
        ""
    };
    let order_expression = match order {
        ProjectWorkspaceSessionOrder::Identity => "0",
        ProjectWorkspaceSessionOrder::Conversation => {
            "-COALESCE(thread.recency_at, CAST(round(unixepoch(session.created_at, 'subsec') * 1000) AS INTEGER),session.\"order\")"
        }
    };
    let sql = format!(
        "WITH task_rows AS (SELECT {TASK_SUMMARY_COLUMNS},
           project.name AS project_name,
           usage.opened_at AS opened_at, usage.score AS open_score,
           direct_section.section_id AS direct_section_id,
           project_section.section_id AS project_section_id,
           pinned_project.project_id IS NOT NULL AS project_pinned,
           {order_expression} AS lane_order
         FROM project_sessions session
         LEFT JOIN project_session_usage usage ON usage.session_id = session.id
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
         WHERE NOT EXISTS (SELECT 1 FROM project_session_side_chats side WHERE side.session_id = session.id) AND session.archived = ?2
           AND (session.project_id IS NULL OR (project.library_id = ?1
             AND (?2 = 1 OR project.lifecycle <> 'archived')))
           AND (thread.thread_id IS NULL OR thread.parent_thread_id IS NULL)
           AND (?3 IS NULL OR session.project_id = ?3)
           AND (?4 IS NULL OR instr(lower(COALESCE(thread.thread_name, session.no_thread_fallback_title)), lower(?4)) > 0
             OR instr(lower(COALESCE(thread.thread_preview, '')), lower(?4)) > 0)
           AND (?5 = 0 OR NOT EXISTS (SELECT 1 FROM project_session_execution_bindings execution
             WHERE execution.session_id = session.id))
           AND (?7 IS NULL OR session.id IN (SELECT value FROM json_each(?7)))
           {execution_predicate} {projectless_predicate})
         SELECT * FROM task_rows {cursor_predicate}
         ORDER BY lane_order, session_id LIMIT ?{limit_parameter}"
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), task_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = rows
        .into_iter()
        .map(|(mut task, lane_order)| {
            let coordinate = KeysetCoordinate {
                values: vec![KeysetValue::Integer { value: lane_order }],
                stable_id: task.task.session.id.clone(),
            };
            task.cursor = cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )?;
            Ok(WindowCandidate {
                coordinate,
                item: task,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
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
) -> rusqlite::Result<(ProjectWorkspaceSessionListingItem, i64)> {
    Ok((
        ProjectWorkspaceSessionListingItem {
            cursor: String::new(),
            task: task_summary_from_row(row, 0)?,
            project_name: row.get("project_name")?,
            direct_section_id: row.get("direct_section_id")?,
            project_section_id: row.get("project_section_id")?,
            project_pinned: row.get("project_pinned")?,
            opens: row
                .get::<_, Option<i64>>("opened_at")?
                .map(|opened_at| -> rusqlite::Result<_> {
                    Ok(ProjectWorkspaceSessionOpenStats {
                        opened_at,
                        score: row.get("open_score")?,
                    })
                })
                .transpose()?,
        },
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
        apply, create_library_page, create_project, create_session_thread, read, seeded_workspace,
    };
    use nodex_core_contracts::workspace::{
        ProjectSessionIntent, ProjectWorkspaceIntent, ProjectWorkspaceRead,
        ProjectWorkspaceReadValue, ProjectWorkspaceSidebarSectionItemRef,
        ProjectWorkspaceThreadPatch, ProjectWorkspaceThreadStatus,
    };

    #[test]
    fn foreground_opens_are_durable_deduped_and_do_not_change_activity_or_unread() {
        let workspace = seeded_workspace();
        create_session_thread(
            &workspace.module,
            "create",
            "session:opened",
            "thread:opened",
            None,
            1,
        );
        let fetch = || {
            let ProjectWorkspaceReadValue::SessionWindow {
                sessions,
                search_revision,
            } = read(
                &workspace.module,
                ProjectWorkspaceRead::SessionWindow {
                    order: None,
                    projectless_only: None,
                    archived: false,
                    project_id: None,
                    query: None,
                    native_only: None,
                    execution_refs: None,
                    session_ids: Some(vec!["session:opened".into()]),
                    window: CollectionWindowRequest {
                        after: None,
                        first: Some(1),
                    },
                },
            )
            else {
                panic!("Session window expected")
            };
            (sessions.items[0].clone(), search_revision)
        };
        let (before, initial_revision) = fetch();
        assert!(before.opens.is_none());
        assert_eq!(
            fetch().1,
            initial_revision,
            "Passive discovery must not record opens"
        );
        create_library_page(&workspace, "page:unrelated", "project:default");
        apply(
            &workspace.module,
            "background-status",
            ProjectWorkspaceIntent::UpsertThread {
                thread_id: "thread:opened".into(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    thread_preview: Some("Background preview".into()),
                    status: Some(ProjectWorkspaceThreadStatus {
                        status_type: nodex_core_contracts::workspace::CodexThreadStatusType::Active,
                        active_flags: vec![],
                    }),
                    ..ProjectWorkspaceThreadPatch::default()
                }),
            },
        );
        assert_eq!(
            fetch().1,
            initial_revision,
            "Unrelated Pages and nonranking status updates keep the snapshot valid"
        );
        let before = fetch().0;
        for operation in ["opened", "opened", "reopened"] {
            apply(
                &workspace.module,
                operation,
                ProjectWorkspaceIntent::MutateSession {
                    session_id: "session:opened".into(),
                    intent: ProjectSessionIntent::RecordOpened,
                },
            );
        }
        let (after, opened_revision) = fetch();
        assert_eq!(after.opens.as_ref().unwrap().score, 1.0);
        assert!(after.opens.as_ref().unwrap().opened_at > 0);
        assert_eq!(
            opened_revision,
            initial_revision + 1,
            "Receipt retries and deduped opens do not change rank"
        );
        assert_eq!(
            before.task, after.task,
            "Usage does not become conversation activity or read receipts"
        );
        apply(
            &workspace.module,
            "unread",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:opened".into(),
                intent: ProjectSessionIntent::SetUnread { unread: true },
            },
        );
        assert_eq!(
            fetch().1,
            opened_revision,
            "Read receipts do not invalidate ranking"
        );
        apply(
            &workspace.module,
            "rename",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:opened".into(),
                intent: ProjectSessionIntent::Rename {
                    title: "Opened title".into(),
                },
            },
        );
        assert!(
            fetch().1 > opened_revision,
            "Canonical titles invalidate ranked search"
        );
        let before_recency = fetch().1;
        apply(
            &workspace.module,
            "recency",
            ProjectWorkspaceIntent::UpsertThread {
                thread_id: "thread:opened".into(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    recency_at: Some(2),
                    ..ProjectWorkspaceThreadPatch::default()
                }),
            },
        );
        assert!(
            fetch().1 > before_recency,
            "Discovery keyset changes invalidate the candidate snapshot"
        );
    }

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
            let ProjectWorkspaceReadValue::SessionWindow { sessions, .. } = read(
                &workspace.module,
                ProjectWorkspaceRead::SessionWindow {
                    order: None,
                    projectless_only: None,
                    archived,
                    project_id: None,
                    query: None,
                    native_only: None,
                    execution_refs: None,
                    session_ids: None,
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
        let ProjectWorkspaceReadValue::SessionWindow {
            sessions: projectless,
            ..
        } = read(
            &workspace.module,
            ProjectWorkspaceRead::SessionWindow {
                order: None,
                projectless_only: Some(true),
                archived: false,
                project_id: None,
                query: None,
                native_only: None,
                execution_refs: None,
                session_ids: None,
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(1),
                },
            },
        )
        else {
            panic!("Session window expected")
        };
        assert_eq!(projectless.items.len(), 1);
        assert_eq!(projectless.items[0].task.session.id, "session:2");
        assert!(projectless.next_cursor.is_none());
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
                    SessionListingFilter {
                        order: ProjectWorkspaceSessionOrder::Conversation,
                        projectless_only: false,
                        archived: true,
                        project_id: None,
                        query: None,
                        native_only: false,
                        execution_refs: None,
                        session_ids: None,
                    },
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
    #[test]
    fn discovery_filters_before_pagination_and_preserves_each_owner_cursor() {
        let workspace = seeded_workspace();
        create_project(&workspace.module, "other-project", "project:other");
        for (session, thread, project, at) in [
            ("session:old", "Older title", "project:default", 10),
            ("session:new", "Newer title", "project:default", 20),
            ("session:other", "Other title", "project:other", 30),
        ] {
            create_session_thread(
                &workspace.module,
                session,
                session,
                thread,
                Some(project),
                at,
            );
        }
        apply(
            &workspace.module,
            "pin-old",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:old".into(),
                intent: ProjectSessionIntent::SetPinned { pinned: true },
            },
        );
        apply(
            &workspace.module,
            "runtime",
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                side_chat_source_session_id: None,
                session_id: "session:runtime".into(),
                project_id: Some("project:default".into()),
                title: "Runtime chat".into(),
                initial_page_ids: vec![],
                runtime_id: "runtime:one".into(),
                runtime_thread_id: "runtime-thread".into(),
                launch_request_id: "launch:one".into(),
            },
        );
        let fetch = |query: Option<String>,
                     after: Option<String>,
                     refs: Option<Vec<ProjectWorkspaceSessionExecutionRef>>| {
            let ProjectWorkspaceReadValue::SessionWindow { sessions, .. } = read(
                &workspace.module,
                ProjectWorkspaceRead::SessionWindow {
                    order: None,
                    projectless_only: None,
                    archived: false,
                    project_id: Some("project:default".into()),
                    query,
                    native_only: Some(refs.is_none()),
                    execution_refs: refs,
                    session_ids: None,
                    window: CollectionWindowRequest {
                        first: Some(1),
                        after,
                    },
                },
            ) else {
                panic!("Session window expected")
            };
            sessions
        };
        let first = fetch(None, None, None);
        assert_eq!(first.items[0].task.session.id, "session:new");
        assert_eq!(
            first.next_cursor.as_deref(),
            Some(first.items[0].cursor.as_str())
        );
        let second = fetch(None, Some(first.items[0].cursor.clone()), None);
        assert_eq!(second.items[0].task.session.id, "session:old");
        assert!(second.items[0].task.session.pinned);
        assert!(second.next_cursor.is_none());
        let matching = fetch(Some("older".into()), None, None);
        assert_eq!(matching.items[0].task.session.id, "session:old");
        assert!(matching.next_cursor.is_none());
        let runtime = fetch(
            None,
            None,
            Some(vec![ProjectWorkspaceSessionExecutionRef {
                runtime_id: "runtime:one".into(),
                thread_id: "runtime-thread".into(),
            }]),
        );
        assert_eq!(runtime.items[0].task.session.id, "session:runtime");
        assert!(runtime.items[0].task.thread.is_none());
        assert!(fetch(None, None, Some(vec![])).items.is_empty());
        let ProjectWorkspaceReadValue::SessionWindow {
            sessions: selected, ..
        } = read(
            &workspace.module,
            ProjectWorkspaceRead::SessionWindow {
                order: None,
                projectless_only: None,
                archived: false,
                project_id: Some("project:default".into()),
                query: None,
                native_only: None,
                execution_refs: None,
                session_ids: Some(vec!["session:old".into(), "missing".into()]),
                window: CollectionWindowRequest {
                    first: Some(100),
                    after: None,
                },
            },
        )
        else {
            panic!("Session window expected")
        };
        assert_eq!(selected.items.len(), 1);
        assert_eq!(selected.items[0].task.session.id, "session:old");
        assert!(selected.items[0].task.session.pinned);
    }

    #[test]
    fn identity_enumeration_survives_unscanned_native_activity_changes() {
        let workspace = seeded_workspace();
        for (index, id) in ["a", "b", "c"].into_iter().enumerate() {
            create_session_thread(
                &workspace.module,
                &format!("create:{id}"),
                id,
                &format!("thread:{id}"),
                None,
                index as i64,
            );
        }
        let fetch = |after| {
            let ProjectWorkspaceReadValue::SessionWindow { sessions, .. } = read(
                &workspace.module,
                ProjectWorkspaceRead::SessionWindow {
                    order: Some(ProjectWorkspaceSessionOrder::Identity),
                    archived: false,
                    projectless_only: None,
                    project_id: None,
                    query: None,
                    native_only: None,
                    execution_refs: None,
                    session_ids: None,
                    window: CollectionWindowRequest {
                        after,
                        first: Some(1),
                    },
                },
            ) else {
                panic!("Session window")
            };
            sessions
        };
        let first = fetch(None);
        assert_eq!(first.items[0].task.session.id, "a");
        apply(
            &workspace.module,
            "new-activity",
            ProjectWorkspaceIntent::UpsertThread {
                thread_id: "thread:c".into(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    recency_at: Some(9_999_999_999_999),
                    ..Default::default()
                }),
            },
        );
        let second = fetch(first.next_cursor);
        assert_eq!(second.items[0].task.session.id, "b");
        let third = fetch(second.next_cursor);
        assert_eq!(third.items[0].task.session.id, "c");
        assert!(third.next_cursor.is_none());
    }
}
