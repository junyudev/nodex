use super::test_support::*;
use nodex_core_contracts::collection::CollectionWindowRequest;
use nodex_core_contracts::{CoreErrorCode, agent::AgentTurnProvenance, workspace::*};

fn launch(id: &str) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::CreateAgentRuntimeSession {
        agent_selection: None,
        coordinator: false,
        session_id: id.into(),
        project_id: None,
        title: id.into(),
        initial_page_ids: vec![],
        runtime_id: "runtime".into(),
        runtime_thread_id: format!("thread:{id}"),
        launch_request_id: format!("launch:{id}"),
        side_chat_source_session_id: None,
    }
}
fn coordinator(w: &TestWorkspace) {
    apply(&w.module, "launch:nodex", launch("nodex"));
    apply(
        &w.module,
        "bind",
        ProjectWorkspaceIntent::BindCoordinator {
            session_id: "nodex".into(),
        },
    );
}
fn event(key: &str) -> CoordinatorWorkEventInput {
    CoordinatorWorkEventInput {
        kind: CoordinatorWorkEventKind::Attention,
        session_id: Some("work".into()),
        page_id: None,
        payload: serde_json::json!({"question":"Proceed?"}),
        dedupe_key: key.into(),
    }
}
fn pending(w: &TestWorkspace) -> Vec<CoordinatorWorkEvent> {
    let ProjectWorkspaceReadValue::ReadPendingWorkEvents { events } = read(
        &w.module,
        ProjectWorkspaceRead::ReadPendingWorkEvents { limit: 20 },
    ) else {
        panic!("events")
    };
    events
}
fn report(page: Option<&str>, summary: &str) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::AgentCommand {
        provenance: Box::new(AgentTurnProvenance {
            profile_id: "profile-1".into(),
            authority: ProjectWorkspaceTurnAuthority {
                thread_id: "thread:work".into(),
                root_thread_id: "thread:work".into(),
                turn_id: "run:work".into(),
                actor_project_id: None,
                library_id: "library-1".into(),
                store_epoch: "epoch-1".into(),
                runtime: Some(ProjectWorkspaceAgentRuntimeAuthority {
                    session_id: "work".into(),
                    runtime_id: "runtime".into(),
                    turn_kind: ProjectWorkspaceAgentRuntimeTurnKind::Run,
                }),
            },
        }),
        intent: Box::new(ProjectWorkspaceIntent::ReportPageWork {
            page_id: page.map(str::to_owned),
            outcome: WorkReportOutcome::Ready,
            summary: summary.into(),
        }),
    }
}

#[test]
fn coordinator_managed_state_projects_to_sessions_and_invalidates_on_each_toggle() {
    let w = seeded_workspace();
    coordinator(&w);
    apply(&w.module, "work", launch("work"));
    apply(&w.module, "other", launch("other"));

    let session = || {
        let ProjectWorkspaceReadValue::Session { session } = read(
            &w.module,
            ProjectWorkspaceRead::Session {
                session_id: "work".into(),
            },
        ) else {
            panic!("Session response")
        };
        session
    };
    let tasks = || {
        let ProjectWorkspaceReadValue::TaskWindow { tasks } = read(
            &w.module,
            ProjectWorkspaceRead::TaskWindow {
                project_id: None,
                include_archived: None,
                placement_scope: ProjectWorkspaceTaskPlacementScope::All,
                order: ProjectWorkspaceTaskOrder::Activity,
                window: CollectionWindowRequest::default(),
            },
        ) else {
            panic!("Task window response")
        };
        tasks
    };
    assert!(!session().managed);
    assert!(tasks().items.iter().all(|task| !task.session.managed));

    for (operation, managed) in [("manage", true), ("take-back", false)] {
        let result = w
            .module
            .apply(
                &context(),
                request(
                    operation,
                    ProjectWorkspaceIntent::SetSessionManaged {
                        session_id: "work".into(),
                        managed,
                    },
                ),
            )
            .unwrap();
        let nodex_core_contracts::CoreModuleEventPayload::ProjectWorkspace(event) =
            result.event.expect("Workspace invalidation").payload
        else {
            panic!("Workspace event")
        };
        assert_eq!(event.session_detail_ids, vec!["work"]);
        assert_eq!(
            event.session_summary_scopes,
            vec![ProjectSessionInvalidationScope::All]
        );
        assert_eq!(session().managed, managed);
        let tasks = tasks();
        assert_eq!(tasks.items.len(), 2);
        assert_eq!(
            tasks
                .items
                .iter()
                .find(|task| task.session.id == "work")
                .unwrap()
                .session
                .managed,
            managed
        );
        assert!(
            !tasks
                .items
                .iter()
                .find(|task| task.session.id == "other")
                .unwrap()
                .session
                .managed
        );
    }
}

