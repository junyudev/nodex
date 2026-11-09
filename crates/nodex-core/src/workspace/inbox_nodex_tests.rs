use super::*;
use nodex_core_contracts::inbox::{
};
use nodex_core_contracts::workspace::{
    CoordinatorObservationInput, CoordinatorWorkEventInput, CoordinatorWorkEventKind,
    ProjectWorkspaceAgentRuntimeAuthority, ProjectWorkspaceAgentRuntimeTurnKind,
};

fn runtime_session(
    module: &ProjectWorkspaceModule,
    id: &str,
    project: Option<&str>,
    coordinator: bool,
) {
    apply_host(
        module,
        &format!("runtime:{id}"),
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            coordinator,
            session_id: id.into(),
            project_id: project.map(str::to_owned),
            title: id.into(),
            initial_page_ids: vec![],
            runtime_id: "runtime:test".into(),
            runtime_thread_id: format!("thread:{id}"),
            launch_request_id: format!("launch:{id}"),
            side_chat_source_session_id: None,
        },
    );
}
fn agent_command(id: &str, intent: ProjectWorkspaceIntent) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::AgentCommand {
        provenance: Box::new(AgentTurnProvenance {
            profile_id: "profile-1".into(),
            authority: ProjectWorkspaceTurnAuthority {
                thread_id: format!("thread:{id}"),
                root_thread_id: format!("thread:{id}"),
                turn_id: "run:test".into(),
                actor_project_id: None,
                library_id: "library-1".into(),
                store_epoch: "epoch-1".into(),
                runtime: Some(ProjectWorkspaceAgentRuntimeAuthority {
                    session_id: id.into(),
                    runtime_id: "runtime:test".into(),
                    turn_kind: ProjectWorkspaceAgentRuntimeTurnKind::Run,
                }),
            },
        }),
        intent: Box::new(intent),
    }
}
fn delivered(
    m: &ProjectWorkspaceModule,
    key: &str,
    kind: CoordinatorWorkEventKind,
    session: Option<&str>,
    page: Option<&str>,
    outcome: Option<&str>,
) -> String {
    apply_host(
        m,
        &format!("event:{key}"),
        ProjectWorkspaceIntent::RecordWorkEvents {
            observed: vec![],
            events: vec![CoordinatorWorkEventInput {
                kind,
                session_id: session.map(str::to_owned),
                page_id: page.map(str::to_owned),
                payload: serde_json::json!({"outcome":outcome}),
                dedupe_key: key.into(),
            }],
        },
    );
    let ProjectWorkspaceReadValue::ReadPendingWorkEvents { events } = read_host(
        m,
        ProjectWorkspaceRead::ReadPendingWorkEvents { limit: 100 },
    ) else {
        panic!("events")
    };
    let id = events
        .iter()
        .find(|e| e.dedupe_key == key)
        .unwrap()
        .event_id
        .clone();
    apply_host(
        m,
        &format!("batch:{key}"),
        ProjectWorkspaceIntent::CreateEventBatch {
            batch_id: format!("batch:{key}"),
            coordinator_session_id: "nodex".into(),
            event_ids: vec![id.clone()],
            message_id: format!("message:{key}"),
            body: "Work updates".into(),
            fingerprint: "a".repeat(64),
        },
    );
    apply_host(
        m,
        &format!("settle:{key}"),
        ProjectWorkspaceIntent::SettleEventBatch {
            batch_id: format!("batch:{key}"),
            accepted_at: "2026-11-03T00:00:00.000Z".into(),
        },
    );
    id
}
#[test]
fn automatic_inbox_confirmation_enforces_source_intent_basis_and_action_in_the_transaction() {
    for case in [
        "user", "implicit", "agent", "cli", "mixed", "outdated", "keep", "move", "suggest",
    ] {
        let w = seeded_workspace();
        let m = &w.module;
        let send = ProjectWorkspaceIntent::SendInboxMessage {
            reply_to_page_id: None,
            expected_store_epoch: None,
            page_id: "page:request".into(),
            document_id: "document:request".into(),
            body: "Fix the README typo".into(),
            title: None,
            project_id: None,
        };
        match case {
            "agent" | "mixed" => {
                runtime_session(m, "source", None, false);
                apply_host(m, "capture", agent_command("source", send));
            }
            "cli" => {
                m.apply(
                    &BoundModuleContext {
                        adapter: AdapterKind::NativeCli,
                        project_id: None,
                        ..context()
                    },
                    request("capture", send),
                )
                .unwrap();
            }
            _ => apply_host(m, "capture", send),
        }
        let mut pages = vec!["page:request".into()];
        if case == "mixed" {
            super::send(m, "user", "Also fix the docs");
            pages.push("page:user".into());
        }
        grouped_request(m, "request:auto", pages.clone());
        let pending = requests(m).remove(0);
        let action = match case {
            "keep" => ProjectWorkspaceInboxDispatchAction::Keep,
            "move" => ProjectWorkspaceInboxDispatchAction::MoveToProject {
                project_id: PROJECT.into(),
            },
            _ => ProjectWorkspaceInboxDispatchAction::NewChat {
                project_id: None,
                prompt: "Handle the attached request".into(),
                agent: None,
                additions: vec!["Optional reference".into()],
            },
        };
        apply_host(
            m,
            "settle",
            ProjectWorkspaceIntent::SettleInboxSuggestion {
                automatic_dispatch: case != "suggest",
                request_id: pending.request_id,
                generation: pending.generation,
                titles: vec![],
                suggestions: vec![ProjectWorkspaceInboxSuggestedDispatch {
                    explicit_request: case != "implicit",
                    proposal_id: "proposal:auto".into(),
                    page_ids: pages,
                    action: action.clone(),
                    entry_kind: None,
                    summary: "Fix the typo".into(),
                    rationale: None,
                }],
                produced_by: None,
                error: None,
            },
        );
        if case == "outdated" {
            let item = entry(m, "page:request");
            apply_host(
                m,
                "edit",
                ProjectWorkspaceIntent::EditInboxMessage {
                    page_id: item.page_id,
                    basis: item.basis,
                    original_body: item.body,
                    body: "Delete all docs".into(),
                },
            );
        }
        let mut confirmed_action = action.clone();
        if let ProjectWorkspaceInboxDispatchAction::NewChat { additions, .. } =
            &mut confirmed_action
        {
            additions.clear()
        }
        let confirmation=ProjectWorkspaceIntent::ConfirmInboxDispatch {confirmed_by:InboxConfirmedBy::Nodex,expected_store_epoch:"epoch-1".into(),basis:proposal_basis(m,"proposal:auto"),execution_selection:Some(serde_json::from_value(serde_json::json!({"model_selection":{"instanceId":"codex","model":"model"},"interaction_mode":"default"})).unwrap()),proposal_id:"proposal:auto".into(),expected_revision:1,action:Some(confirmed_action),session_id:Some("session:dispatched".into())};
        let result = m.apply(&host(), request("confirm", confirmation.clone()));
            result.unwrap();
            apply_host(m, "confirm", confirmation);
            assert_eq!(
                entry(m, "page:request").proposal.unwrap().confirmed_by,
                Some(InboxConfirmedBy::Nodex)
            );
            // Another Member reads whose request it was, not their own.
            let owner = local_member(&w);
            let name: String = w
                .kernel
                .writer()
                .call(move |c| {
                    c.execute("UPDATE libraries SET space_kind='team' WHERE id='library-1'",[])?;
                    c.execute("INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES('bob','library-1','Bob','active','member')",[])?;
                    c.execute("INSERT INTO member_devices(id,library_id,member_id,label,credential_hash,created_at,last_seen) VALUES('bob','library-1','bob','Device','bob',unixepoch(),unixepoch())",[])?;
                    c.execute("INSERT INTO member_sessions(id,device_id,token_hash,created_at,expires_at) VALUES('bob','bob','bob',unixepoch(),unixepoch()+3600)",[])?;
                    Ok(c.query_row("SELECT display_name FROM members WHERE id=?1",[&owner],|r|r.get(0))?)
                })
                .unwrap();
            let bob = BoundModuleContext {
                adapter: AdapterKind::RemoteMember,
                principal: Some(nodex_core_contracts::RemotePrincipal {
                    space_id: "library-1".into(),
                    member_id: "bob".into(),
                    device_id: "bob".into(),
                    session_id: "bob".into(),
                    role: nodex_core_contracts::library::MemberRole::Member,
                }),
                ..host()
            };
            let ProjectWorkspaceReadValue::ActivityWindow { rows } = m
                .read(
                    &bob,
                    nodex_core_contracts::ModuleReadRequest {
                        contract_version: nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: ProjectWorkspaceRead::ActivityWindow {
                            scope: nodex_core_contracts::inbox::ProjectWorkspaceInboxScope::All,
                            filter: nodex_core_contracts::sources::ActivityFilter::All,
                            window: nodex_core_contracts::collection::CollectionWindowRequest {
                                after: None,
                                first: Some(100),
                            },
                        },
                    },
                )
                .unwrap()
                .value
            else {
                panic!("Activity window")
            };
            assert_eq!(outbox(m).len(), 1);
            assert!(
                !outbox(m)[0]
                    .final_text
                    .as_ref()
                    .unwrap()
                    .contains("Optional reference")
            );
        } else {
            assert!(result.is_err(), "{case}");
            assert!(outbox(m).is_empty(), "{case}");
        }
    }
}

