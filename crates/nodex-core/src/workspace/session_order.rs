//! Session-owned manual positions. Unarranged chats remain an activity-sorted prefix.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::workspace::ProjectWorkspaceSessionPlacement;
use rusqlite::{Connection, params};

const RANK_GAP: i64 = 1_000_000;

fn lane(
    connection: &Connection,
    project_id: Option<&str>,
    moved: &str,
) -> Result<Vec<(String, Option<i64>)>, StoreError> {
    connection.prepare(
        "SELECT session.id, session.manual_rank FROM project_sessions session \
           AND NOT EXISTS (SELECT 1 FROM project_session_side_chats side WHERE side.session_id=session.id) AND NOT EXISTS (SELECT 1 FROM coordinator WHERE coordinator.session_id = session.id) \
           AND NOT EXISTS (SELECT 1 FROM project_session_threads link JOIN codex_threads thread ON thread.thread_id=link.thread_id WHERE link.session_id=session.id AND thread.parent_thread_id IS NOT NULL) \
           AND NOT EXISTS (SELECT 1 FROM workspace_sidebar_section_items item JOIN workspace_sidebar_sections section ON section.section_id=item.section_id WHERE item.session_id=session.id AND section.lifecycle='active') \
         ORDER BY session.manual_rank IS NOT NULL, CASE WHEN session.manual_rank IS NULL THEN -session.activity_at ELSE session.manual_rank END, session.id"
    )?.query_map(params![project_id, moved], |r| Ok((r.get(0)?,r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

pub(super) fn place(
    connection: &Connection,
    moved: &str,
    project_id: Option<&str>,
    placement: &ProjectWorkspaceSessionPlacement,
) -> Result<(), StoreError> {
    let (ProjectWorkspaceSessionPlacement::Before { session_id: anchor }
    | ProjectWorkspaceSessionPlacement::After { session_id: anchor }) = placement;
    super::session_mutation::validate_id("placement.session_id", anchor)?;
    if anchor == moved {
        return Err(invalid(
            "Session placement anchor must reference another Session",
        ));
    }
    let rows = lane(connection, project_id, moved)?;
    let index = rows
        .iter()
        .position(|(id, _)| id == anchor)
        .ok_or_else(|| invalid("Session placement anchor is outside the destination lane"))?;
    let index = index
        + usize::from(matches!(
            placement,
            ProjectWorkspaceSessionPlacement::After { .. }
        ));
    place_at(connection, moved, project_id, rows, index)
}

pub(super) fn place_at_edge(
    connection: &Connection,
    moved: &str,
    project_id: Option<&str>,
    start: bool,
) -> Result<(), StoreError> {
    let rows = lane(connection, project_id, moved)?;
    let index = if start { 0 } else { rows.len() };
    place_at(connection, moved, project_id, rows, index)
}

fn place_at(
    connection: &Connection,
    moved: &str,
    project_id: Option<&str>,
    mut rows: Vec<(String, Option<i64>)>,
    index: usize,
) -> Result<(), StoreError> {
    let eligible = connection.query_row(
          AND NOT EXISTS(SELECT 1 FROM project_session_side_chats side WHERE side.session_id=session.id) AND NOT EXISTS (SELECT 1 FROM coordinator WHERE coordinator.session_id = session.id) \
          AND NOT EXISTS(SELECT 1 FROM workspace_sidebar_section_items item JOIN workspace_sidebar_sections section ON section.section_id=item.section_id WHERE item.session_id=session.id AND section.lifecycle='active'))",
        params![moved, project_id], |r| r.get::<_, bool>(0))?;
    if !eligible {
        return Err(invalid("Only active built-in lane Sessions can be placed"));
    }
    rows.insert(index, (moved.to_owned(), None));
    let end = index
        + 1
        + rows[index + 1..]
            .iter()
            .take_while(|(_, rank)| rank.is_none())
            .count();
    let count = i64::try_from(end - index)
        .map_err(|_| invalid("Manual Session order exceeds its bound"))?;
    let previous = index.checked_sub(1).and_then(|i| rows[i].1);
    let next = rows.get(end).and_then(|(_, rank)| *rank);
    let start = available_start(previous, next, count);
    let Some((start, step)) = start else {
        // Rewrite only the arranged suffix, including the newly materialized run.
        let first = rows[..index]
            .iter()
            .position(|(_, rank)| rank.is_some())
            .unwrap_or(index);
        for (offset, (id, _)) in rows[first..].iter().enumerate() {
            let rank = i64::try_from(offset + 1)
                .ok()
                .and_then(|n| n.checked_mul(RANK_GAP))
                .ok_or_else(|| invalid("Manual Session rank overflow"))?;
            connection.execute(
                "UPDATE project_sessions SET manual_rank=?1 WHERE id=?2",
                params![rank, id],
            )?;
        }
        return Ok(());
    };
    for (offset, (id, _)) in rows[index..end].iter().enumerate() {
        let rank = start + i64::try_from(offset).expect("bounded run") * step;
        connection.execute(
            "UPDATE project_sessions SET manual_rank=?1 WHERE id=?2",
            params![rank, id],
        )?;
    }
    Ok(())
}

/// Raises a Session's activity to a Store clock reading (RFC 3339). Returns whether it moved.
pub(super) fn raise_activity(
    connection: &Connection,
    session_id: &str,
    now: &str,
) -> Result<bool, StoreError> {
    let changed = connection.execute(
        "UPDATE project_sessions SET activity_at = CAST(round(unixepoch(?2, 'subsec') * 1000) AS INTEGER) \
         WHERE id = ?1 AND activity_at < CAST(round(unixepoch(?2, 'subsec') * 1000) AS INTEGER)",
        params![session_id, now],
    )?;
    Ok(changed > 0)
}

fn available_start(previous: Option<i64>, next: Option<i64>, count: i64) -> Option<(i64, i64)> {
    match (previous, next) {
        (Some(left), Some(right)) => {
            let step = right
                .checked_sub(left)?
                .checked_div(count.checked_add(1)?)?
                .min(RANK_GAP);
            (step > 0).then(|| (left + step, step))
        }
        (None, Some(right)) => Some((right.checked_sub(count.checked_mul(RANK_GAP)?)?, RANK_GAP)),
        (left, None) => {
            let left = left.unwrap_or(0);
            left.checked_add(count.checked_mul(RANK_GAP)?)?;
            Some((left.checked_add(RANK_GAP)?, RANK_GAP))
        }
    }
}
fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::{
        TestWorkspace, apply, create_project, create_session_thread, read, seeded_workspace,
    };
    use nodex_core_contracts::workspace::{
        ProjectSessionIntent, ProjectWorkspaceIntent as Intent,
        ProjectWorkspaceSessionActivityEntry,
    };
    use nodex_core_contracts::workspace::{
        ProjectWorkspaceRead, ProjectWorkspaceReadValue, ProjectWorkspaceTaskOrder,
    };

    fn seed(workspace: &TestWorkspace) {
        for (id, at) in [("a", 400), ("b", 300), ("c", 200), ("d", 100)] {
            create_session_thread(
                &workspace.module,
                &format!("seed-{id}"),
                id,
                &format!("thread:{id}"),
                Some("project:default"),
                at,
            );
        }
    }
    fn place_row(workspace: &TestWorkspace, id: &str, anchor: &str, before: bool, operation: &str) {
        apply(
            &workspace.module,
            operation,
            Intent::PlaceSession {
                session_id: id.into(),
                placement: if before {
                    ProjectWorkspaceSessionPlacement::Before {
                        session_id: anchor.into(),
                    }
                } else {
                    ProjectWorkspaceSessionPlacement::After {
                        session_id: anchor.into(),
                    }
                },
            },
        );
    }
    fn ranks(workspace: &TestWorkspace) -> Vec<(String, Option<i64>)> {
        workspace.kernel.writer().call(|connection| {
            Ok(connection.prepare("SELECT id,manual_rank FROM project_sessions WHERE project_id='project:default' ORDER BY id")?.query_map([],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?)
        }).unwrap()
    }
    fn order(
        workspace: &TestWorkspace,
        kind: ProjectWorkspaceTaskOrder,
        after: Option<String>,
        first: u32,
    ) -> nodex_core_contracts::collection::CollectionWindow<
        nodex_core_contracts::workspace::ProjectWorkspaceTaskSummary,
    > {
        let ProjectWorkspaceReadValue::TaskWindow { tasks } = read(
            &workspace.module,
            ProjectWorkspaceRead::TaskWindow {
                project_id: Some("project:default".into()),
                include_archived: Some(false),
                placement_scope: Default::default(),
                order: kind,
                window: nodex_core_contracts::collection::CollectionWindowRequest {
                    after,
                    first: Some(first),
                },
            },
        ) else {
            panic!("tasks")
        };
        tasks
    }
    fn ids(workspace: &TestWorkspace, kind: ProjectWorkspaceTaskOrder) -> Vec<String> {
        order(workspace, kind, None, 50)
            .items
            .into_iter()
            .map(|r| r.session.id)
            .collect()
    }

    #[test]
    fn placing_materializes_only_the_unarranged_run_below_the_drop() {
        let workspace = seeded_workspace();
        seed(&workspace);
        place_row(&workspace, "d", "b", true, "place-d");
        let initial = ranks(&workspace);
        assert!(initial.iter().find(|r| r.0 == "a").unwrap().1.is_none());
        assert!(initial.iter().filter(|r| r.0 != "a").all(|r| r.1.is_some()));
        assert_eq!(
            ids(&workspace, ProjectWorkspaceTaskOrder::Manual),
            ["a", "d", "b", "c"]
        );
        assert_eq!(
            ids(&workspace, ProjectWorkspaceTaskOrder::Activity),
            ["a", "b", "c", "d"]
        );
        place_row(&workspace, "c", "d", true, "place-c");
        let next = ranks(&workspace);
        for id in ["a", "b", "d"] {
            assert_eq!(
                initial.iter().find(|r| r.0 == id),
                next.iter().find(|r| r.0 == id)
            );
        }
        assert_eq!(
            ids(&workspace, ProjectWorkspaceTaskOrder::Manual),
            ["a", "c", "d", "b"]
        );
        create_session_thread(
            &workspace.module,
            "new-session",
            "new",
            "thread:new",
            Some("project:default"),
            50,
        );
        assert_eq!(
            ids(&workspace, ProjectWorkspaceTaskOrder::Manual),
            ["a", "new", "c", "d", "b"]
        );
    }

    #[test]
    fn exhausted_rank_gaps_renormalize_without_arranging_the_prefix() {
        let workspace = seeded_workspace();
        seed(&workspace);
        workspace.kernel.writer().call(|c| {c.execute_batch("UPDATE project_sessions SET manual_rank=CASE id WHEN 'b' THEN 1 WHEN 'c' THEN 2 ELSE NULL END")?;Ok(())}).unwrap();
        place_row(&workspace, "d", "b", false, "tight-gap");
        assert_eq!(
            ids(&workspace, ProjectWorkspaceTaskOrder::Manual),
            ["a", "b", "d", "c"]
        );
        let rows = ranks(&workspace);
        assert_eq!(rows.iter().find(|r| r.0 == "a").unwrap().1, None);
        assert!(rows.iter().filter_map(|r| r.1).all(|rank| rank >= RANK_GAP));
    }

    #[test]
    fn cross_lane_moves_are_unarranged_unless_given_a_destination_anchor() {
        let workspace = seeded_workspace();
        seed(&workspace);
        create_project(&workspace.module, "other-project", "other");
        place_row(&workspace, "d", "b", true, "place-before-move");
        apply(
            &workspace.module,
            "move-out",
            Intent::MoveSession {
                session_id: "d".into(),
                project_id: Some("other".into()),
                placement: None,
            },
        );
        assert!(
            workspace
                .kernel
                .writer()
                .call(|c| Ok(c.query_row(
                    "SELECT manual_rank IS NULL FROM project_sessions WHERE id='d'",
                    [],
                    |r| r.get::<_, bool>(0)
                )?))
                .unwrap()
        );
        apply(
            &workspace.module,
            "move-back",
            Intent::MoveSession {
                session_id: "d".into(),
                project_id: Some("project:default".into()),
                placement: None,
            },
        );
        assert_eq!(
            ids(&workspace, ProjectWorkspaceTaskOrder::Manual),
            ["a", "d", "b", "c"]
        );
        apply(
            &workspace.module,
            "move-out-again",
            Intent::MoveSession {
                session_id: "d".into(),
                project_id: None,
                placement: None,
            },
        );
        apply(
            &workspace.module,
            "move-with-anchor",
            Intent::MoveSession {
                session_id: "d".into(),
                project_id: Some("project:default".into()),
                placement: Some(ProjectWorkspaceSessionPlacement::After {
                    session_id: "b".into(),
                }),
            },
        );
        assert_eq!(
            ids(&workspace, ProjectWorkspaceTaskOrder::Manual),
            ["a", "b", "d", "c"]
        );
    }

    #[test]
    fn pins_archives_and_custom_sections_release_manual_positions() {
        let workspace = seeded_workspace();
        seed(&workspace);
        place_row(&workspace, "a", "d", false, "place-a");
        apply(
            &workspace.module,
            "pin-a",
            Intent::MutateSession {
                session_id: "a".into(),
                intent: ProjectSessionIntent::SetPinned { pinned: true },
            },
        );
        assert_eq!(
            ranks(&workspace).iter().find(|r| r.0 == "a").unwrap().1,
            None
        );
        place_row(&workspace, "b", "d", false, "place-b");
        apply(
            &workspace.module,
            "archive-b",
            Intent::MutateSession {
                session_id: "b".into(),
                intent: ProjectSessionIntent::SetArchived { archived: true },
            },
        );
        assert_eq!(
            ranks(&workspace).iter().find(|r| r.0 == "b").unwrap().1,
            None
        );
        place_row(&workspace, "c", "d", false, "place-c");
        apply(
            &workspace.module,
            "create-section",
            Intent::CreateSidebarSection {
                section_id: "section:test".into(),
                name: "Test".into(),
                initial_item: None,
            },
        );
        apply(&workspace.module,"move-section",Intent::MoveSidebarSectionItem{item:nodex_core_contracts::workspace::ProjectWorkspaceSidebarSectionItemRef::Session{session_id:"c".into()},section_id:Some("section:test".into()),placement:nodex_core_contracts::workspace::ProjectWorkspaceSidebarSectionItemPlacement::End});
        assert_eq!(
            ranks(&workspace).iter().find(|r| r.0 == "c").unwrap().1,
            None
        );

        let revision = workspace.kernel.writer().call(|connection| Ok(connection.query_row("SELECT revision FROM workspace_sidebar_sections WHERE section_id='section:test'",[],|row|row.get::<_,i64>(0))?)).unwrap();
        apply(
            &workspace.module,
            "delete-section",
            Intent::DeleteSidebarSection {
                section_id: "section:test".into(),
                expected_revision: revision,
            },
        );
        place_row(&workspace, "c", "d", false, "place-released-session");
        assert!(
            ranks(&workspace)
                .iter()
                .find(|r| r.0 == "c")
                .unwrap()
                .1
                .is_some()
        );
        apply(
            &workspace.module,
            "restore-section",
            Intent::RestoreSidebarSection {
                section_id: "section:test".into(),
                expected_revision: revision + 1,
            },
        );
        assert_eq!(
            ranks(&workspace).iter().find(|r| r.0 == "c").unwrap().1,
            None
        );
    }

    #[test]
    fn activity_is_monotonic_clamped_and_independent_of_manual_order() {
        let workspace = seeded_workspace();
        seed(&workspace);
        place_row(&workspace, "d", "b", true, "manual-order");
        let before = ranks(&workspace);
        for (operation, at) in [("raise", 500), ("stale", 1)] {
            apply(
                &workspace.module,
                operation,
                Intent::RecordSessionActivity {
                    entries: vec![ProjectWorkspaceSessionActivityEntry {
                        session_id: "d".into(),
                        at_ms: at,
                    }],
                },
            );
        }
        assert_eq!(
            ids(&workspace, ProjectWorkspaceTaskOrder::Activity),
            ["d", "a", "b", "c"]
        );
        assert_eq!(
            ids(&workspace, ProjectWorkspaceTaskOrder::Manual),
            ["a", "d", "b", "c"]
        );
        assert_eq!(before, ranks(&workspace));
        apply(
            &workspace.module,
            "future",
            Intent::RecordSessionActivity {
                entries: vec![
                    ProjectWorkspaceSessionActivityEntry {
                        session_id: "d".into(),
                        at_ms: i64::MAX,
                    },
                    ProjectWorkspaceSessionActivityEntry {
                        session_id: "deleted".into(),
                        at_ms: 1,
                    },
                ],
            },
        );
        workspace.kernel.writer().call(|c| {let (at,now):(i64,i64)=c.query_row("SELECT activity_at,CAST(round(unixepoch('now','subsec')*1000) AS INTEGER) FROM project_sessions WHERE id='d'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert!(at>=500 && at<=now);Ok(())}).unwrap();
        apply(
            &workspace.module,
            "create-draft",
            Intent::CreateSession {
                session_id: "draft".into(),
                project_id: None,
                title: "Draft".into(),
                initial_page_ids: vec![],
            },
        );
        apply(
            &workspace.module,
            "pre-creation",
            Intent::RecordSessionActivity {
                entries: vec![ProjectWorkspaceSessionActivityEntry {
                    session_id: "draft".into(),
                    at_ms: 0,
                }],
            },
        );
        workspace.kernel.writer().call(|c| {let (at,created):(i64,i64)=c.query_row("SELECT activity_at,CAST(round(unixepoch(created_at,'subsec')*1000) AS INTEGER) FROM project_sessions WHERE id='draft'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;assert_eq!(at,created);Ok(())}).unwrap();
    }

    #[test]
    fn native_recency_raises_session_activity_but_metadata_updates_do_not() {
        let workspace = seeded_workspace();
        seed(&workspace);
        for (operation, recency, updated) in [
            ("native-activity", Some(600), 600),
            ("native-metadata", None, 900),
            ("native-stale", Some(500), 900),
        ] {
            apply(
                &workspace.module,
                operation,
                Intent::UpdateThread {
                    thread_id: "thread:d".into(),
                    patch: Box::new(
                        nodex_core_contracts::workspace::ProjectWorkspaceThreadPatch {
                            recency_at: recency,
                            updated_at: Some(updated),
                            ..Default::default()
                        },
                    ),
                },
            );
        }
        let window = order(&workspace, ProjectWorkspaceTaskOrder::Activity, None, 50);
        assert_eq!(window.items[0].session.id, "d");
        assert_eq!(window.items[0].session.activity_at, 600);
    }

    #[test]
    fn keyset_pages_cover_both_orders_and_reject_a_cursor_from_the_other_order() {
        let workspace = seeded_workspace();
        seed(&workspace);
        place_row(&workspace, "d", "b", true, "place-for-paging");
        for kind in [
            ProjectWorkspaceTaskOrder::Activity,
            ProjectWorkspaceTaskOrder::Manual,
        ] {
            let first = order(&workspace, kind, None, 2);
            let last = order(&workspace, kind, first.next_cursor.clone(), 2);
            assert!(last.next_cursor.is_none());
            assert_eq!(
                first
                    .items
                    .iter()
                    .chain(&last.items)
                    .map(|r| r.session.id.clone())
                    .collect::<Vec<_>>(),
                ids(&workspace, kind)
            );
            let other = if kind == ProjectWorkspaceTaskOrder::Activity {
                ProjectWorkspaceTaskOrder::Manual
            } else {
                ProjectWorkspaceTaskOrder::Activity
            };
            let error = workspace.module.read(
                &crate::workspace::test_support::context(),
                nodex_core_contracts::ModuleReadRequest {
                    contract_version: nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::TaskWindow {
                        project_id: Some("project:default".into()),
                        include_archived: Some(false),
                        placement_scope: Default::default(),
                        order: other,
                        window: nodex_core_contracts::collection::CollectionWindowRequest {
                            after: first.next_cursor,
                            first: Some(2),
                        },
                    },
                },
            );
            assert!(error.is_err());
        }
    }
}