#[test]
fn coordinator_report_is_authorized_atomic_replayed_and_keeps_an_ordinary_links_status() {
    let w = seeded_workspace();
    coordinator(&w);
    apply(&w.module, "work", launch("work"));
    create_project(&w.module, "project:work:create", "project:work");
    apply(
        &w.module,
        "create-work-page",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: "019d0000-0000-7000-8000-000000000091".into(),
            document_id: "019d0000-0000-7000-8000-000000000092".into(),
            title: "Work".into(),
        },
    );
    assert!(
        w.module
            .apply(&context(), request("unlinked", report(None, "Done")))
            .is_err()
    );
    assert!(pending(&w).is_empty());
    apply(
        &w.module,
        "link",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "work".into(),
            intent: ProjectSessionIntent::LinkPage {
                page_id: "019d0000-0000-7000-8000-000000000091".into(),
            },
        },
    );
    apply(
        &w.module,
        "manage",
        ProjectWorkspaceIntent::SetSessionManaged {
            session_id: "work".into(),
            managed: true,
        },
    );
    let status = || {
        w.kernel.readers().read_default(|c| {
        Ok(c.query_row("SELECT value.value_json,value.revision FROM data_source_page_memberships membership JOIN data_source_property_values value ON value.membership_id=membership.id AND value.property_id='status' WHERE membership.page_block_id='019d0000-0000-7000-8000-000000000091' AND membership.removed_at IS NULL",[],|r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?)
    }).unwrap()
    };
    let previous_status = status();
    let result = w
        .module
        .apply(
            &context(),
            request("report", report(None, "Fixed with evidence.")),
        )
        .unwrap();
    assert!(result.event.is_some());
    assert_eq!(status(), previous_status);
    apply(&w.module, "report", report(None, "Fixed with evidence."));
    let events = pending(&w);
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].dedupe_key,
        "report:work:019d0000-0000-7000-8000-000000000091:1"
    );
    let ProjectWorkspaceReadValue::PageChatActivitySummaries { summaries, .. } = read(
        &w.module,
        ProjectWorkspaceRead::PageChatActivitySummaries {
            page_ids: vec!["019d0000-0000-7000-8000-000000000091".into()],
        },
    ) else {
        panic!("activity")
    };
    let ProjectWorkspaceReadValue::ReadManagedSession { managed } = read(
        &w.module,
        ProjectWorkspaceRead::ReadManagedSession {
            session_id: "work".into(),
        },
    ) else {
        panic!("managed");
    };
    assert_eq!(
        managed.unwrap().latest_report_at.as_deref(),
        Some(
            summaries[0]
                .work
                .latest_report
                .as_ref()
                .unwrap()
                .at
                .as_str()
        )
    );
    assert_eq!(summaries[0].work.managed_session_count, 1);
    assert_eq!(
        summaries[0].work.latest_report.as_ref().unwrap().revision,
        1
    );
    let ProjectWorkspaceReadValue::PageChatWindow { chats } = read(
        &w.module,
        ProjectWorkspaceRead::PageChatWindow {
            page_id: "019d0000-0000-7000-8000-000000000091".into(),
            include_archived: None,
            window: CollectionWindowRequest {
                first: Some(10),
                after: None,
            },
        },
    ) else {
        panic!("chats")
    };
    assert_eq!(
        chats.items[0].report.as_ref().unwrap().summary,
        "Fixed with evidence."
    );
    // Force event insertion to fail at the storage boundary: the link report must roll back too.
    w.kernel.writer().call(|c| { c.execute_batch("CREATE TEMP TRIGGER reject_work_event BEFORE INSERT ON coordinator_work_events BEGIN SELECT RAISE(ABORT,'event unavailable'); END;")?; Ok(()) }).unwrap();
    assert!(
        w.module
            .apply(
                &context(),
                request("report:failure", report(None, "Second attempt"))
            )
            .is_err()
    );
    let ProjectWorkspaceReadValue::PageChatActivitySummaries { summaries, .. } = read(
        &w.module,
        ProjectWorkspaceRead::PageChatActivitySummaries {
            page_ids: vec!["019d0000-0000-7000-8000-000000000091".into()],
        },
    ) else {
        panic!("activity")
    };
    assert_eq!(
        summaries[0].work.latest_report.as_ref().unwrap().revision,
        1
    );
}
#[test]
fn a_chat_on_several_pages_reports_by_the_page_key_from_its_brief() {
    let w = seeded_workspace();
    coordinator(&w);
    apply(&w.module, "work", launch("work"));
    create_project(&w.module, "project:work:create", "project:work");
    let pages = [
        "019d0000-0000-7000-8000-0000000000a1",
        "019d0000-0000-7000-8000-0000000000a3",
    ];
    for (index, page) in pages.iter().enumerate() {
        apply(
            &w.module,
            &format!("create:{index}"),
            ProjectWorkspaceIntent::CreatePageFor {
                target: ProjectWorkspacePageCreationTarget::Project {
                    project_id: "project:work".into(),
                },
                page_id: (*page).into(),
                document_id: format!("019d0000-0000-7000-8000-0000000000b{index}"),
                title: format!("Work {index}"),
            },
        );
        apply(
            &w.module,
            &format!("link:{index}"),
            ProjectWorkspaceIntent::MutateSession {
                session_id: "work".into(),
                intent: ProjectSessionIntent::LinkPage {
                    page_id: (*page).into(),
                },
            },
        );
    }
    let key = |page: &str| {
        w.kernel
            .readers()
            .read_default(|c| {
                Ok(
                    crate::database::current_page_key_for_page(c, "library-1", page)?
                        .expect("Project Pages carry keys"),
                )
            })
            .unwrap()
    };
    let (first, second) = (key(pages[0]), key(pages[1]));
    // Naming nothing is ambiguous; the refusal says which Pages the chat may name.
    let ambiguous = w
        .module
        .apply(&context(), request("ambiguous", report(None, "Done")))
        .unwrap_err();
    assert!(ambiguous.message.contains(&first) && ambiguous.message.contains(&second));
    let foreign = w
        .module
        .apply(
            &context(),
            request("foreign", report(Some("NOPE-9"), "Done")),
        )
        .unwrap_err();
    assert!(foreign.message.contains("not linked to NOPE-9"));
    apply(
        &w.module,
        "by-key",
        report(Some(&second.to_lowercase()), "Second is done."),
    );
    let reported = w
        .kernel
        .readers()
        .read_default(|c| {
            Ok(c.query_row(
                "SELECT page_id FROM project_session_pages WHERE session_id='work' AND report_outcome='ready'",
                [],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    assert_eq!(reported, pages[1]);
}

#[test]
fn coordinator_observation_and_event_dedupe_are_one_fenced_transaction() {
    let w = seeded_workspace();
    apply(&w.module, "work", launch("work"));
    apply(
        &w.module,
        "manage",
        ProjectWorkspaceIntent::SetSessionManaged {
            session_id: "work".into(),
            managed: true,
        },
    );
    let observation = |revision| CoordinatorObservationInput {
        resolved_request_ids: vec![],
        session_id: "work".into(),
        expected_revision: revision,
        observed_json: serde_json::json!({"state":"waiting"}),
    };
    apply(
        &w.module,
        "observe",
        ProjectWorkspaceIntent::RecordWorkEvents {
            events: vec![event("attention:1"), event("attention:1")],
            observed: vec![observation(0)],
        },
    );
    assert_eq!(pending(&w).len(), 1);
    let error = w
        .module
        .apply(
            &context(),
            request(
                "stale",
                ProjectWorkspaceIntent::RecordWorkEvents {
                    events: vec![event("attention:2")],
                    observed: vec![observation(0)],
                },
            ),
        )
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::RevisionConflict);
    assert_eq!(pending(&w).len(), 1);
    let ProjectWorkspaceReadValue::ReadManagedSession {
        managed: Some(managed),
    } = read(
        &w.module,
        ProjectWorkspaceRead::ReadManagedSession {
            session_id: "work".into(),
        },
    )
    else {
        panic!("managed")
    };
    assert_eq!(managed.observed_revision, 1);
}
#[test]
fn coordinator_batch_fencing_keeps_membership_and_body_immutable() {
    let w = seeded_workspace();
    coordinator(&w);
    apply(
        &w.module,
        "events",
        ProjectWorkspaceIntent::RecordWorkEvents {
            events: vec![event("one"), event("two")],
            observed: vec![],
        },
    );
    let events = pending(&w);
    let batch = |id: &str, ids: Vec<String>| ProjectWorkspaceIntent::CreateEventBatch {
        batch_id: id.into(),
        coordinator_session_id: "nodex".into(),
        event_ids: ids,
        message_id: format!("message:{id}"),
        body: "Work updates".into(),
        fingerprint: "f".repeat(64),
    };
    apply(
        &w.module,
        "batch:1",
        batch("one", vec![events[0].event_id.clone()]),
    );
    assert!(
        w.module
            .apply(
                &context(),
                request(
                    "batch:2",
                    batch("two", events.iter().map(|e| e.event_id.clone()).collect())
                )
            )
            .is_err()
    );
    assert_eq!(pending(&w).len(), 1);
    let ProjectWorkspaceReadValue::ReadOpenEventBatches { batches } = read(
        &w.module,
        ProjectWorkspaceRead::ReadOpenEventBatches { limit: 100 },
    ) else {
        panic!("batches")
    };
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].body, "Work updates");
    apply(
        &w.module,
        "settle",
        ProjectWorkspaceIntent::SettleEventBatch {
            batch_id: "one".into(),
            accepted_at: NOW.into(),
        },
    );
    let ProjectWorkspaceReadValue::ReadOpenEventBatches { batches } = read(
        &w.module,
        ProjectWorkspaceRead::ReadOpenEventBatches { limit: 100 },
    ) else {
        panic!("batches")
    };
    assert!(batches.is_empty());
    assert!(
        w.module
            .apply(
                &context(),
                request(
                    "manage:self",
                    ProjectWorkspaceIntent::SetSessionManaged {
                        session_id: "nodex".into(),
                        managed: true
                    }
                )
            )
            .is_err()
    );
}
#[test]
fn coordinator_is_absent_from_discovery_routing_and_page_chats() {
    let w = seeded_workspace();
    coordinator(&w);
    apply(&w.module, "work", launch("work"));
    let window = CollectionWindowRequest {
        first: Some(100),
        after: None,
    };
    let ProjectWorkspaceReadValue::SessionWindow { sessions, .. } = read(
        &w.module,
        ProjectWorkspaceRead::SessionWindow {
            archived: false,
            order: None,
            projectless_only: None,
            project_id: None,
            query: None,
            native_only: None,
            execution_refs: None,
            session_ids: None,
            window: window.clone(),
        },
    ) else {
        panic!("sessions")
    };
    assert!(sessions.items.iter().any(|x| x.task.session.id == "work"));
    assert!(!sessions.items.iter().any(|x| x.task.session.id == "nodex"));
    let ProjectWorkspaceReadValue::InboxChatTargets { window: targets } = read(
        &w.module,
        ProjectWorkspaceRead::InboxChatTargets {
            scope: nodex_core_contracts::inbox::ProjectWorkspaceInboxScope::Library,
            query: "".into(),
            window: window.clone(),
        },
    ) else {
        panic!("targets")
    };
    assert!(targets.items.iter().all(|x| x.session_id != "nodex"));
    create_library_page(
        &w,
        "019d0000-0000-7000-8000-000000000091",
        "project:default",
    );
    apply(
        &w.module,
        "link:nodex",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "nodex".into(),
            intent: ProjectSessionIntent::LinkPage {
                page_id: "019d0000-0000-7000-8000-000000000091".into(),
            },
        },
    );
    let ProjectWorkspaceReadValue::PageChatWindow { chats } = read(
        &w.module,
        ProjectWorkspaceRead::PageChatWindow {
            page_id: "019d0000-0000-7000-8000-000000000091".into(),
            include_archived: Some(true),
            window,
        },
    ) else {
        panic!("chats")
    };
    assert!(chats.items.is_empty());
}

