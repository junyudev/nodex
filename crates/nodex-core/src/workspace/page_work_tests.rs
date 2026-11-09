use super::test_support::*;
use nodex_core_contracts::{CoreErrorCode, library::AgentWorkSelection, workspace::*};
use rusqlite::params;
const PAGE: &str = "019d0000-0000-7000-8000-000000000081";
fn setup() -> TestWorkspace {
    let w = seeded_workspace();
    create_project(&w.module, "project:create", "project:work");
    apply(
        &w.module,
        "page:create",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: PAGE.into(),
            document_id: "019d0000-0000-7000-8000-000000000082".into(),
            title: "Work".into(),
        },
    );
    w
}
fn start(launch: &str, again: bool) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::StartPageWork {
        page_id: PAGE.into(),
        selection: Some(AgentWorkSelection {
            instance_id: "codex".into(),
            model: "gpt-6.1-sol".into(),
            effort: None,
        }),
        session_id: format!("session:{launch}"),
        launch_id: launch.into(),
        message_id: format!("message:{launch}"),
        brief: "Work brief".into(),
        again,
        expected_readiness_epoch: None,
        expected_turn_episode: None,
    }
}
fn counts(w: &TestWorkspace) -> (i64, i64, i64, i64, i64, String) {
    w.kernel.readers().read_default(|c| Ok(c.query_row("SELECT (SELECT count(*) FROM project_sessions WHERE id LIKE 'session:%'),(SELECT count(*) FROM project_session_pages WHERE page_id=?1),(SELECT count(*) FROM coordinator_managed_sessions),(SELECT count(*) FROM coordinator_work_events WHERE kind='started'),(SELECT count(*) FROM page_work_launches),(SELECT json_extract(value.value_json,'$') FROM data_source_property_values value JOIN data_source_page_memberships member ON member.id=value.membership_id WHERE member.page_block_id=?1 AND value.property_id='status')",[PAGE],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?)).unwrap()
}
#[test]
fn page_work_start_is_atomic_replayed_and_again_is_explicit() {
    let w = setup();
    let before = counts(&w);
    w.kernel.writer().call(|c| {c.execute_batch("CREATE TRIGGER fail_work_start BEFORE INSERT ON page_work_launches BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END;")?;Ok(())}).unwrap();
    assert!(
        w.module
            .apply(&context(), request("start", start("launch", false)))
            .is_err()
    );
    assert_eq!(counts(&w), before);
    w.kernel
        .writer()
        .call(|c| {
            c.execute_batch("DROP TRIGGER fail_work_start;")?;
            Ok(())
        })
        .unwrap();
    let first = w
        .module
        .apply(&context(), request("start", start("launch", false)))
        .unwrap();
    assert_eq!(counts(&w), (1, 1, 1, 1, 1, "doing".into()));
    let replay = w
        .module
        .apply(&context(), request("start", start("launch", false)))
        .unwrap();
    assert!(replay.committed.receipt.mutation.duplicate);
    assert_eq!(replay.committed.commit_seq, first.committed.commit_seq);
    apply(&w.module, "start:same-launch", start("launch", false));
    assert_eq!(counts(&w), (1, 1, 1, 1, 1, "doing".into()));
    let error = w
        .module
        .apply(&context(), request("start:other", start("other", false)))
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::Conflict);
    assert!(error.message.contains("again"));
    apply(&w.module, "start:again", start("other", true));
    assert_eq!(counts(&w), (2, 2, 2, 2, 2, "doing".into()));
    let ProjectWorkspaceReadValue::PageWorkOutbox { launches } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkOutbox { limit: 10 },
    ) else {
        panic!()
    };
    assert_eq!(launches.len(), 2);
    assert_eq!(launches[0].brief, "Work brief");
    assert_eq!(launches[0].selection.model, "gpt-6.1-sol");
    let event=w.kernel.readers().read_default(|c| Ok(c.query_row("SELECT dedupe_key FROM coordinator_work_events WHERE page_id=?1 AND session_id='session:launch'",params![PAGE],|r|r.get::<_,String>(0))?)).unwrap();
    assert_eq!(event, format!("started:{PAGE}:launch"));
    apply(
        &w.module,
        "settle",
        ProjectWorkspaceIntent::SettlePageWorkLaunch {
            launch_id: "launch".into(),
            accepted_at: Some("2026-11-03T00:00:00.000Z".into()),
            rejection: None,
        },
    );
    apply(&w.module, "start:after-settlement", start("launch", false));
    assert_eq!(counts(&w), (2, 2, 2, 2, 2, "doing".into()));
    assert_eq!(
        activity_rows(&w.module)
            .iter()
            .filter(|row| row.id.starts_with("launch:") && row.session_id.is_some())
            .count(),
        2
    );
}
#[test]
fn page_work_start_requires_host_and_rechecks_automatic_epoch_before_creating() {
    let w = setup();
    let before = counts(&w);
    let mut agent = context();
    agent.adapter = nodex_core_contracts::AdapterKind::Agent;
    assert_eq!(
        w.module
            .apply(&agent, request("agent:start", start("launch", false)))
            .unwrap_err()
            .code,
        CoreErrorCode::Unauthorized
    );
    let mut intent = start("launch", false);
    if let ProjectWorkspaceIntent::StartPageWork {
        expected_readiness_epoch,
        ..
    } = &mut intent
    {
        *expected_readiness_epoch = Some("stale".into());
    }
    assert_eq!(
        w.module
            .apply(&context(), request("stale:start", intent))
            .unwrap_err()
            .code,
        CoreErrorCode::Conflict
    );
    assert_eq!(counts(&w), before);
    let mut intent = start("launch", false);
    if let ProjectWorkspaceIntent::StartPageWork { selection, .. } = &mut intent {
        *selection = None;
    }
    assert_eq!(
        w.module
            .apply(&context(), request("missing:selection", intent))
            .unwrap_err()
            .code,
        CoreErrorCode::InvalidInput
    );
    assert_eq!(counts(&w), before);
}
fn assign(w: &TestWorkspace) {
    use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch, library::*};
    let owner = w
        .kernel
        .readers()
        .read_default(|c| {
            c.query_row(
                "SELECT member_id FROM local_profile_members WHERE library_id='library-1'",
                [],
                |r| r.get::<_, String>(0),
            )
            .map_err(crate::infrastructure::sqlite::StoreError::from)
        })
        .unwrap();
    crate::library::LibraryModule::new("profile-1","library-1",&w.kernel).apply(&context(),ModuleApplyRequest {contract_version:LIBRARY_CONTRACT_VERSION,operation_id:"assign".into(),store_epoch:StoreEpoch("epoch-1".into()),intent:LibraryIntent::ApplyBlockPropertyMutation {mutation:Box::new(LibraryBlockPropertyMutation {actor:serde_json::json!({"kind":"host"}),client_session_id:None,fields:vec![LibraryBlockPropertyFieldMutation::IntrinsicSet {block_id:PAGE.into(),property_key:"work".into(),expected_revision:1,value:serde_json::json!({"owner":owner,"assignee":{"kind":"agent","instance_id":"codex","model":"gpt-6.1-sol","effort":null},"auto_start":true})}]})}}).unwrap();
}
#[test]
fn page_work_start_freezes_page_selection_when_no_override_is_supplied() {
    let w = setup();
    assign(&w);
    let mut intent = start("from-page", false);
    if let ProjectWorkspaceIntent::StartPageWork { selection, .. } = &mut intent {
        *selection = None;
    }
    apply(&w.module, "start:page-selection", intent);
    let ProjectWorkspaceReadValue::PageWorkLaunch {
        launch: Some(value),
    } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkLaunch {
            launch_id: "from-page".into(),
        },
    )
    else {
        panic!()
    };
    assert_eq!(value.selection.model, "gpt-6.1-sol");
    assert_eq!(value.selection.effort, None);
}

