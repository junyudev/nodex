use super::*;

#[test]
fn routing_run_start_survives_reopen_and_never_resets_for_a_retry() {
    let w = seeded_workspace();
    let m = &w.module;
    send(m, "route", "Fix this");
    grouped_request(m, "request:route", vec!["page:route".into()]);
    admit_routing(m, "nodex", "request:route");
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
        decision_session_id: "nodex".into(),
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
                        decision_session_id: "nodex".into(),
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
    send(m, "route", "Fix this");
    grouped_request(m, "request:route", vec!["page:route".into()]);
    admit_routing(m, "nodex", "request:route");
    let refusal = |generation, recipient: &str, reason: &str| {
        ProjectWorkspaceIntent::RecordInboxRoutingRefusal {
            request_id: "request:route".into(),
            generation,
            decision_session_id: recipient.into(),
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

#[test]
fn proposals_require_the_bound_routing_run_and_record_it_in_activity() {
    let w = seeded_workspace();
    let m = &w.module;
    send(m, "route", "Keep this reference");
    grouped_request(m, "request:route", vec!["page:route".into()]);
    let request_data = requests(m).remove(0);
    admit_routing(m, "right", "request:route");
    routing_session(m, "other-request", "request:elsewhere", 1);
    routing_session(m, "other-generation", "request:route", 2);
    routing_session(m, "unassigned-run", "request:route", 1);

    for (i, caller) in [None, Some("other-request"), Some("other-generation"), Some("unassigned-run")].into_iter().enumerate() {
        let mut intent = keep_request(&request_data, None);
        let ProjectWorkspaceIntent::SettleInboxSuggestion { decision_session_id, .. } = &mut intent else { unreachable!() };
        *decision_session_id = caller.map(str::to_owned);
        let error = m.apply(&host(), request(&format!("unauthorized:{i}"), intent)).unwrap_err();
        assert_eq!(error.code, CoreErrorCode::Unauthorized);
    }
    let mut intent = keep_request(&request_data, None);
    let ProjectWorkspaceIntent::SettleInboxSuggestion { decision_session_id, .. } = &mut intent else { unreachable!() };
    *decision_session_id = Some("right".into());
    m.apply(&host(), request("settle", intent)).unwrap();
    let proposal = item(m, "page:route").proposal.unwrap();
    apply_host(m, "confirm", ProjectWorkspaceIntent::ConfirmInboxDispatch {
        skill_invocations: vec![], confirmed_by: nodex_core_contracts::inbox::InboxConfirmedBy::User,
        expected_store_epoch: "epoch-1".into(), basis: proposal.basis, execution_selection: None,
        proposal_id: proposal.proposal_id, expected_revision: proposal.revision, action: None, session_id: None,
    });
    let evidence = w.kernel.readers().read_default(|c| Ok(c.query_row(
        "SELECT json_extract(evidence_json,'$.decision_session_id') FROM activity_facts WHERE page_id='page:route' AND category='messages'",
        [], |row| row.get::<_, String>(0),
    )?)).unwrap();
    assert_eq!(evidence, "right");
}
