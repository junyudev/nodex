//! Remote membership crosses the same Inbox transaction and receipt boundaries as local UI.
use super::*;
use crate::workspace::test_support::read;
use nodex_core_contracts::{RemotePrincipal, library::MemberRole};

fn member(w: &TestWorkspace, id: &str) -> BoundModuleContext {
    let member_id = id.to_owned();
    // Identity storage is the boundary under test; content is authored through public commands.
    w.kernel.writer().call(move |c| {
        c.execute("UPDATE libraries SET space_kind='team' WHERE id='library-1'",[])?;
        c.execute("INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES(?1,'library-1',?1,'active','member')",[&member_id])?;
        c.execute("INSERT INTO member_devices(id,library_id,member_id,label,credential_hash,created_at,last_seen) VALUES(?1,'library-1',?1,'Device',?1,unixepoch(),unixepoch())",[&member_id])?;
        c.execute("INSERT INTO member_sessions(id,device_id,token_hash,created_at,expires_at) VALUES(?1,?1,?1,unixepoch(),unixepoch()+3600)",[&member_id])?;
        Ok(())
    }).unwrap();
    BoundModuleContext {
        adapter: AdapterKind::RemoteMember,
        principal: Some(RemotePrincipal {
            space_id: "library-1".into(),
            member_id: id.into(),
            device_id: id.into(),
            session_id: id.into(),
            role: MemberRole::Member,
        }),
        ..host()
    }
}
fn apply_member(
    w: &TestWorkspace,
    person: &BoundModuleContext,
    op: &str,
    intent: ProjectWorkspaceIntent,
) -> Result<super::super::super::ProjectWorkspaceApplyOutcome, nodex_core_contracts::CoreError> {
    w.module.apply(person, request(op, intent))
}
fn create_remote_page(w: &TestWorkspace, remote: &BoundModuleContext, page: &str) {
    create_work_page(w, page);
    let (revision,raw):(i64,String)=w.kernel.readers().read_default({let page=page.to_owned();move |c|Ok(c.query_row("SELECT revision,value_json FROM block_properties WHERE block_id=?1 AND property_key='work'",[page],|r|Ok((r.get(0)?,r.get(1)?)))?)}).unwrap();
    let mut work: serde_json::Value = serde_json::from_str(&raw).unwrap();
    work["owner"] = serde_json::json!(remote.principal.as_ref().unwrap().member_id);
    crate::library::LibraryModule::new("profile-1","library-1",&w.kernel).apply(remote,nodex_core_contracts::ModuleApplyRequest {contract_version:nodex_core_contracts::LIBRARY_CONTRACT_VERSION,operation_id:"remote-owner".into(),store_epoch:nodex_core_contracts::StoreEpoch("epoch-1".into()),intent:nodex_core_contracts::library::LibraryIntent::ApplyBlockPropertyMutation {mutation:Box::new(nodex_core_contracts::library::LibraryBlockPropertyMutation {actor:serde_json::Value::Null,client_session_id:None,fields:vec![nodex_core_contracts::library::LibraryBlockPropertyFieldMutation::IntrinsicSet {block_id:page.into(),property_key:"work".into(),expected_revision:revision,value:work}]})}}).unwrap();
}

