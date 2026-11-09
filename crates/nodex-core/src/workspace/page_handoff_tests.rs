use nodex_core_contracts::database::{
    DatabaseIntent, DatabasePagePropertyAddress, DatabasePropertyValueEdit,
    DatabasePropertyValueInput, DatabasePropertyValueMutation,
};
use nodex_core_contracts::workspace::{
    ProjectSessionIntent, ProjectWorkspaceIntent, ProjectWorkspacePageCreationTarget,
};
use nodex_core_contracts::{
    DATABASE_CONTRACT_VERSION, ModuleApplyRequest, ProjectionImpact, StoreEpoch,
};
use rusqlite::{OptionalExtension, params};

use crate::database::property_semantics::{
    COMPLETED_STATUS_OPTION_ID as COMPLETED, IN_PROGRESS_STATUS_OPTION_ID as IN_PROGRESS,
};

use super::test_support::{
    TestWorkspace, apply, context, create_library_page, create_project, request, seeded_workspace,
};

const PROJECT: &str = "project:handoff";

fn setup() -> TestWorkspace {
    let workspace = seeded_workspace();
    create_project(&workspace.module, "create-project", PROJECT);
    apply(
        &workspace.module,
        "create-chat",
        create_chat("session:chat", vec![]),
    );
    workspace
}

fn create_chat(session_id: &str, initial_page_ids: Vec<String>) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::CreateSession {
        session_id: session_id.into(),
        project_id: Some(PROJECT.into()),
        title: "Page work".into(),
        initial_page_ids,
    }
}

fn create_page(workspace: &TestWorkspace, operation: &str, session: bool) -> String {
    let page_id = crate::domain::identity::stable_uuid_v7(operation, "page", "test");
    apply(
        &workspace.module,
        operation,
        ProjectWorkspaceIntent::CreatePageFor {
            target: if session {
                ProjectWorkspacePageCreationTarget::Session {
                    session_id: "session:chat".into(),
                }
            } else {
                ProjectWorkspacePageCreationTarget::Project {
                    project_id: PROJECT.into(),
                }
            },
            page_id: page_id.clone(),
            document_id: crate::domain::identity::stable_uuid_v7(operation, "document", "test"),
            title: "Work".into(),
        },
    );
    page_id
}

fn database_apply(workspace: &TestWorkspace, operation: &str, intent: DatabaseIntent) {
    crate::database::DatabaseModule::new("profile-1", "library-1", &workspace.kernel)
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: operation.into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: vec![intent],
            },
        )
        .expect("Database mutation");
}

