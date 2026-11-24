use super::ProjectWorkspaceModule;
use super::test_support::{
    apply, context, create_session_thread, local_member, read, request, seeded_workspace,
};
use nodex_core_contracts::workspace::{
    ProjectSessionIntent, ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
};

fn mutate(
    module: &ProjectWorkspaceModule,
    operation: &str,
    session: &str,
    intent: ProjectSessionIntent,
) {
    apply(
        module,
        operation,
        ProjectWorkspaceIntent::MutateSession {
            session_id: session.into(),
            intent,
        },
    );
}
fn session(
    module: &ProjectWorkspaceModule,
    id: &str,
) -> nodex_core_contracts::workspace::ProjectWorkspaceSessionSummary {
    let ProjectWorkspaceReadValue::Session { session } = read(
        module,
        ProjectWorkspaceRead::Session {
            session_id: id.into(),
        },
    ) else {
        panic!("Session response")
    };
    session
}
fn snooze(module: &ProjectWorkspaceModule, operation: &str, id: &str, value: &str) {
    mutate(
        module,
        operation,
        id,
        ProjectSessionIntent::SetSnooze {
            snoozed_until: Some(value.into()),
        },
    );
}

#[test]
fn snooze_validates_normalizes_replaces_clears_and_replays() {
    let w = seeded_workspace();
    create_session_thread(&w.module, "create", "chat", "thread", None, 1);
    snooze(&w.module, "set", "chat", "2020-01-01T10:00:00+01:00");
    assert_eq!(
        session(&w.module, "chat").snoozed_until.as_deref(),
        Some("2020-01-01T09:00:00.000Z")
    );
    snooze(&w.module, "replace", "chat", "2020-01-02T00:00:00Z");
    snooze(&w.module, "set", "chat", "2020-01-01T10:00:00+01:00");
    assert_eq!(
        session(&w.module, "chat").snoozed_until.as_deref(),
        Some("2020-01-02T00:00:00.000Z")
    );
    for (index, bad) in ["tomorrow", "2026-01-01T00:00:00", "2099-01-01T00:00:00Z"]
        .iter()
        .enumerate()
    {
        assert!(
            w.module
                .apply(
                    &context(),
                    request(
                        &format!("invalid-{index}"),
                        ProjectWorkspaceIntent::MutateSession {
                            session_id: "chat".into(),
                            intent: ProjectSessionIntent::SetSnooze {
                                snoozed_until: Some((*bad).into())
                            },
                        }
                    )
                )
                .is_err()
        );
    }
    let allowed = (chrono::Utc::now() + chrono::Duration::days(366) - chrono::Duration::seconds(2))
        .to_rfc3339();
    snooze(&w.module, "max-allowed", "chat", &allowed);
    let rejected =
        (chrono::Utc::now() + chrono::Duration::days(366) + chrono::Duration::seconds(2))
            .to_rfc3339();
    assert!(
        w.module
            .apply(
                &context(),
                request(
                    "too-late",
                    ProjectWorkspaceIntent::MutateSession {
                        session_id: "chat".into(),
                        intent: ProjectSessionIntent::SetSnooze {
                            snoozed_until: Some(rejected)
                        },
                    }
                )
            )
            .is_err()
    );
    mutate(
        &w.module,
        "clear",
        "chat",
        ProjectSessionIntent::SetSnooze {
            snoozed_until: None,
        },
    );
    assert_eq!(session(&w.module, "chat").snoozed_until, None);
}