#[test]
fn standalone_runtime_chats_are_observed_and_only_the_requesting_member_can_answer() {
    let w = seeded_workspace();
    let bob = member(&w, "bob");
    let alice = member(&w, "alice");
    apply_member(
        &w,
        &bob,
        "bob:standalone",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            session_id: "session:standalone".into(),
            project_id: None,
            title: "Bob's chat".into(),
            initial_page_ids: vec![],
            agent_selection: None,
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread".into(),
            launch_request_id: "launch".into(),
            side_chat_source_session_id: None,
            coordinator: false,
        },
    )
    .unwrap();
    let ProjectWorkspaceReadValue::SessionExecutionObservers { observers } = read(
        &w.module,
        ProjectWorkspaceRead::SessionExecutionObservers {
            after_session_id: None,
            limit: 50,
        },
    ) else {
        panic!("Expected execution observers")
    };
    assert_eq!(observers.len(), 1);
    assert_eq!(observers[0].session_id, "session:standalone");
    assert!(observers[0].managed.is_none());
    assert!(observers[0].observation.is_none());
    let principal = bob.principal.as_ref().unwrap();
    assert!(
        w.module
            .authorize_host_response(principal, "session:standalone", Some("run"), "approval")
            .is_err()
    );
    let observation = serde_json::from_value(serde_json::json!({
        "state": "waiting", "runId": "run", "runStartedAt": 0,
        "pendingRequestIds": ["approval"],
        "pendingRequests": [{"id": "approval", "kind": "approval", "question": "Run command?", "options": []}],
        "queue": null, "terminalStatus": null, "personStopped": false, "stalled": false,
        "progressFingerprint": "approval", "progressSince": 0
    }))
    .unwrap();
    apply_host(
        &w.module,
        "host:observe-approval",
        ProjectWorkspaceIntent::RecordSessionExecution {
            session_id: "session:standalone".into(),
            expected_revision: observers[0].revision,
            observation,
            events: vec![],
            resolved_request_ids: vec![],
        },
    );
    let ProjectWorkspaceReadValue::SessionExecutionObserver {
        observer: Some(observer),
    } = read(
        &w.module,
        ProjectWorkspaceRead::SessionExecutionObserver {
            session_id: "session:standalone".into(),
        },
    )
    else {
        panic!("Expected standalone execution observation")
    };
    assert!(observer.managed.is_none());
    assert_eq!(
        observer.observation.unwrap().pending_requests[0].id,
        "approval"
    );
    w.module
        .authorize_host_response(principal, "session:standalone", Some("run"), "approval")
        .unwrap();
    assert_eq!(
        w.module
            .authorize_host_response(
                alice.principal.as_ref().unwrap(),
                "session:standalone",
                Some("run"),
                "approval"
            )
            .unwrap_err()
            .code,
        CoreErrorCode::Unauthorized
    );
}

#[test]
fn chat_events_concern_the_member_core_entitles_never_another() {
    use nodex_core_contracts::{team::PhonePushAudience, workspace::SessionExecutionRequestKind};
    let w = seeded_workspace();
    let bob = member(&w, "bob");
    let _alice = member(&w, "alice");
    apply_member(
        &w,
        &bob,
        "bob:push",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            session_id: "session:push".into(),
            project_id: None,
            title: "Bob's chat".into(),
            initial_page_ids: vec![],
            agent_selection: None,
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread".into(),
            launch_request_id: "launch".into(),
            side_chat_source_session_id: None,
            coordinator: false,
        },
    )
    .unwrap();
    let audience = |audience: PhonePushAudience| {
        w.module
            .push_audience(Some("session:push"), &audience)
            .unwrap()
    };
    let request = |request| PhonePushAudience::Request {
        run_id: Some("run".into()),
        request,
    };
    // Without a Page Owner, both kinds of request and the Run's outcome go to its requester.
    assert_eq!(
        audience(request(SessionExecutionRequestKind::Question)).as_deref(),
        Some("bob")
    );
    assert_eq!(
        audience(request(SessionExecutionRequestKind::Approval)).as_deref(),
        Some("bob")
    );
    assert_eq!(
        audience(PhonePushAudience::RunRequester {
            run_id: "run".into()
        })
        .as_deref(),
        Some("bob")
    );
    // Alice's Run in the same chat: its question and outcome are hers, and Bob's stay his.
    w.kernel
        .writer()
        .call(|c| {
            c.execute("INSERT INTO session_run_members(session_id,run_id,member_id) VALUES('session:push','alice-run','alice')",[])?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        audience(PhonePushAudience::Request {
            run_id: Some("alice-run".into()),
            request: SessionExecutionRequestKind::Question,
        })
        .as_deref(),
        Some("alice")
    );
    assert_eq!(
        audience(PhonePushAudience::RunRequester {
            run_id: "alice-run".into()
        })
        .as_deref(),
        Some("alice")
    );
    assert_eq!(
        audience(request(SessionExecutionRequestKind::Question)).as_deref(),
        Some("bob")
    );
    assert_eq!(
        w.module
            .push_audience(
                Some("session:missing"),
                &request(SessionExecutionRequestKind::Question)
            )
            .unwrap(),
        None
    );
    // A reminder concerns whoever set it, while they remain an active Member.
    let reminder = |member_id: &str| {
        audience(PhonePushAudience::ReminderOwner {
            member_id: member_id.into(),
        })
    };
    assert_eq!(reminder("alice").as_deref(), Some("alice"));
    assert_eq!(reminder("member:missing"), None);
}

