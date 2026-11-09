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

