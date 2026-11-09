use super::*;
use nodex_core_contracts::inbox::{
    ChatMessageInbound, HandbackMessage, ProjectWorkspaceInboxSource,
};

fn managed(w: &TestWorkspace, id: &str) {
    runtime_session(&w.module, id, None, false);
    apply_host(
        &w.module,
        &format!("managed:{id}"),
        ProjectWorkspaceIntent::SetSessionManaged {
            session_id: id.into(),
            managed: true,
        },
    );
}
fn bind_message(w: &TestWorkspace, session: &str, id: &str, text: &str, count: u32) {
    apply_host(
        &w.module,
        &format!("delivery:{id}"),
        ProjectWorkspaceIntent::RecordChatDelivery {
            session_id: session.into(),
            delivery_id: id.into(),
            body_hash: crate::document::sha256(text.as_bytes()),
            author: ProjectWorkspaceInboxSource::User,
            attachment_count: count,
            question_answer_run_id: None,
        },
    );
    apply_host(
        &w.module,
        &format!("inbound:{id}"),
        ProjectWorkspaceIntent::BindChatInbound {
            session_id: session.into(),
            run_id: "run:test".into(),
            delivery_id: id.into(),
            body_hash: crate::document::sha256(text.as_bytes()),
            attachment_count: count,
            author: ProjectWorkspaceInboxSource::User,
        },
    );
}
fn current(w: &TestWorkspace, session: &str) -> ChatMessageInbound {
    let ProjectWorkspaceReadValue::ChatMessageInbound {
        inbound: Some(inbound),
    } = read_host(
        &w.module,
        ProjectWorkspaceRead::ChatMessageInbound {
            session_id: session.into(),
            run_id: "run:test".into(),
        },
    )
    else {
        panic!("inbound")
    };
    inbound
}
fn give_back(session: &str, page: &str, text: Option<&str>) -> ProjectWorkspaceIntent {
    agent_command(
        session,
        ProjectWorkspaceIntent::HandBackMessage {
            reason: "This belongs to the documentation chat.".into(),
            page_id: page.into(),
            document_id: format!("document:{page}"),
            message: text.map(|text| HandbackMessage {
                text: text.into(),
                files: vec![],
            }),
        },
    )
}
#[test]
fn handback_receipts_preserve_words_and_author_and_bound_rerouting_to_two_returns() {
    let w = seeded_workspace();
    for session in ["first", "second", "third"] {
        managed(&w, session);
    }
    let text = "Please fix only the README typo.";
    bind_message(&w, "first", "direct-message", text, 0);
    assert_eq!(
        apply_host_error(
            &w.module,
            "wrong-text",
            give_back("first", "not-created", Some("Changed words"))
        ),
        CoreErrorCode::Conflict
    );
    apply_host(
        &w.module,
        "first-return",
        give_back("first", "returned", Some(text)),
    );
    let receipt = current(&w, "first").receipt.unwrap();
    assert_eq!(receipt.page_ids, vec!["returned"]);
    let original = entry(&w.module, "returned");
    assert_eq!(original.body, text);
    assert_eq!(original.source, ProjectWorkspaceInboxSource::User);
    assert_eq!(original.handback.as_ref().unwrap().chat.session_id, "first");
    apply_host(
        &w.module,
        "retry-return",
        give_back("first", "unused", Some(text)),
    );
    assert_eq!(current(&w, "first").receipt.unwrap(), receipt);
    assert_eq!(count(&w, "SELECT count(*) FROM inbox_entries"), 1);
    for (index, session) in ["second", "third"].into_iter().enumerate() {
        dispatch(
            &w.module,
            &format!("reroute-{index}"),
            &["returned"],
            ProjectWorkspaceInboxDispatchAction::SendToChat {
                session_id: session.into(),
                prompt: "Read the original message".into(),
                additions: vec![],
            },
            None,
        );
        let work = outbox(&w.module)
            .into_iter()
            .find(|work| work.session_id == session)
            .unwrap();
        bind_message(
            &w,
            session,
            &work.message_id,
            work.final_text.as_deref().unwrap(),
            0,
        );
        if index == 1 {
            assert_eq!(
                apply_host_error(
                    &w.module,
                    "third-return",
                    give_back(session, "never-created", None)
                ),
                CoreErrorCode::Conflict
            );
            continue;
        }
        apply_host(
            &w.module,
            "second-return",
            give_back(session, "unused-again", None),
        );
        let returned = entry(&w.module, "returned");
        assert_eq!(returned.body, original.body);
        assert_eq!(returned.source, original.source);
        assert_eq!(returned.handback.unwrap().chat.session_id, "second");
    }
    assert_eq!(count(&w, "SELECT count(*) FROM chat_message_handbacks"), 2);
    assert_eq!(count(&w, "SELECT count(*) FROM inbox_entries"), 1);
    assert_eq!(
        crate::workspace::test_support::activity_rows(&w.module)
            .iter()
            .filter(|row| row.id.starts_with("handback:")
                && row.session_id.is_some()
                && row.reason.is_some())
            .count(),
        2
    );
}
#[test]
fn handback_preserves_original_page_images_without_granting_new_consent() {
    let w = seeded_workspace();
    managed(&w, "worker");
    crate::workspace::test_support::create_library_image(&w, "handback-image");
    send(
        &w.module,
        "image",
        "![Screenshot](nodex://files/handback-image)\n\nCheck this screenshot.",
    );
    let before = entry(&w.module, "page:image");
    dispatch(
        &w.module,
        "image-work",
        &["page:image"],
        ProjectWorkspaceInboxDispatchAction::SendToChat {
            session_id: "worker".into(),
            prompt: "Check the screenshot".into(),
            additions: vec![],
        },
        None,
    );
    let work = outbox(&w.module).remove(0);
    bind_message(
        &w,
        "worker",
        &work.message_id,
        work.final_text.as_deref().unwrap(),
        1,
    );
    apply_host(
        &w.module,
        "return-image",
        give_back("worker", "unused", None),
    );
    let after = entry(&w.module, "page:image");
    assert_eq!(after.body, before.body);
    assert_eq!(after.source, before.source);
    assert_eq!(after.basis, before.basis);
    assert_eq!(
        after.handback.unwrap().reason,
        "This belongs to the documentation chat."
    );
    grouped_request(&w.module, "route-returned", vec!["page:image".into()]);
    let request = requests(&w.module).remove(0);
    assert_eq!(
        apply_host_error(
            &w.module,
            "no-new-consent",
            ProjectWorkspaceIntent::SettleInboxSuggestion {
                automatic_dispatch: true,
                request_id: request.request_id.clone(),
                generation: request.generation,
                titles: vec![],
                suggestions: vec![ProjectWorkspaceInboxSuggestedDispatch {
                    explicit_request: true,
                    proposal_id: "auto-returned".into(),
                    page_ids: vec!["page:image".into()],
                    action: ProjectWorkspaceInboxDispatchAction::NewChat {
                        project_id: None,
                        prompt: "Continue".into(),
                        agent: None,
                        additions: vec![]
                    },
                    entry_kind: None,
                    summary: "Continue".into(),
                    rationale: None
                }],
                produced_by: None,
                error: None
            }
        ),
        CoreErrorCode::InvalidInput
    );
    // Nodex sees which chat returned the message, and that chat stays a destination: sending it
    // back is Nodex's judgement on the person's word, and it still waits for the person.
    let ProjectWorkspaceReadValue::InboxDispatchContext { context: source } = read_host(
        &w.module,
        ProjectWorkspaceRead::InboxDispatchContext {
            page_ids: vec!["page:image".into()],
        },
    ) else {
        panic!("routing context")
    };
    assert_eq!(
        source.entries[0].handback.as_ref().unwrap().chat.session_id,
        "worker"
    );
    assert!(
        source
            .sessions
            .iter()
            .any(|chat| chat.session_id == "worker")
    );
    apply_host(
        &w.module,
        "resend-returned",
        ProjectWorkspaceIntent::SettleInboxSuggestion {
            automatic_dispatch: true,
            request_id: request.request_id,
            generation: request.generation,
            titles: vec![],
            suggestions: vec![ProjectWorkspaceInboxSuggestedDispatch {
                explicit_request: false,
                proposal_id: "resend-returned".into(),
                page_ids: vec!["page:image".into()],
                action: ProjectWorkspaceInboxDispatchAction::SendToChat {
                    session_id: "worker".into(),
                    prompt: "The person wants this chat to finish it".into(),
                    additions: vec![],
                },
                entry_kind: None,
                summary: "Send back to the worker".into(),
                rationale: None,
            }],
            produced_by: None,
            error: None,
        },
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM inbox_proposals WHERE proposal_id='resend-returned' AND state='open' AND auto_confirm_pending=0"
        ),
        1
    );
}
#[test]
fn an_answered_question_and_an_unmanaged_caller_cannot_be_handed_back() {
    let w = seeded_workspace();
    managed(&w, "worker");
    bind_message(&w, "worker", "question", "Answer this question", 0);
    apply_host(
        &w.module,
        "answer-accepted",
        ProjectWorkspaceIntent::RecordChatDelivery {
            session_id: "worker".into(),
            delivery_id: "answer".into(),
            body_hash: crate::document::sha256(b"Yes"),
            author: ProjectWorkspaceInboxSource::User,
            attachment_count: 0,
            question_answer_run_id: Some("run:test".into()),
        },
    );
    assert!(current(&w, "worker").question_answered);
    assert_eq!(
        apply_host_error(
            &w.module,
            "cannot-unanswer",
            give_back("worker", "never", Some("Answer this question"))
        ),
        CoreErrorCode::Conflict
    );
    runtime_session(&w.module, "unmanaged", None, false);
    bind_message(&w, "unmanaged", "unmanaged-message", "A message", 0);
    assert_eq!(
        apply_host_error(
            &w.module,
            "cannot-unmanage",
            give_back("unmanaged", "never", Some("A message"))
        ),
        CoreErrorCode::Conflict
    );
    assert_eq!(count(&w, "SELECT count(*) FROM inbox_entries"), 0);
}
#[test]
fn direct_handback_publishes_attachments_with_the_message_atomically() {
    let w = seeded_workspace();
    managed(&w, "worker");
    crate::workspace::test_support::create_library_image(&w, "media-source");
    let bytes = b"image bytes for media-source";
    let hash = crate::document::sha256(bytes);
    let library = crate::library::LibraryModule::new("profile-1", "library-1", &w.kernel);
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    library
        .register_prepared_file_blob(
            &host(),
            "epoch-1",
            "publish-media",
            "media-receipt",
            &hash,
            &format!("{hash}.blob"),
            bytes.len() as u64,
            expires,
        )
        .unwrap();
    bind_message(&w, "worker", "with-media", "Check this image", 1);
    let message = HandbackMessage {
        text: "Check this image".into(),
        files: vec![nodex_core_contracts::library::LibraryFileChange::Create {
            file_id: "returned-media".into(),
            default_name: "screenshot.png".into(),
            mime_type: "image/png".into(),
            prepared_blob_receipt_id: "media-receipt".into(),
        }],
    };
    apply_host(
        &w.module,
        "publish-media",
        agent_command(
            "worker",
            ProjectWorkspaceIntent::HandBackMessage {
                reason: "Another chat owns this image.".into(),
                page_id: "returned-image".into(),
                document_id: "returned-image:document".into(),
                message: Some(message),
            },
        ),
    );
    let item = entry(&w.module, "returned-image");
    assert!(
        item.body
            .contains("![screenshot.png](nodex://files/returned-media)")
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM library_files WHERE file_id='returned-media'"
        ),
        1
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM block_asset_refs WHERE file_id='returned-media'"
        ),
        1
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM prepared_blob_receipts WHERE receipt_id='media-receipt' AND state='consumed'"
        ),
        1
    );
}