#[test]
fn managed_work_creates_followup_pages_for_its_owner() {
    let w = setup();
    w.kernel.writer().call(|connection| {
        connection.execute("UPDATE libraries SET space_kind='team' WHERE id='library-1'",[])?;connection.execute("INSERT INTO members(id,library_id,display_name,lifecycle) VALUES('requester','library-1','Requester','active')",[])?;
        connection.execute("UPDATE block_properties SET value_json=json_set(value_json,'$.owner','requester') WHERE block_id=?1 AND property_key='work'",[PAGE])?;
        Ok(())
    }).unwrap();
    apply(&w.module, "work:start", start("owned", false));
    let mut actor = context();
    actor.agent_attribution = Some(nodex_core_contracts::BoundAgentAttribution {
        run_id: None,
        session_id: "session:owned".into(),
        backend: nodex_core_contracts::agent::AgentBackendKind::Codex,
    });
    w.module
        .apply(
            &actor,
            request(
                "work:followup",
                ProjectWorkspaceIntent::CreatePageFor {
                    target: ProjectWorkspacePageCreationTarget::Project {
                        project_id: "project:work".into(),
                    },
                    page_id: "019d0000-0000-7000-8000-000000000083".into(),
                    document_id: "019d0000-0000-7000-8000-000000000084".into(),
                    title: "Follow-up".into(),
                },
            ),
        )
        .unwrap();
    let work=w.kernel.readers().read_default(|connection|connection.query_row("SELECT value_json FROM block_properties WHERE block_id='019d0000-0000-7000-8000-000000000083' AND property_key='work'",[],|row|row.get::<_,String>(0)).map_err(crate::infrastructure::sqlite::StoreError::from)).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&work).unwrap(),
        serde_json::json!({"owner":"requester","assignee":null,"auto_start":false})
    );
}
#[test]
fn page_work_readiness_waits_for_acceptance_and_ignores_later_reports() {
    use nodex_core_contracts::{
        ModuleApplyRequest, ModuleReadRequest, StoreEpoch, agent::AgentTurnProvenance, database::*,
    };
    let w = setup();
    assign(&w);
    let prerequisite = "019d0000-0000-7000-8000-000000000083";
    apply(
        &w.module,
        "prerequisite:create",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: prerequisite.into(),
            document_id: "019d0000-0000-7000-8000-000000000084".into(),
            title: "Prerequisite".into(),
        },
    );
    let source = w
        .kernel
        .readers()
        .read_default(|c| {
            Ok(c.query_row(
                "SELECT parent_id FROM pages WHERE block_id=?1",
                [PAGE],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    let db = crate::database::DatabaseModule::new("profile-1", "library-1", &w.kernel);
    db.apply(
        &context(),
        ModuleApplyRequest {
            contract_version: DATABASE_CONTRACT_VERSION,
            operation_id: "block".into(),
            store_epoch: StoreEpoch("epoch-1".into()),
            intent: vec![DatabaseIntent::EditPropertyValues {
                edits: vec![DatabasePropertyValueMutation {
                    expected_membership_revision: None,
                    address: DatabasePagePropertyAddress {
                        page_id: PAGE.into(),
                        data_source_id: source.clone(),
                        property_id: "blocked_by".into(),
                    },
                    edit: DatabasePropertyValueEdit::PatchSet {
                        delta: DatabasePropertySetDelta::Relation {
                            add_page_ids: vec![prerequisite.into()],
                            remove_edge_ids: vec![],
                        },
                    },
                }],
            }],
        },
    )
    .unwrap();
    let ready = || {
        let DatabaseReadValue::ReadyWork { pages } = db
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ReadyWork {
                        after_page_id: None,
                        project_id: None,
                        limit: Some(10),
                    },
                },
            )
            .unwrap()
            .value
        else {
            panic!()
        };
        pages
    };
    assert!(ready().is_empty());
    apply(
        &w.module,
        "prerequisite:session",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            agent_selection: None,
            coordinator: false,
            session_id: "prerequisite:chat".into(),
            project_id: Some("project:work".into()),
            title: "Prerequisite".into(),
            initial_page_ids: vec![prerequisite.into()],
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread:prerequisite".into(),
            launch_request_id: "launch:prerequisite".into(),
            side_chat_source_session_id: None,
        },
    );
    let report = |operation: &str, outcome: WorkReportOutcome| {
        apply(
            &w.module,
            operation,
            ProjectWorkspaceIntent::AgentCommand {
                provenance: Box::new(AgentTurnProvenance {
                    profile_id: "profile-1".into(),
                    authority: ProjectWorkspaceTurnAuthority {
                        thread_id: "thread:prerequisite".into(),
                        root_thread_id: "thread:prerequisite".into(),
                        turn_id: "run:prerequisite".into(),
                        actor_project_id: Some("project:work".into()),
                        library_id: "library-1".into(),
                        store_epoch: "epoch-1".into(),
                        runtime: Some(ProjectWorkspaceAgentRuntimeAuthority {
                            session_id: "prerequisite:chat".into(),
                            runtime_id: "runtime".into(),
                            turn_kind: ProjectWorkspaceAgentRuntimeTurnKind::Run,
                        }),
                    },
                }),
                intent: Box::new(ProjectWorkspaceIntent::ReportPageWork {
                    page_id: Some(prerequisite.into()),
                    outcome,
                    summary: format!("Report {operation}"),
                }),
            },
        )
    };
    report("report:ready", WorkReportOutcome::Ready);
    assert!(ready().is_empty(), "In Review still awaits acceptance");
    report("report:blocked", WorkReportOutcome::Blocked);
    assert!(ready().is_empty());
    report("report:dropped", WorkReportOutcome::Dropped);
    assert!(
        ready().is_empty(),
        "a dropped report never satisfies a prerequisite"
    );
    apply(
        &w.module,
        "accept:prerequisite",
        ProjectWorkspaceIntent::AcceptPageWork {
            expected_turn_episode: None,
            page_id: prerequisite.into(),
        },
    );
    let done = ready();
    assert_eq!(done.len(), 1);
    assert!(done[0].prerequisites[0].satisfied);
    assert!(
        done[0].prerequisites[0]
            .satisfying_revision
            .as_ref()
            .unwrap()
            .starts_with("status:")
    );
    report("report:failed-after-done", WorkReportOutcome::Failed);
    assert_eq!(done[0].readiness_epoch, ready()[0].readiness_epoch);
    report("report:ready-again", WorkReportOutcome::Ready);
    assert_eq!(done[0].readiness_epoch, ready()[0].readiness_epoch);
}