#[test]
fn coordinator_role_is_bound_atomically_with_its_runtime_session() {
    let w = seeded_workspace();
    let mut intent = launch("nodex");
    let ProjectWorkspaceIntent::CreateAgentRuntimeSession { coordinator, .. } = &mut intent else {
        unreachable!()
    };
    *coordinator = true;
    apply(&w.module, "launch:coordinator", intent);
    let ProjectWorkspaceReadValue::ReadCoordinator { session_id } =
        read(&w.module, ProjectWorkspaceRead::ReadCoordinator)
    else {
        panic!("binding")
    };
    assert_eq!(session_id.as_deref(), Some("nodex"));
    assert!(
        w.module
            .apply(
                &context(),
                request(
                    "manage:coordinator",
                    ProjectWorkspaceIntent::SetSessionManaged {
                        session_id: "nodex".into(),
                        managed: true
                    }
                )
            )
            .is_err()
    );
}

#[test]
fn coordinator_sidebar_sections_and_pins_do_not_reveal_its_session() {
    let w = seeded_workspace();
    coordinator(&w);
    apply(&w.module, "work", launch("work"));
    let window = CollectionWindowRequest {
        first: Some(100),
        after: None,
    };
    let ProjectWorkspaceReadValue::SidebarSectionWindow { sections } = read(
        &w.module,
        ProjectWorkspaceRead::SidebarSectionWindow {
            include_deleted: None,
            window: window.clone(),
        },
    ) else {
        panic!("sections")
    };
    let chats = sections
        .items
        .iter()
        .find(|section| section.section_id == "sidebar:chats")
        .unwrap();
    assert_eq!(chats.effective_session_count, 1);
    apply(
        &w.module,
        "section:nodex",
        ProjectWorkspaceIntent::CreateSidebarSection {
            section_id: "section:nodex".into(),
            name: "Work".into(),
            initial_item: Some(ProjectWorkspaceSidebarSectionItemRef::Session {
                session_id: "nodex".into(),
            }),
        },
    );
    let ProjectWorkspaceReadValue::SidebarSectionItemWindow { items } = read(
        &w.module,
        ProjectWorkspaceRead::SidebarSectionItemWindow {
            section_id: "section:nodex".into(),
            include_archived: Some(true),
            window: window.clone(),
        },
    ) else {
        panic!("section items")
    };
    assert!(items.items.is_empty());
    apply(
        &w.module,
        "pin:nodex",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "nodex".into(),
            intent: ProjectSessionIntent::SetPinned { pinned: true },
        },
    );
    let ProjectWorkspaceReadValue::SidebarOverview { pinned_tasks } = read(
        &w.module,
        ProjectWorkspaceRead::SidebarOverview {
            include_archived: Some(true),
            pinned_window: window,
        },
    ) else {
        panic!("pins")
    };
    assert!(pinned_tasks.items.is_empty());
}

