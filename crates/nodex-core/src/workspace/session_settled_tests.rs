use super::ProjectWorkspaceModule;
use super::test_support::{
    NOW, TestWorkspace, apply, context, create_project, create_session_thread, local_member, read,
    request, seeded_workspace,
};
use nodex_core_contracts::collection::CollectionWindowRequest;
use nodex_core_contracts::workspace::{
    ProjectSessionIntent, ProjectSessionInvalidationScope, ProjectWorkspaceIntent,
    ProjectWorkspaceRead, ProjectWorkspaceReadValue, ProjectWorkspaceSessionSummary,
    ProjectWorkspaceSidebarSectionItemRef, ProjectWorkspaceTaskLane, ProjectWorkspaceTaskLifecycle,
    ProjectWorkspaceTaskOrder, ProjectWorkspaceTaskWindow,
};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, CoreError, CoreErrorCode, CoreModuleEventPayload,
    ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION,
};

use ProjectWorkspaceTaskLifecycle::{All, Open, Settled};
use ProjectWorkspaceTaskOrder::{Activity, Attention, Settlement};

fn mutate(
    module: &ProjectWorkspaceModule,
    operation: &str,
    id: &str,
    intent: ProjectSessionIntent,
) {
    apply(
        module,
        operation,
        ProjectWorkspaceIntent::MutateSession {
            session_id: id.into(),
            intent,
        },
    );
}

fn settle(module: &ProjectWorkspaceModule, op: &str, id: &str, settled: bool) {
    apply(
        module,
        op,
        ProjectWorkspaceIntent::SetSessionsSettled {
            session_ids: vec![id.into()],
            settled,
        },
    );
}

fn session(module: &ProjectWorkspaceModule, id: &str) -> ProjectWorkspaceSessionSummary {
    read_session_as(module, &context(), id)
}

fn read_session_as(
    module: &ProjectWorkspaceModule,
    reader: &BoundModuleContext,
    id: &str,
) -> ProjectWorkspaceSessionSummary {
    let ProjectWorkspaceReadValue::Session { session } = module
        .read(
            reader,
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::Session {
                    session_id: id.into(),
                },
            },
        )
        .expect("Session read")
        .value
    else {
        panic!("Session response")
    };
    session
}

fn sql(workspace: &TestWorkspace, statements: &str) {
    let statements = statements.to_owned();
    workspace
        .kernel
        .writer()
        .call(move |connection| {
            connection.execute_batch(&statements)?;
            Ok(())
        })
        .expect("seed Store state");
}

/// Which chats a test lists, and in what order.
#[derive(Clone, Copy)]
struct Listing<'a> {
    project_id: Option<&'a str>,
    whole_library: bool,
    lifecycle: ProjectWorkspaceTaskLifecycle,
    order: ProjectWorkspaceTaskOrder,
    query: Option<&'a str>,
}

const fn chats(
    lifecycle: ProjectWorkspaceTaskLifecycle,
    order: ProjectWorkspaceTaskOrder,
) -> Listing<'static> {
    Listing {
        project_id: None,
        whole_library: false,
        lifecycle,
        order,
        query: None,
    }
}

const fn library(
    lifecycle: ProjectWorkspaceTaskLifecycle,
    order: ProjectWorkspaceTaskOrder,
) -> Listing<'static> {
    Listing {
        project_id: None,
        whole_library: true,
        lifecycle,
        order,
        query: None,
    }
}

fn try_page(
    module: &ProjectWorkspaceModule,
    reader: &BoundModuleContext,
    listing: Listing<'_>,
    after: Option<String>,
    first: u32,
) -> Result<ProjectWorkspaceTaskWindow, CoreError> {
    let ProjectWorkspaceReadValue::TaskWindow { tasks } = module
        .read(
            reader,
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::TaskWindow {
                    project_id: listing.project_id.map(str::to_owned),
                    whole_library: listing.whole_library,
                    include_archived: Some(false),
                    placement_scope: Default::default(),
                    lifecycle: listing.lifecycle,
                    order: listing.order,
                    query: listing.query.map(str::to_owned),
                    window: CollectionWindowRequest {
                        after,
                        first: Some(first),
                    },
                },
            },
        )?
        .value
    else {
        panic!("Task window response")
    };
    Ok(tasks)
}

