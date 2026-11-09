use super::*;

#[test]
fn routing_run_start_survives_reopen_and_never_resets_for_a_retry() {
    let w = seeded_workspace();
    let m = &w.module;
    runtime_session(m, "nodex", None, true);
    send(m, "route", "Fix this");
    grouped_request(m, "request:route", vec!["page:route".into()]);
    apply_host(
        m,
        "begin",
        ProjectWorkspaceIntent::BeginInboxRouting {
            request_id: "request:route".into(),
            generation: 1,
            coordinator_session_id: "nodex".into(),
        },
    );
    assert!(
        requests(m)[0]
            .delivery
            .as_ref()
            .unwrap()
            .run_started_at_ms
            .is_none()
    );
    let start = |at| ProjectWorkspaceIntent::StartInboxRoutingRun {
        request_id: "request:route".into(),
        generation: 1,
        coordinator_session_id: "nodex".into(),
        run_started_at_ms: at,
    };
    apply_host(m, "start", start(123_000));
    apply_host(m, "reobserve", start(456_000));
    let reopened = reopen_inbox_workspace(w);
    assert_eq!(
        requests(&reopened.module)[0]
            .delivery
            .as_ref()
            .unwrap()
            .run_started_at_ms,
        Some(123_000)
    );
    assert!(
        reopened
            .module
            .apply(
                &host(),
                request(
                    "wrong-generation",
                    ProjectWorkspaceIntent::StartInboxRoutingRun {
                        request_id: "request:route".into(),
                        generation: 2,
                        coordinator_session_id: "nodex".into(),
                        run_started_at_ms: 999_000
                    }
                )
            )
            .is_err()
    );
}

#[test]
fn routing_refusal_survives_reopen_and_is_fenced_to_the_pending_delivery() {
    let w = seeded_workspace();
    let m = &w.module;
    runtime_session(m, "nodex", None, true);
    send(m, "route", "Fix this");
    grouped_request(m, "request:route", vec!["page:route".into()]);
    apply_host(
        m,
        "begin",
        ProjectWorkspaceIntent::BeginInboxRouting {
            request_id: "request:route".into(),
            generation: 1,
            coordinator_session_id: "nodex".into(),
        },
    );
    let refusal = |generation, recipient: &str, reason: &str| {
        ProjectWorkspaceIntent::RecordInboxRoutingRefusal {
            request_id: "request:route".into(),
            generation,
            coordinator_session_id: recipient.into(),
            reason: reason.into(),
        }
    };
    apply_host(
        m,
        "refusal",
        refusal(1, "nodex", "an Agent, model or effort was not offered"),
    );
    for (operation, intent) in [
        ("wrong-generation", refusal(2, "nodex", "wrong")),
        ("wrong-recipient", refusal(1, "another", "wrong")),
        ("unbounded", refusal(1, "nodex", &"x".repeat(2049))),
    ] {
        assert!(m.apply(&host(), request(operation, intent)).is_err());
    }
    let reopened = reopen_inbox_workspace(w);
    let delivery = requests(&reopened.module)[0].delivery.clone().unwrap();
    assert_eq!(
        delivery.last_refusal.as_deref(),
        Some("an Agent, model or effort was not offered")
    );
    assert!(delivery.run_started_at_ms.is_none());
}