#[test]
fn page_work_outbox_bounds_encoded_bytes_and_makes_progress_after_settlement() {
    let w = setup();
    for (id, again) in [("large-one", false), ("large-two", true)] {
        let mut intent = start(id, again);
        if let ProjectWorkspaceIntent::StartPageWork { brief, .. } = &mut intent {
            *brief = "\u{0001}".repeat(256_000);
        }
        apply(&w.module, &format!("start:{id}"), intent);
    }
    let pending = || {
        let ProjectWorkspaceReadValue::PageWorkOutbox { launches } = read(
            &w.module,
            ProjectWorkspaceRead::PageWorkOutbox { limit: 100 },
        ) else {
            panic!()
        };
        launches
    };
    let first = pending();
    assert_eq!(first.len(), 1);
    assert!(serde_json::to_vec(&first).unwrap().len() < 1_750_000);
    apply(
        &w.module,
        "settle:large",
        ProjectWorkspaceIntent::SettlePageWorkLaunch {
            launch_id: first[0].launch_id.clone(),
            accepted_at: Some("2026-11-03T00:00:00.000Z".into()),
            rejection: None,
        },
    );
    let next = pending();
    assert_eq!(next.len(), 1);
    assert_ne!(next[0].launch_id, first[0].launch_id);
}

