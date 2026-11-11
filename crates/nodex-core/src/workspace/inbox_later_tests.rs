use super::*;
use nodex_core_contracts::CoreErrorRecovery;
use nodex_core_contracts::inbox::InboxConfirmedBy;
use nodex_core_contracts::sources::ActivityFilter;

const FUTURE: &str = "2099-01-01T00:00:00Z";
const PAST: &str = "2001-01-02T00:00:00.000000000Z";

fn later(pages: &[&str], until: &str) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::SetInboxLater {
        page_ids: pages.iter().map(|id| (*id).into()).collect(),
        until: until.into(),
    }
}

fn clear(page: &str) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::ClearInboxLater {
        page_ids: vec![page.into()],
    }
}

fn publish_due() -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::PublishDueInboxLater {
        wake_at: PAST.into(),
    }
}

fn past_deferrals(w: &TestWorkspace) {
    w.kernel
        .writer()
        .call(|c| {
            c.execute("UPDATE inbox_deferrals SET until_at=?1", [PAST])?;
            Ok(())
        })
        .unwrap();
}

fn intake(m: &ProjectWorkspaceModule, page: &str) -> ProjectWorkspaceInboxItem {
    let ProjectWorkspaceReadValue::InboxEntry { item: Some(item) } = read_host(
        m,
        ProjectWorkspaceRead::InboxEntry {
            page_id: page.into(),
        },
    ) else {
        panic!("Missing intake {page}")
    };
    *item
}

#[test]
fn later_window_orders_replaces_and_pages_within_its_scope() {
    let workspace = seeded_workspace();
    let m = &workspace.module;
    for name in ["early", "late", "last"] {
        send_to(m, name, name, Some(PROJECT));
    }
    send(m, "unscoped", "Only in the Library");
    apply_host(m, "later-unscoped", later(&["page:unscoped"], FUTURE));
    apply_host(
        m,
        "later-early",
        later(&["page:early"], "2099-01-01T10:00:00+08:00"),
    );
    apply_host(m, "later-late", later(&["page:late"], FUTURE));
    apply_host(
        m,
        "later-replace",
        later(&["page:late"], "2099-01-01T03:00:00Z"),
    );
    apply_host(
        m,
        "later-last",
        later(&["page:last"], "2099-01-01T04:00:00Z"),
    );

    let read = |scope, after| ProjectWorkspaceRead::InboxWindow {
        scope,
        filter: ProjectWorkspaceInboxWindowFilter::Later,
        window: CollectionWindowRequest {
            first: Some(2),
            after,
        },
    };
    let ProjectWorkspaceReadValue::InboxWindow { items } =
        read_host(m, read(project_scope(), None))
    else {
        panic!("Later window")
    };
    assert_eq!(
        items
            .items
            .iter()
            .map(|item| item.page_id.as_str())
            .collect::<Vec<_>>(),
        ["page:early", "page:late"]
    );
    assert_eq!(
        items.items[0].later.as_ref().unwrap().until,
        "2099-01-01T02:00:00.000000000Z"
    );
    assert_eq!(
        items.items[1].later.as_ref().unwrap().until,
        "2099-01-01T03:00:00.000000000Z"
    );
    let cursor = items.next_cursor.unwrap();
    let ProjectWorkspaceReadValue::InboxWindow { items } =
        read_host(m, read(project_scope(), Some(cursor.clone())))
    else {
        panic!("Later continuation")
    };
    assert_eq!(items.items[0].page_id, "page:last");
    assert!(items.next_cursor.is_none());
    assert!(
        m.read(
            &host(),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: read(ProjectWorkspaceInboxScope::All, Some(cursor)),
            }
        )
        .is_err()
    );
    let summary = summary_in(m, project_scope());
    assert_eq!(
        (
            summary.entry_count,
            summary.inbox_count,
            summary.later_count
        ),
        (0, 0, 3)
    );
    assert!(
        window_in(
            m,
            project_scope(),
            ProjectWorkspaceInboxWindowFilter::Processed
        )
        .is_empty()
    );
    assert!(activity_in(m, project_scope(), ActivityFilter::Messages).is_empty());
    apply_host(m, "clear-later", clear("page:early"));
    assert!(intake(m, "page:early").later.is_none());
    assert_eq!(summary_in(m, project_scope()).inbox_count, 1);
}

