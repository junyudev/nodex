use super::*;
use nodex_core_contracts::LIBRARY_CONTRACT_VERSION;
use nodex_core_contracts::library::*;

fn intake(w: &TestWorkspace, github: bool) -> ProjectWorkspaceInboxItem {
    if github {
        batch(
            w,
            "intake",
            thread(),
            vec![event(
                w,
                "discovery_assigned",
                "assigned:relocate",
                SourceActorClass::Person,
            )],
        );
    } else {
    }
    let ProjectWorkspaceReadValue::InboxWindow { items } = read(
        &w.module,
        ProjectWorkspaceRead::InboxWindow {
            scope: ProjectWorkspaceInboxScope::Library,
            filter: ProjectWorkspaceInboxWindowFilter::Inbox,
            window: nodex_core_contracts::collection::CollectionWindowRequest {
                after: None,
                first: Some(10),
            },
        },
    ) else {
        panic!("Inbox")
    };
    items.items.into_iter().next().unwrap()
}
fn read_item(w: &TestWorkspace, page: &str) -> ProjectWorkspaceInboxItem {
    let ProjectWorkspaceReadValue::InboxEntry { item: Some(item) } = read(
        &w.module,
        ProjectWorkspaceRead::InboxEntry {
            page_id: page.into(),
        },
    ) else {
        panic!("entry")
    };
    *item
}
fn work(w: &TestWorkspace, page: &str) -> serde_json::Value {
    w.kernel
        .readers()
        .read_default(|c| {
            let raw: String = c.query_row(
                "SELECT value_json FROM block_properties WHERE block_id=?1 AND property_key='work'",
                [page],
                |r| r.get(0),
            )?;
            Ok(serde_json::from_str(&raw).unwrap())
        })
        .unwrap()
}
fn dispatch(
    w: &TestWorkspace,
    page: &str,
    existing: bool,
    project: Option<&str>,
) -> ProjectWorkspaceIntent {
    let entry = read_item(w, page);
    ProjectWorkspaceIntent::DispatchInboxEntries {
        expected_store_epoch: "epoch-1".into(),
        basis: vec![entry.basis],
        execution_selection: Some(ProjectWorkspaceInboxExecutionSelection {
            model_selection: ProjectWorkspaceInboxModelSelection {
                instance_id: "codex".into(),
                model: "dispatch-model".into(),
            },
            interaction_mode: ProjectWorkspaceInboxInteractionMode::Default,
        }),
        proposal_id: "relocation-proposal".into(),
        page_ids: vec![page.into()],
        action: if existing {
            ProjectWorkspaceInboxDispatchAction::SendToChat {
                session_id: "chat".into(),
                prompt: "Handle the request".into(),
                additions: vec![],
            }
        } else {
            ProjectWorkspaceInboxDispatchAction::NewChat {
                project_id: project.map(str::to_owned),
                prompt: "Handle the request".into(),
                additions: vec![],
                agent: None,
            }
        },
        session_id: (!existing).then(|| "new-chat".into()),
    }
}
fn prepare(w: &TestWorkspace, page: &str) {
    board(w);
    apply(
        &w.module,
        "previous-chat",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            coordinator: false,
            side_chat_source_session_id: None,
            session_id: "chat".into(),
            project_id: Some("project:work".into()),
            title: "Work".into(),
            initial_page_ids: vec![page.into()],
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread:chat".into(),
            launch_request_id: "launch:chat".into(),
        },
    );
    apply(
        &w.module,
        "managed",
        ProjectWorkspaceIntent::SetSessionManaged {
            session_id: "chat".into(),
            managed: true,
        },
    );
    context_follow(w, "chat", "context-follow");
    apply(
        &w.module,
        "workspace",
        ProjectWorkspaceIntent::ClaimPageWorkspace {
            workspace_id: "workspace".into(),
            page_id: page.into(),
            project_id: "project:work".into(),
            session_id: "chat".into(),
            repository_url: Some("https://github.com/alice/repo".into()),
            repository_root: "/repo".into(),
            branch_name: "docs-work".into(),
            base_commit_oid: "a".repeat(40),
            worktree_path: "/worktree".into(),
        },
    );
    let mut assignment = work(w, page);
    assignment["assignee"] =
        json!({"kind":"agent","instance_id":"claude","model":"assigned-model","effort":"high"});
    crate::library::LibraryModule::new("profile-1", "library-1", &w.kernel)
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "assign".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: LibraryIntent::ApplyBlockPropertyMutation {
                    mutation: Box::new(LibraryBlockPropertyMutation {
                        actor: json!({"kind":"host"}),
                        client_session_id: None,
                        fields: vec![LibraryBlockPropertyFieldMutation::IntrinsicSet {
                            block_id: page.into(),
                            property_key: "work".into(),
                            expected_revision: 1,
                            value: assignment,
                        }],
                    }),
                },
            },
        )
        .unwrap();
}
fn membership(w: &TestWorkspace, page: &str) -> String {
    w.kernel.readers().read_default(|c| Ok(c.query_row("SELECT data_source_id FROM data_source_page_memberships WHERE page_block_id=?1 AND removed_at IS NULL", [page], |r|r.get(0))?)).unwrap()
}
fn project_home(w: &TestWorkspace) -> String {
    w.kernel.readers().read_default(|c| Ok(c.query_row("SELECT s.id FROM data_sources s JOIN project_database_bindings b ON b.database_block_id=s.home_database_block_id WHERE b.project_id='project:work' AND b.lifecycle='active' AND s.lifecycle='active'", [], |r|r.get(0))?)).unwrap()
}
fn page_workspace(
    w: &TestWorkspace,
    page: &str,
) -> Option<nodex_core_contracts::workspace::PageWorkspace> {
    let ProjectWorkspaceReadValue::PageWorkspace { workspace, .. } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkspace {
            page_id: page.into(),
        },
    ) else {
        panic!("Workspace")
    };
    workspace
}
fn assert_relocation(existing: bool) {
    for github in [false, true] {
        let w = setup();
        let original = intake(&w, github);
        let page = &original.page_id;
        prepare(&w, page);
        let before_work = work(&w, page);
        let before_follows = follow_list(&w, page);
        let before_workspace = page_workspace(&w, page);
        let home = project_home(&w);
        assert_ne!(membership(&w, page), home);
        let intent = dispatch(&w, page, existing, Some("project:work"));
        apply(&w.module, "dispatch", intent.clone());
        let handled = read_item(&w, page);
        assert_eq!(
            membership(&w, page),
            home,
            "a Project chat's work must be on its Board"
        );
        assert_ne!(handled.page_key, original.page_key);
        assert!(!handled.page_key.as_deref().unwrap().starts_with("IN-"));
        assert_eq!(handled.page_status.as_ref().unwrap().id, "doing");
        assert_eq!(work(&w, page), before_work);
        assert_eq!(handled.source, original.source);
        assert_eq!(handled.scope, ProjectWorkspaceInboxScope::Library);
        assert_eq!(handled.body, original.body);
        assert!(
            matches!(handled.location, ProjectWorkspaceInboxLocation::Database { project_id: Some(ref id), .. } if id == "project:work")
        );
        let follows = follow_list(&w, page);
        assert_eq!(follows.len(), before_follows.len());
        assert_eq!(follows[0].thread, before_follows[0].thread);
        assert_eq!(
            follows[0].role,
            if github {
                ThreadFollowRole::Origin
            } else {
                ThreadFollowRole::Context
            }
        );
        assert_eq!(page_workspace(&w, page), before_workspace);
        let ProjectWorkspaceReadValue::InboxWindow { items } = read(
            &w.module,
            ProjectWorkspaceRead::InboxWindow {
                scope: ProjectWorkspaceInboxScope::Library,
                filter: ProjectWorkspaceInboxWindowFilter::Processed,
                window: nodex_core_contracts::collection::CollectionWindowRequest {
                    after: None,
                    first: Some(10),
                },
            },
        ) else {
            panic!("History")
        };
        assert_eq!(items.items.len(), 1);
        assert_eq!(items.items[0].page_id, *page);
        assert_eq!(
            items.items[0].proposal.as_ref().unwrap().action,
            handled.proposal.as_ref().unwrap().action
        );
        let replay = w
            .module
            .apply(&context(), request("dispatch", intent))
            .unwrap();
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(read_item(&w, page).page_key, handled.page_key);
    }
}
#[test]
fn new_chat_relocates_user_and_github_intake_with_work_context_and_history() {
    assert_relocation(false);
}
#[test]
fn send_to_chat_relocates_user_and_github_intake_with_work_context_and_history() {
    assert_relocation(true);
}
#[test]
fn projectless_chat_keeps_the_library_inbox_page_and_key() {
    let w = setup();
    let original = intake(&w, false);
    let home = membership(&w, &original.page_id);
    apply(
        &w.module,
        "dispatch",
        dispatch(&w, &original.page_id, false, None),
    );
    assert_eq!(membership(&w, &original.page_id), home);
    assert_eq!(read_item(&w, &original.page_id).page_key, original.page_key);
}

