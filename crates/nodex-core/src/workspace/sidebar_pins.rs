//! Each Member's chat pins share one order across Projects and draft, Codex, and ACP chats.
use std::collections::{BTreeSet, VecDeque};

use nodex_core_contracts::workspace::ProjectWorkspaceSessionPlacement;
use rusqlite::{Connection, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

pub(super) const MAX_PINNED_SESSIONS: usize = 100_000;

pub(super) struct PinnedSession {
    pub id: String,
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
    pub title: String,
    pub rank: i64,
}

pub(super) struct PinOrderChange {
    pub moved_project_id: Option<String>,
    pub project_ids: Vec<String>,
    pub session_ids: Vec<String>,
    pub thread_ids: Vec<String>,
}

pub(super) fn is_pinned(
    connection: &Connection,
    member: &str,
    session_id: &str,
) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM member_session_pins WHERE member_id = ?1 AND session_id = ?2)",
        params![member, session_id],
        |row| row.get(0),
    )?)
}

pub(super) fn read_order(
    connection: &Connection,
    library_id: &str,
    member: &str,
) -> Result<Vec<PinnedSession>, StoreError> {
    let rows = connection
        .prepare(
            "SELECT session.id, session.project_id, thread.thread_id, \
           COALESCE(NULLIF(trim(thread.thread_name), ''), session.no_thread_fallback_title), \
           pin.pinned_order \
         FROM member_session_pins pin \
         JOIN project_sessions session ON session.id = pin.session_id \
         LEFT JOIN project_session_threads link ON link.session_id = session.id \
         LEFT JOIN codex_threads thread ON thread.thread_id = link.thread_id \
         WHERE pin.member_id = ?3 AND session.archived = 0 \
           AND (thread.thread_id IS NULL OR thread.parent_thread_id IS NULL) \
           AND (session.project_id IS NULL OR EXISTS (\
             SELECT 1 FROM projects project WHERE project.id = session.project_id \
               AND project.library_id = ?1 AND project.lifecycle <> 'archived')) \
         ORDER BY pin.pinned_order, session.id LIMIT ?2",
        )?
        .query_map(
            params![
                library_id,
                i64::try_from(MAX_PINNED_SESSIONS + 1).expect("bounded pin count"),
                member
            ],
            |row| {
                Ok(PinnedSession {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    title: row.get(3)?,
                    rank: row.get(4)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() > MAX_PINNED_SESSIONS {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Pinned Session order exceeds its bound",
            false,
        ));
    }
    Ok(rows)
}

/// Pins `session` at the end of `member`'s pins, keeping an existing pin where it is. A pinned
/// chat is never settled, so pinning reopens it.
pub(super) fn pin(
    connection: &Connection,
    member: &str,
    session_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO member_session_pins(member_id, session_id, pinned_order) \
         SELECT ?1, ?2, COALESCE(MAX(pinned_order), -1) + 1 FROM member_session_pins WHERE member_id = ?1 \
         ON CONFLICT(member_id, session_id) DO NOTHING",
        params![member, session_id],
    )?;
    super::member_attention::reopen(connection, member, session_id)?;
    super::member_attention::cancel_snooze(connection, member, session_id)?;
    sync_thread_projection(connection, session_id, now)
}

pub(super) fn unpin(
    connection: &Connection,
    member: &str,
    session_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM member_session_pins WHERE member_id = ?1 AND session_id = ?2",
        params![member, session_id],
    )?;
    sync_thread_projection(connection, session_id, now)
}

pub(super) fn clear_thread_projection(
    connection: &Connection,
    thread_id: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM codex_pinned_threads WHERE thread_id = ?1",
        [thread_id],
    )?;
    Ok(())
}

