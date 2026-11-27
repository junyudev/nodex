use super::{RemoteAdmission, authorize};
use crate::agent::AgentTurnProvenance;
use crate::automation::{AutomationIntent, AutomationRead};
use crate::library::{LibraryRead, MemberRole};
use crate::workspace::{ProjectWorkspaceIntent as Intent, ProjectWorkspaceRead as Read};
use crate::{
    AdapterKind, BoundModuleContext, CoreErrorCode, LibraryId, ProfileId, RemotePrincipal,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn remote(role: MemberRole) -> BoundModuleContext {
    BoundModuleContext {
        actor: crate::Actor::Service {
            kind: crate::ServiceKind::Maintenance,
        },
        authorizing_member_id: None,
        profile_id: ProfileId("profile".into()),
        library_id: LibraryId("space".into()),
        project_id: None,
        connection_id: "connection".into(),
        adapter: AdapterKind::RemoteMember,
        principal: Some(RemotePrincipal {
            space_id: "space".into(),
            member_id: "person".into(),
            device_id: "device".into(),
            session_id: "session".into(),
            role,
        }),
        agent_attribution: None,
        editor_history_owner: None,
    }
}

fn decode<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{value}: {error}"))
}

fn admitted<T: RemoteAdmission + std::fmt::Debug>(context: &BoundModuleContext, commands: &[T]) {
    for command in commands {
        assert!(authorize(context, command).is_ok(), "{command:?}");
    }
}

fn refused<T: RemoteAdmission + std::fmt::Debug>(context: &BoundModuleContext, commands: &[T]) {
    for command in commands {
        assert_eq!(
            authorize(context, command).unwrap_err().code,
            CoreErrorCode::Unauthorized,
            "{command:?}"
        );
    }
}

fn provenance() -> AgentTurnProvenance {
    decode(json!({
        "profile_id":"profile",
        "authority":{
            "thread_id":"thread", "turn_id":"turn", "root_thread_id":"thread",
            "library_id":"space", "store_epoch":"epoch"
        }
    }))
}

#[test]
fn commenters_can_participate_in_discussions_without_document_write_access() {
    use crate::discussions::DiscussionCommand;
    use crate::document::OwnedDocumentIntent;
    use crate::library::LibraryIntent;

    let context = remote(MemberRole::Commenter);
    admitted(
        &context,
        &[LibraryRead::Discussion {
            provenance: None,
            discussion_id: "discussion".into(),
        }],
    );
    admitted(
        &context,
        &[LibraryIntent::Discussion {
            command: Box::new(DiscussionCommand::Resolve {
                discussion_id: "discussion".into(),
            }),
            authorization: None,
        }],
    );
    refused(
        &context,
        &[OwnedDocumentIntent::PrepareOwner {
            owner_block_id: "page".into(),
        }],
    );
}

#[test]
fn admission_requires_a_principal_for_the_bound_space_only_on_remote_adapters() {
    let command = Read::Thread {
        thread_id: "thread".into(),
    };
    let mut context = remote(MemberRole::Member);
    context.principal = None;
    for adapter in [
        AdapterKind::ElectronHost,
        AdapterKind::LoopbackHttp,
        AdapterKind::NativeCli,
        AdapterKind::Agent,
        AdapterKind::Test,
    ] {
        context.adapter = adapter;
        admitted(&context, std::slice::from_ref(&command));
    }

    context.adapter = AdapterKind::RemoteMember;
    let command = Read::Session {
        session_id: "chat".into(),
    };
    refused(&context, std::slice::from_ref(&command));

    context = remote(MemberRole::Member);
    context.principal.as_mut().unwrap().space_id = "foreign".into();
    refused(&context, std::slice::from_ref(&command));
}

#[test]
fn members_can_resolve_logical_execution_bindings_without_agent_or_filesystem_authority() {
    let context = remote(MemberRole::Member);
    admitted::<Read>(
        &context,
        &[
            decode(json!({"kind":"agent_runtime_session_binding","session_id":"chat"})),
            decode(
                json!({"kind":"agent_runtime_session_binding_by_execution","runtime_id":"runtime","runtime_thread_id":"thread"}),
            ),
            decode(
                json!({"kind":"agent_runtime_session_binding_window","runtime_id":"runtime","scope":{"kind":"all"},"window":{}}),
            ),
            decode(json!({"kind":"session_work_page","session_id":"chat"})),
        ],
    );
    refused(
        &context,
        &[
            Read::AgentAuthority {
                provenance: provenance(),
            },
            Read::SessionExecutionObserver {
                session_id: "chat".into(),
            },
        ],
    );
    refused(
        &context,
        &[AutomationRead::AutomationExecutionAdmission {
            run_id: "run".into(),
            lease_id: "lease".into(),
            dispatch_id: "dispatch".into(),
        }],
    );
}