#[test]
fn github_plan_steps_are_project_cards_with_origin_follows_and_intake_history() {
    let w = setup();
    let original = intake(&w, true);
    board(&w);
    let mut intent = dispatch(&w, &original.page_id, false, Some("project:work"));
    let ProjectWorkspaceIntent::DispatchInboxEntries {
        action, session_id, ..
    } = &mut intent
    else {
        panic!()
    };
    *session_id = None;
    *action = ProjectWorkspaceInboxDispatchAction::Plan {
        summary: "Prepare and fix".into(),
        steps: ["prepare", "fix"]
            .into_iter()
            .map(|key| InboxPlanStep {
                key: key.into(),
                project_id: "project:work".into(),
                title: key.into(),
                body: "Use the original request".into(),
                agent: None,
                blocked_by: vec![],
            })
            .collect(),
    };
    let result = w.module.apply(&context(), request("plan", intent)).unwrap();
    let ids = result.committed.value.inbox_created_page_ids;
    assert_eq!(ids.len(), 2);
    let owner = work(&w, &original.page_id)["owner"].clone();
    for page in &ids {
        assert_eq!(membership(&w, page), project_home(&w));
        assert_eq!(work(&w, page)["owner"], owner);
        assert_eq!(work(&w, page)["assignee"]["model"], "dispatch-model");
        assert_eq!(follow_list(&w, page)[0].role, ThreadFollowRole::Origin);
        assert_eq!(follow_list(&w, page)[0].thread.id, thread().id);
        let key = w
            .kernel
            .readers()
            .read_default(|c| crate::database::current_page_key_for_page(c, "library-1", page))
            .unwrap()
            .unwrap();
        assert!(!key.starts_with("IN-"));
    }
    let handled = read_item(&w, &original.page_id);
    assert_eq!(handled.state, ProjectWorkspaceInboxEntryState::Done);
    assert_eq!(handled.source, original.source);
    assert_eq!(handled.scope, ProjectWorkspaceInboxScope::Library);
    assert_eq!(handled.proposal.unwrap().created_page_ids, ids);
}