#[test]
fn handback_refuses_a_delivery_after_the_person_has_rerouted_its_message() {
    let w = seeded_workspace();
    managed(&w, "first");
    managed(&w, "second");
    send(&w.module, "task", "Check the release notes.");
    dispatch(
        &w.module,
        "first-target",
        &["page:task"],
        ProjectWorkspaceInboxDispatchAction::SendToChat {
            session_id: "first".into(),
            prompt: "Check".into(),
            additions: vec![],
        },
        None,
    );
    let work = outbox(&w.module).remove(0);
    bind_message(
        &w,
        "first",
        &work.message_id,
        work.final_text.as_deref().unwrap(),
        0,
    );
    apply_host(
        &w.module,
        "first-completed",
        ProjectWorkspaceIntent::CompleteInboxDispatch {
            proposal_id: work.proposal_id,
            expected_revision: work.revision,
            message_id: work.message_id,
            dispatched_thread_id: Some("thread:first".into()),
        },
    );
    apply_host(
        &w.module,
        "person-reopens",
        ProjectWorkspaceIntent::SetInboxEntryState {
            page_ids: vec!["page:task".into()],
            state: ProjectWorkspaceInboxEntryState::Open,
        },
    );
    dispatch(
        &w.module,
        "new-target",
        &["page:task"],
        ProjectWorkspaceInboxDispatchAction::SendToChat {
            session_id: "second".into(),
            prompt: "Check".into(),
            additions: vec![],
        },
        None,
    );
    assert_eq!(
        apply_host_error(
            &w.module,
            "old-chat-return",
            give_back("first", "unused", None)
        ),
        CoreErrorCode::Conflict
    );
    assert_eq!(count(&w, "SELECT count(*) FROM chat_message_handbacks"), 0);
}