#[test]
fn members_can_read_session_details_without_thread_or_agent_access() {
    let context = remote(MemberRole::Member);
    admitted(
        &context,
        &[
            Read::Session {
                session_id: "chat".into(),
            },
            Read::SessionDetail {
                session_id: "chat".into(),
            },
            Read::SessionSideChats {
                source_session_id: "chat".into(),
                window: Default::default(),
            },
        ],
    );
    refused(
        &context,
        &[
            Read::Thread {
                thread_id: "thread".into(),
            },
            Read::AgentSession {
                provenance: provenance(),
                session_id: "chat".into(),
            },
        ],
    );
}

#[test]
fn members_can_batch_chat_lanes() {
    let context = remote(MemberRole::Member);
    admitted::<Read>(
        &context,
        &[
            decode(json!({"kind":"task_window","window":{}})),
            decode(json!({"kind":"task_windows","lanes":[{"window":{}},{"window":{}}]})),
        ],
    );
}

#[test]
fn chat_changes_reach_core_while_host_bookkeeping_stays_local() {
    let context = remote(MemberRole::Member);
    let session = |intent: Value| -> Intent {
        decode(json!({"kind":"mutate_session","session_id":"chat","intent":intent}))
    };
    // Core's writer decides whether this Member may change the chat itself.
    admitted(
        &context,
        &[
            session(json!({"kind":"rename","title":"Renamed"})),
            session(json!({"kind":"set_archived","archived":true})),
            session(json!({"kind":"set_unread","unread":true})),
            session(json!({"kind":"set_pinned","pinned":true})),
            session(json!({"kind":"set_snooze","snoozed_until":null})),
            session(json!({"kind":"record_attention","seen":true})),
            session(json!({"kind":"record_user_message","message_id":"message"})),
            decode(json!({"kind":"move_session","session_id":"chat","project_id":"project"})),
            decode(
                json!({"kind":"place_session","session_id":"chat","placement":{"kind":"before","session_id":"other"}}),
            ),
            decode(
                json!({"kind":"ensure_default_draft_session","session_id":"draft","title":"New chat"}),
            ),
            decode(json!({"kind":"settle_idle_sessions","idle_before_ms":1})),
        ],
    );
    refused(
        &context,
        &[
            session(json!({"kind":"set_fallback_title","title":"Generated"})),
            session(json!({"kind":"link_thread","thread_id":"thread"})),
            session(json!({"kind":"unlink_thread","thread_id":"thread"})),
            session(
                json!({"kind":"consume_snooze","member_id":"person","snoozed_until":"2026-01-01T00:00:00Z","deliver":true}),
            ),
            session(
                json!({"kind":"complete_snooze_delivery","delivery_id":"delivery","unread":true}),
            ),
        ],
    );
}

#[test]
fn person_launch_and_review_cannot_claim_decision_authority() {
    let launch = |decision_run: Value, side_chat: Option<&str>| -> Intent {
        decode(json!({
            "kind":"create_agent_runtime_session", "session_id":"chat", "title":"New chat",
            "initial_page_ids":[], "runtime_id":"runtime", "runtime_thread_id":"thread",
            "launch_request_id":"launch", "decision_run":decision_run,
            "side_chat_source_session_id":side_chat
        }))
    };
    let confirmation = |confirmed_by: Option<&str>| -> Intent {
        let mut value = json!({
            "kind":"confirm_inbox_dispatch", "expected_store_epoch":"epoch",
            "basis":[], "proposal_id":"proposal", "expected_revision":1
        });
        if let Some(confirmed_by) = confirmed_by {
            value["confirmed_by"] = json!(confirmed_by);
        }
        decode(value)
    };

    for role in [MemberRole::Member, MemberRole::Owner] {
        let context = remote(role);
        admitted(
            &context,
            &[
                launch(Value::Null, None),
                launch(Value::Null, Some("other-chat")),
                confirmation(Some("user")),
                confirmation(None),
            ],
        );
        refused(
            &context,
            &[
                launch(
                    json!({"kind":"routing","request_id":"request","generation":1}),
                    None,
                ),
                confirmation(Some("nodex")),
            ],
        );
    }
}