#[test]
fn start_again_moves_the_active_chat_and_archive_or_unlink_clears_only_that_chat() {
    let w = setup();
    apply(&w.module, "start", start("launch", false));
    apply(&w.module, "start:again", start("other", true));
    let active = || {
        w.kernel
            .readers()
            .read_default(|c| super::page_chat::active_chat(c, PAGE))
            .unwrap()
    };
    assert_eq!(active().unwrap().session_id, "session:other");
    let work_page = |session: &str| {
        read(
            &w.module,
            ProjectWorkspaceRead::SessionWorkPage {
                session_id: session.into(),
            },
        )
    };
    assert_eq!(
        work_page("session:other"),
        ProjectWorkspaceReadValue::SessionWorkPage {
            page_id: Some(PAGE.into())
        }
    );
    assert_eq!(
        work_page("session:launch"),
        ProjectWorkspaceReadValue::SessionWorkPage { page_id: None }
    );

    apply(
        &w.module,
        "unlink:old",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "session:launch".into(),
            intent: ProjectSessionIntent::UnlinkPage {
                page_id: PAGE.into(),
            },
        },
    );
    assert_eq!(active().unwrap().session_id, "session:other");
    apply(
        &w.module,
        "archive:active",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "session:other".into(),
            intent: ProjectSessionIntent::SetArchived { archived: true },
        },
    );
    assert!(active().is_none());
    assert_eq!(
        work_page("session:other"),
        ProjectWorkspaceReadValue::SessionWorkPage { page_id: None }
    );
    apply(
        &w.module,
        "restore:chat",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "session:other".into(),
            intent: ProjectSessionIntent::SetArchived { archived: false },
        },
    );
    assert!(
        active().is_none(),
        "restoring a chat never steals the active destination"
    );
    apply(
        &w.module,
        "explicit:handoff",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "session:other".into(),
            intent: ProjectSessionIntent::HandOffPage {
                page_id: PAGE.into(),
            },
        },
    );
    assert_eq!(active().unwrap().session_id, "session:other");
    apply(
        &w.module,
        "unlink:active",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "session:other".into(),
            intent: ProjectSessionIntent::UnlinkPage {
                page_id: PAGE.into(),
            },
        },
    );
    assert!(active().is_none());
}

