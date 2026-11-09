use super::*;
use nodex_core_contracts::collection::CollectionWindowRequest;
fn origin() -> TestWorkspace {
    let w = setup();
    board(&w);
    card(&w, PAGE, "work", true);
    batch(&w, "origin-thread", thread(), vec![]);
    w.kernel
        .writer()
        .call(|c| {
            crate::workspace::thread_follows::add_follow(
                c,
                "library-1",
                PAGE,
                &thread(),
                "origin",
                "github_intake",
                "2026-11-06T01:00:00Z",
            )?;
            Ok(())
        })
        .unwrap();
    apply(
        &w.module,
        "coordinator",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            agent_selection: None,
            coordinator: true,
            side_chat_source_session_id: None,
            session_id: "nodex".into(),
            project_id: None,
            title: "Nodex".into(),
            initial_page_ids: vec![],
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread:nodex".into(),
            launch_request_id: "launch:nodex".into(),
        },
    );
    w
}
fn reply(w: &TestWorkspace, op: &str, body: &str) {
    let mut intent = agent(
        "nodex",
        command(SourceCommand::ReplyToOrigin {
            page_id: PAGE.into(),
            body: body.into(),
        }),
    );
    if let ProjectWorkspaceIntent::AgentCommand { provenance, .. } = &mut intent {
        provenance.authority.actor_project_id = None;
    }
    apply(&w.module, op, intent);
}
fn outbox(w: &TestWorkspace) -> Vec<ChannelOutboxItem> {
    let SourceReadValue::ChannelOutbox { items } = query(
        w,
        SourceRead::ChannelOutbox {
            include_terminal: true,
            after_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    items
}
fn claim_send(w: &TestWorkspace, id: &str, token: &str) {
    apply(
        &w.module,
        &format!("claim-send-{token}"),
        command(SourceCommand::ClaimChannelSend {
            id: id.into(),
            lease_token: token.into(),
            lease_duration_ms: 120000,
        }),
    );
}
fn settle(w: &TestWorkspace, id: &str, token: &str, success: bool, permanent: bool) {
    apply(
        &w.module,
        &format!("settle-{token}"),
        command(SourceCommand::SettleChannelSend {
            id: id.into(),
            lease_token: token.into(),
            receipt: success.then(|| ChannelReceipt {
                comment_id: "77".into(),
                url: "https://github.com/alice/repo/issues/1#issuecomment-77".into(),
            }),
            failure: (!success).then(|| "Lost access".into()),
            permanent,
            credential_invalid: false,
        }),
    );
}
fn problems(w: &TestWorkspace) -> Vec<SourceProblem> {
    let SourceReadValue::OpenProblems { problems } = query(
        w,
        SourceRead::OpenProblems {
            source_id: None,
            after_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    problems
}
fn activity(
    w: &TestWorkspace,
    filter: ActivityFilter,
    after: Option<String>,
    first: u32,
) -> nodex_core_contracts::collection::CollectionWindow<ActivityRow> {
    let ProjectWorkspaceReadValue::ActivityWindow { rows } = read(
        &w.module,
        ProjectWorkspaceRead::ActivityWindow {
            scope: ProjectWorkspaceInboxScope::All,
            filter,
            window: CollectionWindowRequest {
                after,
                first: Some(first),
            },
        },
    ) else {
        panic!()
    };
    rows
}
#[test]
fn channel_replies_dedupe_by_episode_and_body_and_preserve_thread_order_and_leases() {
    let w = origin();
    reply(&w, "reply-one", "Work has started.");
    reply(&w, "same-reply", "Work has started.");
    reply(&w, "reply-two", "The result is ready.");
    let items = outbox(&w);
    assert_eq!(items.len(), 2);
    assert_eq!(
        items.iter().map(|i| i.thread_order).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        items[0].body_hash,
        crate::document::sha256(b"Work has started.")
    );
    assert_eq!(items[0].marker, format!("<!-- nodex:{} -->", items[0].id));
    claim_send(&w, &items[0].id, "first");
    for id in [&items[0].id, &items[1].id] {
        assert!(
            w.module
                .apply(
                    &context(),
                    request(
                        &format!("compete-{id}"),
                        command(SourceCommand::ClaimChannelSend {
                            id: id.clone(),
                            lease_token: "other".into(),
                            lease_duration_ms: 1000
                        })
                    )
                )
                .is_err()
        );
    }
    let first = items[0].id.clone();
    w.kernel
        .writer()
        .call(move |c| {
            c.execute(
                "UPDATE channel_outbox SET lease_expires_at_ms=0 WHERE id=?1",
                [first],
            )?;
            Ok(())
        })
        .unwrap();
    claim_send(&w, &items[0].id, "recovery");
    assert!(
        w.module
            .apply(
                &context(),
                request(
                    "stale-lease",
                    command(SourceCommand::SettleChannelSend {
                        id: items[0].id.clone(),
                        lease_token: "first".into(),
                        receipt: Some(ChannelReceipt {
                            comment_id: "77".into(),
                            url: thread().url
                        }),
                        failure: None,
                        permanent: false,
                        credential_invalid: false
                    })
                )
            )
            .is_err()
    );
    settle(&w, &items[0].id, "recovery", true, false);
    claim_send(&w, &items[1].id, "second");
    assert_eq!(outbox(&w)[0].attempts, 2);
    assert_eq!(outbox(&w)[0].remote_comment_id.as_deref(), Some("77"));
}
#[test]
fn channel_permanent_failure_is_terminal_and_disabled_source_pauses_claiming() {
    let w = origin();
    reply(&w, "reply", "Work started.");
    let item = outbox(&w).remove(0);
    apply(
        &w.module,
        "disable",
        command(SourceCommand::ConfigureSource {
            source_id: "github".into(),
            expected_revision: 1,
            enabled: false,
            config: config(),
        }),
    );
    assert!(
        w.module
            .apply(
                &context(),
                request(
                    "disabled-send",
                    command(SourceCommand::ClaimChannelSend {
                        id: item.id.clone(),
                        lease_token: "no".into(),
                        lease_duration_ms: 1000
                    })
                )
            )
            .is_err()
    );
    apply(
        &w.module,
        "enable",
        command(SourceCommand::ConfigureSource {
            source_id: "github".into(),
            expected_revision: 2,
            enabled: true,
            config: config(),
        }),
    );
    claim_send(&w, &item.id, "permanent");
    settle(&w, &item.id, "permanent", false, true);
    assert_eq!(outbox(&w)[0].state, "dropped");
    assert!(problems(&w).is_empty());
    assert!(
        activity(&w, ActivityFilter::All, None, 100)
            .items
            .iter()
            .any(|r| r.description == "Could not reply on alice/repo #1")
    );
    assert!(
        w.module
            .apply(
                &context(),
                request(
                    "resend",
                    command(SourceCommand::ClaimChannelSend {
                        id: item.id,
                        lease_token: "never".into(),
                        lease_duration_ms: 1000
                    })
                )
            )
            .is_err()
    );
}
#[test]
fn recorded_emissions_are_suppressed_by_marker_and_receipt_without_suppressing_the_person() {
    let w = origin();
    reply(&w, "reply", "Started.");
    let item = outbox(&w).remove(0);
    let mut echoed = event(&w, "comment", "echo", SourceActorClass::Person);
    echoed.actor_login = "alice".into();
    echoed.text = Some(format!("Started.\n{}", item.marker));
    batch(&w, "echo", current_thread(&w), vec![echoed]);
    assert!(deliver_list(&w).is_empty());
    claim_send(&w, &item.id, "sent");
    settle(&w, &item.id, "sent", true, false);
    let mut edited = event(&w, "comment", "edited", SourceActorClass::Person);
    edited.text = Some("Marker removed".into());
    edited.metadata = json!({"comment_id":"77"});
    edited.url = "https://github.com/alice/repo/issues/1#changed-comment-address".into();
    batch(&w, "edited", current_thread(&w), vec![edited]);
    assert!(deliver_list(&w).is_empty());
    let mut personal = event(&w, "comment", "personal", SourceActorClass::Person);
    personal.actor_login = "alice".into();
    batch(&w, "personal", current_thread(&w), vec![personal]);
    assert_eq!(deliver_list(&w).len(), 1);
}
#[test]
fn channel_problem_opens_after_three_failures_retry_keeps_evidence_and_success_resolves() {
    let w = origin();
    reply(&w, "reply", "Started.");
    let item = outbox(&w).remove(0);
    for i in 0..3 {
        let token = format!("attempt-{i}");
        claim_send(&w, &item.id, &token);
        settle(&w, &item.id, &token, false, false);
        let id = item.id.clone();
        w.kernel
            .writer()
            .call(move |c| {
                c.execute("UPDATE channel_outbox SET retry_at_ms=0 WHERE id=?1", [id])?;
                Ok(())
            })
            .unwrap();
        assert_eq!(problems(&w).len(), usize::from(i == 2));
    }
    let p = problems(&w).remove(0);
    assert_eq!(p.kind, "channel_failing");
    assert_eq!(p.consecutive_failures, 3);
    apply(
        &w.module,
        "retry",
        command(SourceCommand::RetryProblem {
            problem_id: p.id.clone(),
        }),
    );
    assert_eq!(problems(&w).len(), 1);
    claim_send(&w, &item.id, "fixed");
    settle(&w, &item.id, "fixed", true, false);
    assert!(problems(&w).is_empty());
    let rows = activity(&w, ActivityFilter::Problems, None, 100).items;
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter()
            .any(|r| r.id == format!("problem-resolved:{}", p.id))
    );
}
#[test]
fn delivery_problem_retries_the_same_message_and_success_resolves_it() {
    let w = origin();
    batch(
        &w,
        "update",
        current_thread(&w),
        vec![event(&w, "comment", "delivery", SourceActorClass::Person)],
    );
    let delivery = deliver_list(&w).remove(0);
    apply(
        &w.module,
        "prepare",
        command(SourceCommand::PrepareThreadDeliveryBatch {
            message_id: "message:problem".into(),
            delivery_ids: vec![delivery.id],
            body: "GitHub update".into(),
        }),
    );
    for i in 0..3 {
        apply(
            &w.module,
            &format!("failed-{i}"),
            command(SourceCommand::RecordThreadDeliveryFailure {
                message_id: "message:problem".into(),
                reason: "Runtime unavailable".into(),
            }),
        );
    }
    let p = problems(&w).remove(0);
    assert_eq!(p.kind, "delivery_failing");
    assert_eq!(p.fix, ProblemFix::Retry);
    apply(
        &w.module,
        "retry",
        command(SourceCommand::RetryProblem { problem_id: p.id }),
    );
    apply(
        &w.module,
        "delivered",
        command(SourceCommand::SettleThreadDeliveryBatch {
            message_id: "message:problem".into(),
            accepted: true,
            receipt: "accepted".into(),
        }),
    );
    assert!(problems(&w).is_empty());
    assert_eq!(deliver_list(&w)[0].state, "accepted");
    assert!(
        activity(&w, ActivityFilter::All, None, 100)
            .items
            .iter()
            .any(|r| r.description == "Delivered @bob’s comment to “Work”"
                && r.session_id.as_deref() == Some("work"))
    );
}
#[test]
fn missing_chat_problem_shares_the_inbox_window_counts_and_resolves_on_work_selection() {
    let w = origin();
    apply(
        &w.module,
        "archive",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "work".into(),
            intent: ProjectSessionIntent::SetArchived { archived: true },
        },
    );
    batch(
        &w,
        "update",
        current_thread(&w),
        vec![event(&w, "comment", "orphan", SourceActorClass::Person)],
    );
    let p = problems(&w).remove(0);
    assert_eq!(p.kind, "delivery_unresolved");
    assert_eq!(p.fix, ProblemFix::OpenCard);
    let ProjectWorkspaceReadValue::InboxWindow { items } = read(
        &w.module,
        ProjectWorkspaceRead::InboxWindow {
            scope: ProjectWorkspaceInboxScope::All,
            filter: ProjectWorkspaceInboxWindowFilter::Inbox,
            window: CollectionWindowRequest {
                after: None,
                first: Some(100),
            },
        },
    ) else {
        panic!()
    };
    assert!(
        items
            .items
            .iter()
            .any(|r| r.row_kind == InboxRowKind::Problem
                && r.problem.as_ref().is_some_and(|problem| problem.id == p.id))
    );
    card_session(&w, "replacement");
    assert!(problems(&w).is_empty());
    let d = deliver_list(&w).remove(0);
    assert_eq!(d.state, "pending");
    assert_eq!(d.session_id.as_deref(), Some("replacement"));
}
fn card_session(w: &TestWorkspace, id: &str) {
    apply(
        &w.module,
        "new-work-chat",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            agent_selection: None,
            coordinator: false,
            side_chat_source_session_id: None,
            session_id: id.into(),
            project_id: Some("project:work".into()),
            title: "Replacement".into(),
            initial_page_ids: vec![PAGE.into()],
            runtime_id: "runtime".into(),
            runtime_thread_id: format!("thread:{id}"),
            launch_request_id: format!("launch:{id}"),
        },
    );
}
#[test]
fn activity_is_paginated_filtered_and_records_channel_and_trigger_facts() {
    let w = origin();
    reply(&w, "reply", "Work started.");
    let mut update = event(&w, "check", "event", SourceActorClass::Ci);
    update.url = "https://github.com/alice/repo/actions/runs/99".into();
    batch(&w, "update", current_thread(&w), vec![update]);
    let all = activity(&w, ActivityFilter::All, None, 100);
    let channel = all
        .items
        .iter()
        .find(|r| r.id.starts_with("channel:"))
        .unwrap();
    assert_eq!(channel.description, "Queued a reply on alice/repo #1");
    assert_eq!(
        channel.subject,
        Some(ActivitySubject::Thread {
            url: "https://github.com/alice/repo/issues/1".into(),
            label: "alice/repo #1".into()
        })
    );
    assert!(all.items.iter().any(|r| r.id.starts_with("trigger:")));
    let delivery = all
        .items
        .iter()
        .find(|r| r.id.starts_with("delivery:"))
        .unwrap();
    assert_eq!(
        delivery.url.as_deref(),
        Some("https://github.com/alice/repo/actions/runs/99")
    );
    assert_eq!(
        delivery.subject,
        Some(ActivitySubject::Thread {
            url: "https://github.com/alice/repo/issues/1".into(),
            label: "alice/repo #1".into()
        })
    );
    let first = activity(&w, ActivityFilter::All, None, 1);
    let second = activity(&w, ActivityFilter::All, first.next_cursor, 1);
    assert_ne!(first.items[0].id, second.items[0].id);
    let decisions = activity(&w, ActivityFilter::Decisions, None, 100);
    assert!(decisions.items.iter().all(|r| r.category == "decisions"));
    let first = activity(&w, ActivityFilter::All, None, 1);
    let wrong = ProjectWorkspaceRead::ActivityWindow {
        scope: ProjectWorkspaceInboxScope::Library,
        filter: ActivityFilter::All,
        window: CollectionWindowRequest {
            after: first.next_cursor,
            first: Some(1),
        },
    };
    assert!(
        w.module
            .read(
                &context(),
                nodex_core_contracts::ModuleReadRequest {
                    contract_version: nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: wrong
                }
            )
            .is_err()
    );
}

#[test]
fn credential_problem_opens_immediately_and_success_resolves_it() {
    let w = origin();
    apply(
        &w.module,
        "bad-credential",
        command(SourceCommand::RecordSourceFailure {
            source_id: "github".into(),
            config_revision: 1,
            partition: None,
            lease_token: None,
            problem_kind: "credential".into(),
            evidence: json!({"reason":"credential"}),
            retry_at_ms: 0,
        }),
    );
    let p = problems(&w).remove(0);
    assert_eq!(p.kind, "credential_invalid");
    assert_eq!(p.consecutive_failures, 1);
    assert_eq!(p.fix, ProblemFix::Reconnect);
    apply(
        &w.module,
        "reconnected",
        command(SourceCommand::RecordSourceSuccess {
            source_id: "github".into(),
            config_revision: 1,
            partition: None,
            lease_token: None,
        }),
    );
    assert!(problems(&w).is_empty());
    assert_eq!(
        activity(&w, ActivityFilter::Problems, None, 100)
            .items
            .len(),
        2
    );
}
