use nodex_core_contracts::collection::{CollectionWindow, CollectionWindowRequest};
use nodex_core_contracts::workspace::{
    ProjectSessionIntent, ProjectWorkspaceBuiltinSidebarLane as Lane,
    ProjectWorkspaceIntent as Intent, ProjectWorkspaceRead as Read,
    ProjectWorkspaceReadValue as Value, ProjectWorkspaceSidebarOrderEntry,
    ProjectWorkspaceSidebarSectionItemRef as Item,
};
use nodex_core_contracts::{ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION};

use super::ProjectWorkspaceModule;
use super::test_support::{
    apply, context, create_project, create_session_thread, read, request, seeded_workspace,
};

fn order(
    module: &ProjectWorkspaceModule,
    lane: Lane,
    after: Option<String>,
    first: u32,
) -> (String, CollectionWindow<ProjectWorkspaceSidebarOrderEntry>) {
    let Value::BuiltinSidebarOrder {
        order_revision,
        items,
    } = read(
        module,
        Read::BuiltinSidebarOrder {
            lane,
            window: CollectionWindowRequest {
                after,
                first: Some(first),
            },
        },
    )
    else {
        panic!("Sidebar order");
    };
    (order_revision, items)
}
fn ids(window: &CollectionWindow<ProjectWorkspaceSidebarOrderEntry>) -> Vec<String> {
    window
        .items
        .iter()
        .map(|entry| match &entry.item {
            Item::Project { project_id } => project_id.clone(),
            Item::Session { session_id } => session_id.clone(),
        })
        .collect()
}
fn reorder(lane: Lane, revision: &str, ids: &[String]) -> Intent {
    Intent::ReorderBuiltinSidebarItems {
        lane,
        expected_order_revision: revision.to_owned(),
        item_ids: ids.to_vec(),
    }
}
fn draft(module: &ProjectWorkspaceModule, id: &str, project_id: Option<&str>) {
    apply(
        module,
        &format!("create-{id}"),
        Intent::CreateSession {
            session_id: id.to_owned(),
            project_id: project_id.map(str::to_owned),
            title: id.to_owned(),
            initial_page_ids: vec![],
        },
    );
}
fn pin(module: &ProjectWorkspaceModule, id: &str) {
    apply(
        module,
        &format!("pin-{id}"),
        Intent::MutateSession {
            session_id: id.to_owned(),
            intent: ProjectSessionIntent::SetPinned { pinned: true },
        },
    );
}

#[test]
fn complete_project_order_is_atomic_revision_fenced_and_replayable() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    create_project(module, "create-a", "project:a");
    create_project(module, "create-b", "project:b");
    let (revision, original) = order(module, Lane::Projects, None, 100);
    let mut reversed = ids(&original);
    reversed.reverse();
    for (operation, invalid) in [
        ("partial", reversed[..2].to_vec()),
        ("duplicate", vec![reversed[0].clone(); reversed.len()]),
        ("unknown", vec!["missing".to_owned()]),
    ] {
        assert!(
            module
                .apply(
                    &context(),
                    request(operation, reorder(Lane::Projects, &revision, &invalid))
                )
                .is_err()
        );
        assert_eq!(order(module, Lane::Projects, None, 100).0, revision);
    }
    let command = reorder(Lane::Projects, &revision, &reversed);
    module
        .apply(&context(), request("reverse", command.clone()))
        .unwrap();
    assert_eq!(ids(&order(module, Lane::Projects, None, 100).1), reversed);
    assert!(
        module
            .apply(
                &context(),
                request("stale", reorder(Lane::Projects, &revision, &ids(&original)))
            )
            .is_err()
    );
    assert!(
        module
            .apply(&context(), request("reverse", command))
            .unwrap()
            .committed
            .receipt
            .mutation
            .duplicate
    );
    assert_eq!(ids(&order(module, Lane::Projects, None, 100).1), reversed);
}