#[test]
fn membership_and_order_follow_the_deadline_without_a_due_write() {
    let workspace = seeded_workspace();
    let m = &workspace.module;
    send_to(m, "timed", "Renew the certificate", Some(PROJECT));
    send_to(m, "other", "Another message", Some(PROJECT));
    apply_host(
        m,
        "important",
        ProjectWorkspaceIntent::SetInboxEntryImportant {
            page_id: "page:timed".into(),
            important: true,
        },
    );
    let until = chrono::Utc::now() + chrono::TimeDelta::seconds(2);
    let deadline = until.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    apply_host(m, "later-timed", later(&["page:timed"], &deadline));
    let before = summary_in(m, project_scope());
    assert_eq!(
        (
            before.inbox_count,
            before.later_count,
            before.important_count
        ),
        (1, 1, 0)
    );
    assert!(before.important.is_empty());
    assert_eq!(
        status_of(&workspace, "page:timed").as_deref(),
        Some("triage")
    );
    let ProjectWorkspaceReadValue::InboxCounts { counts } =
        read_host(m, ProjectWorkspaceRead::InboxCounts)
    else {
        panic!("Inbox counts")
    };
    assert_eq!(counts.projects[0].inbox_count, 1);
    // The read clock uses milliseconds. Wait past the first millisecond after the deadline.
    let remaining = (until - chrono::Utc::now()).to_std().unwrap_or_default();
    std::thread::sleep(remaining + std::time::Duration::from_millis(5));

    let stream = window_in(m, project_scope(), ProjectWorkspaceInboxWindowFilter::Inbox);
    assert_eq!(stream[0].page_id, "page:timed");
    assert!(stream[0].waiting);
    assert_eq!(stream[0].later.as_ref().unwrap().until, deadline);
    assert!(stream[0].important);
    let after = summary_in(m, project_scope());
    assert_eq!(
        (after.inbox_count, after.later_count, after.important_count),
        (2, 0, 1)
    );
    assert_eq!(after.important[0].page_id, "page:timed");
    let ProjectWorkspaceReadValue::InboxCounts { counts } =
        read_host(m, ProjectWorkspaceRead::InboxCounts)
    else {
        panic!("Inbox counts")
    };
    assert_eq!(counts.projects[0].inbox_count, 2);
    assert_eq!(
        count(&workspace, "SELECT count(*) FROM inbox_later_notifications"),
        0
    );
    assert!(activity_in(m, project_scope(), ActivityFilter::Messages).is_empty());
    keep(m, "page:timed");
    assert!(intake(m, "page:timed").later.is_none());
}