#[test]
fn managed_chat_sweep_is_bounded_and_reaches_live_sessions_in_identity_order() {
    let w = seeded_workspace();
    for id in ["z", "a", "m"] {
        apply(&w.module, &format!("launch:{id}"), launch(id));
        apply(
            &w.module,
            &format!("manage:{id}"),
            ProjectWorkspaceIntent::SetSessionManaged {
                session_id: id.into(),
                managed: true,
            },
        );
    }
    apply(
        &w.module,
        "archive:m",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "m".into(),
            intent: ProjectSessionIntent::SetArchived { archived: true },
        },
    );
    let ProjectWorkspaceReadValue::ReadManagedSessions { sessions } = read(
        &w.module,
        ProjectWorkspaceRead::ReadManagedSessions {
            after_session_id: None,
            limit: 1,
        },
    ) else {
        panic!("managed page");
    };
    assert_eq!(
        sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a"]
    );
    let ProjectWorkspaceReadValue::ReadManagedSessions { sessions } = read(
        &w.module,
        ProjectWorkspaceRead::ReadManagedSessions {
            after_session_id: Some("a".into()),
            limit: 2,
        },
    ) else {
        panic!("managed page");
    };
    assert_eq!(
        sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["z"]
    );
    assert!(
        w.module
            .read(
                &context(),
                nodex_core_contracts::ModuleReadRequest {
                    contract_version: nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::ReadManagedSessions {
                        after_session_id: None,
                        limit: 101
                    }
                }
            )
            .is_err()
    );
}