#[test]
fn project_membership_changes_invalidate_order_and_continuations() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    create_project(module, "create-a", "project:a");
    create_project(module, "create-b", "project:b");
    let (revision, first) = order(module, Lane::Projects, None, 1);
    let (_, second) = order(module, Lane::Projects, first.next_cursor.clone(), 1);
    assert_ne!(ids(&first), ids(&second));
    apply(
        module,
        "pin-a",
        Intent::SetProjectPinned {
            project_id: "project:a".to_owned(),
            pinned: true,
        },
    );
    assert!(
        module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: Read::BuiltinSidebarOrder {
                        lane: Lane::Projects,
                        window: CollectionWindowRequest {
                            after: first.next_cursor,
                            first: Some(1)
                        }
                    }
                }
            )
            .is_err()
    );
    assert_ne!(order(module, Lane::Projects, None, 100).0, revision);
    assert_eq!(
        ids(&order(module, Lane::PinnedProjects, None, 100).1),
        vec!["project:a"]
    );
    apply(
        module,
        "custom-b",
        Intent::CreateSidebarSection {
            section_id: "section:b".to_owned(),
            name: "B".to_owned(),
            initial_item: Some(Item::Project {
                project_id: "project:b".to_owned(),
            }),
        },
    );
    assert_eq!(
        ids(&order(module, Lane::Projects, None, 100).1),
        vec!["project:default"]
    );
}

#[test]
fn default_placement_clears_project_and_session_pins_and_the_thread_projection() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    draft(module, "session:draft", None);
    create_session_thread(
        module,
        "attached",
        "session:attached",
        "thread:attached",
        None,
        1,
    );
    pin(module, "session:draft");
    pin(module, "session:attached");
    apply(
        module,
        "pin-project",
        Intent::SetProjectPinned {
            project_id: "project:default".to_owned(),
            pinned: true,
        },
    );
    let (revision, _) = order(module, Lane::PinnedSessions, None, 100);
    for (operation, item) in [
        (
            "default-project",
            Item::Project {
                project_id: "project:default".to_owned(),
            },
        ),
        (
            "default-draft",
            Item::Session {
                session_id: "session:draft".to_owned(),
            },
        ),
        (
            "default-attached",
            Item::Session {
                session_id: "session:attached".to_owned(),
            },
        ),
    ] {
        apply(module, operation, Intent::MoveSidebarSectionItem {
            item,
            section_id: None,
            placement: nodex_core_contracts::workspace::ProjectWorkspaceSidebarSectionItemPlacement::End,
        });
    }
    assert!(ids(&order(module, Lane::PinnedProjects, None, 100).1).is_empty());
    assert!(ids(&order(module, Lane::PinnedSessions, None, 100).1).is_empty());
    assert_ne!(order(module, Lane::PinnedSessions, None, 100).0, revision);
    assert_eq!(
        ids(&order(module, Lane::Projects, None, 100).1),
        ["project:default"]
    );
    for session_id in ["session:draft", "session:attached"] {
        let Value::Session { session } = read(
            module,
            Read::Session {
                session_id: session_id.to_owned(),
            },
        ) else {
            panic!("Session");
        };
        assert!(!session.pinned);
        assert_eq!(session.pinned_order, None);
    }
    let Value::Thread { thread } = read(
        module,
        Read::Thread {
            thread_id: "thread:attached".to_owned(),
        },
    ) else {
        panic!("Thread");
    };
    assert_eq!(thread.pinned_order, None);
}