#[test]
fn remote_members_read_session_execution_routes_without_host_or_agent_authority() {
    let w = seeded_workspace();
    let bob = member(&w, "bob");
    apply_host(
        &w.module,
        "host:bind",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            session_id: "session:bob".into(),
            project_id: Some("project:default".into()),
            title: "Shared chat".into(),
            initial_page_ids: vec![],
            agent_selection: None,
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread".into(),
            launch_request_id: "launch".into(),
            side_chat_source_session_id: None,
            coordinator: false,
        },
    );
    let reads = [
        ProjectWorkspaceRead::AgentRuntimeSessionBinding {
            session_id: "session:bob".into(),
        },
        ProjectWorkspaceRead::AgentRuntimeSessionBindingByExecution {
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread".into(),
        },
        ProjectWorkspaceRead::AgentRuntimeSessionBindingWindow {
            runtime_id: "runtime".into(),
            scope: nodex_core_contracts::workspace::AgentRuntimeBindingScope::All,
            window: CollectionWindowRequest {
                first: Some(10),
                after: None,
            },
        },
    ];
    let agent = BoundModuleContext {
        adapter: AdapterKind::Agent,
        ..host()
    };
    for read in reads {
        let request = ModuleReadRequest {
            contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
            read,
        };
        let value = w.module.read(&bob, request.clone()).unwrap().value;
        match value {
            ProjectWorkspaceReadValue::AgentRuntimeSessionBinding {
                binding: Some(binding),
            } => {
                assert_eq!(binding.session_id, "session:bob");
                assert_eq!(binding.runtime_thread_id, "thread");
            }
            ProjectWorkspaceReadValue::AgentRuntimeSessionBindingWindow { bindings } => {
                assert_eq!(bindings.items.len(), 1);
                assert_eq!(bindings.items[0].session_id, "session:bob");
            }
            _ => panic!("execution route"),
        }
        assert_eq!(
            w.module.read(&agent, request).unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
    }
    let host_only = ModuleReadRequest {
        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
        read: ProjectWorkspaceRead::AgentRuntimeSessionBindingByThread {
            runtime_thread_id: "thread".into(),
        },
    };
    assert_eq!(
        w.module.read(&bob, host_only).unwrap_err().code,
        CoreErrorCode::Unauthorized
    );
    assert_eq!(
        apply_member(
            &w,
            &bob,
            "member:retire",
            ProjectWorkspaceIntent::AcknowledgeAgentRuntimeExecutionCleanup {
                cleanup_id: "cleanup".into(),
                runtime_id: "runtime".into(),
                runtime_thread_id: "thread".into(),
            }
        )
        .unwrap_err()
        .code,
        CoreErrorCode::Unauthorized
    );
}