#[test]
fn a_reply_can_be_returned_as_its_own_inbound_without_losing_answer_provenance() {
    let w = seeded_workspace();
    managed(&w, "worker");
    let text = "This request belongs to the other card.";
    apply_host(
        &w.module,
        "reply-delivery",
        ProjectWorkspaceIntent::RecordChatDelivery {
            session_id: "worker".into(),
            delivery_id: "reply".into(),
            body_hash: crate::document::sha256(text.as_bytes()),
            author: ProjectWorkspaceInboxSource::User,
            attachment_count: 0,
            question_answer_run_id: Some("run:question".into()),
        },
    );
    apply_host(
        &w.module,
        "reply-inbound",
        ProjectWorkspaceIntent::BindChatInbound {
            session_id: "worker".into(),
            run_id: "run:test".into(),
            delivery_id: "reply".into(),
            body_hash: crate::document::sha256(text.as_bytes()),
            author: ProjectWorkspaceInboxSource::User,
            attachment_count: 0,
        },
    );
    assert!(!current(&w, "worker").question_answered);
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM chat_message_deliveries WHERE delivery_id='reply' AND question_answer=1 AND answer_run_id='run:question'"
        ),
        1
    );
    apply_host(
        &w.module,
        "return-reply",
        give_back("worker", "returned-reply", Some(text)),
    );
    assert_eq!(current(&w, "worker").delivery_id, "reply");
    assert_eq!(
        current(&w, "worker").receipt.unwrap().page_ids,
        vec!["returned-reply"]
    );
}