#[test]
fn session_pin_order_includes_drafts_and_thread_projection_and_reorders_only_requested_slots() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    draft(module, "session:draft", None);
    create_session_thread(
        module,
        "a",
        "session:a",
        "thread:a",
        Some("project:default"),
        1,
    );
    create_session_thread(module, "b", "session:b", "thread:b", None, 2);
    pin(module, "session:a");
    pin(module, "session:draft");
    pin(module, "session:b");
    let (revision, original) = order(module, Lane::PinnedSessions, None, 100);
    assert_eq!(
        ids(&original),
        vec!["session:a", "session:draft", "session:b"]
    );
    let command = reorder(
        Lane::PinnedSessions,
        &revision,
        &[
            "session:b".to_owned(),
            "session:draft".to_owned(),
            "session:a".to_owned(),
        ],
    );
    let result = module
        .apply(&context(), request("reverse-pins", command))
        .unwrap();
    assert_eq!(result.committed.value.affected_session_ids.len(), 3);
    for (id, rank) in [("session:b", 0), ("session:draft", 1), ("session:a", 2)] {
        let Value::Session { session } = read(
            module,
            Read::Session {
                session_id: id.to_owned(),
            },
        ) else {
            panic!("Session");
        };
        assert_eq!(session.pinned_order, Some(rank));
    }
    let Value::Thread { thread } = read(
        module,
        Read::Thread {
            thread_id: "thread:a".to_owned(),
        },
    ) else {
        panic!("Thread");
    };
    assert_eq!(thread.pinned_order, Some(2));
    let result = module
        .apply(
            &context(),
            request(
                "thread-gesture",
                Intent::ReorderPinnedThreads {
                    thread_ids: vec!["thread:a".to_owned(), "thread:b".to_owned()],
                },
            ),
        )
        .unwrap();
    assert_eq!(result.committed.value.affected_session_ids.len(), 3);
    assert_eq!(
        ids(&order(module, Lane::PinnedSessions, None, 100).1),
        vec!["session:a", "session:draft", "session:b"]
    );
}

#[test]
fn title_edits_preserve_order_revision_while_archive_and_restore_change_membership() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    draft(module, "session:draft", None);
    pin(module, "session:draft");
    let (revision, _) = order(module, Lane::PinnedSessions, None, 100);
    apply(
        module,
        "rename",
        Intent::MutateSession {
            session_id: "session:draft".to_owned(),
            intent: ProjectSessionIntent::Rename {
                title: "Renamed draft".to_owned(),
            },
        },
    );
    let (renamed_revision, renamed) = order(module, Lane::PinnedSessions, None, 100);
    assert_eq!(revision, renamed_revision);
    assert_eq!(renamed.items[0].title, "Renamed draft");
    apply(
        module,
        "archive",
        Intent::MutateSession {
            session_id: "session:draft".to_owned(),
            intent: ProjectSessionIntent::SetArchived { archived: true },
        },
    );
    assert!(
        order(module, Lane::PinnedSessions, None, 100)
            .1
            .items
            .is_empty()
    );
    assert!(
        module
            .apply(
                &context(),
                request(
                    "stale-archive",
                    reorder(
                        Lane::PinnedSessions,
                        &revision,
                        &["session:draft".to_owned()]
                    )
                )
            )
            .is_err()
    );
    apply(
        module,
        "restore",
        Intent::MutateSession {
            session_id: "session:draft".to_owned(),
            intent: ProjectSessionIntent::SetArchived { archived: false },
        },
    );
    assert!(
        order(module, Lane::PinnedSessions, None, 100)
            .1
            .items
            .is_empty()
    );
    let Value::Session { session } = read(
        module,
        Read::Session {
            session_id: "session:draft".to_owned(),
        },
    ) else {
        panic!("restored Session");
    };
    assert!(!session.archived);
    assert!(!session.pinned);
}

