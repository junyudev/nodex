//! Remote membership crosses the same Inbox transaction and receipt boundaries as local UI.
use super::*;
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
#[test]
fn remote_members_read_and_reply_to_turns_with_member_bound_receipts() {
    for answer in [false, true] {
        let w = seeded_workspace();
        let remote = member(&w, "person");
        let page = "019d0000-0000-7000-8000-000000000091";
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
        assert_eq!(count(&w, "SELECT count(*) FROM inbox_entries"), 0);
    }
}
#[test]
fn remote_members_start_and_accept_work_but_cannot_claim_host_or_agent_authority() {
    let w = seeded_workspace();
    let remote = member(&w, "person");
    let page = "019d0000-0000-7000-8000-000000000091";
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
