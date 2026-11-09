use super::test_support::*;
use nodex_core_contracts::{AdapterKind, CoreErrorCode, workspace::*};
const PAGE: &str = "019d0000-0000-7000-8000-000000000091";
fn setup() -> TestWorkspace {
    let w = seeded_workspace();
    create_project(&w.module, "project", "project:work");
    apply(
        &w.module,
        "page",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: PAGE.into(),
            document_id: "019d0000-0000-7000-8000-000000000092".into(),
            title: "Work".into(),
        },
    );
    w
}
fn holds(w: &TestWorkspace) -> Vec<ExecutionHold> {
    match read(
        &w.module,
        ProjectWorkspaceRead::EffectiveExecutionHold {
            target: ExecutionHoldTarget::Page {
                page_id: PAGE.into(),
            },
        },
    ) {
        ProjectWorkspaceReadValue::EffectiveExecutionHold { holds } => holds,
        _ => panic!("hold read"),
    }
}
#[test]
fn hold_union_replays_and_clearing_child_preserves_parent() {
    let w = setup();
    let page = ExecutionHoldScope::Page {
        page_id: PAGE.into(),
    };
    let project = ExecutionHoldScope::Project {
        project_id: "project:work".into(),
    };
    let first = w
        .module
        .apply(
            &context(),
            request(
                "pause-page",
                ProjectWorkspaceIntent::PauseWork {
                    scope: page.clone(),
                },
            ),
        )
        .unwrap();
    let original = holds(&w);
    assert_eq!(original.len(), 1);
    let retry = w
        .module
        .apply(
            &context(),
            request(
                "pause-page",
                ProjectWorkspaceIntent::PauseWork {
                    scope: page.clone(),
                },
            ),
        )
        .unwrap();
    assert!(retry.committed.receipt.mutation.duplicate);
    assert_eq!(first.committed.value, retry.committed.value);
    assert_eq!(original, holds(&w));
    apply(
        &w.module,
        "pause-again",
        ProjectWorkspaceIntent::PauseWork {
            scope: page.clone(),
        },
    );
    assert_eq!(original, holds(&w));
    apply(
        &w.module,
        "pause-project",
        ProjectWorkspaceIntent::PauseWork {
            scope: project.clone(),
        },
    );
    apply(
        &w.module,
        "pause-space",
        ProjectWorkspaceIntent::PauseWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    assert_eq!(holds(&w).len(), 3);
    apply(
        &w.module,
        "resume-page",
        ProjectWorkspaceIntent::ResumeWork { scope: page },
    );
    assert_eq!(holds(&w).len(), 2);
    apply(
        &w.module,
        "resume-project",
        ProjectWorkspaceIntent::ResumeWork { scope: project },
    );
    assert_eq!(holds(&w).len(), 1);
    apply(
        &w.module,
        "resume-space",
        ProjectWorkspaceIntent::ResumeWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    assert!(holds(&w).is_empty());
    let r = w
        .module
        .apply(
            &context(),
            request(
                "resume-space",
                ProjectWorkspaceIntent::ResumeWork {
                    scope: ExecutionHoldScope::Space,
                },
            ),
        )
        .unwrap();
    assert!(r.committed.receipt.mutation.duplicate);
}
#[test]
fn only_person_adapters_may_pause_or_resume() {
    let w = setup();
    for adapter in [AdapterKind::Agent, AdapterKind::LoopbackHttp] {
        let mut ctx = context();
        ctx.adapter = adapter;
        for intent in [
            ProjectWorkspaceIntent::PauseWork {
                scope: ExecutionHoldScope::Space,
            },
            ProjectWorkspaceIntent::ResumeWork {
                scope: ExecutionHoldScope::Space,
            },
        ] {
            assert_eq!(
                w.module
                    .apply(&ctx, request("denied", intent))
                    .unwrap_err()
                    .code,
                CoreErrorCode::Unauthorized
            );
        }
    }
    let mut ctx = context();
    ctx.adapter = AdapterKind::NativeCli;
    w.module
        .apply(
            &ctx,
            request(
                "cli",
                ProjectWorkspaceIntent::PauseWork {
                    scope: ExecutionHoldScope::Space,
                },
            ),
        )
        .unwrap();
    assert_eq!(holds(&w).len(), 1);
}

fn pending(w: &TestWorkspace) -> Vec<CoordinatorWorkEvent> {
    match read(
        &w.module,
        ProjectWorkspaceRead::ReadPendingWorkEvents { limit: 20 },
    ) {
        ProjectWorkspaceReadValue::ReadPendingWorkEvents { events } => events,
        _ => panic!("events"),
    }
}
fn batch(w: &TestWorkspace, id: &str, events: &[CoordinatorWorkEvent]) {
    apply(
        &w.module,
        &format!("batch:{id}"),
        ProjectWorkspaceIntent::CreateEventBatch {
            batch_id: id.into(),
            coordinator_session_id: "nodex".into(),
            event_ids: events.iter().map(|e| e.event_id.clone()).collect(),
            message_id: format!("message:{id}"),
            body: "Work events".into(),
            fingerprint: "a".repeat(64),
        },
    );
}
#[test]
fn pause_splits_frozen_batches_and_resume_delivers_pending_facts_once() {
    let w = setup();
    let other = "019d0000-0000-7000-8000-000000000093";
    create_library_page(&w, other, "project:work");
    apply(
        &w.module,
        "nodex",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            agent_selection: None,
            coordinator: false,
            session_id: "nodex".into(),
            project_id: None,
            title: "Nodex".into(),
            initial_page_ids: vec![],
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread:nodex".into(),
            launch_request_id: "launch:nodex".into(),
            side_chat_source_session_id: None,
        },
    );
    apply(
        &w.module,
        "bind",
        ProjectWorkspaceIntent::BindCoordinator {
            session_id: "nodex".into(),
        },
    );
    apply(
        &w.module,
        "facts",
        ProjectWorkspaceIntent::RecordWorkEvents {
            observed: vec![],
            events: [PAGE, other]
                .into_iter()
                .map(|page| CoordinatorWorkEventInput {
                    kind: CoordinatorWorkEventKind::Report,
                    session_id: None,
                    page_id: Some(page.into()),
                    payload: serde_json::json!({"outcome":"ready"}),
                    dedupe_key: page.into(),
                })
                .collect(),
        },
    );
    batch(&w, "mixed", &pending(&w));
    apply(
        &w.module,
        "pause",
        ProjectWorkspaceIntent::PauseWork {
            scope: ExecutionHoldScope::Page {
                page_id: PAGE.into(),
            },
        },
    );
    let ProjectWorkspaceReadValue::ReadEventBatch {
        batch: Some(frozen),
    } = read(
        &w.module,
        ProjectWorkspaceRead::ReadEventBatch {
            batch_id: "mixed".into(),
        },
    )
    else {
        panic!("batch")
    };
    assert!(frozen.invalidated_at.is_some());
    apply(
        &w.module,
        "discard",
        ProjectWorkspaceIntent::DiscardEventBatch {
            batch_id: "mixed".into(),
        },
    );
    let eligible = pending(&w);
    assert_eq!(eligible.len(), 1);
    assert_eq!(eligible[0].page_id.as_deref(), Some(other));
    batch(&w, "free", &eligible);
    apply(
        &w.module,
        "settle-free",
        ProjectWorkspaceIntent::SettleEventBatch {
            batch_id: "free".into(),
            accepted_at: "2026-11-05T00:00:00.000Z".into(),
        },
    );
    assert!(pending(&w).is_empty());
    // Reopening the policy read uses the persisted hold, not any process cache.
    assert_eq!(holds(&w).len(), 1);
    apply(
        &w.module,
        "resume",
        ProjectWorkspaceIntent::ResumeWork {
            scope: ExecutionHoldScope::Page {
                page_id: PAGE.into(),
            },
        },
    );
    let retained = pending(&w);
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].page_id.as_deref(), Some(PAGE));
    batch(&w, "resumed", &retained);
    apply(
        &w.module,
        "settle-resumed",
        ProjectWorkspaceIntent::SettleEventBatch {
            batch_id: "resumed".into(),
            accepted_at: "2026-11-05T00:00:00.000Z".into(),
        },
    );
    assert!(pending(&w).is_empty());
}