#[test]
fn routing_delivery_fixes_recipient_and_first_deadline_and_bounds_unsettled_requests() {
    const LIMIT: usize = 16;
    let w = seeded_workspace();
    let m = &w.module;
    runtime_session(m, "nodex", None, true);
    for i in 0..=LIMIT {
        send(m, &format!("route:{i}"), "Fix this");
        grouped_request(m, &format!("request:{i}"), vec![format!("page:route:{i}")]);
    }
    let begin = |i| ProjectWorkspaceIntent::BeginInboxRouting {
        request_id: format!("request:{i}"),
        generation: 1,
        coordinator_session_id: "nodex".into(),
    };
    for i in 0..LIMIT {
        apply_host(m, &format!("begin:{i}"), begin(i));
    }
    let started = requests(m)[0].delivery.clone().unwrap();
    apply_host(m, "begin:0", begin(0));
    assert_eq!(requests(m)[0].delivery.as_ref(), Some(&started));
    let overflow = format!("begin:{LIMIT}");
    assert!(m.apply(&host(), request(&overflow, begin(LIMIT))).is_err());
    let first = requests(m).remove(0);
    apply_host(
        m,
        "timeout",
        keep_request(&first, Some("The suggestion agent timed out")),
    );
    apply_host(m, &overflow, begin(LIMIT));
    let reopened = reopen_inbox_workspace(w);
    assert_eq!(requests(&reopened.module).len(), LIMIT);
    assert!(
        requests(&reopened.module)
            .iter()
            .all(|request| request.delivery.is_some())
    );
}