fn ids(window: &ProjectWorkspaceTaskWindow) -> Vec<String> {
    window
        .items
        .iter()
        .map(|task| task.session.id.clone())
        .collect()
}

/// Every chat of a listing as `reader` sees it, paging `first` at a time.
fn listed_as(
    module: &ProjectWorkspaceModule,
    reader: &BoundModuleContext,
    listing: Listing<'_>,
    first: u32,
) -> Vec<String> {
    let mut listed = Vec::new();
    let mut after = None;
    let mut counts = Vec::new();
    loop {
        let window = try_page(module, reader, listing, after, first).expect("task window");
        listed.extend(ids(&window));
        counts.push(window.total_count as usize);
        match window.next_cursor {
            Some(cursor) => after = Some(cursor),
            None => {
                assert!(counts.into_iter().all(|count| count == listed.len()));
                return listed;
            }
        }
    }
}

fn listed(workspace: &TestWorkspace, listing: Listing<'_>) -> Vec<String> {
    listed_as(&workspace.module, &context(), listing, 50)
}

fn chat(workspace: &TestWorkspace, name: &str, project_id: Option<&str>, activity_at: i64) {
    create_session_thread(
        &workspace.module,
        &format!("create-{name}"),
        &format!("session:{name}"),
        &format!("thread:{name}"),
        project_id,
        activity_at,
    );
}

fn names(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| format!("session:{name}")).collect()
}