#[test]
fn attaching_an_acp_thread_and_moving_projects_preserves_the_session_pin_position() {
    use nodex_core_contracts::agent::AgentBackendBinding;
    use nodex_core_contracts::workspace::ProjectWorkspaceThreadPatch;
    let workspace = seeded_workspace();
    let module = &workspace.module;
    draft(module, "session:acp", Some("project:default"));
    draft(module, "session:draft", None);
    pin(module, "session:acp");
    pin(module, "session:draft");
    let (revision, original) = order(module, Lane::PinnedSessions, None, 100);
    let binding = AgentBackendBinding::Acp {
        agent_definition_id: "agent:test".to_owned(),
        instance_config_id: None,
    };
    apply(
        module,
        "create-acp-thread",
        Intent::UpsertThread {
            thread_id: "thread:acp".to_owned(),
            patch: Box::new(ProjectWorkspaceThreadPatch {
                project_id: Some(Some("project:default".to_owned())),
                backend_binding: Some(binding.clone()),
                ..ProjectWorkspaceThreadPatch::default()
            }),
        },
    );
    apply(
        module,
        "attach-acp-thread",
        Intent::MutateSession {
            session_id: "session:acp".to_owned(),
            intent: ProjectSessionIntent::LinkThread {
                thread_id: "thread:acp".to_owned(),
                expected_project_id: Some("project:default".to_owned()),
                thread_patch: None,
                execution_location: None,
            },
        },
    );
    let Value::Thread { thread } = read(
        module,
        Read::Thread {
            thread_id: "thread:acp".to_owned(),
        },
    ) else {
        panic!("ACP Thread");
    };
    assert_eq!(thread.backend_binding, binding);
    assert_eq!(thread.pinned_order, Some(0));
    assert_eq!(order(module, Lane::PinnedSessions, None, 100).0, revision);
    apply(
        module,
        "move-acp-project",
        Intent::MoveSession {
            session_id: "session:acp".to_owned(),
            project_id: None,
        },
    );
    let (moved_revision, moved) = order(module, Lane::PinnedSessions, None, 100);
    assert_eq!(ids(&moved), ids(&original));
    assert_eq!(moved_revision, revision);
    apply(
        module,
        "detach-acp-thread",
        Intent::MutateSession {
            session_id: "session:acp".to_owned(),
            intent: ProjectSessionIntent::UnlinkThread {
                thread_id: "thread:acp".to_owned(),
            },
        },
    );
    let Value::Thread { thread } = read(
        module,
        Read::Thread {
            thread_id: "thread:acp".to_owned(),
        },
    ) else {
        panic!("detached Thread");
    };
    assert_eq!(thread.pinned_order, None);
    assert_eq!(order(module, Lane::PinnedSessions, None, 100).0, revision);
    apply(
        module,
        "reattach-acp-thread",
        Intent::MutateSession {
            session_id: "session:acp".to_owned(),
            intent: ProjectSessionIntent::LinkThread {
                thread_id: "thread:acp".to_owned(),
                expected_project_id: None,
                thread_patch: None,
                execution_location: None,
            },
        },
    );
    apply(
        module,
        "delete-acp-session",
        Intent::DeleteSession {
            session_id: "session:acp".to_owned(),
        },
    );
    let Value::Thread { thread } = read(
        module,
        Read::Thread {
            thread_id: "thread:acp".to_owned(),
        },
    ) else {
        panic!("unowned Thread");
    };
    assert_eq!(thread.pinned_order, None);
    assert_eq!(
        ids(&order(module, Lane::PinnedSessions, None, 100).1),
        vec!["session:draft"]
    );
}

#[test]
fn an_unowned_thread_cannot_create_a_second_sidebar_pin_authority() {
    use nodex_core_contracts::workspace::ProjectWorkspaceThreadPatch;
    let workspace = seeded_workspace();
    let module = &workspace.module;
    apply(
        module,
        "unowned-thread",
        Intent::UpsertThread {
            thread_id: "thread:unowned".to_owned(),
            patch: Box::new(ProjectWorkspaceThreadPatch::default()),
        },
    );
    assert!(
        module
            .apply(
                &context(),
                request(
                    "pin-unowned",
                    Intent::SetThreadPinned {
                        thread_id: "thread:unowned".to_owned(),
                        pinned: true,
                        placement: None
                    }
                )
            )
            .is_err()
    );
    let Value::Thread { thread } = read(
        module,
        Read::Thread {
            thread_id: "thread:unowned".to_owned(),
        },
    ) else {
        panic!("unowned Thread");
    };
    assert_eq!(thread.pinned_order, None);
    assert!(
        order(module, Lane::PinnedSessions, None, 100)
            .1
            .items
            .is_empty()
    );
}