#[test]
fn remote_members_read_and_reply_to_turns_with_member_bound_receipts() {
    for answer in [false, true] {
        let w = seeded_workspace();
        let remote = member(&w, "person");
        let page = "019d0000-0000-7000-8000-000000000091";
        create_remote_page(&w, &remote, page);
        apply_member(
            &w,
            &remote,
            "remote-start",
            ProjectWorkspaceIntent::StartPageWork {
                page_id: page.into(),
                selection: Some(nodex_core_contracts::library::AgentWorkSelection {
                    instance_id: "codex".into(),
                    model: "gpt".into(),
                    effort: None,
                }),
                session_id: format!("chat:{page}"),
                launch_id: format!("launch:{page}"),
                message_id: format!("message:{page}"),
                brief: "Work".into(),
                again: false,
                expected_readiness_epoch: None,
                expected_turn_episode: None,
            },
        )
        .unwrap();
        set_status_by_hand(&w, page, "review");
        if answer {
            let observation:SessionExecutionObservation=serde_json::from_value(serde_json::json!({"state":"waiting","runId":"run","runStartedAt":0,"pendingRequestIds":["request"],"pendingRequests":[{"id":"request","kind":"question","question":"Continue?","options":["Proceed","Stop"]}],"queue":null,"terminalStatus":null,"personStopped":false,"stalled":false,"progressFingerprint":"question","progressSince":0})).unwrap();
            apply_host(
                &w.module,
                "question",
                ProjectWorkspaceIntent::RecordSessionExecution {
                    session_id: format!("chat:{page}"),
                    expected_revision: 0,
                    observation,
                    events: vec![],
                    resolved_request_ids: vec![],
                },
            );
        }
        let result = w
            .module
            .read(
                &remote,
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::InboxWindow {
                        scope: ProjectWorkspaceInboxScope::All,
                        filter: ProjectWorkspaceInboxWindowFilter::Inbox,
                        window: CollectionWindowRequest {
                            first: Some(10),
                            ..Default::default()
                        },
                    },
                },
            )
            .unwrap();
        let ProjectWorkspaceReadValue::InboxWindow { items } = result.value else {
            panic!("Inbox window")
        };
        assert_eq!(items.items.len(), 1);
        let episode = items.items[0].turn.as_ref().unwrap().turn.episode.clone();
        let exact = w
            .module
            .read(
                &remote,
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::InboxMessage {
                        page_id: page.into(),
                    },
                },
            )
            .expect("The invoking Member can read its exact Turn");
        let ProjectWorkspaceReadValue::InboxMessage { item } = exact.value else {
            panic!("Exact Turn");
        };
        assert_eq!(item.turn.unwrap().turn.episode, episode);
        assert_eq!(
            w.module
                .read(
                    &remote,
                    ModuleReadRequest {
                        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                        read: ProjectWorkspaceRead::InboxDispatchContext {
                            page_ids: vec![page.into()]
                        },
                    }
                )
                .expect_err("A Turn cannot become intake review context")
                .code,
            CoreErrorCode::NotFound
        );

        let dispatch = if answer {
            nodex_core_contracts::inbox::InboxReplyDispatch::Answer {
                response: nodex_core_contracts::inbox::InboxQuestionResponse {
                    request_id: "request".into(),
                    run_id: Some("run".into()),
                    question_id: "choice".into(),
                    answer: "Proceed".into(),
                },
            }
        } else {
            nodex_core_contracts::inbox::InboxReplyDispatch::Send
        };
        let intent = ProjectWorkspaceIntent::ReplyToPageTurn {
            page_id: page.into(),
            episode,
            body: "  Proceed unchanged.  ".into(),
            dispatch: Some(dispatch),
        };
        let first = apply_member(&w, &remote, "remote-reply", intent.clone()).unwrap();
        let replay = apply_member(&w, &remote, "remote-reply", intent.clone()).unwrap();
        assert_eq!(first.committed.commit_seq, replay.committed.commit_seq);
        let other = member(&w, "other-person");
        assert_eq!(
            apply_member(&w, &other, "remote-reply", intent)
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        let delivery = outbox(&w.module).remove(0);
        assert_eq!(
            delivery.final_text.as_deref(),
            Some("  Proceed unchanged.  ")
        );
        assert_eq!(delivery.question_response.is_some(), answer);
        let session = delivery.session_id.clone();
        let message = delivery.message_id.clone();
        let captured: String = w.kernel.readers().read_default(move |c| {
            Ok(c.query_row("SELECT member_id FROM session_requesting_members WHERE session_id=?1 AND message_id=?2", rusqlite::params![session, message], |r| r.get(0))?)
        }).expect("an accepted reply retains its authenticated requesting Member");
        assert_eq!(captured, "person");

        assert_eq!(count(&w, "SELECT count(*) FROM inbox_entries"), 0);
    }
}
#[test]
fn remote_members_start_and_accept_work_but_cannot_claim_host_or_agent_authority() {
    let w = seeded_workspace();
    let remote = member(&w, "person");
    let page = "019d0000-0000-7000-8000-000000000091";
    create_remote_page(&w, &remote, page);
    apply_member(
        &w,
        &remote,
        "remote-start",
        ProjectWorkspaceIntent::StartPageWork {
            page_id: page.into(),
            selection: Some(nodex_core_contracts::library::AgentWorkSelection {
                instance_id: "codex".into(),
                model: "gpt".into(),
                effort: None,
            }),
            session_id: format!("chat:{page}"),
            launch_id: format!("launch:{page}"),
            message_id: format!("message:{page}"),
            brief: "Work".into(),
            again: false,
            expected_readiness_epoch: None,
            expected_turn_episode: None,
        },
    )
    .unwrap();
    set_status_by_hand(&w, page, "review");
    let snapshot = w
        .module
        .read(
            &remote,
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::InboxWindow {
                    scope: project_scope(),
                    filter: ProjectWorkspaceInboxWindowFilter::Inbox,
                    window: CollectionWindowRequest {
                        first: Some(10),
                        ..Default::default()
                    },
                },
            },
        )
        .unwrap();
    let ProjectWorkspaceReadValue::InboxWindow { mut items } = snapshot.value else {
        panic!("Inbox")
    };
    let episode = items.items.remove(0).turn.unwrap().turn.episode;
    for intent in [
        ProjectWorkspaceIntent::WriteTurnNote {
            note_id: "note".into(),
            page_id: page.into(),
            event_ids: vec!["event".into()],
            body: "A note".into(),
            notify: true,
        },
        ProjectWorkspaceIntent::AnswerInboxQuestion {
            question_page_id: "question".into(),
            page_id: "answer".into(),
            document_id: "answer:doc".into(),
            body: "An answer".into(),
        },
        ProjectWorkspaceIntent::HandBackMessage {
            reason: "Wrong destination".into(),
            page_id: "return".into(),
            document_id: "return:document".into(),
            message: None,
        },
        ProjectWorkspaceIntent::SettlePageWorkLaunch {
            launch_id: format!("launch:{page}"),
            accepted_at: Some("today".into()),
            rejection: None,
        },
    ] {
        assert_eq!(
            apply_member(&w, &remote, "remote-forbidden", intent)
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
    }
    assert_eq!(
        apply_member(
            &w,
            &remote,
            "remote-stale",
            ProjectWorkspaceIntent::AcceptPageWork {
                page_id: page.into(),
                expected_turn_episode: Some("stale".into())
            }
        )
        .unwrap_err()
        .code,
        CoreErrorCode::Conflict
    );
    apply_member(
        &w,
        &remote,
        "remote-accept",
        ProjectWorkspaceIntent::AcceptPageWork {
            page_id: page.into(),
            expected_turn_episode: Some(episode),
        },
    )
    .unwrap();
    assert!(mixed(&w, project_scope(), None, 10).items.is_empty());
}