fn tomorrow() -> String {
    (chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339()
}

fn invalidation(
    outcome: &super::ProjectWorkspaceApplyOutcome,
) -> Option<nodex_core_contracts::workspace::ProjectWorkspaceEvent> {
    outcome.event.as_ref().map(|event| {
        let CoreModuleEventPayload::ProjectWorkspace(event) = &event.payload else {
            panic!("Workspace event")
        };
        event.clone()
    })
}

#[test]
fn reopening_a_settled_chat_returns_it_exactly_where_it_was() {
    let w = seeded_workspace();
    for (name, at) in [("a", 100), ("b", 200), ("c", 300)] {
        chat(&w, name, None, at);
    }
    let open = chats(Open, Attention);
    assert_eq!(listed(&w, open), names(&["c", "b", "a"]));

    settle(&w.module, "settled-b", "session:b", true);
    assert_eq!(listed(&w, open), names(&["c", "a"]));
    assert_eq!(listed(&w, chats(Settled, Settlement)), names(&["b"]));
    assert_eq!(listed(&w, chats(All, Attention)), names(&["c", "b", "a"]));
    assert!(session(&w.module, "session:b").settled_at.is_some());

    // Marking it Settled again keeps when it was first finished.
    sql(&w, "UPDATE member_session_settled SET settled_at = 42");
    settle(&w.module, "settled-b-again", "session:b", true);
    assert_eq!(session(&w.module, "session:b").settled_at, Some(42));

    settle(&w.module, "reopen-b", "session:b", false);
    let reopened = session(&w.module, "session:b");
    assert_eq!(reopened.settled_at, None);
    assert_eq!((reopened.activity_at, reopened.attention_at), (200, 200));
    assert_eq!(listed(&w, open), names(&["c", "b", "a"]));
    assert!(listed(&w, chats(Settled, Settlement)).is_empty());
}

#[test]
fn settling_clears_the_members_pin_snooze_and_unread_mark() {
    let w = seeded_workspace();
    chat(&w, "a", None, 100);
    for (name, hold) in [
        ("pin", ProjectSessionIntent::SetPinned { pinned: true }),
        (
            "snooze",
            ProjectSessionIntent::SetSnooze {
                snoozed_until: Some(tomorrow()),
            },
        ),
    ] {
        mutate(&w.module, name, "session:a", hold);
        mutate(
            &w.module,
            &format!("unread-{name}"),
            "session:a",
            ProjectSessionIntent::SetUnread { unread: true },
        );
        let before = session(&w.module, "session:a");
        assert!(before.unread);
        assert_eq!(before.pinned, name == "pin");
        assert_eq!(before.snoozed_until.is_some(), name == "snooze");

        settle(&w.module, &format!("settle-{name}"), "session:a", true);
        let settled = session(&w.module, "session:a");
        assert!(settled.settled_at.is_some());
        assert!(!settled.pinned && !settled.unread && settled.snoozed_until.is_none());
        settle(&w.module, &format!("reopen-{name}"), "session:a", false);
    }
}

#[test]
fn anything_that_asks_for_the_member_again_reopens_a_settled_chat() {
    let w = seeded_workspace();
    chat(&w, "a", None, 100);
    for (index, reopen) in [
        ProjectSessionIntent::SetPinned { pinned: true },
        ProjectSessionIntent::RecordUserMessage {
            message_id: "message:1".into(),
        },
        ProjectSessionIntent::SetUnread { unread: true },
        ProjectSessionIntent::RecordAttention {
            seen: true,
            asked_at: None,
        },
    ]
    .into_iter()
    .enumerate()
    {
        settle(&w.module, &format!("settled-{index}"), "session:a", true);
        assert!(session(&w.module, "session:a").settled_at.is_some());
        mutate(
            &w.module,
            &format!("reopen-{index}"),
            "session:a",
            reopen.clone(),
        );
        assert_eq!(
            session(&w.module, "session:a").settled_at,
            None,
            "{reopen:?}"
        );
    }
}

#[test]
fn attention_brings_a_chat_back_and_turns_it_unread_only_when_unseen() {
    let w = seeded_workspace();
    chat(&w, "a", None, 100);
    chat(&w, "b", None, 200);
    assert_eq!(listed(&w, chats(All, Attention)), names(&["b", "a"]));

    mutate(
        &w.module,
        "a-returns",
        "session:a",
        ProjectSessionIntent::RecordAttention {
            seen: false,
            asked_at: None,
        },
    );
    let a = session(&w.module, "session:a");
    assert!(a.unread);
    assert_eq!(
        a.activity_at, 100,
        "the Agent stopping is not a person's message"
    );
    assert!(a.attention_at > 200);
    assert_eq!(listed(&w, chats(All, Attention)), names(&["a", "b"]));
    assert_eq!(listed(&w, chats(All, Activity)), names(&["b", "a"]));

    // `a` came back well before `b` does.
    sql(
        &w,
        "UPDATE project_sessions SET returned_at = 1000 WHERE id = 'session:a'",
    );
    mutate(
        &w.module,
        "b-returns",
        "session:b",
        ProjectSessionIntent::RecordAttention {
            seen: true,
            asked_at: None,
        },
    );
    let b = session(&w.module, "session:b");
    assert!(!b.unread, "the Member was already looking at it");
    assert!(b.attention_at > 1000);
    assert_eq!(listed(&w, chats(All, Attention)), names(&["b", "a"]));
}

#[test]
fn an_archived_chat_takes_no_done_or_attention() {
    let w = seeded_workspace();
    chat(&w, "a", None, 100);
    sql(
        &w,
        &format!(
            "UPDATE project_sessions SET archived = 1, archived_at = '{NOW}' WHERE id = 'session:a'"
        ),
    );
    for (operation, intent) in [
        (
            "settled",
            ProjectWorkspaceIntent::SetSessionsSettled {
                session_ids: vec!["session:a".into()],
                settled: true,
            },
        ),
        (
            "attention",
            ProjectWorkspaceIntent::MutateSession {
                session_id: "session:a".into(),
                intent: ProjectSessionIntent::RecordAttention {
                    seen: false,
                    asked_at: None,
                },
            },
        ),
    ] {
        let outcome = w
            .module
            .apply(&context(), request(operation, intent))
            .expect("archived chats accept the intent");
        assert!(
            invalidation(&outcome).is_none_or(|event| event.session_detail_ids.is_empty()
                && event.session_summary_scopes.is_empty()),
            "{operation}"
        );
    }
    let archived = session(&w.module, "session:a");
    assert_eq!(archived.settled_at, None);
    assert!(!archived.unread);
    assert_eq!(archived.attention_at, 100);
}

#[test]
fn settled_and_attention_belong_to_each_member() {
    let w = seeded_workspace();
    chat(&w, "a", None, 100);
    sql(
        &w,
        "UPDATE libraries SET space_kind = 'team';
         INSERT INTO members(id, library_id, display_name, lifecycle, role) VALUES ('bob', 'library-1', 'Bob', 'active', 'member');
         INSERT INTO member_devices(id, library_id, member_id, label, credential_hash, created_at, last_seen) VALUES ('bob', 'library-1', 'bob', 'Device', 'bob', unixepoch(), unixepoch());
         INSERT INTO member_sessions(id, device_id, token_hash, created_at, expires_at) VALUES ('bob', 'bob', 'bob', unixepoch(), unixepoch() + 3600);",
    );
    let bob = BoundModuleContext {
        adapter: AdapterKind::RemoteMember,
        principal: Some(nodex_core_contracts::RemotePrincipal {
            space_id: "library-1".into(),
            member_id: "bob".into(),
            device_id: "bob".into(),
            session_id: "bob".into(),
            role: nodex_core_contracts::library::MemberRole::Member,
        }),
        ..context()
    };
    let as_bob = |operation: &str, intent| {
        w.module
            .apply(
                &bob,
                request(
                    operation,
                    ProjectWorkspaceIntent::MutateSession {
                        session_id: "session:a".into(),
                        intent,
                    },
                ),
            )
            .expect("Bob's own attention");
    };

    settle(&w.module, "settled", "session:a", true);
    assert!(session(&w.module, "session:a").settled_at.is_some());
    assert_eq!(
        read_session_as(&w.module, &bob, "session:a").settled_at,
        None
    );
    assert!(listed(&w, chats(Open, Attention)).is_empty());
    assert_eq!(
        listed_as(&w.module, &bob, chats(Open, Attention), 50),
        names(&["a"])
    );

    // The chat comes back to the top for everyone, but reopens and turns unread only for Bob.
    w.module
        .apply(
            &bob,
            request(
                "bob-settled",
                ProjectWorkspaceIntent::SetSessionsSettled {
                    session_ids: vec!["session:a".into()],
                    settled: true,
                },
            ),
        )
        .expect("Bob can settle his own chat");
    as_bob(
        "bob-attention",
        ProjectSessionIntent::RecordAttention {
            seen: false,
            asked_at: None,
        },
    );
    let for_bob = read_session_as(&w.module, &bob, "session:a");
    assert_eq!(for_bob.settled_at, None);
    assert!(for_bob.unread);
    let for_owner = session(&w.module, "session:a");
    assert!(for_owner.settled_at.is_some());
    assert!(!for_owner.unread);
    assert_eq!(for_owner.attention_at, for_bob.attention_at);
    assert!(for_owner.attention_at > 100);
}

#[test]
fn task_search_counts_matches_and_scopes_its_cursor() {
    let w = seeded_workspace();
    create_project(&w.module, "create-project", "project:a");
    chat(&w, "title", Some("project:a"), 100);
    chat(&w, "preview", None, 200);
    chat(&w, "open", Some("project:a"), 300);
    chat(&w, "wildcard", None, 400);
    sql(
        &w,
        "UPDATE codex_threads SET thread_name = 'Résumé 100%_ready' WHERE thread_id = 'thread:title';
         UPDATE codex_threads SET thread_name = 'Deployment', thread_preview = 'Résumé 100%_ready'
            WHERE thread_id = 'thread:preview';
         UPDATE codex_threads SET thread_name = 'Résumé 100%_ready' WHERE thread_id = 'thread:open';
         UPDATE codex_threads SET thread_name = NULL, thread_preview = '' WHERE thread_id = 'thread:wildcard';
         UPDATE project_sessions SET no_thread_fallback_title = 'Résumé 100xaReady' WHERE id = 'session:wildcard';",
    );
    for id in ["title", "preview", "wildcard"] {
        settle(
            &w.module,
            &format!("settle-{id}"),
            &format!("session:{id}"),
            true,
        );
    }

    let filtered = Listing {
        query: Some("  RÉSUMÉ 100%_READY  "),
        ..library(Settled, Settlement)
    };
    let reader = context();
    let first = try_page(&w.module, &reader, filtered, None, 1).expect("first match");
    assert_eq!(first.total_count, 2);
    assert_eq!(ids(&first), names(&["preview"]));
    let continued = try_page(
        &w.module,
        &reader,
        Listing {
            query: Some("résumé 100%_ready"),
            ..filtered
        },
        first.next_cursor.clone(),
        1,
    )
    .expect("second match");
    assert_eq!(continued.total_count, 2);
    assert_eq!(ids(&continued), names(&["title"]));
    assert!(continued.next_cursor.is_none());

    let project = Listing {
        project_id: Some("project:a"),
        whole_library: false,
        ..filtered
    };
    assert_eq!(listed(&w, project), names(&["title"]));
    assert_eq!(
        listed(
            &w,
            Listing {
                lifecycle: Open,
                order: Attention,
                ..project
            }
        ),
        names(&["open"])
    );
    assert_eq!(
        listed(
            &w,
            Listing {
                query: Some("   "),
                ..filtered
            }
        )
        .len(),
        3
    );

    assert_eq!(
        listed(
            &w,
            Listing {
                query: Some("100XAREADY"),
                ..filtered
            }
        ),
        names(&["wildcard"])
    );
    for query in [None, Some("deployment")] {
        assert_eq!(
            try_page(
                &w.module,
                &reader,
                Listing { query, ..filtered },
                first.next_cursor.clone(),
                1
            )
            .expect_err("invalid search continuation")
            .code,
            CoreErrorCode::InvalidInput
        );
    }
    let too_long = "x".repeat(201);
    assert_eq!(
        try_page(
            &w.module,
            &reader,
            Listing {
                query: Some(&too_long),
                ..filtered
            },
            None,
            1
        )
        .expect_err("overlong query")
        .code,
        CoreErrorCode::InvalidInput
    );
}

#[test]
fn whole_library_lists_span_every_project_and_validate_their_shape() {
    let w = seeded_workspace();
    for project in ["project:a", "project:b", "project:archived"] {
        create_project(&w.module, &format!("create-{project}"), project);
    }
    chat(&w, "a", Some("project:a"), 100);
    chat(&w, "b", Some("project:b"), 200);
    chat(&w, "loose", None, 300);
    chat(&w, "shelved", Some("project:archived"), 400);
    sql(
        &w,
        "UPDATE projects SET lifecycle = 'archived' WHERE id = 'project:archived'",
    );
    settle(&w.module, "settled-a", "session:a", true);

    assert_eq!(
        listed(&w, library(All, Attention)),
        names(&["loose", "b", "a"])
    );
    assert_eq!(listed(&w, library(Open, Attention)), names(&["loose", "b"]));
    assert_eq!(listed(&w, library(Settled, Settlement)), names(&["a"]));
    // One scope's list stays that scope's.
    assert_eq!(listed(&w, chats(All, Attention)), names(&["loose"]));
    assert_eq!(
        listed(
            &w,
            Listing {
                project_id: Some("project:b"),
                ..chats(Open, Attention)
            }
        ),
        names(&["b"])
    );

    // Lanes carry their own lifecycle within one whole-Library read.
    let lane = |lifecycle, order| ProjectWorkspaceTaskLane {
        include_archived: Some(false),
        placement_scope: Default::default(),
        lifecycle,
        order,
        query: None,
        window: CollectionWindowRequest {
            after: None,
            first: Some(50),
        },
    };
    let ProjectWorkspaceReadValue::TaskWindows { lanes } = read(
        &w.module,
        ProjectWorkspaceRead::TaskWindows {
            project_id: None,
            whole_library: true,
            lanes: vec![lane(Open, Attention), lane(Settled, Settlement)],
        },
    ) else {
        panic!("task lanes")
    };
    assert_eq!(
        lanes.iter().map(ids).collect::<Vec<_>>(),
        [names(&["loose", "b"]), names(&["a"])]
    );

    assert_eq!(
        lanes
            .iter()
            .map(|lane| lane.total_count)
            .collect::<Vec<_>>(),
        [2, 1]
    );

    let rejected = |listing| {
        try_page(&w.module, &context(), listing, None, 10)
            .expect_err("invalid listing")
            .code
    };
    for listing in [
        Listing {
            project_id: Some("project:a"),
            ..library(All, Attention)
        },
        library(All, Settlement),
        chats(Open, Settlement),
    ] {
        assert_eq!(rejected(listing), CoreErrorCode::InvalidInput);
    }
    // A cursor belongs to the lifecycle and scope it was minted for.
    let cursor = try_page(&w.module, &context(), library(Open, Attention), None, 1)
        .unwrap()
        .next_cursor;
    assert!(cursor.is_some());
    for listing in [library(All, Attention), chats(Open, Attention)] {
        assert!(try_page(&w.module, &context(), listing, cursor.clone(), 1).is_err());
    }
}

#[test]
fn attention_and_completion_orders_page_by_keyset() {
    let w = seeded_workspace();
    for (index, at) in [100, 200, 300, 400, 500, 500].into_iter().enumerate() {
        chat(&w, &format!("c{index}"), None, at);
    }
    mutate(
        &w.module,
        "pin-c0",
        "session:c0",
        ProjectSessionIntent::SetPinned { pinned: true },
    );
    sql(
        &w,
        "UPDATE project_sessions SET returned_at = 1000 WHERE id = 'session:c1';
         UPDATE project_sessions SET returned_at = 450 WHERE id = 'session:c3';",
    );
    let expected = names(&["c0", "c1", "c4", "c5", "c3", "c2"]);
    for first in [1, 2, 4] {
        assert_eq!(
            listed_as(&w.module, &context(), chats(All, Attention), first),
            expected
        );
    }

    let member = local_member(&w);
    sql(
        &w,
        &format!(
            "INSERT INTO member_session_settled(member_id, session_id, settled_at) VALUES
               ('{member}', 'session:c1', 10), ('{member}', 'session:c2', 40),
               ('{member}', 'session:c3', 30), ('{member}', 'session:c4', 40);"
        ),
    );
    let finished = names(&["c2", "c4", "c3", "c1"]);
    for first in [1, 3] {
        assert_eq!(
            listed_as(&w.module, &context(), chats(Settled, Settlement), first),
            finished
        );
    }
    assert_eq!(
        listed_as(&w.module, &context(), chats(Open, Attention), 1),
        names(&["c0", "c5"])
    );
}

#[test]
fn idle_sweep_finishes_only_quiet_started_chats_and_repeats_as_a_no_op() {
    let w = seeded_workspace();
    create_project(&w.module, "create-a", "project:a");
    create_project(&w.module, "create-archived", "project:archived");
    for name in [
        "idle",
        "recent",
        "returned",
        "working",
        "pinned",
        "unread",
        "snoozed",
        "archived",
        "side",
        "decision-run",
        "child",
        "finished",
        "filed",
    ] {
        chat(&w, name, None, if name == "recent" { 5_000 } else { 100 });
    }
    chat(&w, "in-project", Some("project:a"), 100);
    chat(&w, "shelved", Some("project:archived"), 100);
    apply(
        &w.module,
        "create-draft",
        ProjectWorkspaceIntent::CreateSession {
            session_id: "session:draft".into(),
            project_id: None,
            title: "Draft".into(),
            initial_page_ids: Vec::new(),
        },
    );
    apply(
        &w.module,
        "create-section",
        ProjectWorkspaceIntent::CreateSidebarSection {
            section_id: "section:parked".into(),
            name: "Parked".into(),
            initial_item: Some(ProjectWorkspaceSidebarSectionItemRef::Session {
                session_id: "session:filed".into(),
            }),
        },
    );
    mutate(
        &w.module,
        "pin",
        "session:pinned",
        ProjectSessionIntent::SetPinned { pinned: true },
    );
    mutate(
        &w.module,
        "unread",
        "session:unread",
        ProjectSessionIntent::SetUnread { unread: true },
    );
    mutate(
        &w.module,
        "remind",
        "session:snoozed",
        ProjectSessionIntent::SetSnooze {
            snoozed_until: Some(tomorrow()),
        },
    );
    let member = local_member(&w);
    sql(
        &w,
        &format!(
            "UPDATE project_sessions SET created_at = '1970-01-01T00:00:00.050Z', activity_at = 100 WHERE id = 'session:draft';
             UPDATE project_sessions SET returned_at = 5000 WHERE id = 'session:returned';
             UPDATE codex_threads SET status_type = 'active' WHERE thread_id = 'thread:working';
             UPDATE project_sessions SET archived = 1, archived_at = '{NOW}' WHERE id = 'session:archived';
             INSERT INTO project_session_side_chats(session_id, source_session_id) VALUES ('session:side', 'session:idle');
             INSERT INTO nodex_decision_runs(session_id,kind,request_id,generation,created_at) VALUES ('session:decision-run','routing','request',1,'{NOW}');
             UPDATE codex_threads SET parent_thread_id = 'thread:idle' WHERE thread_id = 'thread:child';
             UPDATE projects SET lifecycle = 'archived' WHERE id = 'project:archived';
             INSERT INTO member_session_settled(member_id, session_id, settled_at) VALUES ('{member}', 'session:finished', 7);"
        ),
    );
    let sweep = |operation: &str, idle_before_ms| {
        w.module.apply(
            &context(),
            request(
                operation,
                ProjectWorkspaceIntent::SettleIdleSessions { idle_before_ms },
            ),
        )
    };
    let settled = || {
        let member = member.clone();
        w.kernel
            .readers()
            .read_default(move |connection| {
                Ok(connection
                    .prepare(
                        "SELECT session_id, settled_at FROM member_session_settled \
                         WHERE member_id = ?1 ORDER BY session_id",
                    )?
                    .query_map([&member], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .unwrap()
    };

    let completed = sweep("sweep", 1_000).expect("idle sweep");
    let event = invalidation(&completed).expect("the sweep invalidates chat lists");
    assert_eq!(
        event.session_summary_scopes,
        vec![ProjectSessionInvalidationScope::All]
    );
    assert!(event.session_detail_ids.is_empty());
    // Each swept chat is Settled from when it last came back to a person.
    // A Section only arranges chats; one filed there settles like any other.
    let swept = vec![
        ("session:filed".to_owned(), 100),
        ("session:finished".to_owned(), 7),
        ("session:idle".to_owned(), 100),
        ("session:in-project".to_owned(), 100),
    ];
    assert_eq!(settled(), swept);

    let repeated = sweep("sweep-again", 1_000).expect("repeated sweep");
    assert!(invalidation(&repeated).is_none());
    assert_eq!(settled(), swept);
    assert_eq!(
        sweep("negative", -1).expect_err("negative instant").code,
        CoreErrorCode::InvalidInput
    );
}

#[test]
fn settlement_batch_reports_exact_changes_and_rolls_back_an_invalid_batch() {
    let w = seeded_workspace();
    for id in ["a", "b", "c"] {
        chat(&w, id, None, 10);
    }
    settle(&w.module, "prior", "session:b", true);
    let batch = |op: &str, ids: &[&str], settled| {
        w.module.apply(
            &context(),
            request(
                op,
                ProjectWorkspaceIntent::SetSessionsSettled {
                    session_ids: names(ids),
                    settled,
                },
            ),
        )
    };
    assert!(batch("missing", &["a", "missing"], true).is_err());
    assert!(batch("duplicate", &["a", "a"], true).is_err());
    assert_eq!(session(&w.module, "session:a").settled_at, None);
    let changed = batch("settle-batch", &["c", "b", "a"], true)
        .unwrap()
        .committed
        .value
        .affected_session_ids;
    assert_eq!(changed, names(&["c", "a"]));
    assert_eq!(
        batch("settle-batch", &["c", "b", "a"], true)
            .unwrap()
            .committed
            .value
            .affected_session_ids,
        changed
    );
    assert_eq!(
        batch("undo-batch", &["c", "a"], false)
            .unwrap()
            .committed
            .value
            .affected_session_ids,
        changed
    );
    assert_eq!(listed(&w, chats(Settled, Settlement)), names(&["b"]));
}

#[test]
fn builtin_windows_leave_placed_chats_to_their_sections_and_scope_the_settled_shelf() {
    let w = seeded_workspace();
    create_project(&w.module, "p", "project:one");
    chat(&w, "loose", None, 10);
    chat(&w, "filed", Some("project:one"), 20);
    chat(&w, "project", Some("project:one"), 30);
    apply(
        &w.module,
        "file",
        ProjectWorkspaceIntent::CreateSidebarSection {
            section_id: "filed".into(),
            name: "Filed".into(),
            initial_item: Some(ProjectWorkspaceSidebarSectionItemRef::Session {
                session_id: "session:filed".into(),
            }),
        },
    );
    let lane = |project: Option<&str>, lifecycle, order| {
        let ProjectWorkspaceReadValue::TaskWindow { tasks } = read(
            &w.module,
            ProjectWorkspaceRead::TaskWindow {
                project_id: project.map(str::to_owned),
                whole_library: project.is_none(),
                include_archived: Some(false),
                placement_scope: if lifecycle == Open {
                    nodex_core_contracts::workspace::ProjectWorkspaceTaskPlacementScope::Builtin
                } else {
                    Default::default()
                },
                lifecycle,
                order,
                query: None,
                window: CollectionWindowRequest {
                    first: Some(10),
                    after: None,
                },
            },
        ) else {
            panic!("chat window")
        };
        ids(&tasks)
    };
    assert_eq!(lane(None, Open, Attention), names(&["project", "loose"]));
    assert_eq!(
        lane(Some("project:one"), Open, Attention),
        names(&["project"])
    );
    settle(&w.module, "settle-filed", "session:filed", true);
    settle(&w.module, "settle-loose", "session:loose", true);
    assert_eq!(
        lane(Some("project:one"), Settled, Settlement),
        names(&["filed"])
    );
    let shelf = lane(None, Settled, Settlement);
    assert!(shelf.contains(&"session:loose".to_owned()));
    assert!(shelf.contains(&"session:filed".to_owned()));
    let ProjectWorkspaceReadValue::SidebarSectionItemWindow { items } = read(
        &w.module,
        ProjectWorkspaceRead::SidebarSectionItemWindow {
            section_id: "filed".into(),
            include_archived: Some(false),
            window: CollectionWindowRequest {
                first: Some(10),
                after: None,
            },
        },
    ) else {
        panic!("Section window")
    };
    assert!(items.items.is_empty());
}