#[test]
fn handback_is_fenced_by_an_answer_recorded_before_the_inbound_binding() {
    let w = seeded_workspace();
    managed(&w, "worker");
    apply_host(
        &w.module,
        "earlier-answer",
        ProjectWorkspaceIntent::RecordChatDelivery {
            session_id: "worker".into(),
            delivery_id: "answer-before-binding".into(),
            body_hash: crate::document::sha256(b"Yes"),
            author: ProjectWorkspaceInboxSource::User,
            attachment_count: 0,
            question_answer_run_id: Some("run:test".into()),
        },
    );
    bind_message(&w, "worker", "original-after-answer", "Question", 0);
    assert!(current(&w, "worker").question_answered);
    assert_eq!(
        apply_host_error(
            &w.module,
            "no-late-handback",
            give_back("worker", "never", Some("Question"))
        ),
        CoreErrorCode::Conflict
    );
}

#[test]
fn handback_rolls_back_all_files_and_intake_when_one_attachment_is_unavailable() {
    let w = seeded_workspace();
    managed(&w, "worker");
    crate::workspace::test_support::create_library_image(&w, "rollback-source");
    let hash = crate::document::sha256(b"image bytes for rollback-source");
    let library = crate::library::LibraryModule::new("profile-1", "library-1", &w.kernel);
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    library
        .register_prepared_file_blob(
            &host(),
            "epoch-1",
            "rollback-media",
            "rollback-receipt",
            &hash,
            &format!("{hash}.blob"),
            31,
            expires,
        )
        .unwrap();
    bind_message(&w, "worker", "two-images", "Compare these screenshots", 2);
    let files = [
        ("would-be-file", "rollback-receipt"),
        ("missing-file", "missing-receipt"),
    ]
    .into_iter()
    .map(
        |(file, receipt)| nodex_core_contracts::library::LibraryFileChange::Create {
            file_id: file.into(),
            default_name: "screenshot.png".into(),
            mime_type: "image/png".into(),
            prepared_blob_receipt_id: receipt.into(),
        },
    )
    .collect();
    apply_host_error(
        &w.module,
        "rollback-media",
        agent_command(
            "worker",
            ProjectWorkspaceIntent::HandBackMessage {
                reason: "Another chat owns these images.".into(),
                page_id: "never-published".into(),
                document_id: "never-published:document".into(),
                message: Some(HandbackMessage {
                    text: "Compare these screenshots".into(),
                    files,
                }),
            },
        ),
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM library_files WHERE file_id='would-be-file'"
        ),
        0
    );
    assert_eq!(count(&w, "SELECT count(*) FROM inbox_entries"), 0);
    assert_eq!(count(&w, "SELECT count(*) FROM chat_message_handbacks"), 0);
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM prepared_blob_receipts WHERE receipt_id='rollback-receipt' AND state='prepared'"
        ),
        1
    );
}