#[test]
fn coordinator_duplicate_capture_does_not_wake_event_consumers() {
    let w = seeded_workspace();
    let intent = ProjectWorkspaceIntent::RecordWorkEvents {
        events: vec![event("same")],
        observed: vec![],
    };
    apply(&w.module, "capture:one", intent.clone());
    let result = w
        .module
        .apply(&context(), request("capture:duplicate", intent))
        .unwrap();
    assert!(result.event.is_none());
    assert_eq!(pending(&w).len(), 1);
}

#[test]
fn coordinator_composite_work_keys_fit_full_page_identities_and_stay_bounded() {
    let w = seeded_workspace();
    let key = format!(
        "ready_to_start:{}:{}:{}",
        "p".repeat(512),
        "p".repeat(512),
        "e".repeat(64)
    );
    apply(
        &w.module,
        "long-key",
        ProjectWorkspaceIntent::RecordWorkEvents {
            events: vec![event(&key)],
            observed: vec![],
        },
    );
    assert_eq!(pending(&w)[0].dedupe_key, key);
    let rejected = w
        .module
        .apply(
            &context(),
            request(
                "oversized-key",
                ProjectWorkspaceIntent::RecordWorkEvents {
                    events: vec![event(&"k".repeat(2049))],
                    observed: vec![],
                },
            ),
        )
        .unwrap_err();
    assert_eq!(rejected.code, CoreErrorCode::InvalidInput);
    assert_eq!(pending(&w).len(), 1);
}