#[test]
        );
        apply_host(
            m,
            "capture",
            ProjectWorkspaceIntent::RecordWorkEvents {
                observed: vec![],
                events: ["resolved", "still-pending"]
                    .iter()
                    .map(|id| CoordinatorWorkEventInput {
                        kind: CoordinatorWorkEventKind::Attention,
                        session_id: Some("work".into()),
                        page_id: None,
                        dedupe_key: format!("attention:work:{id}"),
                        payload: serde_json::json!({"question":id}),
                    })
                    .collect(),
            },
        );
        let ProjectWorkspaceReadValue::ReadPendingWorkEvents { events } = read_host(
            m,
            ProjectWorkspaceRead::ReadPendingWorkEvents { limit: 100 },
        ) else {
            panic!()
        };
        apply_host(
            m,
            "batch",
            ProjectWorkspaceIntent::CreateEventBatch {
                batch_id: "queued".into(),
                coordinator_session_id: "nodex".into(),
                event_ids: events.iter().map(|e| e.event_id.clone()).collect(),
                message_id: "queued".into(),
                body: "Frozen Work updates".into(),
                fingerprint: "a".repeat(64),
            },
        );
        apply_host(
            m,
            "resolved",
            ProjectWorkspaceIntent::RecordWorkEvents {
                events: vec![],
                observed: vec![CoordinatorObservationInput {
                    session_id: "work".into(),
                    resolved_request_ids: vec!["resolved".into()],
                    expected_revision: 0,
                    observed_json: serde_json::json!({"pendingRequestIds":["still-pending"]}),
                }],
            },
        );
        let ProjectWorkspaceReadValue::ReadEventBatch { batch: Some(batch) } = read_host(
            m,
            ProjectWorkspaceRead::ReadEventBatch {
                batch_id: "queued".into(),
            },
        ) else {
            panic!()
        };
        assert!(batch.invalidated_at.is_some());
        assert_eq!(batch.body, "Frozen Work updates");
        if admitted {
            // Runtime may have admitted it before Main lost the reply. Reconciliation wins.
            apply_host(
                m,
                "accepted",
                ProjectWorkspaceIntent::SettleEventBatch {
                    batch_id: "queued".into(),
                    accepted_at: "2026-11-03T00:00:00.000Z".into(),
                },
            );
            assert!(
                m.apply(
                    &host(),
                    request(
                        "discard",
                        ProjectWorkspaceIntent::DiscardEventBatch {
                            batch_id: "queued".into()
                        }
                    )
                )
                .is_err()
            );
        } else {
            apply_host(
                m,
                "discard",
                ProjectWorkspaceIntent::DiscardEventBatch {
                    batch_id: "queued".into(),
                },
            );
            assert!(matches!(
                read_host(
                    m,
                    ProjectWorkspaceRead::ReadEventBatch {
                        batch_id: "queued".into()
                    }
                ),
                ProjectWorkspaceReadValue::ReadEventBatch { batch: None }
            ));
            assert!(
                m.apply(
                    &host(),
                    request(
                        "late-accept",
                        ProjectWorkspaceIntent::SettleEventBatch {
                            batch_id: "queued".into(),
                            accepted_at: "2026-11-03T00:00:00.000Z".into()
                        }
                    )
                )
                .is_err()
            );
        }
        let ProjectWorkspaceReadValue::ReadOpenEventBatches { batches } =
            read_host(m, ProjectWorkspaceRead::ReadOpenEventBatches { limit: 100 })
        else {
            panic!()
        };
        assert!(batches.is_empty());
        let ProjectWorkspaceReadValue::ReadPendingWorkEvents { events } = read_host(
            m,
            ProjectWorkspaceRead::ReadPendingWorkEvents { limit: 100 },
        ) else {
            panic!()
        };
        assert_eq!(events.len(), if admitted { 0 } else { 1 });
        if !admitted {
            assert_eq!(events[0].dedupe_key, "attention:work:still-pending");
        }
    }
}