#[test]
fn due_intents_are_claimed_once_and_suppressed_for_terminal_or_handled_pages() {
    let workspace = seeded_workspace();
    let m = &workspace.module;
    for name in [
        "timed", "done", "canceled", "handled", "cleared", "archived", "erased",
    ] {
        send_to(m, name, name, Some(PROJECT));
    }
    apply_host(
        m,
        "defer-all",
        later(
            &[
                "page:timed",
                "page:done",
                "page:canceled",
                "page:handled",
                "page:cleared",
                "page:archived",
                "page:erased",
            ],
            FUTURE,
        ),
    );
    set_status_by_hand(&workspace, "page:done", "done");
    set_status_by_hand(&workspace, "page:canceled", "canceled");
    keep(m, "page:handled");
    change_message_lifecycle(&workspace, "page:archived", "archive");
    apply_host(
        m,
        "erase",
        ProjectWorkspaceIntent::DeleteInboxMessages {
            page_ids: vec!["page:erased".into()],
        },
    );
    apply_host(m, "clear", clear("page:cleared"));
    past_deferrals(&workspace);
    apply_host(m, "due", publish_due());
    apply_host(m, "due", publish_due());
    apply_host(m, "due-again", publish_due());
    let ProjectWorkspaceReadValue::NextInboxLater { remind_at } =
        read_host(m, ProjectWorkspaceRead::NextInboxLater)
    else {
        panic!("next reminder")
    };
    assert!(remind_at.is_none());
    set_status_by_hand(&workspace, "page:done", "triage");
    set_status_by_hand(&workspace, "page:canceled", "triage");
    change_message_lifecycle(&workspace, "page:archived", "unarchive");
    apply_host(m, "due-after-reopening", publish_due());
    for for_push in [false, true] {
        let ProjectWorkspaceReadValue::InboxLaterNotifications { intents } = read_host(
            m,
            ProjectWorkspaceRead::InboxLaterNotifications { for_push },
        ) else {
            panic!("notification intents")
        };
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].page_id, "page:timed");
        let claim = ProjectWorkspaceIntent::ClaimInboxLaterNotification {
            id: intents[0].id.clone(),
            for_push,
        };
        apply_host(m, &format!("claim-{for_push}"), claim.clone());
        assert_eq!(
            apply_host_error(m, &format!("claimed-{for_push}"), claim),
            CoreErrorCode::Conflict
        );
    }
    assert_eq!(
        count(&workspace, "SELECT count(*) FROM inbox_later_notifications"),
        1
    );
}

