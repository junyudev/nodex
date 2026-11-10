use super::*;
use crate::workspace::test_support::local_member;
use nodex_core_contracts::inbox::{
    InboxConfirmedBy, InboxRowKind, ProjectWorkspaceInboxSuggestedDispatch,
};
use nodex_core_contracts::workspace::{
    CoordinatorObservationInput, CoordinatorWorkEventInput, CoordinatorWorkEventKind,
    ProjectWorkspaceAgentRuntimeAuthority, ProjectWorkspaceAgentRuntimeTurnKind,
    ProjectWorkspacePageCreationTarget, SessionExecutionObservation, SessionExecutionState,
};

// Keep fixture Page UUIDs separate from operation timestamps.
fn apply_host(module: &ProjectWorkspaceModule, operation: &str, intent: ProjectWorkspaceIntent) {
    super::apply_host(module, &operation.replace(':', "_"), intent);
}
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
            agent_selection: None,
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
        apply_host(
            m,
            "consent",
            ProjectWorkspaceIntent::SetInboxRoutingConsent {
                start_my_requests: true,
                initialize_only: false,
            },
        );
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
                skills: vec![],
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
        let confirmation=ProjectWorkspaceIntent::ConfirmInboxDispatch {skill_invocations:vec![],confirmed_by:InboxConfirmedBy::Nodex,expected_store_epoch:"epoch-1".into(),basis:proposal_basis(m,"proposal:auto"),execution_selection:Some(serde_json::from_value(serde_json::json!({"model_selection":{"instanceId":"codex","model":"model"},"interaction_mode":"default"})).unwrap()),proposal_id:"proposal:auto".into(),expected_revision:1,action:Some(confirmed_action),session_id:Some("session:dispatched".into())};
        let result = m.apply(&host(), request("confirm", confirmation.clone()));
        if case == "user" || case == "cli" {
            result.unwrap();
            apply_host(m, "confirm", confirmation);
            assert_eq!(
                entry(m, "page:request").proposal.unwrap().confirmed_by,
                Some(InboxConfirmedBy::Nodex)
            );
            // The start is the message's one handled fact, and one of Nodex's decisions.
            let activity = crate::workspace::test_support::activity_rows(m);
            let started = activity
                .iter()
                .filter(|row| row.page_id.as_deref() == Some("page:request"))
                .collect::<Vec<_>>();
            assert_eq!(started.len(), 1);
            assert_eq!(started[0].category, "messages");
            assert!(started[0].description.ends_with(" on your request"));
            let ProjectWorkspaceReadValue::ActivityWindow { rows: decisions } = m
                .read(
                    &host(),
                    nodex_core_contracts::ModuleReadRequest {
                        contract_version: nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: ProjectWorkspaceRead::ActivityWindow {
                            scope: nodex_core_contracts::inbox::ProjectWorkspaceInboxScope::All,
                            filter: nodex_core_contracts::sources::ActivityFilter::Decisions,
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
            assert!(decisions.items.iter().any(|row| row.id == started[0].id));
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
            assert!(rows.items.iter().any(|row| row.id.starts_with("message:")
                && row.description.ends_with(&format!(" on {name}’s request"))));
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
        skill_offers: vec![],
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
fn resolved_questions_in_unadmitted_batches_are_discarded_without_losing_other_facts() {
    for admitted in [false, true] {
        let w = seeded_workspace();
        let m = &w.module;
        runtime_session(m, "nodex", None, true);
        runtime_session(m, "work", None, false);
        apply_host(
            m,
            "managed",
            ProjectWorkspaceIntent::SetSessionManaged {
                session_id: "work".into(),
                managed: true,
            },
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

#[test]
fn routing_clocks_preserve_the_pause_union_across_reopen_and_agents_hold_for_their_person() {
    use nodex_core_contracts::workspace::ExecutionHoldScope;
    let w = seeded_workspace();
    let m = &w.module;
    runtime_session(m, "nodex", None, true);
    send(m, "paused-route", "Fix this");
    grouped_request(m, "paused-request", vec!["page:paused-route".into()]);
    apply_host(
        m,
        "begin-paused",
        ProjectWorkspaceIntent::BeginInboxRouting {
            skill_offers: vec![],
            request_id: "paused-request".into(),
            generation: 1,
            coordinator_session_id: "nodex".into(),
        },
    );
    let page = ExecutionHoldScope::Page {
        page_id: "page:paused-route".into(),
    };
    // Nodex pauses and resumes for the person it works for; the hold is that person's.
    m.apply(
        &host(),
        request(
            "agent-pause",
            agent_command(
                "nodex",
                ProjectWorkspaceIntent::PauseWork {
                    scope: page.clone(),
                },
            ),
        ),
    )
    .unwrap();
    assert!(requests(m).is_empty());
    let (holder, actor) = w
        .kernel
        .readers()
        .read_default(|c| {
            Ok((
                c.query_row("SELECT actor FROM execution_holds WHERE scope_kind='page' AND scope_id='page:paused-route'", [], |r| r.get::<_, String>(0))?,
                c.query_row("SELECT json_extract(actor_json,'$.type')||':'||json_extract(actor_json,'$.on_behalf_of') FROM mutation_actors WHERE module_name='project_workspace' AND operation_id='agent-pause'", [], |r| r.get::<_, String>(0))?,
            ))
        })
        .unwrap();
    assert_eq!(holder, local_member(&w));
    assert_eq!(actor, format!("agent:{holder}"));
    m.apply(
        &host(),
        request(
            "agent-resume",
            agent_command(
                "nodex",
                ProjectWorkspaceIntent::ResumeWork {
                    scope: page.clone(),
                },
            ),
        ),
    )
    .unwrap();
    assert_eq!(requests(m).len(), 1);
    apply_host(
        m,
        "hold-page",
        ProjectWorkspaceIntent::PauseWork {
            scope: page.clone(),
        },
    );
    assert!(requests(m).is_empty());
    w.kernel
        .writer()
        .call(|c| {
            c.execute(
                "UPDATE execution_hold_routing_clocks SET paused_at_ms=paused_at_ms-10000",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    apply_host(
        m,
        "hold-space",
        ProjectWorkspaceIntent::PauseWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    apply_host(
        m,
        "resume-page",
        ProjectWorkspaceIntent::ResumeWork { scope: page },
    );
    assert!(requests(m).is_empty());
    let reopened = reopen_inbox_workspace(w);
    let m = &reopened.module;
    apply_host(
        m,
        "resume-space",
        ProjectWorkspaceIntent::ResumeWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    let delivery = requests(m)[0].delivery.clone().unwrap();
    assert!(delivery.paused_ms.unwrap() >= 10000);
    let budget = delivery.paused_ms;
    apply_host(
        m,
        "resume-space-again",
        ProjectWorkspaceIntent::ResumeWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    assert_eq!(requests(m)[0].delivery.as_ref().unwrap().paused_ms, budget);
}

fn create_work_page(w: &TestWorkspace, id: &str) {
    apply_host(
        &w.module,
        &format!("page:{id}"),
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: PROJECT.into(),
            },
            page_id: id.into(),
            document_id: format!(
                "019d0000-0000-7000-8000-{:012}",
                match &id[id.len() - 2..] {
                    "91" => 92,
                    "93" => 94,
                    _ => 96,
                }
            ),
            title: id.into(),
        },
    );
}
fn start_work_page(w: &TestWorkspace, id: &str) {
    apply_host(
        &w.module,
        &format!("start:{id}"),
        ProjectWorkspaceIntent::StartPageWork {
            page_id: id.into(),
            selection: Some(nodex_core_contracts::library::AgentWorkSelection {
                instance_id: "codex".into(),
                model: "gpt".into(),
                effort: None,
            }),
            session_id: format!("chat:{id}"),
            launch_id: format!("launch:{id}"),
            message_id: format!("message:{id}"),
            brief: "Work".into(),
            again: false,
            expected_readiness_epoch: None,
            expected_turn_episode: None,
        },
    );
}
fn observe(w: &TestWorkspace, id: &str, revision: i64, state: SessionExecutionState) {
    let observation:SessionExecutionObservation=serde_json::from_value(serde_json::json!({"state":state,"runId":"run","runStartedAt":0,"pendingRequestIds":[],"pendingRequests":[],"queue":null,"terminalStatus":null,"personStopped":false,"stalled":false,"progressFingerprint":"p","progressSince":0})).unwrap();
    apply_host(
        &w.module,
        &format!("observe:{id}:{revision}"),
        ProjectWorkspaceIntent::RecordSessionExecution {
            session_id: format!("chat:{id}"),
            expected_revision: revision,
            observation,
            events: vec![],
            resolved_request_ids: vec![],
        },
    );
}
fn mixed(
    w: &TestWorkspace,
    scope: ProjectWorkspaceInboxScope,
    after: Option<String>,
    first: u32,
) -> nodex_core_contracts::collection::CollectionWindow<ProjectWorkspaceInboxItem> {
    let ProjectWorkspaceReadValue::InboxWindow { items } = read_host(
        &w.module,
        ProjectWorkspaceRead::InboxWindow {
            scope,
            filter: ProjectWorkspaceInboxWindowFilter::Inbox,
            window: CollectionWindowRequest {
                after,
                first: Some(first),
            },
        },
    ) else {
        panic!("mixed Inbox")
    };
    items
}
fn note(page: &str, id: &str, event: &str, body: &str) -> ProjectWorkspaceIntent {
    agent_command(
        "nodex",
        ProjectWorkspaceIntent::WriteTurnNote {
            page_id: page.into(),
            note_id: id.into(),
            body: body.into(),
            event_ids: vec![event.into()],
            notify: true,
        },
    )
}
#[test]
fn mixed_inbox_counts_scope_pagination_and_episode_reentry_share_one_membership() {
    let w = seeded_workspace();
    runtime_session(&w.module, "nodex", None, true);
    send(&w.module, "intake", "Please route this");
    create_work_page(&w, "019d0000-0000-7000-8000-000000000091");
    start_work_page(&w, "019d0000-0000-7000-8000-000000000091");
    set_status_by_hand(&w, "019d0000-0000-7000-8000-000000000091", "review");
    send(&w.module, "question", "What is waiting?");
    apply_host(
        &w.module,
        "question:kind",
        ProjectWorkspaceIntent::SetInboxEntryKind {
            page_id: "page:question".into(),
            entry_kind: Some(ProjectWorkspaceInboxEntryKind::Question),
        },
    );
    let answer = agent_command(
        "nodex",
        ProjectWorkspaceIntent::AnswerInboxQuestion {
            question_page_id: "page:question".into(),
            page_id: "answer".into(),
            document_id: "answer:doc".into(),
            body: "Work is ready to review.".into(),
        },
    );
    apply_host(&w.module, "answer", answer.clone());
    apply_host(&w.module, "answer:retry", answer);
    let all = mixed(&w, ProjectWorkspaceInboxScope::All, None, 20);
    assert_eq!(all.items.len(), 3);
    assert_eq!(
        all.items
            .iter()
            .filter(|r| r.row_kind == InboxRowKind::Turn)
            .count(),
        1
    );
    assert_eq!(
        all.items
            .iter()
            .filter(|r| r.row_kind == InboxRowKind::Answer)
            .count(),
        1
    );
    let ProjectWorkspaceReadValue::InboxCounts { counts } =
        read_host(&w.module, ProjectWorkspaceRead::InboxCounts)
    else {
        panic!()
    };
    assert_eq!(counts.library_count, 2);
    assert_eq!(counts.projects[0].inbox_count, 1);
    assert_eq!(mixed(&w, project_scope(), None, 10).items.len(), 1);
    let mut seen = vec![];
    let mut cursor = None;
    loop {
        let page = mixed(&w, ProjectWorkspaceInboxScope::All, cursor, 1);
        seen.extend(page.items.into_iter().map(|r| r.page_id));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        seen,
        all.items
            .iter()
            .map(|r| r.page_id.clone())
            .collect::<Vec<_>>()
    );
    let original = all
        .items
        .iter()
        .find_map(|r| r.turn.as_ref())
        .unwrap()
        .turn
        .episode
        .clone();
    observe(
        &w,
        "019d0000-0000-7000-8000-000000000091",
        0,
        SessionExecutionState::Working,
    );
    assert_eq!(mixed(&w, project_scope(), None, 10).items.len(), 0);
    observe(
        &w,
        "019d0000-0000-7000-8000-000000000091",
        1,
        SessionExecutionState::Idle,
    );
    let row = mixed(&w, project_scope(), None, 10).items.remove(0);
    assert_ne!(row.turn.unwrap().turn.episode, original);
    apply_host(
        &w.module,
        "pause",
        ProjectWorkspaceIntent::PauseWork {
            scope: nodex_core_contracts::workspace::ExecutionHoldScope::Page {
                page_id: "019d0000-0000-7000-8000-000000000091".into(),
            },
        },
    );
    assert!(mixed(&w, project_scope(), None, 10).items.is_empty());
}
#[test]
fn turn_notes_bind_delivered_page_events_to_current_episode_and_retry_exactly() {
    let w = seeded_workspace();
    runtime_session(&w.module, "nodex", None, true);
    create_work_page(&w, "019d0000-0000-7000-8000-000000000091");
    set_status_by_hand(&w, "019d0000-0000-7000-8000-000000000091", "review");
    let event = delivered(
        &w.module,
        "ready",
        CoordinatorWorkEventKind::Attention,
        None,
        Some("019d0000-0000-7000-8000-000000000091"),
        None,
    );
    apply_host(
        &w.module,
        "note",
        note(
            "019d0000-0000-7000-8000-000000000091",
            "note:one",
            &event,
            "Check the migration evidence before accepting.",
        ),
    );
    apply_host(
        &w.module,
        "note:retry",
        note(
            "019d0000-0000-7000-8000-000000000091",
            "note:two",
            &event,
            "Check the migration evidence before accepting.",
        ),
    );
    let row = mixed(&w, project_scope(), None, 20).items.remove(0);
    assert_eq!(row.turn.unwrap().note_id.as_deref(), Some("note:one"));
    assert_eq!(row.body, "Check the migration evidence before accepting.");
    assert_eq!(
        apply_host_error(
            &w.module,
            "note:changed",
            note(
                "019d0000-0000-7000-8000-000000000091",
                "note:three",
                &event,
                "Changed"
            )
        ),
        CoreErrorCode::Conflict
    );
    create_work_page(&w, "019d0000-0000-7000-8000-000000000093");
    set_status_by_hand(&w, "019d0000-0000-7000-8000-000000000093", "review");
    assert_eq!(
        apply_host_error(
            &w.module,
            "note:wrong",
            note(
                "019d0000-0000-7000-8000-000000000093",
                "note:wrong",
                &event,
                "Wrong Page"
            )
        ),
        CoreErrorCode::InvalidInput
    );
    assert_eq!(
        apply_host_error(
            &w.module,
            "note:undelivered",
            note(
                "019d0000-0000-7000-8000-000000000091",
                "note:missing",
                "missing",
                "Missing"
            )
        ),
        CoreErrorCode::InvalidInput
    );
    start_work_page(&w, "019d0000-0000-7000-8000-000000000091");
    observe(
        &w,
        "019d0000-0000-7000-8000-000000000091",
        0,
        SessionExecutionState::Working,
    );
    assert_eq!(
        apply_host_error(
            &w.module,
            "note:late",
            note(
                "019d0000-0000-7000-8000-000000000091",
                "note:late",
                &event,
                "Late"
            )
        ),
        CoreErrorCode::Conflict
    );
    observe(
        &w,
        "019d0000-0000-7000-8000-000000000091",
        1,
        SessionExecutionState::Idle,
    );
    let row = mixed(&w, project_scope(), None, 20)
        .items
        .into_iter()
        .find(|r| r.page_id == "019d0000-0000-7000-8000-000000000091")
        .unwrap();
    assert!(row.turn.unwrap().note_id.is_none());
    assert!(
        crate::workspace::test_support::activity_rows(&w.module)
            .iter()
            .any(|row| row.id.starts_with("note:") && row.reason.is_some())
    );
}
#[test]
fn turn_reply_is_durable_unchanged_and_never_creates_intake_and_stale_episode_fails() {
    let w = seeded_workspace();
    create_work_page(&w, "019d0000-0000-7000-8000-000000000091");
    start_work_page(&w, "019d0000-0000-7000-8000-000000000091");
    set_status_by_hand(&w, "019d0000-0000-7000-8000-000000000091", "review");
    let row = mixed(&w, project_scope(), None, 10).items.remove(0);
    let episode = row.turn.unwrap().turn.episode;
    let reply = ProjectWorkspaceIntent::ReplyToPageTurn {
        page_id: "019d0000-0000-7000-8000-000000000091".into(),
        episode: episode.clone(),
        body: "  Keep my words\nexactly.  ".into(),
        dispatch: Some(nodex_core_contracts::inbox::InboxReplyDispatch::Send),
    };
    apply_host(&w.module, "reply", reply.clone());
    let ProjectWorkspaceReadValue::InboxDispatchOutbox { dispatches } = read_host(
        &w.module,
        ProjectWorkspaceRead::InboxDispatchOutbox { limit: 10 },
    ) else {
        panic!()
    };
    assert_eq!(dispatches.len(), 1);
    assert_eq!(
        dispatches[0].final_text.as_deref(),
        Some("  Keep my words\nexactly.  ")
    );
    assert_eq!(
        dispatches[0].session_id,
        "chat:019d0000-0000-7000-8000-000000000091"
    );
    let ProjectWorkspaceReadValue::InboxSummary { summary } = read_host(
        &w.module,
        ProjectWorkspaceRead::InboxSummary {
            scope: ProjectWorkspaceInboxScope::Library,
        },
    ) else {
        panic!()
    };
    assert_eq!(summary.entry_count, 0);
    observe(
        &w,
        "019d0000-0000-7000-8000-000000000091",
        0,
        SessionExecutionState::Working,
    );
    assert_eq!(
        apply_host_error(&w.module, "reply:stale", reply),
        CoreErrorCode::Conflict
    );
}
#[test]
fn an_agent_replies_on_its_members_turn_but_never_on_another_members() {
    let w = seeded_workspace();
    let page = "019d0000-0000-7000-8000-000000000091";
    create_work_page(&w, page);
    start_work_page(&w, page);
    set_status_by_hand(&w, page, "review");
    let episode = mixed(&w, project_scope(), None, 10)
        .items
        .remove(0)
        .turn
        .unwrap()
        .turn
        .episode;
    runtime_session(&w.module, "helper", None, false);
    runtime_session(&w.module, "theirs", None, false);
    let member = local_member(&w);
    // Another Member of a team Space opened the second chat.
    w.kernel
        .writer()
        .call(|c| {
            c.execute_batch("UPDATE libraries SET space_kind='team' WHERE id='library-1'; INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES('other','library-1','Other','active','member'); UPDATE session_requesting_members SET member_id='other' WHERE session_id='theirs';")?;
            Ok(())
        })
        .unwrap();
    let reply = |chat: &str, operation: &str| {
        w.module.apply(
            &host(),
            request(
                operation,
                agent_command(
                    chat,
                    ProjectWorkspaceIntent::ReplyToPageTurn {
                        page_id: page.into(),
                        episode: episode.clone(),
                        body: "Ship it as reviewed.".into(),
                        dispatch: Some(nodex_core_contracts::inbox::InboxReplyDispatch::Send),
                    },
                ),
            ),
        )
    };
    // Nobody answers another Member's Turn, through an Agent or otherwise.
    assert_eq!(
        reply("theirs", "agent_reply_theirs").unwrap_err().code,
        CoreErrorCode::Unauthorized
    );
    // The Agent acts on its own Member's Turn when the person asked it to.
    reply("helper", "agent_reply").unwrap();
    let ProjectWorkspaceReadValue::InboxDispatchOutbox { dispatches } = read_host(
        &w.module,
        ProjectWorkspaceRead::InboxDispatchOutbox { limit: 10 },
    ) else {
        panic!()
    };
    assert_eq!(
        dispatches[0].final_text.as_deref(),
        Some("Ship it as reviewed.")
    );
    let actor: String = w
        .kernel
        .readers()
        .read_default(|c| {
            Ok(c.query_row("SELECT json_extract(actor_json,'$.type')||':'||json_extract(actor_json,'$.on_behalf_of') FROM mutation_actors WHERE module_name='project_workspace' AND operation_id='agent_reply'", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(actor, format!("agent:{member}"));
    // Showing a Turn notification remains the person's devices' own receipt.
    assert_eq!(
        w.module
            .apply(
                &host(),
                request(
                    "agent_claim",
                    agent_command(
                        "helper",
                        ProjectWorkspaceIntent::ClaimTurnNotification {
                            page_id: page.into(),
                            episode,
                        },
                    ),
                ),
            )
            .unwrap_err()
            .code,
        CoreErrorCode::Unauthorized
    );
}
fn entry(module: &ProjectWorkspaceModule, id: &str) -> ProjectWorkspaceInboxItem {
    let ProjectWorkspaceReadValue::InboxEntry { item } = read_host(
        module,
        ProjectWorkspaceRead::InboxEntry { page_id: id.into() },
    ) else {
        panic!("entry")
    };
    *item.expect("entry")
}

#[test]
fn inbox_ready_turn_requires_real_done_prerequisites_and_excludes_backlog_and_pause() {
    use nodex_core_contracts::database::DatabasePropertySetDelta;
    let w = seeded_workspace();
    let page = "019d0000-0000-7000-8000-000000000091";
    let prerequisite = "019d0000-0000-7000-8000-000000000093";
    create_work_page(&w, page);
    start_work_page(&w, page);
    apply_host(
        &w.module,
        "archive:work",
        ProjectWorkspaceIntent::MutateSession {
            session_id: format!("chat:{page}"),
            intent: ProjectSessionIntent::SetArchived { archived: true },
        },
    );
    set_status_by_hand(&w, page, "plan");
    assert!(
        mixed(&w, project_scope(), None, 20).items.is_empty(),
        "Todo backlog is not Inbox work"
    );
    create_work_page(&w, prerequisite);
    let source = page_parent(&w, page);
    crate::database::DatabaseModule::new("profile-1", "library-1", &w.kernel)
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "prerequisite:add".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: vec![DatabaseIntent::EditPropertyValues {
                    edits: vec![DatabasePropertyValueMutation {
                        expected_membership_revision: None,
                        address: DatabasePagePropertyAddress {
                            page_id: page.into(),
                            data_source_id: source,
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
    assert!(mixed(&w, project_scope(), None, 20).items.is_empty());
    set_status_by_hand(&w, prerequisite, "review");
    // Review is the person's Turn, but does not release dependent work.
    assert!(
        !mixed(&w, project_scope(), None, 20)
            .items
            .iter()
            .any(|row| row.page_id == page)
    );
    set_status_by_hand(&w, prerequisite, "done");
    let rows = mixed(&w, project_scope(), None, 20).items;
    let ready = rows.iter().find(|row| row.page_id == page).unwrap();
    assert_eq!(
        ready.turn.as_ref().unwrap().turn.reason,
        Some(nodex_core_contracts::workspace::TurnReason::ReadyToStart)
    );
    assert!(ready.body.starts_with("Finished:"));
    apply_host(
        &w.module,
        "pause:ready",
        ProjectWorkspaceIntent::PauseWork {
            scope: nodex_core_contracts::workspace::ExecutionHoldScope::Page {
                page_id: page.into(),
            },
        },
    );
    assert!(
        !mixed(&w, project_scope(), None, 20)
            .items
            .iter()
            .any(|row| row.page_id == page)
    );
}

#[test]
fn notification_intents_are_claimed_once_only_while_their_turn_is_current() {
    let w = seeded_workspace();
    let page = "019d0000-0000-7000-8000-000000000091";
    create_work_page(&w, page);
    start_work_page(&w, page);
    let capture = |revision: i64, kind: &str| {
        let observation:SessionExecutionObservation=serde_json::from_value(serde_json::json!({"state":"waiting","runId":"run","runStartedAt":0,"pendingRequestIds":["request"],"pendingRequests":[{"id":"request","kind":kind,"question":"Choose one","options":["One","Two"]}],"queue":null,"terminalStatus":null,"personStopped":false,"stalled":false,"progressFingerprint":"p","progressSince":0})).unwrap();
        apply_host(
            &w.module,
            &format!("notify:observe:{revision}"),
            ProjectWorkspaceIntent::RecordSessionExecution {
                session_id: format!("chat:{page}"),
                expected_revision: revision,
                observation,
                events: vec![],
                resolved_request_ids: vec![],
            },
        );
    };
    let intents = || {
        let ProjectWorkspaceReadValue::InboxTurnNotifications { intents } =
            read_host(&w.module, ProjectWorkspaceRead::InboxTurnNotifications)
        else {
            panic!()
        };
        intents
    };
    capture(0, "question");
    capture(1, "question");
    let first = intents();
    assert_eq!(first.len(), 1);
    let claim = ProjectWorkspaceIntent::ClaimTurnNotification {
        page_id: page.into(),
        episode: first[0].episode.clone(),
    };
    apply_host(&w.module, "notify:claim", claim.clone());
    apply_host(&w.module, "notify:claim:retry", claim.clone());
    assert!(intents().is_empty());
    capture(2, "approval");
    let second = intents();
    assert_eq!(second.len(), 1);
    assert_ne!(second[0].episode, first[0].episode);
    assert_eq!(
        apply_host_error(&w.module, "notify:stale", claim),
        CoreErrorCode::Conflict
    );
}

#[test]
fn phones_hear_of_each_current_turn_whether_or_not_a_desktop_claimed_it() {
    use nodex_core_contracts::team::PhonePushAudience;
    let w = seeded_workspace();
    let page = "019d0000-0000-7000-8000-000000000092";
    create_work_page(&w, page);
    start_work_page(&w, page);
    let capture = |revision: i64, kind: &str| {
        let observation:SessionExecutionObservation=serde_json::from_value(serde_json::json!({"state":"waiting","runId":"run","runStartedAt":0,"pendingRequestIds":["request"],"pendingRequests":[{"id":"request","kind":kind,"question":"Choose one","options":["One","Two"]}],"queue":null,"terminalStatus":null,"personStopped":false,"stalled":false,"progressFingerprint":"p","progressSince":0})).unwrap();
        apply_host(
            &w.module,
            &format!("phone:observe:{revision}"),
            ProjectWorkspaceIntent::RecordSessionExecution {
                session_id: format!("chat:{page}"),
                expected_revision: revision,
                observation,
                events: vec![],
                resolved_request_ids: vec![],
            },
        );
    };
    let current = || {
        let ProjectWorkspaceReadValue::CurrentTurnNotifications { turns } =
            read_host(&w.module, ProjectWorkspaceRead::CurrentTurnNotifications)
        else {
            panic!()
        };
        turns
    };
    let owner = |episode: &str| {
        w.module
            .push_audience(
                None,
                &PhonePushAudience::TurnOwner {
                    page_id: page.into(),
                    episode: episode.into(),
                },
            )
            .unwrap()
    };
    assert!(current().is_empty());
    capture(0, "question");
    let first = current();
    assert_eq!(first.len(), 1);
    let turn = &first[0];
    assert_eq!(turn.member_id, local_member(&w));
    assert_eq!(
        turn.reason,
        Some(nodex_core_contracts::workspace::TurnReason::Question)
    );
    assert_eq!(
        turn.session_id.as_deref(),
        Some(format!("chat:{page}").as_str())
    );
    assert_eq!(owner(&turn.episode), Some(local_member(&w)));
    // A desktop showing it does not take it from the phone.
    apply_host(
        &w.module,
        "phone:claim",
        ProjectWorkspaceIntent::ClaimTurnNotification {
            page_id: page.into(),
            episode: turn.episode.clone(),
        },
    );
    assert_eq!(current(), first);
    // Once the Turn moves on, it concerns no one and is no longer listed.
    capture(1, "approval");
    let second = current();
    assert_eq!(second.len(), 1);
    assert_ne!(second[0].episode, turn.episode);
    assert_eq!(owner(&turn.episode), None);
}

#[test]
fn answers_refuse_questions_already_dispatched_to_a_chat() {
    let w = seeded_workspace();
    runtime_session(&w.module, "nodex", None, true);
    send(&w.module, "routed-question", "How should we test this?");
    dispatch(
        &w.module,
        "routed-question",
        &["page:routed-question"],
        ProjectWorkspaceInboxDispatchAction::NewChat {
            project_id: None,
            prompt: "Investigate the question".into(),
            agent: None,
            skills: vec![],
            additions: vec![],
        },
        Some("question-chat"),
    );
    assert_eq!(
        apply_host_error(
            &w.module,
            "answer:routed",
            agent_command(
                "nodex",
                ProjectWorkspaceIntent::AnswerInboxQuestion {
                    question_page_id: "page:routed-question".into(),
                    page_id: "answer:routed".into(),
                    document_id: "answer:routed:doc".into(),
                    body: "An answer".into(),
                }
            )
        ),
        CoreErrorCode::Conflict
    );
    assert_eq!(count(&w, "SELECT count(*) FROM inbox_answers"), 0);
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
fn nodex_starts_work_for_the_person_and_reads_as_nodex_on_their_behalf() {
    let w = seeded_workspace();
    runtime_session(&w.module, "nodex", None, true);
    runtime_session(&w.module, "helper", Some(PROJECT), false);
    let page = "019d0000-0000-7000-8000-000000000091";
    let consented = "019d0000-0000-7000-8000-000000000093";
    let other = "019d0000-0000-7000-8000-000000000095";
    for id in [page, consented, other] {
        create_work_page(&w, id);
    }
    let member = local_member(&w);
    let launch = |id: &str| {
        super::super::test_support::activity_rows(&w.module)
            .into_iter()
            .find(|row| row.id == format!("launch:launch:{id}"))
            .unwrap()
    };
    let nodex = nodex_acting_for(&member);
    // Ready work without consent waits for the person; when they ask, Nodex starts it for them.
    assign_agent(&w, "assign-ask", page, false, 1);
    apply_host(&w.module, "nodex:ask", agent_start("nodex", page, "asked"));
    assert_eq!(launch("asked").actor, nodex);
    assert_eq!(launch("asked").actor_label, "by Nodex on behalf of You");
    // A Page set to Start automatically starts on its consenting Member's standing grant.
    assign_agent(&w, "assign-consent", consented, true, 1);
    apply_host(
        &w.module,
        "nodex:consented",
        agent_start("nodex", consented, "consented"),
    );
    assert_eq!(launch("consented").actor, nodex);
    assert_eq!(launch("consented").actor_label, "by Nodex on behalf of You");
    // Another Agent starts work for the person it serves, under its own name.
    assign_agent(&w, "assign-helper", other, false, 1);
    apply_host(
        &w.module,
        "helper:start",
        agent_start("helper", other, "helper"),
    );
    let helper = launch("helper");
    assert!(
        matches!(helper.actor, nodex_core_contracts::Actor::Agent { ref session_id, .. } if session_id == "helper")
    );
    assert_eq!(helper.actor_label, "by Agent on behalf of You");
}

fn nodex_acting_for(member: &str) -> nodex_core_contracts::Actor {
    nodex_core_contracts::Actor::Agent {
        session_id: "nodex".into(),
        run_id: Some("run:test".into()),
        on_behalf_of: member.into(),
    }
}

#[path = "inbox_remote_tests.rs"]
mod remote_tests;

#[path = "inbox_handback_tests.rs"]
mod handback_tests;