fn assign_agent(w: &TestWorkspace, operation: &str, page: &str, auto_start: bool, revision: i64) {
    use nodex_core_contracts::LIBRARY_CONTRACT_VERSION;
    use nodex_core_contracts::library::*;
    let owner = local_member(w);
    crate::library::LibraryModule::new("profile-1", "library-1", &w.kernel)
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: operation.into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: LibraryIntent::ApplyBlockPropertyMutation {
                    mutation: Box::new(LibraryBlockPropertyMutation {
                        actor: serde_json::json!({"kind":"host"}),
                        client_session_id: None,
                        fields: vec![LibraryBlockPropertyFieldMutation::IntrinsicSet {
                            block_id: page.into(),
                            property_key: "work".into(),
                            expected_revision: revision,
                            value: serde_json::json!({"owner":owner,"assignee":{"kind":"agent","instance_id":"codex","model":"gpt","effort":null},"auto_start":auto_start}),
                        }],
                    }),
                },
            },
        )
        .unwrap();
}
fn agent_start(session: &str, page: &str, launch: &str) -> ProjectWorkspaceIntent {
    agent_command(
        session,
        ProjectWorkspaceIntent::StartPageWork {
            page_id: page.into(),
            selection: None,
            session_id: format!("chat:{launch}"),
            launch_id: format!("launch:{launch}"),
            message_id: format!("message:{launch}"),
            brief: "Work".into(),
            again: false,
            expected_readiness_epoch: None,
            expected_turn_episode: None,
        },
    )
}

#[test]
fn nodex_starts_only_work_that_may_start_on_its_own_and_reads_as_nodex() {
    let w = seeded_workspace();
    runtime_session(&w.module, "nodex", None, true);
    runtime_session(&w.module, "helper", Some(PROJECT), false);
    let page = "019d0000-0000-7000-8000-000000000091";
    let other = "019d0000-0000-7000-8000-000000000093";
    create_work_page(&w, page);
    create_work_page(&w, other);
    assign_agent(&w, "assign-ask", page, false, 1);
    // Ready work without consent is the person's Turn to start; Nodex cannot take it.
    assert_eq!(
        apply_host_error(&w.module, "nodex:ask", agent_start("nodex", page, "asked")),
        CoreErrorCode::Unauthorized
    );
    assert_eq!(count(&w, "SELECT count(*) FROM page_work_launches"), 0);
    assign_agent(&w, "assign-consent", page, true, 2);
    apply_host(
        &w.module,
        "nodex:consented",
        agent_start("nodex", page, "consented"),
    );
    let launch = super::super::test_support::activity_rows(&w.module)
        .into_iter()
        .find(|row| row.id == "launch:launch:consented")
        .unwrap();
    let member = local_member(&w);
    assert_eq!(
        launch.actor,
        nodex_core_contracts::Actor::Agent {
            session_id: "nodex".into(),
            run_id: Some("run:test".into()),
            on_behalf_of: member,
        }
    );
    assert_eq!(launch.actor_label, "by Nodex on behalf of You");
    // Another Agent still starts work for the person it serves, under its own name.
    assign_agent(&w, "assign-helper", other, false, 1);
    apply_host(
        &w.module,
        "helper:start",
        agent_start("helper", other, "helper"),
    );
    let helper = super::super::test_support::activity_rows(&w.module)
        .into_iter()
        .find(|row| row.id == "launch:launch:helper")
        .unwrap();
    assert!(
        matches!(helper.actor, nodex_core_contracts::Actor::Agent { ref session_id, .. } if session_id == "helper")
    );
    assert_eq!(helper.actor_label, "by Agent on behalf of You");
}