#[test]
fn changing_the_intake_owner_hands_the_move_over_and_discards_the_deferral() {
    let w = seeded_workspace();
    let m = &w.module;
    w.kernel.writer().call(|c| {
        c.execute_batch("UPDATE libraries SET space_kind='team';
          INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES('bob','library-1','Bob','active','member');
          INSERT INTO member_devices(id,library_id,member_id,label,credential_hash,created_at,last_seen) VALUES('bob','library-1','bob','Device','bob',unixepoch(),unixepoch());
          INSERT INTO member_sessions(id,device_id,token_hash,created_at,expires_at) VALUES('bob','bob','bob',unixepoch(),unixepoch()+3600)")?;
        Ok(())
    }).unwrap();
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
    send(m, "shared", "Shared message");
    apply_host(m, "defer-owner", later(&["page:shared"], FUTURE));
    let read_bob = |filter| {
        let ProjectWorkspaceReadValue::InboxWindow { items } = m
            .read(
                &bob,
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::InboxWindow {
                        scope: ProjectWorkspaceInboxScope::Library,
                        filter,
                        window: CollectionWindowRequest {
                            first: Some(8),
                            after: None,
                        },
                    },
                },
            )
            .unwrap()
            .value
        else {
            panic!("Bob's Inbox window")
        };
        items.items
    };
    assert_eq!(summary(m).inbox_count, 0);
    assert!(read_bob(ProjectWorkspaceInboxWindowFilter::Inbox).is_empty());
    assert!(read_bob(ProjectWorkspaceInboxWindowFilter::Later).is_empty());
    let transfer = |owner: &str, operation: &str| {
        use nodex_core_contracts::{LIBRARY_CONTRACT_VERSION, library::*};
        let (encoded, revision) = w.kernel.readers().read_default(|c| {
            Ok(c.query_row("SELECT value_json,revision FROM block_properties WHERE block_id='page:shared' AND property_key='work'", [], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?)
        }).unwrap();
        let mut work: PageWork = serde_json::from_str(&encoded).unwrap();
        work.owner = owner.into();
        crate::library::LibraryModule::new("profile-1", "library-1", &w.kernel)
            .apply(
                &host(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: operation.into(),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    intent: LibraryIntent::ApplyBlockPropertyMutation {
                        mutation: Box::new(LibraryBlockPropertyMutation {
                            actor: serde_json::json!({"kind":"host"}),
                            client_session_id: None,
                            fields: vec![LibraryBlockPropertyFieldMutation::IntrinsicSet {
                                block_id: "page:shared".into(),
                                property_key: "work".into(),
                                expected_revision: revision,
                                value: serde_json::to_value(&work).unwrap(),
                            }],
                        }),
                    },
                },
            )
            .unwrap();
    };
    transfer("bob", "handover");
    assert_eq!(count(&w, "SELECT count(*) FROM inbox_deferrals"), 0);
    assert_eq!(read_bob(ProjectWorkspaceInboxWindowFilter::Inbox).len(), 1);
    assert_eq!(summary(m).inbox_count, 0);
    m.apply(&bob, request("defer-bob", later(&["page:shared"], FUTURE)))
        .unwrap();
    assert_eq!(read_bob(ProjectWorkspaceInboxWindowFilter::Later).len(), 1);
    // Removing the Owner makes the routing decision available to the active Members.
    w.kernel
        .writer()
        .call(|c| {
            c.execute("UPDATE members SET lifecycle='removed' WHERE id='bob'", [])?;
            Ok(())
        })
        .unwrap();
    apply_host(
        m,
        "refresh-shared-turn",
        ProjectWorkspaceIntent::SetInboxEntryImportant {
            page_id: "page:shared".into(),
            important: true,
        },
    );
    assert_eq!(summary(m).inbox_count, 1);
    assert_eq!(count(&w, "SELECT count(*) FROM inbox_deferrals"), 0);
}

#[test]
fn confirmation_refuses_expired_advice_and_accepts_a_reviewed_override() {
    let workspace = seeded_workspace();
    let m = &workspace.module;
    send(m, "defer", "Remind me about this next week.");
    let action = |time: &str| ProjectWorkspaceInboxDispatchAction::Later {
        remind_at: time.into(),
    };
    propose(
        m,
        "proposal:later",
        &pending(m)[0],
        action("2000-01-01T00:00:00Z"),
    );
    let confirmation =
        |override_action, confirmed_by| ProjectWorkspaceIntent::ConfirmInboxDispatch {
            expected_store_epoch: "epoch-1".into(),
            proposal_id: "proposal:later".into(),
            expected_revision: 1,
            basis: proposal_basis(m, "proposal:later"),
            action: override_action,
            session_id: None,
            execution_selection: None,
            skill_invocations: vec![],
            confirmed_by,
        };
    let error = m
        .apply(
            &host(),
            request(
                "confirm-expired",
                confirmation(None, InboxConfirmedBy::User),
            ),
        )
        .unwrap_err();
    assert_eq!(error.recovery, CoreErrorRecovery::InboxRemindAtPassed);
    assert!(intake(m, "page:defer").waiting);
    assert!(
        m.apply(
            &host(),
            request(
                "auto-later",
                confirmation(
                    Some(action("2099-01-01T00:00:00Z")),
                    InboxConfirmedBy::Nodex
                )
            )
        )
        .is_err()
    );
    apply_host(
        m,
        "confirm-future",
        confirmation(Some(action("2099-01-01T00:00:00Z")), InboxConfirmedBy::User),
    );
    assert!(window(m, ProjectWorkspaceInboxWindowFilter::Later)[0].waiting);
    assert_eq!(
        intake(m, "page:defer").proposal.unwrap().state,
        ProjectWorkspaceInboxProposalState::Completed
    );
    assert_eq!(
        activity_in(
            m,
            ProjectWorkspaceInboxScope::Library,
            ActivityFilter::Messages
        )
        .len(),
        0
    );
}

#[test]
fn deferral_preserves_group_advice_and_a_running_request() {
    let w = seeded_workspace();
    let m = &w.module;
    send(m, "first", "First item");
    send(m, "second", "Second item");
    let pages = vec!["page:first".into(), "page:second".into()];
    let basis = window(m, ProjectWorkspaceInboxWindowFilter::Inbox)
        .into_iter()
        .map(|item| item.basis)
        .collect();
    apply_host(
        m,
        "suggest-group",
        ProjectWorkspaceIntent::ProposeInboxDispatch {
            proposal_id: "proposal:group".into(),
            page_ids: pages,
            basis,
            action: ProjectWorkspaceInboxDispatchAction::Keep,
            entry_kind: None,
            summary: "Keep together".into(),
            rationale: None,
            produced_by: None,
        },
    );
    send(m, "waiting", "Still waiting");
    grouped_request(m, "request:waiting", vec!["page:waiting".into()]);
    let before = requests(m);
    apply_host(m, "defer", later(&["page:first", "page:waiting"], FUTURE));
    assert_eq!(
        intake(m, "page:first").proposal.unwrap().state,
        ProjectWorkspaceInboxProposalState::Open
    );
    assert_eq!(
        intake(m, "page:second").proposal.unwrap().state,
        ProjectWorkspaceInboxProposalState::Open
    );
    let after = requests(m);
    assert_eq!(before.len(), 1);
    assert_eq!(after[0].basis, before[0].basis);
    assert_eq!(summary(m).pending_suggestion_count, 0);
    assert_eq!(summary(m).needs_decision_count, 1);
    apply_host(
        m,
        "settle-deferred-request",
        ProjectWorkspaceIntent::SettleInboxSuggestion {
            automatic_dispatch: false,
            request_id: after[0].request_id.clone(),
            generation: after[0].generation,
            titles: vec![],
            suggestions: vec![
                nodex_core_contracts::inbox::ProjectWorkspaceInboxSuggestedDispatch {
                    explicit_request: false,
                    proposal_id: "proposal:arrived".into(),
                    page_ids: vec!["page:waiting".into()],
                    action: ProjectWorkspaceInboxDispatchAction::Keep,
                    entry_kind: None,
                    summary: "Keep".into(),
                    rationale: None,
                },
            ],
            produced_by: None,
            error: None,
        },
    );
    assert_eq!(
        intake(m, "page:waiting").proposal.unwrap().proposal_id,
        "proposal:arrived"
    );
    assert!(intake(m, "page:waiting").later.is_some());
}

#[test]
fn a_work_turn_can_wait_until_later_and_the_next_episode_breaks_through() {
    let workspace = seeded_workspace();
    let m = &workspace.module;
    send_to(m, "review-later", "Review the summary", Some(PROJECT));
    let page = "page:review-later";
    set_status_by_hand(&workspace, page, "review");
    let before = intake(m, page);
    assert_eq!(
        before.row_kind,
        nodex_core_contracts::inbox::InboxRowKind::Turn
    );
    let episode = before.turn.unwrap().turn.episode;
    apply_host(m, "defer-review", later(&[page], FUTURE));
    assert!(window_in(m, project_scope(), ProjectWorkspaceInboxWindowFilter::Inbox).is_empty());
    let deferred = window_in(m, project_scope(), ProjectWorkspaceInboxWindowFilter::Later);
    assert_eq!(deferred.len(), 1);
    assert_eq!(
        deferred[0].row_kind,
        nodex_core_contracts::inbox::InboxRowKind::Turn
    );
    assert!(deferred[0].later.is_some());
    set_status_by_hand(&workspace, page, "triage");
    let returned = window_in(m, project_scope(), ProjectWorkspaceInboxWindowFilter::Inbox);
    assert_eq!(returned.len(), 1);
    assert_eq!(
        returned[0].row_kind,
        nodex_core_contracts::inbox::InboxRowKind::Intake
    );
    assert!(returned[0].later.is_none());
    assert_eq!(count(&workspace, "SELECT count(*) FROM inbox_deferrals"), 0);
    let ProjectWorkspaceReadValue::PageTurns { turns } = read_host(
        m,
        ProjectWorkspaceRead::PageTurns {
            page_ids: vec![page.into()],
        },
    ) else {
        panic!("Page Turns");
    };
    assert_ne!(turns[0].episode, episode);
}