#[test]
fn remote_inbox_admission_keeps_person_actions_separate_from_host_and_agent_commands() {
    let delivery = |author: Value| -> Intent {
        decode(json!({
            "kind":"record_chat_delivery", "author":author, "session_id":"chat",
            "delivery_id":"delivery", "body_hash":"hash", "attachment_count":0
        }))
    };
    for role in [MemberRole::Member, MemberRole::Owner] {
        let context = remote(role);
        admitted(
            &context,
            &[
                delivery(json!({"kind":"user"})),
                decode(json!({"kind":"stop_inbox_suggestion","page_id":"page"})),
                decode(
                    json!({"kind":"reply_to_page_turn","page_id":"page","episode":"episode","body":"Reply"}),
                ),
                decode(json!({"kind":"accept_page_work","page_id":"page"})),
                decode(json!({
                    "kind":"start_page_work", "page_id":"page", "session_id":"chat", "launch_id":"launch",
                    "message_id":"message", "brief":"Work", "again":false
                })),
                decode(
                    json!({"kind":"claim_turn_notification","page_id":"page","episode":"episode"}),
                ),
                decode(
                    json!({"kind":"set_inbox_routing_consent","start_my_requests":true,"initialize_only":false}),
                ),
            ],
        );
        admitted::<Read>(
            &context,
            &[
                decode(
                    json!({"kind":"inbox_window","scope":{"kind":"library"},"filter":"inbox","window":{}}),
                ),
                decode(json!({"kind":"inbox_entry","page_id":"page"})),
                decode(json!({"kind":"inbox_message","page_id":"page"})),
                decode(json!({"kind":"inbox_dispatch_context","page_ids":["page"]})),
                decode(json!({"kind":"inbox_summary","scope":{"kind":"library"}})),
                Read::InboxCounts,
                Read::InboxTurnNotifications,
            ],
        );
        refused(
            &context,
            &[
                delivery(json!({"kind":"agent","label":"Agent"})),
                decode(
                    json!({"kind":"hand_back_message","reason":"Blocked","page_id":"page","document_id":"document"}),
                ),
                decode(json!({
                    "kind":"bind_chat_inbound","session_id":"chat","run_id":"run","delivery_id":"delivery",
                    "body_hash":"hash","attachment_count":0,"author":{"kind":"user"}
                })),
                decode(json!({
                    "kind":"answer_inbox_question","request_id":"request","generation":1,
                    "question_page_id":"question","page_id":"page","document_id":"document","body":"Answer"
                })),
                decode(json!({"kind":"settle_page_work_launch","launch_id":"launch"})),
                Intent::AgentCommand {
                    provenance: Box::new(provenance()),
                    intent: Box::new(Intent::AcceptPageWork {
                        page_id: "page".into(),
                        expected_turn_episode: None,
                    }),
                },
            ],
        );
        refused(
            &context,
            &[Read::ChatMessageInbound {
                session_id: "chat".into(),
                run_id: "run".into(),
            }],
        );
    }

    // Unknown commands and deliveries without an author cannot reach admission.
    for value in [
        json!({"kind":"future_inbox_command"}),
        json!({
            "kind":"record_chat_delivery", "session_id":"chat", "delivery_id":"delivery",
            "body_hash":"hash", "attachment_count":0
        }),
    ] {
        assert!(serde_json::from_value::<Intent>(value).is_err());
    }
}

#[test]
fn remote_people_can_reply_to_origin_and_only_hosts_can_deliver() {
    let source = |command: Value| -> Intent { decode(json!({"kind":"source","command":command})) };
    for role in [MemberRole::Member, MemberRole::Owner] {
        let context = remote(role);
        admitted::<Read>(
            &context,
            &[decode(
                json!({"kind":"activity_window","scope":{"kind":"library"},"filter":"all","window":{}}),
            )],
        );
        admitted(
            &context,
            &[
                source(json!({"kind":"retry_problem","problem_id":"problem"})),
                source(json!({"kind":"reply_to_origin","page_id":"page","body":"Reply"})),
            ],
        );
        refused(
            &context,
            &[
                source(
                    json!({"kind":"claim_channel_send","id":"send","lease_token":"lease","lease_duration_ms":1000}),
                ),
                source(json!({
                    "kind":"settle_channel_send", "id":"send","lease_token":"lease",
                    "permanent":false,"credential_invalid":false
                })),
                source(
                    json!({"kind":"record_thread_delivery_failure","message_id":"message","reason":"Failed"}),
                ),
            ],
        );
        refused::<Read>(
            &context,
            &[decode(
                json!({"kind":"sources","read":{"kind":"channel_outbox","limit":10}}),
            )],
        );
    }
}