#[test]
fn only_first_due_exact_value_claim_wins_even_after_reopening_core() {
    let w = seeded_workspace();
    create_session_thread(&w.module, "create", "chat", "thread", None, 1);
    snooze(&w.module, "set", "chat", "2020-01-01T00:00:00Z");
    let claim = |owner: &ProjectWorkspaceModule, operation: &str, value: &str| {
        owner
            .apply(
                &context(),
                request(
                    operation,
                    ProjectWorkspaceIntent::MutateSession {
                        session_id: "chat".into(),
                        intent: ProjectSessionIntent::ConsumeSnooze {
                            member_id: local_member(&w),
                            snoozed_until: value.into(),
                            deliver: false,
                        },
                    },
                ),
            )
            .unwrap()
            .committed
            .value
            .affected_session_ids
    };
    assert!(claim(&w.module, "old-value", "2019-01-01T00:00:00.000Z").is_empty());
    assert_eq!(
        claim(&w.module, "claim", "2020-01-01T00:00:00.000Z"),
        vec!["chat"]
    );
    let restarted = ProjectWorkspaceModule::new("profile-1", "library-1", &w.kernel).unwrap();
    assert!(
        claim(
            &restarted,
            "claim-after-restart",
            "2020-01-01T00:00:00.000Z"
        )
        .is_empty()
    );
    snooze(&restarted, "reschedule", "chat", "2020-01-02T00:00:00Z");
    assert!(claim(&restarted, "stale-claim", "2020-01-01T00:00:00.000Z").is_empty());
    assert_eq!(
        session(&restarted, "chat").snoozed_until.as_deref(),
        Some("2020-01-02T00:00:00.000Z")
    );
    let future = (chrono::Utc::now() + chrono::Duration::hours(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    snooze(&restarted, "future", "chat", &future);
    assert!(claim(&restarted, "early-claim", &future).is_empty());
}

#[test]
fn opening_and_agent_activity_preserve_snoozes_while_user_sends_and_archive_cancel() {
    let w = seeded_workspace();
    create_session_thread(&w.module, "create", "chat", "thread", None, 1);
    snooze(&w.module, "set", "chat", "2020-01-01T00:00:00Z");
    mutate(
        &w.module,
        "read",
        "chat",
        ProjectSessionIntent::SetUnread { unread: false },
    );
    mutate(
        &w.module,
        "open",
        "chat",
        ProjectSessionIntent::RecordOpened,
    );
    mutate(
        &w.module,
        "agent-complete",
        "chat",
        ProjectSessionIntent::SetUnread { unread: true },
    );
    assert!(session(&w.module, "chat").snoozed_until.is_some());
    mutate(
        &w.module,
        "user-message",
        "chat",
        ProjectSessionIntent::RecordUserMessage {
            message_id: "message".into(),
        },
    );
    assert_eq!(session(&w.module, "chat").snoozed_until, None);
    snooze(&w.module, "reschedule", "chat", "2020-01-02T00:00:00Z");
    mutate(
        &w.module,
        "user-message-replayed-with-new-operation",
        "chat",
        ProjectSessionIntent::RecordUserMessage {
            message_id: "message".into(),
        },
    );
    assert!(session(&w.module, "chat").snoozed_until.is_some());
    mutate(
        &w.module,
        "archive",
        "chat",
        ProjectSessionIntent::SetArchived { archived: true },
    );
    mutate(
        &w.module,
        "late-unread-after-archive",
        "chat",
        ProjectSessionIntent::SetUnread { unread: true },
    );
    assert!(!session(&w.module, "chat").unread);
    mutate(
        &w.module,
        "restore",
        "chat",
        ProjectSessionIntent::SetArchived { archived: false },
    );
    assert_eq!(session(&w.module, "chat").snoozed_until, None);
    // A fork gets a fresh Session and execution binding; organization state is never copied.
    create_session_thread(&w.module, "fork", "fork", "fork-thread", None, 1);
    assert_eq!(session(&w.module, "fork").snoozed_until, None);
}

#[test]
fn earliest_snooze_and_session_windows_share_canonical_state() {
    let w = seeded_workspace();
    for id in ["one", "two"] {
        create_session_thread(&w.module, id, id, &format!("thread-{id}"), None, 1);
    }
    snooze(&w.module, "later", "one", "2020-02-01T00:00:00Z");
    snooze(&w.module, "sooner", "two", "2020-01-01T00:00:00Z");
    let ProjectWorkspaceReadValue::NextSessionSnooze {
        session: Some(next),
        ..
    } = read(&w.module, ProjectWorkspaceRead::NextSessionSnooze)
    else {
        panic!("next snooze")
    };
    assert_eq!(next.id, "two");
    mutate(
        &w.module,
        "archive-earliest",
        "two",
        ProjectSessionIntent::SetArchived { archived: true },
    );
    let ProjectWorkspaceReadValue::NextSessionSnooze {
        session: Some(next),
        ..
    } = read(&w.module, ProjectWorkspaceRead::NextSessionSnooze)
    else {
        panic!("next snooze")
    };
    assert_eq!(next.id, "one");
}

#[test]
fn claimed_delivery_survives_restart_and_settles_once_or_is_cancelled() {
    let w = seeded_workspace();
    create_session_thread(&w.module, "create", "chat", "thread", None, 1);
    snooze(&w.module, "set", "chat", "2020-01-01T00:00:00Z");
    mutate(
        &w.module,
        "claim-delivery",
        "chat",
        ProjectSessionIntent::ConsumeSnooze {
            member_id: local_member(&w),
            snoozed_until: "2020-01-01T00:00:00.000Z".into(),
            deliver: true,
        },
    );
    assert_eq!(session(&w.module, "chat").snoozed_until, None);
    let restarted = ProjectWorkspaceModule::new("profile-1", "library-1", &w.kernel).unwrap();
    let ProjectWorkspaceReadValue::NextSessionSnooze {
        delivery: Some(delivery),
        ..
    } = read(&restarted, ProjectWorkspaceRead::NextSessionSnooze)
    else {
        panic!("unfinished delivery")
    };
    assert_eq!(delivery.delivery_id, "claim-delivery");
    let complete = |operation: &str, delivery_id: &str| {
        restarted
            .apply(
                &context(),
                request(
                    operation,
                    ProjectWorkspaceIntent::MutateSession {
                        session_id: "chat".into(),
                        intent: ProjectSessionIntent::CompleteSnoozeDelivery {
                            delivery_id: delivery_id.into(),
                            unread: false,
                        },
                    },
                ),
            )
            .unwrap()
            .committed
            .value
            .affected_session_ids
    };
    assert_eq!(complete("complete", &delivery.delivery_id), vec!["chat"]);
    assert!(complete("duplicate", &delivery.delivery_id).is_empty());
    snooze(&restarted, "again", "chat", "2020-01-01T00:00:00Z");
    mutate(
        &restarted,
        "claim-again",
        "chat",
        ProjectSessionIntent::ConsumeSnooze {
            member_id: local_member(&w),
            snoozed_until: "2020-01-01T00:00:00.000Z".into(),
            deliver: true,
        },
    );
    snooze(
        &restarted,
        "replace-pending",
        "chat",
        "2020-01-02T00:00:00Z",
    );
    assert!(complete("stale-completion", "claim-again").is_empty());
    mutate(
        &restarted,
        "claim-replacement",
        "chat",
        ProjectSessionIntent::ConsumeSnooze {
            member_id: local_member(&w),
            snoozed_until: "2020-01-02T00:00:00.000Z".into(),
            deliver: true,
        },
    );
    mutate(
        &restarted,
        "user-cancels-pending",
        "chat",
        ProjectSessionIntent::RecordUserMessage {
            message_id: "came-back".into(),
        },
    );
    assert!(complete("cancelled-completion", "claim-replacement").is_empty());
    assert!(matches!(
        read(&restarted, ProjectWorkspaceRead::NextSessionSnooze),
        ProjectWorkspaceReadValue::NextSessionSnooze {
            session: None,
            delivery: None,
            ..
        }
    ));
}

#[test]
fn native_queue_acceptance_cancels_atomically_and_retains_agent_provenance() {
    use std::collections::BTreeMap;
    let w = seeded_workspace();
    create_session_thread(&w.module, "create", "chat", "thread", None, 1);
    let queue = |operation: &str, message_id: &str, prompt: &str| {
        apply(
            &w.module,
            operation,
            ProjectWorkspaceIntent::SetQueuedMessageState {
                state: BTreeMap::from([(
                    "thread".into(),
                    vec![serde_json::json!({"id":message_id,"context":{"prompt":prompt}})],
                )]),
            },
        )
    };
    snooze(&w.module, "set", "chat", "2020-01-01T00:00:00Z");
    queue(
        "agent-queue",
        "agent-message",
        "<codex_delegation><source_thread_id>agent</source_thread_id><input>Update</input></codex_delegation>",
    );
    assert!(session(&w.module, "chat").snoozed_until.is_some());
    apply(
        &w.module,
        "agent-capture-with-attachments",
        ProjectWorkspaceIntent::SetQueuedMessageState {
            state: BTreeMap::from([(
                "thread".into(),
                vec![
                    serde_json::json!({ "id":"agent-capture", "context": { "prompt":"Tool message with file context", "turnTrigger":"agent_message" } }),
                ],
            )]),
        },
    );
    assert!(session(&w.module, "chat").snoozed_until.is_some());
    queue("person-queue", "person-message", "Continue later");
    assert_eq!(session(&w.module, "chat").snoozed_until, None);
    snooze(&w.module, "new-snooze", "chat", "2020-01-02T00:00:00Z");
    queue(
        "edit-existing",
        "person-message",
        "Continue with the updated details",
    );
    assert!(session(&w.module, "chat").snoozed_until.is_some());
}

#[test]
fn person_messages_and_due_snoozes_bring_a_chat_back_but_agent_activity_does_not() {
    let w = seeded_workspace();
    create_session_thread(&w.module, "create", "chat", "thread", None, 1);
    let pause = || std::thread::sleep(std::time::Duration::from_millis(5));
    let activity = || session(&w.module, "chat").activity_at;
    let created = activity();
    pause();
    mutate(
        &w.module,
        "agent-complete",
        "chat",
        ProjectSessionIntent::SetUnread { unread: true },
    );
    snooze(&w.module, "set", "chat", "2020-01-01T00:00:00Z");
    assert_eq!(activity(), created);
    mutate(
        &w.module,
        "user-message",
        "chat",
        ProjectSessionIntent::RecordUserMessage {
            message_id: "message".into(),
        },
    );
    let sent = activity();
    assert!(sent > created);
    pause();
    mutate(
        &w.module,
        "user-message-replayed",
        "chat",
        ProjectSessionIntent::RecordUserMessage {
            message_id: "message".into(),
        },
    );
    assert_eq!(activity(), sent);
    snooze(&w.module, "due", "chat", "2020-01-02T00:00:00Z");
    assert_eq!(activity(), sent);
    mutate(
        &w.module,
        "claim",
        "chat",
        ProjectSessionIntent::ConsumeSnooze {
            member_id: local_member(&w),
            snoozed_until: "2020-01-02T00:00:00.000Z".into(),
            deliver: false,
        },
    );
    assert!(activity() > sent);
}

#[test]
fn a_snooze_defers_the_current_ask_and_only_a_new_ask_wakes_it() {
    let w = seeded_workspace();
    create_session_thread(&w.module, "create", "chat", "thread", None, 1);
    w.kernel.writer().call(|c| {
        c.execute("UPDATE codex_threads SET status_type='active',status_active_flags_json='[\"waitingOnUserInput\"]' WHERE thread_id='thread'", [])?;
        Ok(())
    }).unwrap();
    let attention = |op, asked_at| {
        mutate(
            &w.module,
            op,
            "chat",
            ProjectSessionIntent::RecordAttention {
                seen: true,
                asked_at,
            },
        )
    };
    let pin = |op| {
        mutate(
            &w.module,
            op,
            "chat",
            ProjectSessionIntent::SetPinned { pinned: true },
        )
    };
    pin("pin-first");
    snooze(&w.module, "defer", "chat", "2020-01-01T00:00:00Z");
    let deferred = session(&w.module, "chat");
    let set_at = deferred.snoozed_at.expect("snooze set time");
    assert!(!deferred.pinned);
    attention("completion", None);
    attention("same-ask", Some(set_at));
    assert_eq!(
        session(&w.module, "chat").snoozed_until,
        deferred.snoozed_until
    );
    attention("new-ask", Some(set_at + 1));
    assert!(session(&w.module, "chat").snoozed_at.is_none());
    assert!(session(&w.module, "chat").woke_at.is_none());
    snooze(&w.module, "again", "chat", "2020-01-01T00:00:00Z");
    pin("wake-by-pin");
    let pinned = session(&w.module, "chat");
    assert!(pinned.pinned);
    assert!(pinned.snoozed_at.is_none());
    assert!(pinned.woke_at.is_none());
}

#[test]
fn a_due_wake_lasts_until_seen_messaged_settled_or_snoozed_again() {
    let w = seeded_workspace();
    let member = local_member(&w);
    for id in ["seen", "message", "settle", "resnooze"] {
        create_session_thread(
            &w.module,
            &format!("create-{id}"),
            id,
            &format!("thread-{id}"),
            None,
            1,
        );
        snooze(
            &w.module,
            &format!("snooze-{id}"),
            id,
            "2020-01-01T00:00:00Z",
        );
        mutate(
            &w.module,
            &format!("due-{id}"),
            id,
            ProjectSessionIntent::ConsumeSnooze {
                member_id: member.clone(),
                snoozed_until: "2020-01-01T00:00:00.000Z".into(),
                deliver: true,
            },
        );
        assert!(session(&w.module, id).woke_at.is_some());
        assert!(session(&w.module, id).snoozed_at.is_none());
    }
    mutate(
        &w.module,
        "seen",
        "seen",
        ProjectSessionIntent::SetUnread { unread: false },
    );
    mutate(
        &w.module,
        "send",
        "message",
        ProjectSessionIntent::RecordUserMessage {
            message_id: "sent".into(),
        },
    );
    apply(
        &w.module,
        "settle",
        ProjectWorkspaceIntent::SetSessionsSettled {
            session_ids: vec!["settle".into()],
            settled: true,
        },
    );
    snooze(&w.module, "resnooze", "resnooze", "2020-01-01T00:00:00Z");
    for id in ["seen", "message", "settle", "resnooze"] {
        assert!(session(&w.module, id).woke_at.is_none(), "{id}");
    }
}