fn status(workspace: &TestWorkspace, page_id: &str) -> Option<(Option<String>, i64)> {
    let page_id = page_id.to_owned();
    workspace
        .kernel
        .readers()
        .read_default(move |c| {
            Ok(c.query_row(
                "SELECT json_extract(value.value_json, '$'), value.revision \
             FROM data_source_page_memberships membership \
             JOIN data_source_property_values value ON value.membership_id=membership.id \
               AND value.property_id='status' \
             WHERE membership.page_block_id=?1 AND membership.removed_at IS NULL",
                [page_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
        })
        .expect("Status")
}

fn set_status(workspace: &TestWorkspace, page_id: &str, option_id: Option<&str>) {
    let data_source_id = workspace
        .kernel
        .readers()
        .read_default({
            let page_id = page_id.to_owned();
            move |c| {
                Ok(c.query_row(
                    "SELECT parent_id FROM pages WHERE block_id=?1",
                    [page_id],
                    |r| r.get(0),
                )?)
            }
        })
        .unwrap();
    database_apply(
        workspace,
        &format!("set-{page_id}-{}", option_id.unwrap_or("empty")),
        DatabaseIntent::EditPropertyValues {
            edits: vec![DatabasePropertyValueMutation {
                expected_membership_revision: None,
                address: DatabasePagePropertyAddress {
                    page_id: page_id.into(),
                    data_source_id,
                    property_id: "status".into(),
                },
                edit: DatabasePropertyValueEdit::Replace {
                    expected_value_revision: status(workspace, page_id).unwrap().1,
                    value: option_id.map_or(DatabasePropertyValueInput::Empty, |id| {
                        DatabasePropertyValueInput::Select {
                            option_id: id.into(),
                        }
                    }),
                },
            }],
        },
    );
}

fn hand_off(page_id: &str) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::MutateSession {
        session_id: "session:chat".into(),
        intent: ProjectSessionIntent::HandOffPage {
            page_id: page_id.into(),
        },
    }
}

fn edge_count(workspace: &TestWorkspace, page_id: &str) -> i64 {
    let page_id = page_id.to_owned();
    workspace
        .kernel
        .readers()
        .read_default(move |c| {
            Ok(c.query_row(
                "SELECT count(*) FROM project_session_pages WHERE page_id=?1",
                [page_id],
                |r| r.get(0),
            )?)
        })
        .unwrap()
}

#[test]
fn handoff_advances_only_early_stage_ids_and_preserves_other_value_revisions() {
    let workspace = setup();
    for stage in [
        Some("triage"),
        Some("plan"),
        Some(IN_PROGRESS),
        Some("review"),
        Some(COMPLETED),
        Some("canceled"),
        None,
    ] {
        let page = create_page(
            &workspace,
            &format!("page-{}", stage.unwrap_or("empty")),
            false,
        );
        if stage != Some("triage") {
            set_status(&workspace, &page, stage);
        }
        let before = status(&workspace, &page).unwrap();
        apply(
            &workspace.module,
            &format!("handoff-{page}"),
            hand_off(&page),
        );
        let expected = if matches!(stage, Some("triage" | "plan")) {
            (Some(IN_PROGRESS.into()), before.1 + 1)
        } else {
            before
        };
        assert_eq!(status(&workspace, &page), Some(expected));
        assert_eq!(edge_count(&workspace, &page), 1);
    }
}

#[test]
fn related_links_do_not_start_an_attempt_until_the_first_handoff() {
    let workspace = setup();
    let page = create_page(&workspace, "scene-page", true);
    let before = status(&workspace, &page);
    assert_eq!(before.as_ref().unwrap().0.as_deref(), Some("triage"));
    apply(
        &workspace.module,
        "manual-link",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "session:chat".into(),
            intent: ProjectSessionIntent::LinkPage {
                page_id: page.clone(),
            },
        },
    );
    assert_eq!(status(&workspace, &page), before);
    let other = create_page(&workspace, "related-page", false);
    let other_before = status(&workspace, &other);
    apply(
        &workspace.module,
        "new-manual-link",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "session:chat".into(),
            intent: ProjectSessionIntent::LinkPage {
                page_id: other.clone(),
            },
        },
    );
    assert_eq!(status(&workspace, &other), other_before);
    set_status(&workspace, &page, Some("plan"));
    apply(&workspace.module, "handoff-related", hand_off(&page));
    assert_eq!(
        status(&workspace, &page).unwrap().0.as_deref(),
        Some(IN_PROGRESS)
    );
    assert_eq!(edge_count(&workspace, &page), 1);
}

#[test]
fn initial_pages_advance_atomically_with_view_effects_and_exact_retry() {
    let workspace = setup();
    let page = create_page(&workspace, "initial-page", false);
    let before = status(&workspace, &page).unwrap();
    let intent = create_chat("session:initial", vec![page.clone()]);
    let first = workspace
        .module
        .apply(&context(), request("open-page", intent.clone()))
        .unwrap();
    let after = status(&workspace, &page).unwrap();
    assert_eq!(after, (Some(IN_PROGRESS.into()), before.1 + 1));
    let ProjectionImpact::Resources {
        page_ids,
        database_ids,
        data_source_ids,
        view_ids,
        ..
    } = &first.event.as_ref().unwrap().projection_impact
    else {
        panic!("Resource effects")
    };
    assert!(page_ids.contains(&page));
    assert!(!database_ids.is_empty());
    assert!(!data_source_ids.is_empty());
    assert!(!view_ids.is_empty());
    let replay = workspace
        .module
        .apply(&context(), request("open-page", intent))
        .unwrap();
    assert!(replay.committed.receipt.mutation.duplicate);
    assert_eq!(replay.committed.commit_seq, first.committed.commit_seq);
    assert!(replay.event.is_none());
    assert_eq!(status(&workspace, &page), Some(after));
    assert_eq!(edge_count(&workspace, &page), 1);
}

#[test]
fn handoff_retry_preserves_later_manual_status_and_label_renames_do_not_change_stage_identity() {
    let workspace = setup();
    let page = create_page(&workspace, "renamed-page", false);
    let source = workspace
        .kernel
        .readers()
        .read_default({
            let page = page.clone();
            move |c| {
                Ok(c.query_row(
                    "SELECT parent_id FROM pages WHERE block_id=?1",
                    [page],
                    |r| r.get::<_, String>(0),
                )?)
            }
        })
        .unwrap();
    database_apply(
        &workspace,
        "rename-triage",
        DatabaseIntent::PutOption {
            data_source_id: source,
            property_id: "status".into(),
            option_id: "triage".into(),
            name: "Waiting for acceptance".into(),
            color: None,
            expected_property_revision: 1,
        },
    );
    let first = workspace
        .module
        .apply(&context(), request("handoff-renamed", hand_off(&page)))
        .unwrap();
    assert_eq!(
        status(&workspace, &page).unwrap().0.as_deref(),
        Some(IN_PROGRESS)
    );
    set_status(&workspace, &page, Some("review"));
    let review = status(&workspace, &page);
    let replay = workspace
        .module
        .apply(&context(), request("handoff-renamed", hand_off(&page)))
        .unwrap();
    assert!(replay.committed.receipt.mutation.duplicate);
    assert_eq!(first.committed.commit_seq, replay.committed.commit_seq);
    assert_eq!(status(&workspace, &page), review);
}