/// Attached native Threads mirror their Session's pin for the local Member, the only one whose
/// desktop has them, without acquiring another position authority.
pub(super) fn sync_thread_projection(
    connection: &Connection,
    session_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let local = super::member_attention::LOCAL_MEMBER_SQL;
    connection.execute(
        &format!(
            "DELETE FROM codex_pinned_threads WHERE thread_id IN (\
           SELECT link.thread_id FROM project_session_threads link \
           JOIN project_sessions session ON session.id = link.session_id \
           WHERE session.id = ?1 AND (session.archived = 1 OR NOT EXISTS (\
             SELECT 1 FROM member_session_pins pin WHERE pin.session_id = session.id AND pin.member_id = {local})))"
        ),
        [session_id],
    )?;
    connection.execute(
        &format!(
            "INSERT INTO codex_pinned_threads(thread_id, pinned_order, created_at, updated_at) \
         SELECT link.thread_id, pin.pinned_order, ?2, ?2 \
         FROM project_sessions session \
         JOIN member_session_pins pin ON pin.session_id = session.id AND pin.member_id = {local} \
         JOIN project_session_threads link ON link.session_id = session.id \
         JOIN codex_threads thread ON thread.thread_id = link.thread_id \
         WHERE session.id = ?1 AND session.archived = 0 \
           AND thread.parent_thread_id IS NULL AND thread.archived = 0 \
         ON CONFLICT(thread_id) DO UPDATE SET pinned_order = excluded.pinned_order, updated_at = excluded.updated_at"
        ),
        params![session_id, now],
    )?;
    Ok(())
}

pub(super) fn write_order(
    connection: &Connection,
    member: &str,
    session_ids: &[String],
    now: &str,
) -> Result<(), StoreError> {
    for (index, session_id) in session_ids.iter().enumerate() {
        let rank = i64::try_from(index).map_err(|_| {
            StoreError::new(
                StoreErrorCode::InvalidInput,
                "Pinned Session order exceeds its bound",
                false,
            )
        })?;
        connection.execute(
            "UPDATE member_session_pins SET pinned_order = ?1 WHERE member_id = ?2 AND session_id = ?3",
            params![rank, member, session_id],
        )?;
        sync_thread_projection(connection, session_id, now)?;
    }
    Ok(())
}

/// Places a pinned chat next to another visible pin in the Member's order.
pub(super) fn place(
    connection: &Connection,
    library_id: &str,
    member: &str,
    session_id: &str,
    placement: &ProjectWorkspaceSessionPlacement,
    now: &str,
) -> Result<Option<PinOrderChange>, StoreError> {
    let (ProjectWorkspaceSessionPlacement::Before { session_id: anchor }
    | ProjectWorkspaceSessionPlacement::After { session_id: anchor }) = placement;
    super::session_mutation::validate_id("placement.session_id", anchor)?;
    if anchor == session_id {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Session placement anchor must reference another Session",
            false,
        ));
    }

    let mut pins = read_order(connection, library_id, member)?;
    let source = pins
        .iter()
        .position(|pin| pin.id == session_id)
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::InvalidInput,
                "Only visible pinned Sessions can be placed",
                false,
            )
        })?;
    let anchor_index = pins
        .iter()
        .position(|pin| &pin.id == anchor)
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::InvalidInput,
                "Session placement anchor is outside the destination lane",
                false,
            )
        })?;
    let anchor_after_removal = anchor_index - usize::from(source < anchor_index);
    let destination = anchor_after_removal
        + usize::from(matches!(
            placement,
            ProjectWorkspaceSessionPlacement::After { .. }
        ));
    if destination == source {
        return Ok(None);
    }
    let moved = pins.remove(source);
    let moved_project_id = moved.project_id.clone();
    pins.insert(destination, moved);

    let change = PinOrderChange {
        moved_project_id,
        project_ids: pins
            .iter()
            .filter_map(|pin| pin.project_id.as_ref())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .cloned()
            .collect(),
        thread_ids: pins
            .iter()
            .filter_map(|pin| pin.thread_id.clone())
            .collect(),
        session_ids: pins.into_iter().map(|pin| pin.id).collect(),
    };
    write_order(connection, member, &change.session_ids, now)?;
    Ok(Some(change))
}