const STAGE_PAGE: &str = "019d0000-0000-7000-8000-000000000091";
fn stage_fixture() -> TestWorkspace {
    let w = seeded_workspace();
    create_project(&w.module, "project:stages", "project:work");
    apply(
        &w.module,
        "page:stages",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: STAGE_PAGE.into(),
            document_id: "019d0000-0000-7000-8000-000000000092".into(),
            title: "Work".into(),
        },
    );
    apply(&w.module, "work", launch("work"));
    apply(
        &w.module,
        "handoff",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "work".into(),
            intent: ProjectSessionIntent::HandOffPage {
                page_id: STAGE_PAGE.into(),
            },
        },
    );
    apply(
        &w.module,
        "manage",
        ProjectWorkspaceIntent::SetSessionManaged {
            session_id: "work".into(),
            managed: true,
        },
    );
    w
}
fn stage(w: &TestWorkspace) -> String {
    w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT json_extract(value.value_json,'$') FROM data_source_property_values value JOIN data_source_page_memberships member ON member.id=value.membership_id WHERE member.page_block_id=?1 AND member.removed_at IS NULL AND value.property_id='status'",[STAGE_PAGE],|r|r.get(0))?)).unwrap()
}
fn stage_edit(w: &TestWorkspace, status: &str) -> nodex_core_contracts::database::DatabaseIntent {
    use nodex_core_contracts::database::*;
    let (source,revision) = w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT value.data_source_id,value.revision FROM data_source_property_values value JOIN data_source_page_memberships member ON member.id=value.membership_id WHERE member.page_block_id=?1 AND member.removed_at IS NULL AND value.property_id='status'",[STAGE_PAGE],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?)).unwrap();
    DatabaseIntent::EditPropertyValues {
        edits: vec![DatabasePropertyValueMutation {
            expected_membership_revision: None,
            address: DatabasePagePropertyAddress {
                page_id: STAGE_PAGE.into(),
                data_source_id: source,
                property_id: "status".into(),
            },
            edit: DatabasePropertyValueEdit::Replace {
                expected_value_revision: revision,
                value: DatabasePropertyValueInput::Select {
                    option_id: status.into(),
                },
            },
        }],
    }
}