#[test]
fn revoked_or_expired_members_cannot_commit_a_mutation_already_waiting_for_the_writer() {
    for withdrawal in [
        "UPDATE member_devices SET revoked_at=unixepoch() WHERE id='bob-queued'",
        "UPDATE member_sessions SET expires_at=unixepoch()-1 WHERE id='bob-queued'",
    ] {
        queued_member_withdrawal(withdrawal);
    }
}

fn queued_member_withdrawal(withdrawal: &'static str) {
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };
    let w = seeded_workspace();
    let bob = member(&w, "bob-queued");
    let (entered, waiting) = mpsc::sync_channel(1);
    let (release, released) = mpsc::sync_channel(1);
    std::thread::scope(|scope| {
        let writer = w.kernel.writer();
        let blocker = scope.spawn(move || {
            writer
                .call(move |connection| {
                    entered.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(5)).unwrap();
                    // Revocation is serialized ahead of the already-admitted queued command.
                    connection.execute(withdrawal, [])?;
                    Ok(())
                })
                .unwrap()
        });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        let pending = scope.spawn(|| {
            apply_member(
                &w,
                &bob,
                "queued-after-revoke",
                ProjectWorkspaceIntent::SendInboxMessage {
                    page_id: "019d0000-0000-7000-8000-000000000099".into(),
                    document_id: "019d0000-0000-7000-8000-000000000098".into(),
                    body: "Must never commit".into(),
                    title: None,
                    project_id: None,
                    reply_to_page_id: None,
                    expected_store_epoch: None,
                },
            )
        });
        let until = Instant::now() + Duration::from_secs(5);
        while w.kernel.writer().queued_job_count() == 0 && Instant::now() < until {
            std::thread::yield_now();
        }
        let queued = w.kernel.writer().queued_job_count();
        release.send(()).unwrap();
        blocker.join().unwrap();
        assert_eq!(
            queued, 1,
            "Mutation must have reached the real writer queue"
        );
        let rejected = pending.join().unwrap().unwrap_err();
        assert_eq!(rejected.code, CoreErrorCode::Unauthorized);
        assert_eq!(
            rejected.recovery,
            nodex_core_contracts::CoreErrorRecovery::RenewRemoteSession
        );
    });
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM core_module_receipts WHERE operation_id='queued-after-revoke'"
        ),
        0
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM blocks WHERE id='019d0000-0000-7000-8000-000000000099'"
        ),
        0
    );
}

