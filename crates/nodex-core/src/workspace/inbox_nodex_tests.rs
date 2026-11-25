use super::*;
use crate::workspace::test_support::{local_member, read as read_workspace};
use nodex_core_contracts::inbox::{
    InboxConfirmedBy, InboxRowKind, ProjectWorkspaceInboxSuggestedDispatch,
};
use nodex_core_contracts::workspace::{
    ProjectWorkspaceAgentRuntimeAuthority, ProjectWorkspaceAgentRuntimeTurnKind,
    ProjectWorkspacePageCreationTarget, SessionExecutionObservation, SessionExecutionState,
};

// Keep fixture Page UUIDs separate from operation timestamps.
fn apply_host(module: &ProjectWorkspaceModule, operation: &str, intent: ProjectWorkspaceIntent) {
    super::apply_host(module, &operation.replace(':', "_"), intent);
}
fn runtime_session(module: &ProjectWorkspaceModule, id: &str, project: Option<&str>) {
    apply_host(
        module,
        &format!("runtime:{id}"),
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            agent_selection: None,
            decision_run: None,
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
fn admit_routing(m: &ProjectWorkspaceModule, session: &str, request_id: &str) {
    routing_session(m, session, request_id, 1);
    apply_host(
        m,
        &format!("begin:{request_id}"),
        ProjectWorkspaceIntent::BeginInboxRouting {
            request_id: request_id.into(),
            generation: 1,
            decision_session_id: session.into(),
            skill_offers: vec![],
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
#[test]
fn automatic_inbox_confirmation_enforces_source_intent_basis_and_action_in_the_transaction() {
    for case in [
        "user",
        "implicit",
        "agent",
        "cli",
        "mixed",
        "outdated",
        "keep",
        "move",
        "suggest",
        "deferred",
        "deferred-before-confirm",
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
                runtime_session(m, "source", None);
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
        let defer = || {
            apply_host(
                m,
                "defer",
                ProjectWorkspaceIntent::SetInboxSnooze {
                    page_ids: vec!["page:request".into()],
                    until: "2099-01-01T00:00:00Z".into(),
                },
            )
        };
        if case == "deferred" {
            defer();
        }
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
                decision_session_id: None,
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
        if case == "deferred-before-confirm" {
            defer();
        }
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
            if case.starts_with("deferred") {
                w.kernel
                    .writer()
                    .call(|c| {
                        c.execute(
                            "UPDATE inbox_deferrals SET until_at='2001-01-01T00:00:00.000000000Z'",
                            [],
                        )?;
                        Ok(())
                    })
                    .unwrap();
                assert!(
                    m.apply(&host(), request("confirm-after-deadline", confirmation))
                        .is_err()
                );
                assert_eq!(
                    entry(m, "page:request").proposal.unwrap().state,
                    ProjectWorkspaceInboxProposalState::Open
                );
                assert!(outbox(m).is_empty());
            }
        }
    }
}

#[test]
fn routing_delivery_fixes_recipient_and_first_deadline_and_bounds_unsettled_requests() {
    const LIMIT: usize = 16;
    let w = seeded_workspace();
    let m = &w.module;
    for i in 0..=LIMIT {
        send(m, &format!("route:{i}"), "Fix this");
        grouped_request(m, &format!("request:{i}"), vec![format!("page:route:{i}")]);
        routing_session(m, &format!("routing:{i}"), &format!("request:{i}"), 1);
    }
    let begin = |i| ProjectWorkspaceIntent::BeginInboxRouting {
        skill_offers: vec![],
        request_id: format!("request:{i}"),
        generation: 1,
        decision_session_id: format!("routing:{i}"),
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
fn retired_routing_remains_discoverable_until_execution_stops() {
    let w = seeded_workspace();
    let m = &w.module;
    send(m, "retired-route", "Fix this");
    grouped_request(m, "retired-request", vec!["page:retired-route".into()]);
    routing_session(m, "nodex", "retired-request", 1);
    apply_host(
        m,
        "begin-retired",
        ProjectWorkspaceIntent::BeginInboxRouting {
            skill_offers: vec![],
            request_id: "retired-request".into(),
            generation: 1,
            decision_session_id: "nodex".into(),
        },
    );
    let retired = |m: &ProjectWorkspaceModule| {
        let ProjectWorkspaceReadValue::RetiredDecisionRuns { runs } = read_workspace(
            m,
            ProjectWorkspaceRead::RetiredDecisionRuns {
                after_session_id: None,
            },
        ) else {
            panic!("retired decision runs")
        };
        runs
    };
    assert!(retired(m).is_empty());
    let first = requests(m).remove(0);
    apply_host(
        m,
        "expire",
        keep_request(&first, Some("The suggestion agent timed out")),
    );
    let reopened = reopen_inbox_workspace(w);
    let m = &reopened.module;
    assert_eq!(retired(m)[0].session_id, "nodex");
    apply_host(
        m,
        "stop-retired",
        ProjectWorkspaceIntent::AcknowledgeDecisionRunStopped {
            session_id: "nodex".into(),
        },
    );
    assert!(retired(m).is_empty());
    let ProjectWorkspaceReadValue::DecisionRun {
        decision_run,
        pending,
    } = read_workspace(
        m,
        ProjectWorkspaceRead::DecisionRun {
            session_id: "nodex".into(),
        },
    )
    else {
        panic!("decision run")
    };
    assert!(decision_run.is_some() && !pending);
}

#[test]
fn routing_clocks_preserve_the_pause_union_across_reopen_and_agents_hold_for_their_person() {
    use nodex_core_contracts::workspace::ExecutionHoldScope;
    let w = seeded_workspace();
    let m = &w.module;
    send(m, "paused-route", "Fix this");
    grouped_request(m, "paused-request", vec!["page:paused-route".into()]);
    routing_session(m, "nodex", "paused-request", 1);
    apply_host(
        m,
        "begin-paused",
        ProjectWorkspaceIntent::BeginInboxRouting {
            skill_offers: vec![],
            request_id: "paused-request".into(),
            generation: 1,
            decision_session_id: "nodex".into(),
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
    let ProjectWorkspaceReadValue::DecisionRunReservations {
        routing,
        assessment,
    } = read_workspace(m, ProjectWorkspaceRead::DecisionRunReservations)
    else {
        panic!("reservations")
    };
    assert_eq!((routing, assessment), (1, 0));
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
#[test]
fn mixed_inbox_counts_scope_pagination_and_episode_reentry_share_one_membership() {
    let w = seeded_workspace();
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
    grouped_request(&w.module, "request:answer", vec!["page:question".into()]);
    admit_routing(&w.module, "nodex", "request:answer");
    let answer = agent_command(
        "nodex",
        ProjectWorkspaceIntent::AnswerInboxQuestion {
            request_id: "request:answer".into(),
            generation: 1,
            question_page_id: "page:question".into(),
            page_id: "answer".into(),
            document_id: "answer:doc".into(),
            body: "Work is ready to review.".into(),
        },
    );
    routing_session(&w.module, "different-request", "request:elsewhere", 1);
    let ProjectWorkspaceIntent::AgentCommand { intent, .. } = &answer else {
        unreachable!()
    };
    assert_eq!(
        apply_host_error(
            &w.module,
            "answer:other-request",
            agent_command("different-request", *intent.clone())
        ),
        CoreErrorCode::Unauthorized,
    );
    let mut other_page = answer.clone();
    let ProjectWorkspaceIntent::AgentCommand { intent, .. } = &mut other_page else {
        unreachable!()
    };
    let ProjectWorkspaceIntent::AnswerInboxQuestion {
        question_page_id, ..
    } = intent.as_mut()
    else {
        unreachable!()
    };
    *question_page_id = "page:elsewhere".into();
    assert_eq!(
        apply_host_error(&w.module, "answer:other-page", other_page),
        CoreErrorCode::Unauthorized
    );
    apply_host(&w.module, "answer", answer.clone());
    apply_host(&w.module, "answer:retry", answer);
    let activity = crate::workspace::test_support::activity_rows(&w.module);
    let answered = activity
        .iter()
        .find(|row| row.evidence["answered"] == true)
        .unwrap();
    assert_eq!(answered.evidence["decision_session_id"], "nodex");

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
    runtime_session(&w.module, "helper", None);
    runtime_session(&w.module, "theirs", None);
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
    let ProjectWorkspaceReadValue::InboxTurnNotifications { intents } =
        read_host(&w.module, ProjectWorkspaceRead::InboxTurnNotifications)
    else {
        panic!("Turn notifications")
    };
    assert!(intents.is_empty());

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
fn chat_windows_and_inbox_counts_follow_the_same_current_turn() {
    use crate::workspace::test_support::create_project;
    use nodex_core_contracts::events::DeliveryAtomPayload;
    use nodex_core_contracts::workspace::{
        ProjectSessionInvalidationScope, ProjectWorkspaceTaskLifecycle, ProjectWorkspaceTaskOrder,
        ProjectWorkspaceTaskPlacementScope, TurnReason,
    };

    let w = seeded_workspace();
    let m = &w.module;
    let page = "019d0000-0000-7000-8000-000000000091";
    let chat = format!("chat:{page}");
    let other_project = "project:other";
    create_project(m, "other-project", other_project);
    send_to(
        m,
        "other-intake",
        "Still needs routing",
        Some(other_project),
    );
    create_work_page(&w, page);
    start_work_page(&w, page);
    runtime_session(m, "related", Some(PROJECT));
    apply_host(
        m,
        "link-related",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "related".into(),
            intent: nodex_core_contracts::workspace::ProjectSessionIntent::LinkPage {
                page_id: page.into(),
            },
        },
    );

    let window = |after| {
        let ProjectWorkspaceReadValue::TaskWindow { tasks } = read_host(
            m,
            ProjectWorkspaceRead::TaskWindow {
                project_id: Some(PROJECT.into()),
                whole_library: false,
                include_archived: None,
                placement_scope: ProjectWorkspaceTaskPlacementScope::All,
                lifecycle: ProjectWorkspaceTaskLifecycle::Open,
                order: ProjectWorkspaceTaskOrder::Attention,
                query: None,
                window: CollectionWindowRequest {
                    after,
                    first: Some(1),
                },
            },
        ) else {
            panic!("chat window");
        };
        tasks
    };
    let chat_turn = || {
        let first = window(None);
        assert_eq!(first.items.len(), 1);
        let next = window(Some(first.next_cursor.expect("second chat cursor")));
        assert_eq!(next.items.len(), 1);
        assert!(next.next_cursor.is_none());
        let sessions: std::collections::BTreeMap<_, _> = first
            .items
            .into_iter()
            .chain(next.items)
            .map(|task| (task.session.id, task.session.page_turn))
            .collect();
        assert_eq!(sessions.get("related"), Some(&None));
        sessions
            .get(&chat)
            .expect("the Active chat is listed")
            .clone()
    };

    let assert_invalidated = |commit_seq| {
        let packet = crate::infrastructure::event_log::CoreEventLog::new(w.kernel.readers())
            .authorized_packet(commit_seq, &host(), None, false)
            .expect("authorized mutation packet")
            .expect("mutation packet");
        assert!(packet.atoms.iter().any(|atom| matches!(
            &atom.payload,
            DeliveryAtomPayload::ProjectWorkspace { event, .. }
                if event.session_summary_scopes.contains(&ProjectSessionInvalidationScope::Project {
                    project_id: PROJECT.into()
                }) && event.session_detail_ids.contains(&chat)
        )), "the changed Page Turn must refresh its chat");
    };

    observe(&w, page, 0, SessionExecutionState::Working);
    assert!(chat_turn().is_none());
    observe(&w, page, 1, SessionExecutionState::Idle);
    let reviewed = set_status_by_hand(&w, page, "review");
    assert_invalidated(reviewed.committed.commit_seq);
    let review = chat_turn().expect("review asks the reader");
    assert_eq!(review.reason, Some(TurnReason::Review));
    let waiting = counts(m).waiting;
    assert!(!waiting.library);
    assert_eq!(waiting.projects.get(PROJECT), Some(&false));

    record_request(&w, page, 2, "question");
    let question = chat_turn().expect("question asks the reader");
    assert_eq!(question.reason, Some(TurnReason::Question));
    assert_ne!(question.episode, review.episode);
    let waiting = counts(m).waiting;
    assert!(waiting.library);
    assert_eq!(waiting.projects.get(PROJECT), Some(&true));
    assert_eq!(waiting.projects.get(other_project), Some(&false));

    apply_host(
        m,
        "defer-question",
        ProjectWorkspaceIntent::SetInboxSnooze {
            page_ids: vec![page.into()],
            until: "2099-01-01T00:00:00Z".into(),
        },
    );
    assert_eq!(chat_turn(), Some(question.clone()));
    let deferred = counts(m);
    assert!(!deferred.waiting.library);
    assert!(!deferred.waiting.projects.contains_key(PROJECT));
    assert_eq!(deferred.waiting.projects.get(other_project), Some(&false));

    record_request(&w, page, 3, "approval");
    let approval = chat_turn().expect("approval starts a fresh episode");
    assert_eq!(approval.reason, Some(TurnReason::Approval));
    assert_ne!(approval.episode, question.episode);
    let waiting = counts(m).waiting;
    assert!(waiting.library);
    assert_eq!(waiting.projects.get(PROJECT), Some(&true));

    let done = set_status_by_hand(&w, page, "done");
    assert_invalidated(done.committed.commit_seq);
    assert!(chat_turn().is_none());
    assert!(!counts(m).waiting.library);
}

fn record_request(w: &TestWorkspace, page: &str, revision: i64, kind: &str) {
    let observation:SessionExecutionObservation=serde_json::from_value(serde_json::json!({"state":"waiting","runId":"run","runStartedAt":0,"pendingRequestIds":["request"],"pendingRequests":[{"id":"request","kind":kind,"question":"Choose one","options":["One","Two"]}],"queue":null,"terminalStatus":null,"personStopped":false,"stalled":false,"progressFingerprint":"p","progressSince":0})).unwrap();
    apply_host(
        &w.module,
        &format!("observe-request:{revision}"),
        ProjectWorkspaceIntent::RecordSessionExecution {
            session_id: format!("chat:{page}"),
            expected_revision: revision,
            observation,
        },
    );
}

#[test]
fn notification_intents_are_claimed_once_only_while_their_turn_is_current() {
    let w = seeded_workspace();
    let page = "019d0000-0000-7000-8000-000000000091";
    create_work_page(&w, page);
    start_work_page(&w, page);
    let capture = |revision, kind| record_request(&w, page, revision, kind);
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
    send(&w.module, "routed-question", "How should we test this?");
    grouped_request(
        &w.module,
        "request:answer",
        vec!["page:routed-question".into()],
    );
    admit_routing(&w.module, "nodex", "request:answer");
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
                    request_id: "request:answer".into(),
                    generation: 1,
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

#[path = "inbox_remote_tests.rs"]
mod remote_tests;

#[path = "inbox_handback_tests.rs"]
mod handback_tests;