#[test]
fn library_pages_without_a_status_are_linked_without_adding_database_membership() {
    let workspace = setup();
    create_library_page(&workspace, "page:library", PROJECT);
    apply(
        &workspace.module,
        "handoff-library",
        hand_off("page:library"),
    );
    assert_eq!(status(&workspace, "page:library"), None);
    assert_eq!(edge_count(&workspace, "page:library"), 1);
}

#[test]
fn invalid_initial_pages_roll_back_all_links_status_changes_and_session_creation() {
    let workspace = setup();
    let page = create_page(&workspace, "valid-page", false);
    let before = status(&workspace, &page);
    workspace
        .module
        .apply(
            &context(),
            request(
                "invalid-handoff",
                create_chat("session:invalid", vec![page.clone(), "page:missing".into()]),
            ),
        )
        .expect_err("Missing Page");
    assert_eq!(status(&workspace, &page), before);
    assert_eq!(edge_count(&workspace, &page), 0);
    let sessions = workspace
        .kernel
        .readers()
        .read_default(|c| {
            Ok(c.query_row(
                "SELECT count(*) FROM project_sessions WHERE id=?1",
                params!["session:invalid"],
                |r| r.get::<_, i64>(0),
            )?)
        })
        .unwrap();
    assert_eq!(sessions, 0);
}

#[test]
fn runtime_launch_hands_off_initial_pages_for_new_and_existing_sessions() {
    let workspace = setup();
    let host = nodex_core_contracts::BoundModuleContext {
        adapter: nodex_core_contracts::AdapterKind::ElectronHost,
        ..context()
    };
    for session_id in ["session:chat", "session:new"] {
        let page = create_page(&workspace, &format!("runtime-page-{session_id}"), false);
        let before = status(&workspace, &page).unwrap();
        let intent = ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            agent_selection: Some(nodex_core_contracts::library::AgentWorkSelection {
                instance_id: "codex".into(),
                model: "gpt".into(),
                effort: Some("high".into()),
            }),
            coordinator: false,
            session_id: session_id.into(),
            project_id: Some(PROJECT.into()),
            title: "Work".into(),
            initial_page_ids: vec![page.clone()],
            runtime_id: "runtime:test".into(),
            runtime_thread_id: format!("thread:{session_id}"),
            launch_request_id: format!("launch:{session_id}"),
            side_chat_source_session_id: None,
        };
        workspace
            .module
            .apply(&host, request(&format!("launch-{session_id}"), intent))
            .unwrap();
        assert_eq!(
            status(&workspace, &page),
            Some((Some(IN_PROGRESS.into()), before.1 + 1))
        );
        assert_eq!(edge_count(&workspace, &page), 1);
        let assigned = workspace.kernel.readers().read_default(|c| Ok(c.query_row("SELECT value_json FROM block_properties WHERE block_id=?1 AND property_key='work'",[&page],|r|r.get::<_,String>(0))?)).unwrap();
        let work: nodex_core_contracts::library::PageWork =
            serde_json::from_str(&assigned).unwrap();
        assert_eq!(
            work.assignee,
            Some(nodex_core_contracts::library::PageAssignee::Agent {
                instance_id: "codex".into(),
                model: "gpt".into(),
                effort: Some("high".into())
            })
        );
        assert!(!work.auto_start);
        let peer = create_page(&workspace, &format!("handoff-peer-{session_id}"), false);
        apply(
            &workspace.module,
            &format!("handoff-{session_id}"),
            ProjectWorkspaceIntent::MutateSession {
                session_id: session_id.into(),
                intent: ProjectSessionIntent::HandOffPage {
                    page_id: peer.clone(),
                },
            },
        );
        let peer_work = workspace.kernel.readers().read_default(|c| Ok(c.query_row("SELECT value_json FROM block_properties WHERE block_id=?1 AND property_key='work'",[&peer],|r|r.get::<_,String>(0))?)).unwrap();
        assert_eq!(
            serde_json::from_str::<nodex_core_contracts::library::PageWork>(&peer_work).unwrap(),
            work
        );
    }
}