/// A narrower Project or Thread gesture permutes its existing slots in the Member's pin order.
pub(super) fn reorder_subset(
    connection: &Connection,
    library_id: &str,
    member: &str,
    requested: &[String],
    now: &str,
) -> Result<(), StoreError> {
    let current = read_order(connection, library_id, member)?;
    let members = current
        .iter()
        .map(|row| row.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut replacement = requested
        .iter()
        .filter(|id| members.contains(id.as_str()) && seen.insert(id.as_str()))
        .cloned()
        .collect::<VecDeque<_>>();
    let ordered = current
        .into_iter()
        .map(|row| {
            if seen.contains(row.id.as_str()) {
                replacement
                    .pop_front()
                    .expect("requested pin slots are complete")
            } else {
                row.id
            }
        })
        .collect::<Vec<_>>();
    write_order(connection, member, &ordered, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::{
        TestWorkspace, apply, context, create_project, create_session_thread, enroll_remote_member,
        local_member, request, seeded_workspace,
    };
    use nodex_core_contracts::workspace::{
        ProjectLifecycle, ProjectSessionIntent, ProjectSessionInvalidationScope,
        ProjectWorkspaceIntent as Intent,
    };
    use nodex_core_contracts::{CoreErrorCode, CoreModuleEventPayload};

    fn create_draft(workspace: &TestWorkspace, id: &str, project_id: Option<&str>) {
        apply(
            &workspace.module,
            &format!("create-{id}"),
            Intent::CreateSession {
                session_id: id.into(),
                project_id: project_id.map(str::to_owned),
                title: id.into(),
                initial_page_ids: vec![],
            },
        );
    }

    fn set_pinned(workspace: &TestWorkspace, id: &str, pinned: bool) {
        apply(
            &workspace.module,
            &format!("set-{id}-pinned-{pinned}"),
            Intent::MutateSession {
                session_id: id.into(),
                intent: ProjectSessionIntent::SetPinned { pinned },
            },
        );
    }

    fn before(session_id: &str, anchor: &str) -> Intent {
        Intent::PlaceSession {
            session_id: session_id.into(),
            placement: ProjectWorkspaceSessionPlacement::Before {
                session_id: anchor.into(),
            },
        }
    }

    fn pins(workspace: &TestWorkspace, member: String) -> Vec<PinnedSession> {
        workspace
            .kernel
            .readers()
            .read_default(move |connection| read_order(connection, "library-1", &member))
            .unwrap()
    }

    #[test]
    fn placing_pins_updates_global_order_native_projection_and_sidebar_invalidation() {
        let workspace = seeded_workspace();
        let project = Some("project:default");
        create_project(&workspace.module, "create-other-project", "project:other");
        apply(
            &workspace.module,
            "create-default-draft",
            Intent::EnsureDefaultDraftSession {
                session_id: "draft".into(),
                project_id: project.map(str::to_owned),
                title: "New chat".into(),
            },
        );
        create_draft(&workspace, "other", Some("project:other"));
        create_session_thread(
            &workspace.module,
            "native",
            "native",
            "thread:native",
            project,
            100,
        );
        apply(
            &workspace.module,
            "create-runtime-chat",
            Intent::CreateAgentRuntimeSession {
                session_id: "root-a".into(),
                project_id: None,
                title: "Runtime chat".into(),
                initial_page_ids: vec![],
                agent_selection: None,
                runtime_id: "runtime".into(),
                runtime_thread_id: "root-a-thread".into(),
                launch_request_id: "launch-root-a".into(),
                side_chat_source_session_id: None,
                decision_run: None,
            },
        );
        create_draft(&workspace, "root-b", None);
        for id in ["draft", "other", "native", "root-a", "root-b"] {
            set_pinned(&workspace, id, true);
        }
        apply(
            &workspace.module,
            "inactivate-other-project",
            Intent::SetProjectLifecycle {
                project_id: "project:other".into(),
                lifecycle: ProjectLifecycle::Inactive,
            },
        );

        let assert_order = |expected: &[&str], native_rank: i64| {
            let rows = pins(&workspace, local_member(&workspace));
            assert_eq!(
                rows.iter().map(|pin| pin.id.as_str()).collect::<Vec<_>>(),
                expected
            );
            let projection = workspace
                .kernel
                .readers()
                .read_default(|connection| {
                    Ok(connection
                        .prepare("SELECT thread_id, pinned_order FROM codex_pinned_threads")?
                        .query_map([], |row| {
                            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?)
                })
                .unwrap();
            assert_eq!(projection, [("thread:native".to_owned(), native_rank)]);
        };
        assert_order(&["draft", "other", "native", "root-a", "root-b"], 2);

        let outcome = workspace
            .module
            .apply(
                &context(),
                request("native-before-draft", before("native", "draft")),
            )
            .unwrap();
        assert_order(&["native", "draft", "other", "root-a", "root-b"], 0);
        let CoreModuleEventPayload::ProjectWorkspace(event) = outcome.event.unwrap().payload else {
            panic!("expected Workspace invalidation");
        };
        assert_eq!(event.project_ids, ["project:default", "project:other"]);
        assert_eq!(
            event.session_ids,
            ["native", "draft", "other", "root-a", "root-b"]
        );
        assert_eq!(event.thread_ids, ["thread:native"]);
        assert_eq!(
            event.session_summary_scopes,
            [ProjectSessionInvalidationScope::All]
        );

        for (id, anchor) in [("other", "root-b"), ("root-a", "root-b")] {
            apply(
                &workspace.module,
                &format!("{id}-after-{anchor}"),
                Intent::PlaceSession {
                    session_id: id.into(),
                    placement: ProjectWorkspaceSessionPlacement::After {
                        session_id: anchor.into(),
                    },
                },
            );
        }
        assert_order(&["native", "draft", "root-b", "root-a", "other"], 0);

        apply(
            &workspace.module,
            "archive-other-project",
            Intent::SetProjectLifecycle {
                project_id: "project:other".into(),
                lifecycle: ProjectLifecycle::Archived,
            },
        );
        let error = workspace
            .module
            .apply(
                &context(),
                request("reject-hidden-pin", before("native", "other")),
            )
            .unwrap_err();
        assert_eq!(error.code, CoreErrorCode::InvalidInput);
        assert_eq!(
            error.message,
            "Session placement anchor is outside the destination lane"
        );
    }

    #[test]
    fn placing_sessions_requires_an_anchor_in_the_members_lane() {
        let workspace = seeded_workspace();
        let project = Some("project:default");
        for id in ["pinned-a", "pinned-b", "unpinned"] {
            create_draft(&workspace, id, project);
        }
        for id in ["pinned-a", "pinned-b"] {
            set_pinned(&workspace, id, true);
        }
        workspace
            .kernel
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "UPDATE libraries SET space_kind = 'team' WHERE id = 'library-1';
                 INSERT INTO members(id, library_id, display_name, lifecycle, role)
                   VALUES ('member:other', 'library-1', 'Other', 'active', 'member');
                 INSERT INTO member_session_pins(member_id, session_id, pinned_order)
                   VALUES ('member:other', 'unpinned', 0),
                          ('member:other', 'pinned-a', 1),
                          ('member:other', 'pinned-b', 2);",
                )?;
                Ok(())
            })
            .unwrap();

        for (id, anchor) in [("pinned-a", "unpinned"), ("unpinned", "pinned-a")] {
            let error = workspace
                .module
                .apply(
                    &context(),
                    request(&format!("reject-{id}"), before(id, anchor)),
                )
                .unwrap_err();
            assert_eq!(error.code, CoreErrorCode::InvalidInput);
            assert_eq!(
                error.message,
                "Session placement anchor is outside the destination lane"
            );
        }

        apply(
            &workspace.module,
            "reorder-local-pins",
            before("pinned-b", "pinned-a"),
        );
        let local = pins(&workspace, local_member(&workspace));
        assert_eq!(
            local.iter().map(|pin| pin.id.as_str()).collect::<Vec<_>>(),
            ["pinned-b", "pinned-a"]
        );
        let other = pins(&workspace, "member:other".into());
        assert_eq!(
            other
                .iter()
                .map(|pin| (pin.id.as_str(), pin.rank))
                .collect::<Vec<_>>(),
            [("unpinned", 0), ("pinned-a", 1), ("pinned-b", 2),]
        );
    }

    #[test]
    fn remote_members_can_place_their_own_pins_but_cannot_set_manual_order() {
        let workspace = seeded_workspace();
        let remote = enroll_remote_member(&workspace, "Remote Member");
        let remote_id = remote.principal.as_ref().unwrap().member_id.clone();
        for id in ["a", "b", "host-pin"] {
            create_draft(&workspace, id, None);
            set_pinned(&workspace, id, true);
        }
        for id in ["a", "b"] {
            workspace
                .module
                .apply(
                    &remote,
                    request(
                        &format!("remote-pin-{id}"),
                        Intent::MutateSession {
                            session_id: id.into(),
                            intent: ProjectSessionIntent::SetPinned { pinned: true },
                        },
                    ),
                )
                .unwrap();
        }
        workspace
            .module
            .apply(
                &remote,
                request(
                    "remote-default-draft",
                    Intent::EnsureDefaultDraftSession {
                        session_id: "unpinned".into(),
                        project_id: None,
                        title: "New chat".into(),
                    },
                ),
            )
            .unwrap();

        let placed = workspace
            .module
            .apply(&remote, request("remote-place-pin", before("b", "a")))
            .unwrap();
        assert!(placed.event.is_some());
        let remote_pins = pins(&workspace, remote_id);
        assert_eq!(
            remote_pins
                .iter()
                .map(|pin| pin.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );
        let host_pins = pins(&workspace, local_member(&workspace));
        assert_eq!(
            host_pins
                .iter()
                .map(|pin| pin.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "host-pin"]
        );

        for (op, intent) in [
            ("remote-place-unpinned", before("unpinned", "host-pin")),
            ("remote-place-host-pin", before("host-pin", "unpinned")),
            (
                "remote-move-with-anchor",
                Intent::MoveSession {
                    session_id: "unpinned".into(),
                    project_id: None,
                    placement: Some(ProjectWorkspaceSessionPlacement::Before {
                        session_id: "host-pin".into(),
                    }),
                },
            ),
        ] {
            let error = workspace
                .module
                .apply(&remote, request(op, intent))
                .unwrap_err();
            assert_eq!(error.code, CoreErrorCode::Unauthorized, "{op}");
            assert!(!error.retryable, "{op}");
        }
        workspace
            .module
            .apply(
                &remote,
                request(
                    "remote-move-without-anchor",
                    Intent::MoveSession {
                        session_id: "unpinned".into(),
                        project_id: Some("project:default".into()),
                        placement: None,
                    },
                ),
            )
            .unwrap();
    }

    #[test]
    fn placing_an_already_adjacent_pin_preserves_ranks_and_emits_no_event() {
        let workspace = seeded_workspace();
        for id in ["a", "b", "c"] {
            create_draft(&workspace, id, None);
            set_pinned(&workspace, id, true);
        }
        set_pinned(&workspace, "b", false);

        let command = request("already-before", before("a", "c"));
        let outcome = workspace.module.apply(&context(), command.clone()).unwrap();
        assert!(outcome.event.is_none());
        let rows = pins(&workspace, local_member(&workspace));
        assert_eq!(
            rows.iter()
                .map(|pin| (pin.id.as_str(), pin.rank))
                .collect::<Vec<_>>(),
            [("a", 0), ("c", 2)]
        );
        let replay = workspace.module.apply(&context(), command).unwrap();
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(replay.event.is_none());
    }
}
