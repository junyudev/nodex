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
    report("report:blocked", WorkReportOutcome::Blocked);
    assert!(ready().is_empty());
    report("report:dropped", WorkReportOutcome::Dropped);
        },
    let done = ready();
    assert_eq!(done.len(), 1);
    assert!(
        done[0].prerequisites[0]
            .satisfying_revision
            .as_ref()
            .unwrap()
            .starts_with("status:")
    );
    report("report:ready-again", WorkReportOutcome::Ready);
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