fn set_stage(w: &TestWorkspace, id: &str, status: &str, person: bool) {
    let intent = stage_edit(w, status);
    if person {
        crate::database::DatabaseModule::new("profile-1", "library-1", &w.kernel)
            .apply(
                &context(),
                nodex_core_contracts::ModuleApplyRequest {
                    contract_version: nodex_core_contracts::DATABASE_CONTRACT_VERSION,
                    store_epoch: nodex_core_contracts::StoreEpoch("epoch-1".into()),
                    operation_id: id.into(),
                    intent: vec![intent],
                },
            )
            .unwrap();
        return;
    }
    // Set an automatic predecessor through the same transactional Database collaborator.
    let id = id.to_owned();
    let mut agent = context();
    agent.adapter = nodex_core_contracts::AdapterKind::Agent;
    w.kernel
        .writer()
        .call(move |c| {
            crate::infrastructure::sqlite::with_immediate_transaction(c, |c| {
                crate::database::apply_intents_as_collaborator(
                    c,
                    "library-1",
                    &agent,
                    &id,
                    &[intent],
                    "2026-11-05T00:00:00.000Z",
                )
                .map(|_| ())
            })
        })
        .unwrap();
}
fn outcome_report(outcome: WorkReportOutcome) -> ProjectWorkspaceIntent {
    let ProjectWorkspaceIntent::AgentCommand { provenance, .. } = report(None, "Checked work.")
    else {
        panic!()
    };
    ProjectWorkspaceIntent::AgentCommand {
        provenance,
        intent: Box::new(ProjectWorkspaceIntent::ReportPageWork {
            page_id: None,
            outcome,
            summary: "Checked work.".into(),
        }),
    }
}
fn report_moved(w: &TestWorkspace) -> bool {
    pending(w)
        .iter()
        .rev()
        .find(|e| e.kind == CoordinatorWorkEventKind::Report)
        .unwrap()
        .payload["status_moved"]
        .as_bool()
        .unwrap()
}
#[test]
fn report_facts_follow_only_their_predecessors_and_keep_every_skipped_fact() {
    for before in ["triage", "plan", "doing", "review", "done", "canceled"] {
        for outcome in [
            WorkReportOutcome::Ready,
            WorkReportOutcome::Dropped,
            WorkReportOutcome::Blocked,
            WorkReportOutcome::Failed,
        ] {
            let w = stage_fixture();
            set_stage(&w, "predecessor", before, false);
            apply(&w.module, "report", outcome_report(outcome));
            let expected = match (outcome, before) {
                (WorkReportOutcome::Ready, "doing") => "review",
                (WorkReportOutcome::Dropped, "triage" | "plan" | "doing") => "canceled",
                _ => before,
            };
            assert_eq!(stage(&w), expected, "{before} {outcome:?}");
            assert_eq!(report_moved(&w), before != expected);
            let ProjectWorkspaceReadValue::PageChatActivitySummaries { summaries, .. } = read(
                &w.module,
                ProjectWorkspaceRead::PageChatActivitySummaries {
                    page_ids: vec![STAGE_PAGE.into()],
                },
            ) else {
                panic!()
            };
            assert_eq!(
                summaries[0]
                    .work
                    .latest_report
                    .as_ref()
                    .unwrap()
                    .status_moved,
                Some(before != expected)
            );

            let retained=w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT report_revision,report_status_moved FROM project_session_pages WHERE page_id=?1 AND session_id='work'",[STAGE_PAGE],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,bool>(1)?)))?)).unwrap();
            assert_eq!(retained, (1, before != expected));
        }
    }
}
#[test]
fn a_persons_move_including_aba_fences_a_later_report() {
    for moves in [vec!["review"], vec!["plan", "doing"]] {
        let w = stage_fixture();
        for (i, status) in moves.iter().enumerate() {
            set_stage(&w, &format!("person:{i}"), status, true);
        }
        apply(
            &w.module,
            "report",
            outcome_report(WorkReportOutcome::Ready),
        );
        assert_eq!(stage(&w), *moves.last().unwrap());
        assert!(!report_moved(&w));
    }
}
#[test]
fn an_old_chat_reports_evidence_without_moving_the_new_attempt() {
    let w = stage_fixture();
    apply(&w.module, "new", launch("new"));
    apply(
        &w.module,
        "new:handoff",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "new".into(),
            intent: ProjectSessionIntent::HandOffPage {
                page_id: STAGE_PAGE.into(),
            },
        },
    );
    apply(
        &w.module,
        "old:report",
        outcome_report(WorkReportOutcome::Ready),
    );
    assert_eq!(stage(&w), "doing");
    assert!(!report_moved(&w));
    let ProjectWorkspaceReadValue::ReadManagedSession { managed } = read(
        &w.module,
        ProjectWorkspaceRead::ReadManagedSession {
            session_id: "work".into(),
        },
    ) else {
        panic!()
    };
    assert!(managed.unwrap().active_page_ids.is_empty());
}
#[test]
fn only_a_person_accepts_reviewed_work_and_acceptance_is_a_person_edit() {
    use nodex_core_contracts::AdapterKind;
    for adapter in [AdapterKind::ElectronHost, AdapterKind::NativeCli] {
        let w = stage_fixture();
        apply(&w.module, "ready", outcome_report(WorkReportOutcome::Ready));
        let ProjectWorkspaceIntent::AgentCommand { provenance, .. } = report(None, "Reviewed")
        else {
            panic!()
        };
        let rejected = w
            .module
            .apply(
                &context(),
                request(
                    "agent:accept",
                    ProjectWorkspaceIntent::AgentCommand {
                        provenance,
                        intent: Box::new(ProjectWorkspaceIntent::AcceptPageWork {
                            expected_turn_episode: None,
                            page_id: STAGE_PAGE.into(),
                        }),
                    },
                ),
            )
            .unwrap_err();
        assert_eq!(rejected.code, CoreErrorCode::Unauthorized);
        let mut person = context();
        person.adapter = adapter;
        w.module
            .apply(
                &person,
                request(
                    "accept",
                    ProjectWorkspaceIntent::AcceptPageWork {
                        expected_turn_episode: None,
                        page_id: STAGE_PAGE.into(),
                    },
                ),
            )
            .unwrap();
        assert_eq!(stage(&w), "done");
        assert_eq!(
            w.kernel
                .readers()
                .read_default(|c| crate::database::status_person_revision(c, STAGE_PAGE))
                .unwrap(),
            1
        );
    }
    for before in ["triage", "plan", "doing", "done", "canceled"] {
        let w = stage_fixture();
        set_stage(&w, "before", before, false);
        apply(
            &w.module,
            "accept",
            ProjectWorkspaceIntent::AcceptPageWork {
                expected_turn_episode: None,
                page_id: STAGE_PAGE.into(),
            },
        );
        assert_eq!(stage(&w), before);
    }
}