#[test]
fn a_member_starts_a_chat_from_the_inbox_and_the_host_keeps_delivery() {
    let w = seeded_workspace();
    let bob = member(&w, "bob");
    apply_member(
        &w,
        &bob,
        "bob:capture",
        ProjectWorkspaceIntent::SendInboxMessage {
            reply_to_page_id: None,
            expected_store_epoch: None,
            page_id: "page:bob-idea".into(),
            document_id: "document:bob-idea".into(),
            body: "Draft the release notes".into(),
            title: None,
            project_id: None,
        },
    )
    .unwrap();
    let start = |person: &BoundModuleContext, operation: &str, id: &str| {
        apply_member(
            &w,
            person,
            operation,
            ProjectWorkspaceIntent::DispatchInboxEntries {
                expected_store_epoch: "epoch-1".into(),
                basis: pages_basis(&w.module, vec!["page:bob-idea".into()]),
                execution_selection: Some(selection()),
                proposal_id: format!("proposal:{id}"),
                page_ids: vec!["page:bob-idea".into()],
                action: ProjectWorkspaceInboxDispatchAction::NewChat {
                    project_id: None,
                    prompt: "Draft the release notes".into(),
                    additions: vec![],
                    agent: None,
                },
                session_id: Some(format!("session:{id}")),
            },
        )
    };
    // Only a person's decision starts Agent work; other connections cannot.
    for adapter in [AdapterKind::NativeCli, AdapterKind::LoopbackHttp] {
        let caller = BoundModuleContext { adapter, ..host() };
        let refused = start(&caller, "other:start", "other").unwrap_err();
        assert_eq!(
            refused.code,
            nodex_core_contracts::CoreErrorCode::Unauthorized
        );
    }
    start(&bob, "bob:start", "bob").unwrap();

    let ProjectWorkspaceReadValue::InboxDispatchOutbox { dispatches } = read(
        &w.module,
        ProjectWorkspaceRead::InboxDispatchOutbox { limit: 16 },
    ) else {
        panic!("Expected the dispatch outbox")
    };
    assert_eq!(dispatches.len(), 1);
    assert_eq!(dispatches[0].session_id, "session:bob");
    let (requester, actor): (String, String) = w
        .kernel
        .readers()
        .read_default(|c| {
            Ok(c.query_row(
                "SELECT requester.member_id, json_extract(proposal.confirmed_actor_json,'$.member_id') \
                 FROM session_requesting_members requester, inbox_proposals proposal \
                 WHERE requester.session_id='session:bob' AND proposal.proposal_id='proposal:bob'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!((requester.as_str(), actor.as_str()), ("bob", "bob"));

    // Delivering the chat stays with the host's execution owner.
    let delivery = apply_member(
        &w,
        &bob,
        "bob:deliver",
        ProjectWorkspaceIntent::CompleteInboxDispatch {
            proposal_id: "proposal:bob".into(),
            expected_revision: dispatches[0].revision,
            message_id: dispatches[0].message_id.clone(),
            dispatched_thread_id: Some("thread:bob".into()),
        },
    )
    .unwrap_err();
    assert_eq!(
        delivery.code,
        nodex_core_contracts::CoreErrorCode::Unauthorized
    );
}