#[test]
fn a_chat_with_multiple_active_pages_requires_an_explicit_work_launch() {
    let w = setup();
    apply(&w.module, "start", start("launch", false));
    let other = "019d0000-0000-7000-8000-000000000083";
    apply(
        &w.module,
        "other-page",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: other.into(),
            document_id: "019d0000-0000-7000-8000-000000000084".into(),
            title: "Other work".into(),
        },
    );
    apply(
        &w.module,
        "handoff-other",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "session:launch".into(),
            intent: ProjectSessionIntent::HandOffPage {
                page_id: other.into(),
            },
        },
    );
    assert_eq!(
        read(
            &w.module,
            ProjectWorkspaceRead::SessionWorkPage {
                session_id: "session:launch".into()
            }
        ),
        ProjectWorkspaceReadValue::SessionWorkPage { page_id: None }
    );
    let ProjectWorkspaceReadValue::PageWorkLaunch {
        launch: Some(launch),
    } = read(
        &w.module,
        ProjectWorkspaceRead::PageWorkLaunch {
            launch_id: "launch".into(),
        },
    )
    else {
        panic!("first launch retained")
    };
    assert_eq!(launch.page_id, PAGE);
}

#[test]
fn page_workspace_allocation_requires_an_agent_assignee() {
    use nodex_core_contracts::{ModuleApplyRequest, StoreEpoch, library::*};
    let w = setup();
    let has_agent = || {
        let ProjectWorkspaceReadValue::PageWorkspace { has_agent_work, .. } = read(
            &w.module,
            ProjectWorkspaceRead::PageWorkspace {
                page_id: PAGE.into(),
            },
        ) else {
            panic!("Page Workspace");
        };
        has_agent_work
    };
    assert!(
        !has_agent(),
        "unassigned Pages stay in the chat's directory"
    );
    assign(&w);
    assert!(has_agent());
    let (owner, revision) = w.kernel.readers().read_default(|c| {
        Ok(c.query_row("SELECT json_extract(value_json,'$.owner'),revision FROM block_properties WHERE block_id=?1 AND property_key='work'", [PAGE], |r| Ok((r.get::<_, String>(0)?,r.get::<_, i64>(1)?)))?)
    }).unwrap();
    crate::library::LibraryModule::new("profile-1", "library-1", &w.kernel).apply(&context(), ModuleApplyRequest {
        contract_version: LIBRARY_CONTRACT_VERSION,
        operation_id: "assign-person".into(), store_epoch: StoreEpoch("epoch-1".into()),
        intent: LibraryIntent::ApplyBlockPropertyMutation { mutation: Box::new(LibraryBlockPropertyMutation {
            actor: serde_json::json!({"kind":"host"}), client_session_id: None,
            fields: vec![LibraryBlockPropertyFieldMutation::IntrinsicSet {
                block_id: PAGE.into(), property_key: "work".into(), expected_revision: revision,
                value: serde_json::json!({"owner":owner,"assignee":{"kind":"member","member_id":owner},"auto_start":false}),
            }],
        }) },
    }).unwrap();
    assert!(
        !has_agent(),
        "person assignments do not allocate an Agent Workspace"
    );
}

