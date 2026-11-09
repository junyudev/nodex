use super::*;
use nodex_core_contracts::{
    DATABASE_CONTRACT_VERSION, ModuleApplyRequest, StoreEpoch, agent::AgentTurnProvenance,
    database::*, inbox::*,
};
const PAGE: &str = "019d0000-0000-7000-8000-000000000091";
fn board(w: &TestWorkspace) {
    create_project(&w.module, "project-work", "project:work");
}
pub(super) fn card(w: &TestWorkspace, page: &str, session: &str, active: bool) {
    apply(
        &w.module,
        &format!("create-{page}"),
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: page.into(),
            document_id: crate::domain::identity::stable_uuid_v7("test-document", "page", page),
            title: "Work".into(),
        },
    );
    apply(
        &w.module,
        &format!("session-{session}"),
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            agent_selection: None,
            coordinator: false,
            side_chat_source_session_id: None,
            session_id: session.into(),
            project_id: Some("project:work".into()),
            title: "Work".into(),
            initial_page_ids: if active { vec![page.into()] } else { vec![] },
            runtime_id: "runtime".into(),
            runtime_thread_id: format!("thread:{session}"),
            launch_request_id: format!("launch:{session}"),
        },
    );
    apply(
        &w.module,
        &format!("managed-{session}"),
        ProjectWorkspaceIntent::SetSessionManaged {
            session_id: session.into(),
            managed: true,
        },
    );
}
fn agent(session: &str, intent: ProjectWorkspaceIntent) -> ProjectWorkspaceIntent {
    ProjectWorkspaceIntent::AgentCommand {
        provenance: Box::new(AgentTurnProvenance {
            profile_id: "profile-1".into(),
            authority: ProjectWorkspaceTurnAuthority {
                thread_id: format!("thread:{session}"),
                root_thread_id: format!("thread:{session}"),
                turn_id: "run".into(),
                actor_project_id: Some("project:work".into()),
                library_id: "library-1".into(),
                store_epoch: "epoch-1".into(),
                runtime: Some(ProjectWorkspaceAgentRuntimeAuthority {
                    session_id: session.into(),
                    runtime_id: "runtime".into(),
                    turn_kind: ProjectWorkspaceAgentRuntimeTurnKind::Run,
                }),
            },
        }),
        intent: Box::new(intent),
    }
}
fn current_thread(w: &TestWorkspace) -> ExternalThread {
    let SourceReadValue::Threads { threads } = query(
        w,
        SourceRead::Threads {
            host: "github.com".into(),
            repository_id: "10".into(),
            after_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    threads.into_iter().next().unwrap_or_else(thread)
}
pub(super) fn context_follow(w: &TestWorkspace, session: &str, op: &str) {
    apply(
        &w.module,
        op,
        agent(
            session,
            command(SourceCommand::FollowThread {
                source_id: "github".into(),
                config_revision: 1,
                thread: current_thread(w),
            }),
        ),
    );
}
fn follow_list(w: &TestWorkspace, page: &str) -> Vec<PageThreadFollow> {
    let SourceReadValue::PageFollows { follows } = query(
        w,
        SourceRead::PageFollows {
            page_id: page.into(),
            after_thread_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    follows
}
fn deliver_list(w: &TestWorkspace) -> Vec<ThreadDelivery> {
    let SourceReadValue::Deliveries { deliveries } = query(
        w,
        SourceRead::Deliveries {
            page_id: None,
            state: None,
            after_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    deliveries
}
fn batch(w: &TestWorkspace, op: &str, t: ExternalThread, events: Vec<SourceTriggerInput>) {
    let p = cursor(w);
    apply(
        &w.module,
        op,
        command(SourceCommand::IngestSourceBatch {
            source_id: "github".into(),
            config_revision: 1,
            partition: "repo:10".into(),
            expected_position: p.revision,
            lease_token: "lease".into(),
            threads: vec![t],
            triggers: events,
            next_position: p.cursor,
            next_poll_at_ms: 0,
            quarantine: vec![],
        }),
    );
}
fn event(w: &TestWorkspace, kind: &str, key: &str, class: SourceActorClass) -> SourceTriggerInput {
    SourceTriggerInput {
        semantic_key: format!("github:github.com:10:{key}"),
        kind: kind.into(),
        occurred_at_ms: cursor(w).cursor.baseline_at_ms + 1,
        actor_login: "bob".into(),
        actor_class: class,
        thread_id: thread().id,
        text: Some(format!("Update {key}")),
        metadata: json!({"observed_revision":1}),
        url: thread().url,
    }
}
fn set_status(w: &TestWorkspace, page: &str, status: &str) {
    let p = page.to_string();
    let (source,revision)=w.kernel.readers().read_default(move|c|Ok(c.query_row("SELECT p.parent_id,v.revision FROM pages p JOIN data_source_page_memberships m ON m.page_block_id=p.block_id AND m.removed_at IS NULL JOIN data_source_property_values v ON v.membership_id=m.id AND v.property_id='status' WHERE p.block_id=?1",[p],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?)).unwrap();
    crate::database::DatabaseModule::new("profile-1", "library-1", &w.kernel)
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: format!("status-{page}-{status}-{revision}"),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: vec![DatabaseIntent::EditPropertyValues {
                    edits: vec![DatabasePropertyValueMutation {
                        expected_membership_revision: None,
                        address: DatabasePagePropertyAddress {
                            page_id: page.into(),
                            data_source_id: source,
                            property_id: "status".into(),
                        },
                        edit: DatabasePropertyValueEdit::Replace {
                            expected_value_revision: revision,
                            value: DatabasePropertyValueInput::Select {
                                option_id: status.into(),
                            },
                        },
                    }],
                }],
            },
        )
        .unwrap();
}
fn stage(w: &TestWorkspace) -> String {
    w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT json_extract(v.value_json,'$') FROM data_source_property_values v JOIN data_source_page_memberships m ON m.id=v.membership_id WHERE m.page_block_id=?1 AND m.removed_at IS NULL AND v.property_id='status'",[PAGE],|r|r.get(0))?)).unwrap()
}
fn claim_workspace(w: &TestWorkspace) {
    apply(
        &w.module,
        "workspace",
        ProjectWorkspaceIntent::ClaimPageWorkspace {
            workspace_id: "workspace".into(),
            page_id: PAGE.into(),
            project_id: "project:work".into(),
            session_id: "chat".into(),
            repository_url: Some("https://github.com/alice/repo".into()),
            repository_root: "/repo".into(),
            branch_name: "nodex-1-work".into(),
            base_commit_oid: "a".repeat(40),
            worktree_path: "/worktree".into(),
        },
    );
}
fn own_pr(w: &TestWorkspace) -> ExternalThread {
    claim_workspace(w);
    let mut t = thread();
    t.kind = ExternalThreadKind::PullRequest;
    t.url = "https://github.com/alice/repo/pull/1".into();
    t.head = Some(SourcePullRequestHead {
        repository_id: "10".into(),
        repository: "alice/repo".into(),
        branch: "nodex-1-work".into(),
        sha: "a".repeat(40),
    });
    batch(w, "observe-pr", t, vec![]);
    current_thread(w)
}
#[test]
fn context_follows_fan_out_once_with_frozen_chat_identity() {
    let w = setup();
    board(&w);
    card(&w, PAGE, "chat", true);
    let second = "019d0000-0000-7000-8000-000000000093";
    card(&w, second, "other", true);
    context_follow(&w, "chat", "follow");
    context_follow(&w, "chat", "follow");
    context_follow(&w, "other", "follow-other");
    assert_eq!(follow_list(&w, PAGE)[0].role, ThreadFollowRole::Context);
    let e = event(&w, "comment", "comment:1", SourceActorClass::Person);
    batch(&w, "first", current_thread(&w), vec![e.clone()]);
    batch(&w, "duplicate", current_thread(&w), vec![e]);
    let deliveries = deliver_list(&w);
    assert_eq!(deliveries.len(), 2);
    assert!(
        deliveries
            .iter()
            .all(|d| d.state == "pending" && d.binding_revision == Some(1))
    );
    assert_eq!(
        deliveries
            .iter()
            .map(|d| d.session_id.as_deref().unwrap())
            .collect::<std::collections::BTreeSet<_>>(),
        ["chat", "other"].into_iter().collect()
    );
    assert!(
        w.module
            .apply(
                &context(),
                request(
                    "host-fake-follow",
                    command(SourceCommand::FollowThread {
                        source_id: "github".into(),
                        config_revision: 1,
                        thread: current_thread(&w)
                    })
                )
            )
            .is_err()
    );
}
#[test]
fn own_pr_requires_exact_head_repository_and_branch_and_verified_links_follow() {
    let w = setup();
    board(&w);
    card(&w, PAGE, "chat", false);
    let mut t = own_pr(&w);
    assert_eq!(follow_list(&w, PAGE)[0].role, ThreadFollowRole::OwnPr);
    // A separate Page sharing a branch name in another repository is never associated.
    let second = "019d0000-0000-7000-8000-000000000093";
    card(&w, second, "other", false);
    apply(
        &w.module,
        "other-workspace",
        ProjectWorkspaceIntent::ClaimPageWorkspace {
            workspace_id: "other-workspace".into(),
            page_id: second.into(),
            project_id: "project:work".into(),
            session_id: "other".into(),
            repository_url: Some("https://github.com/elsewhere/repo".into()),
            repository_root: "/other".into(),
            branch_name: "nodex-1-work".into(),
            base_commit_oid: "a".repeat(40),
            worktree_path: "/other-worktree".into(),
        },
    );
    t.head.as_mut().unwrap().repository_id = "20".into();
    batch(&w, "fork", t, vec![]);
    assert!(follow_list(&w, second).is_empty());
    apply(
        &w.module,
        "verified-link",
        ProjectWorkspaceIntent::UpsertPagePullRequest {
            workspace_id: "workspace".into(),
            head_branch: "nodex-1-work".into(),
            repository: "https://github.com/alice/repo".into(),
            number: 2,
            url: "https://github.com/alice/repo/pull/2".into(),
            state: "OPEN".into(),
        },
    );
    let follows = follow_list(&w, PAGE);
    assert!(
        follows
            .iter()
            .any(|f| f.role == ThreadFollowRole::OwnPr && f.thread.number == 2)
    );
    assert_eq!(
        follows
            .iter()
            .filter(|f| f.role == ThreadFollowRole::OwnPr)
            .count(),
        1
    );
    let mut old = current_thread(&w);
    old.state = "closed".into();
    old.head.as_mut().unwrap().repository_id = "10".into();
    batch(&w, "late-old-pr", old, vec![]);
    assert!(
        follow_list(&w, PAGE)
            .iter()
            .any(|f| f.role == ThreadFollowRole::OwnPr && f.thread.number == 2)
    );
}
#[test]
fn milestones_cover_every_predecessor_and_request_workspace_cleanup() {
    for (kind, from, to) in [
        ("opened", "doing", "review"),
        ("ready_for_review", "doing", "review"),
        ("merged", "doing", "done"),
        ("merged", "review", "done"),
        ("closed", "triage", "canceled"),
        ("closed", "plan", "canceled"),
        ("closed", "doing", "canceled"),
        ("closed", "review", "canceled"),
        ("review", "review", "doing"),
    ] {
        let w = setup();
        board(&w);
        card(&w, PAGE, "chat", false);
        set_status(&w, PAGE, from);
        let mut t = own_pr(&w);
        if kind == "merged" {
            t.state = "merged".into();
        }
        if kind == "closed" {
            t.state = "closed".into();
        }
        let mut e = event(&w, kind, "lifecycle:1", SourceActorClass::Person);
        if kind == "review" {
            e.metadata =
                json!({"state":"CHANGES_REQUESTED","effective":true,"observed_revision":1});
        }
        batch(&w, "milestone", t, vec![e]);
        assert_eq!(stage(&w), to, "{kind} from {from}");
        let state = w
            .kernel
            .readers()
            .read_default(|c| {
                Ok(c.query_row(
                    "SELECT lifecycle FROM page_workspaces WHERE workspace_id='workspace'",
                    [],
                    |r| r.get::<_, String>(0),
                )?)
            })
            .unwrap();
        assert_eq!(
            state,
            if ["done", "canceled"].contains(&to) {
                "cleanup_requested"
            } else {
                "preparing"
            }
        );
    }
}
#[test]
fn milestones_preserve_newer_person_edits_and_skip_draft_context_and_ineffective_reviews() {
    let w = setup();
    board(&w);
    card(&w, PAGE, "chat", false);
    set_status(&w, PAGE, "doing");
    let mut t = own_pr(&w);
    t.draft = true;
    batch(
        &w,
        "draft",
        t,
        vec![event(&w, "opened", "opened:1", SourceActorClass::Person)],
    );
    assert_eq!(stage(&w), "doing");
    set_status(&w, PAGE, "review");
    let e = event(&w, "merged", "merge:1", SourceActorClass::Person);
    batch(&w, "person-wins", current_thread(&w), vec![e]);
    assert_eq!(stage(&w), "review");
    let w = setup();
    board(&w);
    card(&w, PAGE, "chat", true);
    context_follow(&w, "chat", "context");
    batch(
        &w,
        "context-merge",
        current_thread(&w),
        vec![event(&w, "merged", "merge:1", SourceActorClass::Person)],
    );
    assert_eq!(stage(&w), "doing");
    let w = setup();
    board(&w);
    card(&w, PAGE, "chat", false);
    set_status(&w, PAGE, "review");
    own_pr(&w);
    let mut e = event(&w, "review", "review:1", SourceActorClass::Person);
    e.metadata = json!({"state":"CHANGES_REQUESTED","effective":false});
    batch(&w, "ineffective", current_thread(&w), vec![e]);
    assert_eq!(stage(&w), "review");
    set_status(&w, PAGE, "doing");
    assert!(
        activity_rows(&w.module)
            .iter()
            .any(|row| row.description.starts_with("Left ")
                && row.description.ends_with(" in In Review")
                && row.reason.as_deref() == Some("Review is no longer effective"))
    );
}
#[test]
fn closed_work_suppresses_bots_and_ci_but_delivers_people_and_missing_chats_are_unresolved() {
    for terminal in ["done", "canceled"] {
        let w = setup();
        board(&w);
        card(&w, PAGE, "chat", true);
        context_follow(&w, "chat", "follow");
        batch(
            &w,
            "open-events",
            current_thread(&w),
            vec![
                event(&w, "check", "open-ci", SourceActorClass::Ci),
                event(&w, "comment", "open-bot", SourceActorClass::Bot),
            ],
        );
        assert_eq!(
            deliver_list(&w)
                .iter()
                .filter(|d| d.state == "pending")
                .count(),
            2
        );
        set_status(&w, PAGE, terminal);
        batch(
            &w,
            "events",
            current_thread(&w),
            vec![
                event(&w, "comment", "human", SourceActorClass::Person),
                event(&w, "comment", "bot", SourceActorClass::Bot),
                event(&w, "check", "ci", SourceActorClass::Ci),
            ],
        );
        let d = deliver_list(&w);
        assert_eq!(d.iter().filter(|d| d.state == "pending").count(), 3);
        assert_eq!(d.iter().filter(|d| d.state == "suppressed").count(), 2);
    }
    let w = setup();
    board(&w);
    card(&w, PAGE, "chat", false);
    own_pr(&w);
    batch(
        &w,
        "missing",
        current_thread(&w),
        vec![event(&w, "comment", "human", SourceActorClass::Person)],
    );
    let d = deliver_list(&w);
    assert_eq!(d[0].state, "unresolved");
    assert_eq!(d[0].reason.as_deref(), Some("missing_active_chat"));
}
#[test]
fn intake_deduplicates_discovery_and_dispatch_follows_its_origin_without_automatic_consent() {
    let w = setup();
    batch(
        &w,
        "intake",
        thread(),
        vec![
            event(
                &w,
                "discovery_assigned",
                "assigned:1",
                SourceActorClass::Person,
            ),
            event(
                &w,
                "discovery_mentions",
                "mentioned:1",
                SourceActorClass::Person,
            ),
        ],
    );
    let page = w
        .kernel
        .readers()
        .read_default(|c| {
            Ok(c.query_row("SELECT page_id FROM github_intakes", [], |r| {
                r.get::<_, String>(0)
            })?)
        })
        .unwrap();
    let ProjectWorkspaceReadValue::InboxEntry { item: Some(item) } = read(
        &w.module,
        ProjectWorkspaceRead::InboxEntry {
            page_id: page.clone(),
        },
    ) else {
        panic!()
    };
    assert!(
        matches!(item.source,ProjectWorkspaceInboxSource::Github{ref actor_login,number:1,..} if actor_login=="bob")
    );
    assert!(item.body.contains("Update assigned:1"));
    assert!(item.body.contains("Update mentioned:1"));
    let ProjectWorkspaceReadValue::InboxDispatchContext { context: dispatch } = read(
        &w.module,
        ProjectWorkspaceRead::InboxDispatchContext {
            page_ids: vec![page.clone()],
        },
    ) else {
        panic!()
    };
    apply(
        &w.module,
        "dispatch",
        ProjectWorkspaceIntent::DispatchInboxEntries {
            expected_store_epoch: "epoch-1".into(),
            basis: vec![dispatch.entries[0].basis.clone()],
            execution_selection: Some(ProjectWorkspaceInboxExecutionSelection {
                model_selection: ProjectWorkspaceInboxModelSelection {
                    instance_id: "codex".into(),
                    model: "gpt".into(),
                    options: None,
                },
                interaction_mode: ProjectWorkspaceInboxInteractionMode::Default,
            }),
            proposal_id: "proposal".into(),
            page_ids: vec![page.clone()],
            action: ProjectWorkspaceInboxDispatchAction::NewChat {
                project_id: None,
                prompt: "Investigate the request".into(),
                additions: vec![],
                agent: None,
            },
            session_id: Some("intake-chat".into()),
        },
    );
    assert_eq!(follow_list(&w, &page)[0].role, ThreadFollowRole::Origin);
    let explicit = w
        .kernel
        .readers()
        .read_default(|c| {
            Ok(c.query_row(
                "SELECT explicit_request FROM inbox_proposals WHERE proposal_id='proposal'",
                [],
                |r| r.get::<_, bool>(0),
            )?)
        })
        .unwrap();
    assert!(!explicit);
    let ProjectWorkspaceReadValue::InboxAutomaticDispatches { proposals } = read(
        &w.module,
        ProjectWorkspaceRead::InboxAutomaticDispatches { limit: 100 },
    ) else {
        panic!()
    };
    assert!(proposals.is_empty());
    batch(
        &w,
        "followed-discovery",
        current_thread(&w),
        vec![event(
            &w,
            "discovery_mentions",
            "mentioned:2",
            SourceActorClass::Person,
        )],
    );
    let count = w
        .kernel
        .readers()
        .read_default(|c| {
            Ok(c.query_row("SELECT count(*) FROM inbox_entries", [], |r| {
                r.get::<_, i64>(0)
            })?)
        })
        .unwrap();
    assert_eq!(count, 1);
    apply(
        &w.module,
        "bind-intake-runtime",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            agent_selection: None,
            coordinator: false,
            side_chat_source_session_id: None,
            session_id: "intake-chat".into(),
            project_id: None,
            title: "Intake work".into(),
            initial_page_ids: vec![],
            runtime_id: "runtime".into(),
            runtime_thread_id: "thread:intake-chat".into(),
            launch_request_id: "intake-launch".into(),
        },
    );
    apply(
        &w.module,
        "manage-intake",
        ProjectWorkspaceIntent::SetSessionManaged {
            session_id: "intake-chat".into(),
            managed: true,
        },
    );
    batch(
        &w,
        "new-message",
        current_thread(&w),
        vec![event(
            &w,
            "comment",
            "out-of-scope",
            SourceActorClass::Person,
        )],
    );
    let delivery = deliver_list(&w)
        .into_iter()
        .find(|d| d.trigger.event.kind == "comment")
        .unwrap();
    let body = "GitHub update · comment by bob on issue #1: Another task https://github.com/alice/repo/issues/1";
    apply(
        &w.module,
        "prepare-handback",
        command(SourceCommand::PrepareThreadDeliveryBatch {
            message_id: "external-update".into(),
            delivery_ids: vec![delivery.id],
            body: body.into(),
        }),
    );
    apply(
        &w.module,
        "bind-external",
        ProjectWorkspaceIntent::BindChatInbound {
            session_id: "intake-chat".into(),
            run_id: "run".into(),
            delivery_id: "external-update".into(),
            body_hash: crate::document::sha256(body.as_bytes()),
            attachment_count: 0,
            author: ProjectWorkspaceInboxSource::User,
        },
    );
    let mut handback = agent(
        "intake-chat",
        ProjectWorkspaceIntent::HandBackMessage {
            reason: "This is separate work".into(),
            page_id: "019d0000-0000-7000-8000-000000000095".into(),
            document_id: "019d0000-0000-7000-8000-000000000096".into(),
            message: Some(HandbackMessage {
                text: body.into(),
                files: vec![],
            }),
        },
    );
    if let ProjectWorkspaceIntent::AgentCommand { provenance, .. } = &mut handback {
        provenance.authority.actor_project_id = None;
    }
    apply(&w.module, "handback-external", handback);
    let ProjectWorkspaceReadValue::InboxDispatchContext { context: original } = read(
        &w.module,
        ProjectWorkspaceRead::InboxDispatchContext {
            page_ids: vec![page],
        },
    ) else {
        panic!()
    };
    assert!(matches!(
        original.entries[0].source,
        ProjectWorkspaceInboxSource::Github { .. }
    ));
}
#[test]
fn bots_never_create_intake_and_batch_fences_hold_and_active_chat_replacement() {
    let w = setup();
    batch(
        &w,
        "bot-intake",
        thread(),
        vec![event(
            &w,
            "discovery_mentions",
            "bot:1",
            SourceActorClass::Bot,
        )],
    );
    assert_eq!(
        w.kernel
            .readers()
            .read_default(|c| Ok(c
                .query_row("SELECT count(*) FROM inbox_entries", [], |r| r
                    .get::<_, i64>(0))?))
            .unwrap(),
        0
    );
    board(&w);
    card(&w, PAGE, "chat", true);
    context_follow(&w, "chat", "follow");
    batch(
        &w,
        "human",
        current_thread(&w),
        vec![event(&w, "comment", "human", SourceActorClass::Person)],
    );
    let id = deliver_list(&w)[0].id.clone();
    let peer = "019d0000-0000-7000-8000-000000000097";
    apply(
        &w.module,
        "peer-page",
        ProjectWorkspaceIntent::CreatePageFor {
            target: ProjectWorkspacePageCreationTarget::Project {
                project_id: "project:work".into(),
            },
            page_id: peer.into(),
            document_id: "019d0000-0000-7000-8000-000000000098".into(),
            title: "Other work in this chat".into(),
        },
    );
    apply(
        &w.module,
        "peer-handoff",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "chat".into(),
            intent: ProjectSessionIntent::HandOffPage {
                page_id: peer.into(),
            },
        },
    );
    apply(
        &w.module,
        "pause",
        ProjectWorkspaceIntent::PauseWork {
            scope: ExecutionHoldScope::Page {
                page_id: peer.into(),
            },
        },
    );
    assert!(
        w.kernel
            .readers()
            .read_default(|c| super::super::execution_holds::for_page(c, PAGE))
            .unwrap()
            .is_empty()
    );
    let prepare = SourceCommand::PrepareThreadDeliveryBatch {
        message_id: "github-message".into(),
        delivery_ids: vec![id],
        body: "GitHub update".into(),
    };
    assert!(
        w.module
            .apply(&context(), request("held", command(prepare.clone())))
            .is_err()
    );
    apply(
        &w.module,
        "resume",
        ProjectWorkspaceIntent::ResumeWork {
            scope: ExecutionHoldScope::Page {
                page_id: peer.into(),
            },
        },
    );
    apply(&w.module, "prepare", command(prepare));
    let SourceReadValue::DeliveryBatches { batches } = query(
        &w,
        SourceRead::DeliveryBatches {
            after_message_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    assert!(batches[0].eligible);
    assert!(!batches[0].held);
    apply(
        &w.module,
        "pause-before-attempt",
        ProjectWorkspaceIntent::PauseWork {
            scope: ExecutionHoldScope::Page {
                page_id: peer.into(),
            },
        },
    );
    let SourceReadValue::DeliveryBatches { batches } = query(
        &w,
        SourceRead::DeliveryBatches {
            after_message_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    assert!(batches[0].held);
    assert!(
        w.module
            .apply(
                &context(),
                request(
                    "held-attempt",
                    command(SourceCommand::BeginThreadDeliveryBatch {
                        message_id: "github-message".into()
                    })
                )
            )
            .is_err()
    );
    apply(
        &w.module,
        "resume-before-attempt",
        ProjectWorkspaceIntent::ResumeWork {
            scope: ExecutionHoldScope::Page {
                page_id: peer.into(),
            },
        },
    );
    apply(
        &w.module,
        "archive",
        ProjectWorkspaceIntent::MutateSession {
            session_id: "chat".into(),
            intent: ProjectSessionIntent::SetArchived { archived: true },
        },
    );
    let SourceReadValue::DeliveryBatches { batches } = query(
        &w,
        SourceRead::DeliveryBatches {
            after_message_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    assert!(!batches[0].eligible);
}
#[test]
fn github_handback_preserves_external_author_and_reason() {
    let w = setup();
    board(&w);
    card(&w, PAGE, "chat", true);
    context_follow(&w, "chat", "follow");
    batch(
        &w,
        "update",
        current_thread(&w),
        vec![event(&w, "comment", "human", SourceActorClass::Person)],
    );
    let body = "GitHub update · comment by bob on issue #1: Please review this https://github.com/alice/repo/issues/1";
    apply(
        &w.module,
        "prepare",
        command(SourceCommand::PrepareThreadDeliveryBatch {
            message_id: "github-message".into(),
            delivery_ids: vec![deliver_list(&w)[0].id.clone()],
            body: body.into(),
        }),
    );
    apply(
        &w.module,
        "bind",
        ProjectWorkspaceIntent::BindChatInbound {
            session_id: "chat".into(),
            run_id: "run".into(),
            delivery_id: "github-message".into(),
            body_hash: crate::document::sha256(body.as_bytes()),
            attachment_count: 0,
            author: ProjectWorkspaceInboxSource::User,
        },
    );
    let returned = "019d0000-0000-7000-8000-000000000095";
    apply(
        &w.module,
        "return",
        agent(
            "chat",
            ProjectWorkspaceIntent::HandBackMessage {
                reason: "This needs a different Page".into(),
                page_id: returned.into(),
                document_id: "019d0000-0000-7000-8000-000000000096".into(),
                message: Some(HandbackMessage {
                    text: body.into(),
                    files: vec![],
                }),
            },
        ),
    );
    let ProjectWorkspaceReadValue::InboxEntry { item: Some(item) } = read(
        &w.module,
        ProjectWorkspaceRead::InboxEntry {
            page_id: returned.into(),
        },
    ) else {
        panic!()
    };
    assert!(
        matches!(item.source,ProjectWorkspaceInboxSource::Github{ref actor_login,..} if actor_login=="bob")
    );
    assert_eq!(item.handback.unwrap().reason, "This needs a different Page");
    assert!(item.body.contains(body));
}
#[test]
fn external_intake_refuses_explicit_request_even_when_start_my_requests_is_enabled() {
    let w = setup();
    batch(
        &w,
        "intake",
        thread(),
        vec![event(
            &w,
            "discovery_assigned",
            "assigned",
            SourceActorClass::Person,
        )],
    );
    apply(
        &w.module,
        "prepare",
        ProjectWorkspaceIntent::PrepareInboxSuggestions {
            automatic: true,
            request_id: "request".into(),
            limit: 8,
        },
    );
    let ProjectWorkspaceReadValue::InboxSuggestionRequest {
        request: Some(pending),
    } = read(
        &w.module,
        ProjectWorkspaceRead::InboxSuggestionRequest {
            request_id: "request".into(),
        },
    )
    else {
        panic!()
    };
    let suggestion = ProjectWorkspaceInboxSuggestedDispatch {
        explicit_request: true,
        proposal_id: "proposal".into(),
        page_ids: pending.page_ids,
        action: ProjectWorkspaceInboxDispatchAction::NewChat {
            project_id: None,
            prompt: "Investigate".into(),
            additions: vec![],
            agent: None,
        },
        entry_kind: None,
        summary: "Investigate request".into(),
        rationale: None,
    };
    let settlement = ProjectWorkspaceIntent::SettleInboxSuggestion {
        automatic_dispatch: true,
        request_id: "request".into(),
        generation: pending.generation,
        titles: vec![],
        suggestions: vec![suggestion],
        produced_by: Some("Nodex".into()),
        error: None,
    };
    let error = w
        .module
        .apply(&context(), request("settle-explicit", settlement.clone()))
        .unwrap_err();
    assert_eq!(
        error.code,
        nodex_core_contracts::CoreErrorCode::InvalidInput
    );
    assert!(error.message.contains("explicit_request"));
    let mut settlement = settlement;
    let ProjectWorkspaceIntent::SettleInboxSuggestion { suggestions, .. } = &mut settlement else {
        panic!()
    };
    suggestions[0].explicit_request = false;
    apply(&w.module, "settle", settlement);
    let ProjectWorkspaceReadValue::InboxAutomaticDispatches { proposals } = read(
        &w.module,
        ProjectWorkspaceRead::InboxAutomaticDispatches { limit: 100 },
    ) else {
        panic!()
    };
    assert!(proposals.is_empty());
}
#[test]
fn ingestion_rolls_back_follow_delivery_and_position_together() {
    let w = setup();
    board(&w);
    card(&w, PAGE, "chat", true);
    context_follow(&w, "chat", "follow");
    w.kernel.writer().call(|c|{c.execute_batch("CREATE TRIGGER fail_delivery BEFORE INSERT ON thread_deliveries BEGIN SELECT RAISE(ABORT,'injected');END;")?;Ok(())}).unwrap();
    let e = event(&w, "comment", "rollback", SourceActorClass::Person);
    let p = cursor(&w);
    let intent = command(SourceCommand::IngestSourceBatch {
        source_id: "github".into(),
        config_revision: 1,
        partition: "repo:10".into(),
        expected_position: p.revision,
        lease_token: "lease".into(),
        threads: vec![current_thread(&w)],
        triggers: vec![e],
        next_position: p.cursor,
        next_poll_at_ms: 0,
        quarantine: vec![],
    });
    assert!(w.module.apply(&context(), request("fail", intent)).is_err());
    assert_eq!(cursor(&w).revision, 0);
    assert!(deliver_list(&w).is_empty());
    let SourceReadValue::Triggers { triggers } = query(
        &w,
        SourceRead::Triggers {
            thread_url: thread().url,
            before_id: None,
            limit: 100,
        },
    ) else {
        panic!()
    };
    assert!(triggers.is_empty());
}
#[test]
fn discovering_an_own_pr_refuses_forks_and_branch_name_similarity() {
    let w = setup();
    board(&w);
    card(&w, PAGE, "chat", false);
    claim_workspace(&w);
    let mut t = thread();
    t.kind = ExternalThreadKind::PullRequest;
    t.url = "https://github.com/alice/repo/pull/1".into();
    t.head = Some(SourcePullRequestHead {
        repository_id: "20".into(),
        repository: "fork/repo".into(),
        branch: "nodex-1-work".into(),
        sha: "a".repeat(40),
    });
    batch(&w, "fork-first", t, vec![]);
    assert!(follow_list(&w, PAGE).is_empty());
    let mut t = current_thread(&w);
    let h = t.head.as_mut().unwrap();
    h.repository_id = "10".into();
    h.repository = "alice/repo".into();
    h.branch = "nodex-1-work-copy".into();
    batch(&w, "similar-branch", t, vec![]);
    assert!(follow_list(&w, PAGE).is_empty());
    let mut t = current_thread(&w);
    t.head.as_mut().unwrap().branch = "nodex-1-work".into();
    batch(&w, "exact-head", t, vec![]);
    assert_eq!(follow_list(&w, PAGE)[0].role, ThreadFollowRole::OwnPr);
}
#[test]
fn large_discovery_updates_keep_ingestion_live_without_growing_an_unbounded_intake() {
    let w = setup();
    let events = (0..12)
        .map(|n| {
            let mut e = event(
                &w,
                "discovery_mentions",
                &format!("large-{n}"),
                SourceActorClass::Person,
            );
            e.text = Some("x".repeat(65536));
            e
        })
        .collect();
    batch(&w, "large-intake", thread(), events);
    let (entries,triggers,length)=w.kernel.readers().read_default(|c|Ok(c.query_row("SELECT (SELECT count(*) FROM inbox_entries),(SELECT count(*) FROM github_intake_triggers),(SELECT length(m.markdown) FROM github_intakes i JOIN pages p ON p.block_id=i.page_id JOIN document_materializations m ON m.document_id=p.document_id)",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?)))?)).unwrap();
    assert_eq!((entries, triggers), (1, 12));
    assert!(length <= 65536);
    assert_eq!(cursor(&w).revision, 1);
}

#[path = "channel_activity_tests.rs"]
mod channel_activity;

#[path = "inbox_chat_relocation_tests.rs"]
mod inbox_chat_relocation;