#[test]
fn project_priority_preserves_unlisted_order_and_replays_the_original_partial_request() {
    for lane in [Lane::Projects, Lane::PinnedProjects] {
        let workspace = seeded_workspace();
        let module = &workspace.module;
        create_project(module, "create-a", "project:a");
        create_project(module, "create-b", "project:b");
        if lane == Lane::PinnedProjects {
            for (index, id) in ids(&order(module, Lane::Projects, None, 100).1)
                .iter()
                .enumerate()
            {
                apply(
                    module,
                    &format!("pin-{index}"),
                    Intent::SetProjectPinned {
                        project_id: id.clone(),
                        pinned: true,
                    },
                );
            }
        }
        let (revision, original) = order(module, lane, None, 100);
        let original_ids = ids(&original);
        assert_eq!(original_ids.len(), 3);
        let expected = vec![
            original_ids[2].clone(),
            original_ids[0].clone(),
            original_ids[1].clone(),
        ];
        let command = Intent::PrioritizeBuiltinSidebarProjects {
            lane,
            expected_order_revision: revision.clone(),
            project_ids: vec![original_ids[2].clone()],
        };
        module
            .apply(&context(), request("prioritize", command.clone()))
            .unwrap();
        assert_eq!(ids(&order(module, lane, None, 100).1), expected);
        assert!(
            module
                .apply(&context(), request("prioritize", command))
                .unwrap()
                .committed
                .receipt
                .mutation
                .duplicate
        );
        assert_eq!(ids(&order(module, lane, None, 100).1), expected);
        let (current_revision, _) = order(module, lane, None, 100);
        apply(
            module,
            "empty",
            Intent::PrioritizeBuiltinSidebarProjects {
                lane,
                expected_order_revision: current_revision.clone(),
                project_ids: vec![],
            },
        );
        assert_eq!(order(module, lane, None, 100).0, current_revision);
        for (operation, expected_order_revision, project_ids) in [
            ("stale", revision, vec![original_ids[0].clone()]),
            (
                "duplicate",
                current_revision.clone(),
                vec![original_ids[0].clone(), original_ids[0].clone()],
            ),
            (
                "unknown",
                current_revision.clone(),
                vec!["project:missing".to_owned()],
            ),
        ] {
            assert!(
                module
                    .apply(
                        &context(),
                        request(
                            operation,
                            Intent::PrioritizeBuiltinSidebarProjects {
                                lane,
                                expected_order_revision,
                                project_ids,
                            }
                        )
                    )
                    .is_err()
            );
            assert_eq!(ids(&order(module, lane, None, 100).1), expected);
        }
    }
}

#[test]
fn project_priority_rejects_changed_membership_and_the_session_lane() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    let (revision, original) = order(module, Lane::Projects, None, 100);
    create_project(module, "create-a", "project:a");
    let current = order(module, Lane::Projects, None, 100);
    assert!(
        module
            .apply(
                &context(),
                request(
                    "old-membership",
                    Intent::PrioritizeBuiltinSidebarProjects {
                        lane: Lane::Projects,
                        expected_order_revision: revision,
                        project_ids: ids(&original),
                    }
                )
            )
            .is_err()
    );
    assert_eq!(
        ids(&order(module, Lane::Projects, None, 100).1),
        ids(&current.1)
    );
    let (revision, _) = order(module, Lane::PinnedSessions, None, 100);
    assert!(
        module
            .apply(
                &context(),
                request(
                    "wrong-lane",
                    Intent::PrioritizeBuiltinSidebarProjects {
                        lane: Lane::PinnedSessions,
                        expected_order_revision: revision,
                        project_ids: vec![],
                    }
                )
            )
            .is_err()
    );
}