#[test]
fn only_hosts_can_read_and_claim_inbox_snooze_notifications_for_push() {
    let context = remote(MemberRole::Member);
    let claim = |for_push| Intent::ClaimInboxSnoozeNotification {
        id: "snooze".into(),
        for_push,
    };
    admitted(
        &context,
        &[Read::InboxSnoozeNotifications { for_push: false }],
    );
    refused(
        &context,
        &[Read::InboxSnoozeNotifications { for_push: true }],
    );
    admitted(&context, &[claim(false)]);
    refused(&context, &[claim(true)]);
}

#[test]
fn remote_automation_access_preserves_source_reads_without_granting_producer_authority() {
    let automation = json!({
        "name":"Daily brief","kind":"cron","trigger":{"kind":"clock","rrule":"FREQ=DAILY"}
    });
    for role in [MemberRole::Member, MemberRole::Owner] {
        let context = remote(role);
        admitted::<AutomationRead>(
            &context,
            &[
                decode(json!({"kind":"automations","window":{}})),
                decode(json!({"kind":"automation","automation_id":"automation"})),
                decode(
                    json!({"kind":"automation_decisions","automation_id":"automation","window":{}}),
                ),
                decode(json!({"kind":"runs","window":{}})),
            ],
        );
        // The Automation writer checks its exact Owner and current mode after admission.
        admitted::<AutomationIntent>(
            &context,
            &[
                decode(
                    json!({"kind":"create_automation","automation_id":"automation","automation":automation}),
                ),
                decode(json!({
                    "kind":"update_automation","automation_id":"automation","automation":automation,
                    "expected_revision":1,"status":"ACTIVE"
                })),
                decode(
                    json!({"kind":"delete_automation","automation_id":"automation","expected_revision":1}),
                ),
                decode(
                    json!({"kind":"set_automation_status","automation_id":"automation","expected_revision":1,"status":"PAUSED"}),
                ),
                AutomationIntent::DispatchNow {
                    automation_id: "automation".into(),
                },
            ],
        );
        let sources = |read: Value| -> Read { decode(json!({"kind":"sources","read":read})) };
        admitted(
            &context,
            &[
                sources(json!({"kind":"sources","limit":10})),
                sources(json!({"kind":"page_follows","page_id":"page","limit":10})),
                sources(json!({"kind":"deliveries","limit":10})),
                sources(json!({"kind":"open_problems","limit":10})),
            ],
        );
        refused::<AutomationIntent>(
            &context,
            &[
                decode(
                    json!({"kind":"claim_due","work_token":"token","limit":1,"lease_duration_ms":1000}),
                ),
                decode(json!({"kind":"begin_run","run_id":"run","automation_id":"automation"})),
                decode(json!({"kind":"complete_lease","lease_id":"lease"})),
                decode(
                    json!({"kind":"reschedule_automation","automation_id":"automation","expected_revision":1}),
                ),
                AutomationIntent::AgentCommand {
                    provenance: Box::new(provenance()),
                    intent: Box::new(AutomationIntent::DispatchNow {
                        automation_id: "automation".into(),
                    }),
                },
            ],
        );
    }
}

#[test]
fn members_can_reconcile_structural_edits_and_plan_block_transfers() {
    let context = remote(MemberRole::Member);
    admitted(
        &context,
        &[
            LibraryRead::StructuralHistoryStates { tokens: vec![] },
            decode(json!({
                "kind":"block_transfer_presentation_plan","operation_id":"operation",
                "store_epoch":"epoch","intent":{
                    "mode":"move","root_block_ids":["root"],"causal_dependencies":[],
                    "source":{"kind":"page","page_id":"source"},
                    "target":{"kind":"library","library_id":"space"},"promotion_policy":"literal"
                }
            })),
        ],
    );
}