#[test]
fn session_only_facts_follow_active_work_and_space_holds_include_projectless_nodex() {
    let w = setup();
    apply(
        &w.module,
        "start",
        ProjectWorkspaceIntent::StartPageWork {
            page_id: PAGE.into(),
            selection: Some(nodex_core_contracts::library::AgentWorkSelection {
                instance_id: "codex".into(),
                model: "test".into(),
                effort: None,
            }),
            session_id: "work".into(),
            launch_id: "launch".into(),
            message_id: "message".into(),
            brief: "Work".into(),
            again: false,
            expected_readiness_epoch: None,
            expected_turn_episode: None,
        },
    );
    apply(
        &w.module,
        "pause",
        ProjectWorkspaceIntent::PauseWork {
            scope: ExecutionHoldScope::Page {
                page_id: PAGE.into(),
            },
        },
    );
    apply(
        &w.module,
        "session-fact",
        ProjectWorkspaceIntent::RecordWorkEvents {
            observed: vec![],
            events: vec![CoordinatorWorkEventInput {
                kind: CoordinatorWorkEventKind::Attention,
                session_id: Some("work".into()),
                page_id: None,
                payload: serde_json::json!({}),
                dedupe_key: "session-fact".into(),
            }],
        },
    );
    assert!(pending(&w).is_empty());
    let ProjectWorkspaceReadValue::EffectiveExecutionHold { holds } = read(
        &w.module,
        ProjectWorkspaceRead::EffectiveExecutionHold {
            target: ExecutionHoldTarget::Session {
                session_id: "work".into(),
            },
        },
    ) else {
        panic!("holds")
    };
    assert_eq!(holds.len(), 1);
    let ProjectWorkspaceReadValue::HeldSessionWindow { session_ids } = read(
        &w.module,
        ProjectWorkspaceRead::HeldSessionWindow {
            after_session_id: None,
            limit: 100,
        },
    ) else {
        panic!("sessions")
    };
    assert!(session_ids.contains(&"work".into()));
    apply(
        &w.module,
        "nodex",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            agent_selection: None,
            coordinator: false,
            session_id: "nodex".into(),
            project_id: None,
            title: "Nodex".into(),
            initial_page_ids: vec![],
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread:nodex".into(),
            launch_request_id: "launch:nodex".into(),
            side_chat_source_session_id: None,
        },
    );
    apply(
        &w.module,
        "space",
        ProjectWorkspaceIntent::PauseWork {
            scope: ExecutionHoldScope::Space,
        },
    );
    let ProjectWorkspaceReadValue::EffectiveExecutionHold { holds } = read(
        &w.module,
        ProjectWorkspaceRead::EffectiveExecutionHold {
            target: ExecutionHoldTarget::Session {
                session_id: "nodex".into(),
            },
        },
    ) else {
        panic!("holds")
    };
    assert_eq!(holds.len(), 1);
}