#[test]
fn handback_never_recreates_an_original_intake_message_the_person_erased() {
    let w = seeded_workspace();
    managed(&w, "worker");
    send(&w.module, "erase-me", "An original request.");
    dispatch(
        &w.module,
        "delivered-before-delete",
        &["page:erase-me"],
        ProjectWorkspaceInboxDispatchAction::SendToChat {
            session_id: "worker".into(),
            prompt: "Check this".into(),
            additions: vec![],
        },
        None,
    );
    let work = outbox(&w.module).remove(0);
    let text = work.final_text.as_deref().unwrap();
    bind_message(&w, "worker", &work.message_id, text, 0);
    apply_host(
        &w.module,
        "person-erases",
        ProjectWorkspaceIntent::DeleteInboxMessages {
            page_ids: vec!["page:erase-me".into()],
        },
    );
    assert_eq!(
        apply_host_error(
            &w.module,
            "cannot-resurrect",
            give_back("worker", "recreated", Some(text))
        ),
        CoreErrorCode::Conflict
    );
    assert_eq!(count(&w, "SELECT count(*) FROM inbox_entries"), 0);
    assert_eq!(count(&w, "SELECT count(*) FROM chat_message_handbacks"), 0);
}

#[test]
fn handback_refuses_a_group_when_one_original_message_was_erased() {
    let w = seeded_workspace();
    managed(&w, "worker");
    send(&w.module, "removed-member", "First request.");
    send(&w.module, "retained-member", "Second request.");
    dispatch(
        &w.module,
        "group-before-delete",
        &["page:removed-member", "page:retained-member"],
        ProjectWorkspaceInboxDispatchAction::SendToChat {
            session_id: "worker".into(),
            prompt: "Check these".into(),
            additions: vec![],
        },
        None,
    );
    let work = outbox(&w.module).remove(0);
    let text = work.final_text.as_deref().unwrap();
    bind_message(&w, "worker", &work.message_id, text, 0);
    apply_host(
        &w.module,
        "erase-one-member",
        ProjectWorkspaceIntent::DeleteInboxMessages {
            page_ids: vec!["page:removed-member".into()],
        },
    );
    assert_eq!(
        apply_host_error(
            &w.module,
            "cannot-return-partial-group",
            give_back("worker", "unused", None)
        ),
        CoreErrorCode::Conflict
    );
    assert_eq!(count(&w, "SELECT count(*) FROM chat_message_handbacks"), 0);
}

#[test]
fn handback_does_not_reopen_a_message_the_person_closed() {
    for state in [
        ProjectWorkspaceInboxEntryState::Done,
        ProjectWorkspaceInboxEntryState::Kept,
    ] {
        let w = seeded_workspace();
        managed(&w, "worker");
        send(&w.module, "closed", "Check this request.");
        dispatch(
            &w.module,
            "close-after-delivery",
            &["page:closed"],
            ProjectWorkspaceInboxDispatchAction::SendToChat {
                session_id: "worker".into(),
                prompt: "Check".into(),
                additions: vec![],
            },
            None,
        );
        let work = outbox(&w.module).remove(0);
        bind_message(
            &w,
            "worker",
            &work.message_id,
            work.final_text.as_deref().unwrap(),
            0,
        );
        apply_host(
            &w.module,
            "person-closes",
            ProjectWorkspaceIntent::SetInboxEntryState {
                page_ids: vec!["page:closed".into()],
                state,
            },
        );
        assert_eq!(
            apply_host_error(
                &w.module,
                "cannot-reopen-closed",
                give_back("worker", "unused", None)
            ),
            CoreErrorCode::Conflict
        );
        assert_eq!(count(&w, "SELECT count(*) FROM chat_message_handbacks"), 0);
    }
}