#[test]
fn rehanding_an_existing_attempt_cannot_undo_a_newer_person_choice() {
    let w = stage_fixture();
    set_stage(&w, "person:triage", "triage", true);
    set_stage(&w, "person:todo", "plan", true);
    apply(
        &w.module,
        "rehand",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "work".into(),
            intent: ProjectSessionIntent::HandOffPage {
                page_id: STAGE_PAGE.into(),
            },
        },
    );
    assert_eq!(stage(&w), "plan");
    let moved=w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT status_moved FROM project_session_pages WHERE page_id=?1 AND session_id='work'",[STAGE_PAGE],|r|r.get::<_,bool>(0))?)).unwrap();
    assert!(!moved);
}

#[test]
fn report_keeps_its_fact_when_the_status_source_is_unavailable() {
    let w = stage_fixture();
    w.kernel.writer().call(|c|{c.execute("UPDATE data_sources SET lifecycle='archived' WHERE id=(SELECT parent_id FROM pages WHERE block_id=?1)",[STAGE_PAGE])?;Ok(())}).unwrap();
    apply(
        &w.module,
        "report",
        outcome_report(WorkReportOutcome::Ready),
    );
    assert_eq!(stage(&w), "doing");
    assert!(!report_moved(&w));
}

#[test]
fn compound_page_metadata_status_edits_also_fence_work_reports() {
    use nodex_core_contracts::library::*;
    let w = stage_fixture();
    let revision=w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT COALESCE((SELECT revision FROM block_properties WHERE block_id=?1 AND property_key='schedule.isAllDay'),0)",[STAGE_PAGE],|r|r.get::<_,i64>(0))?)).unwrap();
    let intent = LibraryIntent::ApplyPageMetadataProperties {
        database_intents: vec![stage_edit(&w, "doing")],
        intrinsic_mutation: Box::new(LibraryBlockPropertyMutation {
            actor: serde_json::json!({"kind":"host"}),
            client_session_id: None,
            fields: vec![LibraryBlockPropertyFieldMutation::IntrinsicSet {
                block_id: STAGE_PAGE.into(),
                property_key: "schedule.isAllDay".into(),
                expected_revision: revision,
                value: serde_json::json!(false),
            }],
        }),
    };
    let library = crate::library::LibraryModule::new("profile-1", "library-1", &w.kernel);
    let input = nodex_core_contracts::ModuleApplyRequest {
        contract_version: LIBRARY_CONTRACT_VERSION,
        operation_id: "compound:status".into(),
        store_epoch: nodex_core_contracts::StoreEpoch("epoch-1".into()),
        intent,
    };
    library.apply(&context(), input.clone()).unwrap();
    library.apply(&context(), input).unwrap();
    assert_eq!(
        w.kernel
            .readers()
            .read_default(|c| crate::database::status_person_revision(c, STAGE_PAGE))
            .unwrap(),
        1,
        "an exact retry retains its one person edit"
    );
    apply(
        &w.module,
        "ready:after-person",
        outcome_report(WorkReportOutcome::Ready),
    );
    assert_eq!(stage(&w), "doing");
    assert!(!report_moved(&w));
}