#[test]
fn managed_chat_owner_uses_its_active_work_page_without_following_related_links() {
    for active in [false, true] {
        let w = setup();
        let local = w.kernel.writer().call(|c| {
            let local: String = c.query_row("SELECT member_id FROM local_profile_members WHERE library_id='library-1'", [], |r| r.get(0))?;
            c.execute("UPDATE libraries SET space_kind='team' WHERE id='library-1'",[])?;c.execute("INSERT INTO members(id,library_id,display_name,lifecycle) VALUES('requester','library-1','Requester','active')",[])?;
            c.execute("UPDATE block_properties SET value_json=json_set(value_json,'$.owner','requester') WHERE block_id=?1 AND property_key='work'",[PAGE])?;
            Ok(local)
        }).unwrap();
        apply(
            &w.module,
            "chat",
            ProjectWorkspaceIntent::CreateAgentRuntimeSession {
                agent_selection: None,
                coordinator: false,
                side_chat_source_session_id: None,
                project_id: Some("project:work".into()),
                session_id: "chat".into(),
                title: "Work".into(),
                initial_page_ids: vec![],
                runtime_id: "runtime".into(),
                runtime_thread_id: "thread".into(),
                launch_request_id: "launch".into(),
            },
        );
        apply(
            &w.module,
            "link",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "chat".into(),
                intent: if active {
                    ProjectSessionIntent::HandOffPage {
                        page_id: PAGE.into(),
                    }
                } else {
                    ProjectSessionIntent::LinkPage {
                        page_id: PAGE.into(),
                    }
                },
            },
        );
        apply(
            &w.module,
            "manage",
            ProjectWorkspaceIntent::SetSessionManaged {
                session_id: "chat".into(),
                managed: true,
            },
        );
        let mut actor = context();
        actor.agent_attribution = Some(nodex_core_contracts::BoundAgentAttribution {
            run_id: None,
            session_id: "chat".into(),
            backend: nodex_core_contracts::agent::AgentBackendKind::Codex,
        });
        w.module
            .apply(
                &actor,
                request(
                    "followup",
                    ProjectWorkspaceIntent::CreatePageFor {
                        target: ProjectWorkspacePageCreationTarget::Project {
                            project_id: "project:work".into(),
                        },
                        page_id: "019d0000-0000-7000-8000-000000000083".into(),
                        document_id: "019d0000-0000-7000-8000-000000000084".into(),
                        title: "Follow-up".into(),
                    },
                ),
            )
            .unwrap();
        let owner = w.kernel.readers().read_default(|c| {
            Ok(c.query_row("SELECT json_extract(value_json,'$.owner') FROM block_properties WHERE block_id='019d0000-0000-7000-8000-000000000083' AND property_key='work'", [], |r| r.get::<_, String>(0))?)
        }).unwrap();
        assert_eq!(owner, if active { "requester" } else { &local });
    }
}