#[test]
fn failed_chat_confirmation_rolls_back_page_location_key_and_history_together() {
    let w = setup();
    let original = intake(&w, true);
    prepare(&w, &original.page_id);
    let home = membership(&w, &original.page_id);
    let before = read_item(&w, &original.page_id);
    let follows = follow_list(&w, &original.page_id);
    // Fail after relocation, Session creation and follow updates inside the decision transaction.
    w.kernel.writer().call(|c| { c.execute_batch("CREATE TRIGGER fail_inbox_handoff BEFORE INSERT ON inbox_handoffs BEGIN SELECT RAISE(ABORT,'injected handoff failure'); END;")?; Ok(()) }).unwrap();
    assert!(
        w.module
            .apply(
                &context(),
                request(
                    "dispatch",
                    dispatch(&w, &original.page_id, false, Some("project:work"))
                )
            )
            .is_err()
    );
    assert_eq!(membership(&w, &original.page_id), home);
    assert_eq!(read_item(&w, &original.page_id), before);
    assert_eq!(follow_list(&w, &original.page_id), follows);
    let sessions = w
        .kernel
        .readers()
        .read_default(|c| {
            Ok(c.query_row(
                "SELECT count(*) FROM project_sessions WHERE id='new-chat'",
                [],
                |r| r.get::<_, i64>(0),
            )?)
        })
        .unwrap();
    assert_eq!(sessions, 0);
}
