use nodex_core_contracts::agent::AgentTurnProvenance;
use nodex_core_contracts::collection::CollectionWindowRequest;
use nodex_core_contracts::inbox::{
    ProjectWorkspaceInboxDispatchAction, ProjectWorkspaceInboxEntryKind,
    ProjectWorkspaceInboxEntryState, ProjectWorkspaceInboxItem, ProjectWorkspaceInboxLocation,
    ProjectWorkspaceInboxMessageEdit, ProjectWorkspaceInboxProjectCount,
    ProjectWorkspaceInboxProposalOrigin, ProjectWorkspaceInboxProposalState,
    ProjectWorkspaceInboxScope, ProjectWorkspaceInboxSource, ProjectWorkspaceInboxSuggestionInput,
    ProjectWorkspaceInboxSuggestionState, ProjectWorkspaceInboxSummary,
    ProjectWorkspaceInboxWindowFilter,
};
use nodex_core_contracts::workspace::{
    ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
    ProjectWorkspaceTurnAuthority,
};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, CoreErrorCode, ModuleReadRequest,
    PROJECT_WORKSPACE_CONTRACT_VERSION,
};

use super::ProjectWorkspaceModule;
use super::test_support::{
    TestWorkspace, context, create_session_thread, request, seeded_workspace,
};

fn host() -> BoundModuleContext {
    BoundModuleContext {
        project_id: None,
        adapter: AdapterKind::ElectronHost,
        ..context()
    }
}

fn apply_host(module: &ProjectWorkspaceModule, operation_id: &str, intent: ProjectWorkspaceIntent) {
    module
        .apply(&host(), request(operation_id, intent))
        .unwrap_or_else(|error| panic!("{operation_id}: {}", error.message));
}

fn apply_host_error(
    module: &ProjectWorkspaceModule,
    operation_id: &str,
    intent: ProjectWorkspaceIntent,
) -> CoreErrorCode {
    module
        .apply(&host(), request(operation_id, intent))
        .expect_err(operation_id)
        .code
}

fn read_host(
    module: &ProjectWorkspaceModule,
    read: ProjectWorkspaceRead,
) -> ProjectWorkspaceReadValue {
    module
        .read(
            &host(),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read,
            },
        )
        .expect("Inbox read")
        .value
}

const PROJECT: &str = "project:default";

fn project_scope() -> ProjectWorkspaceInboxScope {
    ProjectWorkspaceInboxScope::Project {
        project_id: PROJECT.into(),
    }
}

fn send(module: &ProjectWorkspaceModule, id: &str, text: &str) {
    send_to(module, id, text, None);
}

fn send_to(module: &ProjectWorkspaceModule, id: &str, text: &str, project_id: Option<&str>) {
    apply_host(
        module,
        &format!("send:{id}"),
        ProjectWorkspaceIntent::SendInboxMessage {
            expected_store_epoch: None,
            page_id: format!("page:{id}"),
            document_id: format!("document:{id}"),
            body: text.to_owned(),
            title: None,
            project_id: project_id.map(str::to_owned),
        },
    );
}

fn window(
    module: &ProjectWorkspaceModule,
    filter: ProjectWorkspaceInboxWindowFilter,
) -> Vec<ProjectWorkspaceInboxItem> {
    window_in(module, ProjectWorkspaceInboxScope::Library, filter)
}

fn window_in(
    module: &ProjectWorkspaceModule,
    scope: ProjectWorkspaceInboxScope,
    filter: ProjectWorkspaceInboxWindowFilter,
) -> Vec<ProjectWorkspaceInboxItem> {
    let ProjectWorkspaceReadValue::InboxWindow { items } = read_host(
        module,
        ProjectWorkspaceRead::InboxWindow {
            scope,
            filter,
            window: CollectionWindowRequest {
                after: None,
                first: Some(50),
            },
        },
    ) else {
        panic!("Inbox window");
    };
    items.items
}

fn summary(module: &ProjectWorkspaceModule) -> ProjectWorkspaceInboxSummary {
    summary_in(module, ProjectWorkspaceInboxScope::Library)
}

fn summary_in(
    module: &ProjectWorkspaceModule,
    scope: ProjectWorkspaceInboxScope,
) -> ProjectWorkspaceInboxSummary {
    let ProjectWorkspaceReadValue::InboxSummary { summary } =
        read_host(module, ProjectWorkspaceRead::InboxSummary { scope })
    else {
        panic!("Inbox summary");
    };
    summary
}

fn pending(module: &ProjectWorkspaceModule) -> Vec<ProjectWorkspaceInboxSuggestionInput> {
    let ProjectWorkspaceReadValue::InboxPendingSuggestions { entries } = read_host(
        module,
        ProjectWorkspaceRead::InboxPendingSuggestions { limit: 16 },
    ) else {
        panic!("pending suggestions");
    };
    entries
}

fn propose(
    module: &ProjectWorkspaceModule,
    proposal_id: &str,
    entry: &ProjectWorkspaceInboxSuggestionInput,
    action: ProjectWorkspaceInboxDispatchAction,
) {
    apply_host(
        module,
        &format!("propose:{proposal_id}"),
        ProjectWorkspaceIntent::ProposeInboxDispatch {
            proposal_id: proposal_id.to_owned(),
            page_ids: vec![entry.page_id.clone()],
            basis: vec![entry.basis.clone()],
            action,
            entry_kind: Some(ProjectWorkspaceInboxEntryKind::Question),
            summary: "Compare both positions".to_owned(),
            rationale: Some("This is still an open question".to_owned()),
            produced_by: Some("Test".to_owned()),
        },
    );
}

fn count(workspace: &TestWorkspace, sql: &'static str) -> i64 {
    workspace
        .kernel
        .readers()
        .read_default(move |connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .expect("count")
}

#[test]
fn sending_creates_one_hidden_inbox_and_streams_messages_newest_first() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(
        module,
        "one",
        "Maybe the homepage should feel like an assistant",
    );
    send(
        module,
        "two",
        "Fix the sidebar flicker\n\nIt happens on hover.\n",
    );

    assert_eq!(count(&workspace, "SELECT count(*) FROM inbox_registry"), 1);
    assert_eq!(
        count(
            &workspace,
            "SELECT count(*) FROM database_containers WHERE name = 'Inbox'"
        ),
        1
    );
    let items = window(module, ProjectWorkspaceInboxWindowFilter::Inbox);
    assert_eq!(
        items
            .iter()
            .map(|item| item.page_id.as_str())
            .collect::<Vec<_>>(),
        vec!["page:two", "page:one"]
    );
    assert!(window(module, ProjectWorkspaceInboxWindowFilter::Processed).is_empty());
    let newest = &items[0];
    // The whole message is the body, as Nested Markdown; Blocks carry their own spacing,
    // so the blank line between them is not kept. The title only labels it.
    assert_eq!(newest.body, "Fix the sidebar flicker\nIt happens on hover.");
    assert_eq!(newest.title, "Fix the sidebar flicker");
    assert_eq!(newest.source, ProjectWorkspaceInboxSource::User);
    assert_eq!(newest.location, ProjectWorkspaceInboxLocation::Inbox);
    assert_eq!(newest.state, ProjectWorkspaceInboxEntryState::Open);
    assert_eq!(
        newest.suggestion_state,
        ProjectWorkspaceInboxSuggestionState::Pending
    );
    assert!(newest.page_key.as_deref().is_some_and(|key| key == "IN-2"));
    assert_eq!(
        items[1].body,
        "Maybe the homepage should feel like an assistant"
    );
    assert!(pending(module).iter().all(|entry| entry.title_provisional));
    let summary = summary(module);
    assert_eq!(summary.entry_count, 2);
    assert_eq!(summary.inbox_count, 2);
    assert_eq!(summary.pending_suggestion_count, 2);
    assert!(summary.database_id.is_some());
    // The Inbox has its own entry point and never appears as a standalone Library root.
    assert_eq!(
        count(
            &workspace,
            "SELECT count(*) FROM library_block_placements placement \
             WHERE placement.block_id IN (SELECT database_block_id FROM inbox_registry)"
        ),
        1
    );
}

#[test]
fn project_selection_preserves_the_profile_inbox() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    module
        .apply(
            &context(),
            request(
                "project-send",
                ProjectWorkspaceIntent::SendInboxMessage {
                    expected_store_epoch: None,
                    page_id: "page:cross-project".into(),
                    document_id: "document:cross-project".into(),
                    body: "Shared Profile message".into(),
                    title: None,
                    project_id: None,
                },
            ),
        )
        .expect("selected Project does not fence the Inbox");
    let read = module
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::InboxSummary {
                    scope: ProjectWorkspaceInboxScope::Library,
                },
            },
        )
        .expect("same Profile Inbox");
    let ProjectWorkspaceReadValue::InboxSummary { summary } = read.value else {
        panic!("summary")
    };
    assert_eq!(summary.entry_count, 1);
    assert_eq!(
        window(module, ProjectWorkspaceInboxWindowFilter::Inbox)[0].body,
        "Shared Profile message"
    );
}

#[test]
fn confirmed_new_chat_creates_one_session_and_enters_the_outbox() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(
        module,
        "idea",
        "Research how other assistants onboard users",
    );
    let entry = pending(module).remove(0);
    propose(
        module,
        "proposal:1",
        &entry,
        ProjectWorkspaceInboxDispatchAction::NewChat {
            project_id: Some("project:default".into()),
            prompt: "Survey three assistant onboarding flows; do not change code.".into(),
        },
    );
    assert!(pending(module).is_empty());
    let item = window(module, ProjectWorkspaceInboxWindowFilter::Inbox).remove(0);
    let proposal = item.proposal.expect("suggestion");
    assert_eq!(proposal.state, ProjectWorkspaceInboxProposalState::Open);
    assert_eq!(proposal.origin, ProjectWorkspaceInboxProposalOrigin::Agent);
    assert_eq!(proposal.target_project_name.as_deref(), Some("Nodex"));
    assert_eq!(item.kind, Some(ProjectWorkspaceInboxEntryKind::Question));
    assert_eq!(summary(module).needs_decision_count, 1);

    let confirm = ProjectWorkspaceIntent::ConfirmInboxDispatch {
        expected_store_epoch: "epoch-1".into(),
        basis: proposal_basis(module, "proposal:1"),
        execution_selection: Some(selection()),
        proposal_id: "proposal:1".into(),
        expected_revision: proposal.revision,
        action: None,
        session_id: Some("session:dispatched".into()),
    };
    let first = module
        .apply(&host(), request("confirm:1", confirm.clone()))
        .expect("confirm");
    assert_eq!(
        first.committed.value.affected_session_ids,
        vec!["session:dispatched"]
    );
    let replay = module
        .apply(&host(), request("confirm:1", confirm.clone()))
        .expect("idempotent confirm");
    assert!(replay.committed.receipt.mutation.duplicate);
    assert_eq!(
        apply_host_error(module, "confirm:again", confirm),
        CoreErrorCode::RevisionConflict
    );
    assert_eq!(
        count(
            &workspace,
            "SELECT count(*) FROM project_sessions WHERE id = 'session:dispatched'"
        ),
        1
    );

    let ProjectWorkspaceReadValue::InboxDispatchOutbox { dispatches } = read_host(
        module,
        ProjectWorkspaceRead::InboxDispatchOutbox { limit: 16 },
    ) else {
        panic!("outbox");
    };
    assert_eq!(dispatches.len(), 1);
    assert_eq!(dispatches[0].session_id, "session:dispatched");
    assert_eq!(dispatches[0].project_id.as_deref(), Some("project:default"));
    assert_eq!(dispatches[0].page_ids, vec!["page:idea"]);
    assert_eq!(summary(module).dispatching_count, 1);
    // A confirmed dispatch is handled: it leaves the Inbox while it is delivered.
    assert!(window(module, ProjectWorkspaceInboxWindowFilter::Inbox).is_empty());
    assert_eq!(summary(module).inbox_count, 0);

    apply_host(
        module,
        "complete:1",
        ProjectWorkspaceIntent::CompleteInboxDispatch {
            expected_revision: dispatches[0].revision,
            message_id: dispatches[0].message_id.clone(),
            proposal_id: "proposal:1".into(),
            dispatched_thread_id: Some("thread:dispatched".into()),
        },
    );
    let item = window(module, ProjectWorkspaceInboxWindowFilter::Processed).remove(0);
    let proposal = item.proposal.expect("completed suggestion");
    assert_eq!(
        proposal.state,
        ProjectWorkspaceInboxProposalState::Completed
    );
    assert_eq!(
        proposal.chat.as_ref().map(|chat| chat.session_id.as_str()),
        Some("session:dispatched")
    );
    assert_eq!(summary(module).dispatching_count, 0);
}

#[test]
fn edited_messages_invalidate_unedited_suggestions() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "stale", "Tighten the onboarding copy");
    let mut entry = pending(module).remove(0);
    entry.basis.head_seq += 7;
    assert_eq!(
        apply_host_error(
            module,
            "propose:stale",
            ProjectWorkspaceIntent::ProposeInboxDispatch {
                proposal_id: "proposal:stale".into(),
                page_ids: vec![entry.page_id.clone()],
                basis: vec![entry.basis],
                action: ProjectWorkspaceInboxDispatchAction::Keep,
                entry_kind: None,
                summary: "Keep".into(),
                rationale: None,
                produced_by: None,
            },
        ),
        CoreErrorCode::Conflict
    );
}

#[test]
fn keep_dismisses_suggestions_and_states_filter_the_stream() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "note", "The Linear changelog layout is nice");
    let entry = pending(module).remove(0);
    propose(
        module,
        "proposal:note",
        &entry,
        ProjectWorkspaceInboxDispatchAction::NewChat {
            project_id: None,
            prompt: "Study it".into(),
        },
    );
    apply_host(
        module,
        "keep:note",
        ProjectWorkspaceIntent::KeepInboxEntries {
            page_ids: vec!["page:note".into()],
        },
    );
    assert!(window(module, ProjectWorkspaceInboxWindowFilter::Inbox).is_empty());
    let kept = window(module, ProjectWorkspaceInboxWindowFilter::Processed);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].state, ProjectWorkspaceInboxEntryState::Kept);
    assert_eq!(
        kept[0].proposal.as_ref().map(|proposal| proposal.state),
        Some(ProjectWorkspaceInboxProposalState::Dismissed)
    );
    assert_eq!(summary(module).needs_decision_count, 0);
    apply_host(
        module,
        "done:note",
        ProjectWorkspaceIntent::SetInboxEntryState {
            page_ids: vec!["page:note".into()],
            state: ProjectWorkspaceInboxEntryState::Done,
        },
    );
    assert_eq!(
        window(module, ProjectWorkspaceInboxWindowFilter::Processed)[0].state,
        ProjectWorkspaceInboxEntryState::Done
    );

    apply_host(
        module,
        "resuggest:note",
        ProjectWorkspaceIntent::RequestInboxSuggestion {
            request_id: "request:note".into(),
            mode: nodex_core_contracts::inbox::ProjectWorkspaceInboxSuggestionMode::Auto,
            basis: pages_basis(module, vec!["page:note".into()]),
            proposal_id: None,
            expected_revision: None,
            correction: None,
            page_ids: vec!["page:note".into()],
        },
    );
    assert_eq!(pending(module).len(), 1);
    apply_host(
        module,
        "fail:note",
        ProjectWorkspaceIntent::RecordInboxSuggestionFailure {
            page_ids: vec!["page:note".into()],
            message: "Model unavailable".into(),
        },
    );
    // Asking again reopens it, so it is back in the Inbox even though its suggestion failed.
    let item = window(module, ProjectWorkspaceInboxWindowFilter::Inbox).remove(0);
    assert_eq!(
        item.suggestion_state,
        ProjectWorkspaceInboxSuggestionState::Failed
    );
    assert_eq!(item.suggestion_error.as_deref(), Some("Model unavailable"));
}

#[test]
fn user_dispatch_to_a_started_chat_carries_its_thread() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    create_session_thread(
        module,
        "target",
        "session:target",
        "thread:target",
        Some("project:default"),
        1,
    );
    send(module, "follow-up", "Also cover the empty state");
    apply_host(
        module,
        "dispatch:follow-up",
        ProjectWorkspaceIntent::DispatchInboxEntries {
            expected_store_epoch: "epoch-1".into(),
            basis: pages_basis(module, vec!["page:follow-up".into()]),
            execution_selection: Some(selection()),
            proposal_id: "proposal:manual".into(),
            page_ids: vec!["page:follow-up".into()],
            action: ProjectWorkspaceInboxDispatchAction::SendToChat {
                session_id: "session:target".into(),
                prompt: "Also cover the empty state".into(),
            },
            session_id: None,
        },
    );
    let ProjectWorkspaceReadValue::InboxDispatchOutbox { dispatches } = read_host(
        module,
        ProjectWorkspaceRead::InboxDispatchOutbox { limit: 16 },
    ) else {
        panic!("outbox");
    };
    assert_eq!(dispatches[0].thread_id.as_deref(), Some("thread:target"));
    let item = window(module, ProjectWorkspaceInboxWindowFilter::Processed).remove(0);
    let proposal = item.proposal.expect("manual dispatch");
    assert_eq!(proposal.origin, ProjectWorkspaceInboxProposalOrigin::User);
    assert_eq!(
        proposal.state,
        ProjectWorkspaceInboxProposalState::Dispatching
    );
    assert_eq!(
        proposal.chat.map(|chat| chat.display_title),
        Some("thread:target".to_owned())
    );

    apply_host(
        module,
        "fail:follow-up",
        ProjectWorkspaceIntent::FailInboxDispatch {
            expected_revision: dispatches[0].revision,
            message_id: dispatches[0].message_id.clone(),
            failure_kind:
                nodex_core_contracts::inbox::ProjectWorkspaceInboxFailureKind::Unavailable,
            proposal_id: "proposal:manual".into(),
            message: "Chat is busy".into(),
        },
    );
    apply_host(
        module,
        "retry:follow-up",
        ProjectWorkspaceIntent::RetryInboxDispatch {
            proposal_id: "proposal:manual".into(),
        },
    );
    assert_eq!(summary(module).dispatching_count, 1);
}

#[test]
fn confirming_a_move_owns_the_library_relocation() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "task", "Add keyboard shortcuts to the Board");
    let entry = pending(module).remove(0);
    propose(
        module,
        "proposal:move",
        &entry,
        ProjectWorkspaceInboxDispatchAction::MoveToProject {
            project_id: "project:default".into(),
        },
    );
    apply_host(
        module,
        "confirm:move",
        ProjectWorkspaceIntent::ConfirmInboxDispatch {
            expected_store_epoch: "epoch-1".into(),
            basis: proposal_basis(module, "proposal:move"),
            execution_selection: None,
            proposal_id: "proposal:move".into(),
            expected_revision: 1,
            action: None,
            session_id: None,
        },
    );
    let item = window(module, ProjectWorkspaceInboxWindowFilter::Processed).remove(0);
    assert_eq!(
        item.outcome,
        Some(nodex_core_contracts::inbox::ProjectWorkspaceInboxOutcome::Moved)
    );
}

#[test]
fn agents_capture_authenticated_provenance_with_a_replay_safe_turn_cap() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    create_session_thread(
        module,
        "source",
        "session:source",
        "thread:source",
        Some("project:default"),
        1,
    );
    super::test_support::apply(
        module,
        "admit:write",
        ProjectWorkspaceIntent::AdmitTurnAuthority {
            thread_id: "thread:source".into(),
            turn_id: "write".into(),
            root_thread_id: "thread:source".into(),
            actor_project_id: Some("project:default".into()),
        },
    );
    let command = |turn: &str, id: &str| ProjectWorkspaceIntent::AgentCommand {
        provenance: Box::new(AgentTurnProvenance {
            profile_id: "profile-1".into(),
            authority: ProjectWorkspaceTurnAuthority {
                thread_id: "thread:source".into(),
                turn_id: turn.into(),
                root_thread_id: "thread:source".into(),
                actor_project_id: Some("project:default".into()),
                library_id: "library-1".into(),
                store_epoch: "epoch-1".into(),
                runtime: None,
            },
        }),
        intent: Box::new(ProjectWorkspaceIntent::SendInboxMessage {
            expected_store_epoch: None,
            page_id: format!("page:{id}"),
            document_id: format!("document:{id}"),
            body: "The settings buttons are missing accessible labels".into(),
            title: Some("Label the  settings buttons".into()),
            project_id: None,
        }),
    };
    let agent = BoundModuleContext {
        adapter: AdapterKind::Agent,
        ..context()
    };
    module
        .apply(&agent, request("agent:write", command("write", "agent")))
        .expect("Agent Inbox drop");
    // The Turn works in the default Project, so its message waits in that Project's Inbox.
    assert!(window(module, ProjectWorkspaceInboxWindowFilter::Inbox).is_empty());
    let item = window_in(
        module,
        project_scope(),
        ProjectWorkspaceInboxWindowFilter::Inbox,
    )
    .remove(0);
    assert_eq!(item.scope, project_scope());
    // A sender's own title is final; only Core's provisional title is open to naming.
    assert_eq!(item.title, "Label the settings buttons");
    assert_eq!(
        item.body,
        "The settings buttons are missing accessible labels"
    );
    assert!(!pending(module)[0].title_provisional);
    assert_eq!(
        item.source,
        ProjectWorkspaceInboxSource::Agent {
            session_id: Some("session:source".into()),
            thread_id: Some("thread:source".into()),
            run_id: Some("write".into()),
            project_id: Some("project:default".into()),
            label: "thread:source".into(),
        }
    );

    let cap = super::inbox::MAX_AGENT_MESSAGES_PER_TURN;
    for index in 1..cap {
        module
            .apply(
                &agent,
                request(
                    &format!("agent:write:{index}"),
                    command("write", &format!("agent-{index}")),
                ),
            )
            .expect("Agent Inbox drop within the Turn cap");
    }
    assert_eq!(
        module
            .apply(&agent, request("agent:over", command("write", "over")))
            .expect_err("Turn cap")
            .code,
        CoreErrorCode::ResourceExhausted
    );
    let replay = module
        .apply(&agent, request("agent:write", command("write", "agent")))
        .expect("an idempotent replay is not a new message");
    assert!(replay.committed.receipt.mutation.duplicate);
    assert_eq!(
        window_in(
            module,
            project_scope(),
            ProjectWorkspaceInboxWindowFilter::Inbox
        )
        .len(),
        usize::try_from(cap).expect("cap")
    );
}

#[test]
fn command_line_sends_are_labeled_with_their_project() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    let command_line = |project: bool| BoundModuleContext {
        adapter: AdapterKind::NativeCli,
        project_id: if project { context().project_id } else { None },
        ..context()
    };
    let intent = |id: &str| ProjectWorkspaceIntent::SendInboxMessage {
        expected_store_epoch: None,
        page_id: format!("page:{id}"),
        document_id: format!("document:{id}"),
        body: "Benchmark search on the large fixture".into(),
        title: None,
        project_id: None,
    };
    module
        .apply(
            &command_line(false),
            request("cli:library", intent("library")),
        )
        .expect("Library-wide command line send");
    module
        .apply(
            &command_line(true),
            request("cli:project", intent("project")),
        )
        .expect("Project-scoped command line send");
    let project_items = window_in(
        module,
        project_scope(),
        ProjectWorkspaceInboxWindowFilter::Inbox,
    );
    assert_eq!(project_items.len(), 1);
    let ProjectWorkspaceInboxSource::CommandLine {
        project_id: Some(project_id),
        label,
    } = &project_items[0].source
    else {
        panic!("Project-scoped source: {:?}", project_items[0].source);
    };
    assert_eq!(project_id, PROJECT);
    // The Project's Inbox already names the Project.
    assert_eq!(label, "Command line");
    let library_items = window(module, ProjectWorkspaceInboxWindowFilter::Inbox);
    assert_eq!(library_items.len(), 1);
    assert_eq!(
        library_items[0].source,
        ProjectWorkspaceInboxSource::CommandLine {
            project_id: None,
            label: "Command line".into(),
        }
    );

    let read = module
        .read(
            &command_line(true),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::InboxSummary {
                    scope: ProjectWorkspaceInboxScope::Library,
                },
            },
        )
        .expect("command line reads the current Profile Inbox");
    let ProjectWorkspaceReadValue::InboxSummary { summary } = read.value else {
        panic!("summary")
    };
    assert_eq!(summary.entry_count, 1);
    module
        .apply(
            &command_line(true),
            request(
                "cli:keep",
                ProjectWorkspaceIntent::SetInboxEntryState {
                    page_ids: vec!["page:project".into()],
                    state: ProjectWorkspaceInboxEntryState::Kept,
                },
            ),
        )
        .expect("selected Project does not fence triage");
    assert_eq!(
        window_in(
            module,
            project_scope(),
            ProjectWorkspaceInboxWindowFilter::Processed
        )[0]
        .page_id,
        "page:project"
    );
}

#[test]
fn routing_context_is_bounded_to_active_targets() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    create_session_thread(
        module,
        "recent",
        "session:recent",
        "thread:recent",
        Some("project:default"),
        5,
    );
    send(module, "ctx", "Where should this go?");
    let ProjectWorkspaceReadValue::InboxDispatchContext { context } = read_host(
        module,
        ProjectWorkspaceRead::InboxDispatchContext {
            page_ids: vec!["page:ctx".into()],
        },
    ) else {
        panic!("context");
    };
    assert_eq!(context.entries.len(), 1);
    assert_eq!(context.entries[0].title, "Where should this go?");
    assert_eq!(
        context
            .projects
            .iter()
            .map(|project| project.project_id.as_str())
            .collect::<Vec<_>>(),
        vec!["project:default"]
    );
    assert_eq!(context.sessions[0].session_id, "session:recent");
}

#[test]
fn provisional_titles_are_short_labels_of_the_opening_words() {
    use super::inbox::provisional_title;
    assert_eq!(provisional_title("  Fix   the flicker "), "Fix the flicker");
    assert_eq!(
        provisional_title(
            "Compare how three assistants onboard new users and write a one-page summary"
        ),
        "Compare how three assistants onboard new users…"
    );
    // Wide characters count twice, so a Chinese label stays about as wide as an English one.
    assert_eq!(
        provisional_title("首页现在看起来像开发者工具，也许应该更像一个个人助理，你觉得呢"),
        "首页现在看起来像开发者工具，也许应该更像一个个人…"
    );
}

#[test]
fn deleting_a_message_erases_it_and_every_suggestion_that_names_it() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(
        module,
        "secret",
        "Use the key sk-live-0123456789 for staging",
    );
    send(module, "sibling", "Also rotate the staging credentials");
    let entries = pending(module);
    // One grouped suggestion covers both messages and quotes the secret.
    apply_host(
        module,
        "propose:group",
        ProjectWorkspaceIntent::ProposeInboxDispatch {
            proposal_id: "proposal:group".into(),
            page_ids: entries.iter().map(|entry| entry.page_id.clone()).collect(),
            basis: entries.iter().map(|entry| entry.basis.clone()).collect(),
            action: ProjectWorkspaceInboxDispatchAction::NewChat {
                project_id: None,
                prompt: "Configure staging with sk-live-0123456789".into(),
            },
            entry_kind: Some(ProjectWorkspaceInboxEntryKind::Todo),
            summary: "Set up staging with the key".into(),
            rationale: None,
            produced_by: Some("Test".into()),
        },
    );
    // An edit burst that has not become a revision yet must not outlive the erasure either.
    workspace
        .kernel
        .writer()
        .call(|connection| {
            connection.execute(
                "INSERT INTO document_revision_sessions( \
                   document_id, generation, dirty_head_seq, burst_started_at, last_edit_at, \
                   client_session_id \
                 ) VALUES ('document:secret', 1, 1, ?1, ?1, 'renderer:editor')",
                [super::test_support::NOW],
            )?;
            Ok(())
        })
        .expect("open edit burst");
    apply_host(
        module,
        "delete:secret",
        ProjectWorkspaceIntent::DeleteInboxMessages {
            page_ids: vec!["page:secret".into()],
        },
    );

    let items = window(module, ProjectWorkspaceInboxWindowFilter::Inbox);
    assert_eq!(
        items
            .iter()
            .map(|item| item.page_id.as_str())
            .collect::<Vec<_>>(),
        vec!["page:sibling"]
    );
    // The sibling loses the suggestion that quoted the secret and waits for a new one.
    assert!(items[0].proposal.is_none());
    assert_eq!(
        items[0].suggestion_state,
        ProjectWorkspaceInboxSuggestionState::Pending
    );
    assert!(window(module, ProjectWorkspaceInboxWindowFilter::Processed).is_empty());
    assert_eq!(count(&workspace, "SELECT count(*) FROM inbox_proposals"), 0);
    assert_eq!(
        count(
            &workspace,
            "SELECT count(*) FROM blocks WHERE id = 'page:secret' AND lifecycle = 'deleted'"
        ),
        1
    );
    assert_eq!(
        count(
            &workspace,
            "SELECT count(*) FROM document_versions WHERE document_id = 'document:secret'"
        ),
        0
    );
    assert_eq!(
        count(
            &workspace,
            "SELECT count(*) FROM block_erasure_requests WHERE root_block_id = 'page:secret'"
        ),
        1
    );

    // Privacy erasure bypasses ordinary trash retention while preserving the transaction.
    workspace
        .kernel
        .writer()
        .call(|connection| {
            crate::document::run_block_retention_pass(connection, 10_000)?;
            Ok(())
        })
        .expect("block retention");
    for sql in [
        "SELECT count(*) FROM blocks WHERE id = 'page:secret'",
        "SELECT count(*) FROM documents WHERE id = 'document:secret'",
        "SELECT count(*) FROM document_updates WHERE document_id = 'document:secret'",
        "SELECT count(*) FROM document_materializations WHERE document_id = 'document:secret'",
        "SELECT count(*) FROM block_erasure_requests",
    ] {
        assert_eq!(count(&workspace, sql), 0, "{sql}");
    }
    assert_eq!(
        count(
            &workspace,
            "SELECT count(*) FROM blocks WHERE id = 'page:sibling'"
        ),
        1
    );
}

#[test]
fn deleting_keeps_handled_neighbours_handled_and_refuses_filed_pages() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "a", "Survey onboarding flows");
    send(module, "b", "Include the empty states");
    apply_host(
        module,
        "dispatch:ab",
        ProjectWorkspaceIntent::DispatchInboxEntries {
            expected_store_epoch: "epoch-1".into(),
            basis: pages_basis(module, vec!["page:a".into(), "page:b".into()]),
            execution_selection: Some(selection()),
            proposal_id: "proposal:ab".into(),
            page_ids: vec!["page:a".into(), "page:b".into()],
            action: ProjectWorkspaceInboxDispatchAction::NewChat {
                project_id: None,
                prompt: "Survey onboarding flows and their empty states".into(),
            },
            session_id: Some("session:ab".into()),
        },
    );
    let delivery = outbox(module).remove(0);
    apply_host(
        module,
        "complete:ab",
        ProjectWorkspaceIntent::CompleteInboxDispatch {
            proposal_id: delivery.proposal_id,
            expected_revision: delivery.revision,
            message_id: delivery.message_id,
            dispatched_thread_id: Some("thread:accepted".into()),
        },
    );
    apply_host(
        module,
        "delete:a",
        ProjectWorkspaceIntent::DeleteInboxMessages {
            page_ids: vec!["page:a".into()],
        },
    );
    // The other message was already dispatched, so it stays handled rather than resurfacing.
    let processed = window(module, ProjectWorkspaceInboxWindowFilter::Processed);
    assert_eq!(processed.len(), 1);
    assert_eq!(processed[0].page_id, "page:b");
    assert_eq!(processed[0].state, ProjectWorkspaceInboxEntryState::Done);
    assert!(window(module, ProjectWorkspaceInboxWindowFilter::Inbox).is_empty());
    assert_eq!(
        apply_host_error(
            module,
            "delete:missing",
            ProjectWorkspaceIntent::DeleteInboxMessages {
                page_ids: vec!["page:a".into()],
            },
        ),
        CoreErrorCode::NotFound
    );
}

fn runtime_session(module: &ProjectWorkspaceModule) {
    apply_host(
        module,
        "runtime-session",
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            session_id: "session:runtime-source".into(),
            project_id: Some("project:default".into()),
            title: "Background work".into(),
            initial_page_ids: vec![],
            runtime_id: "runtime:inbox".into(),
            runtime_thread_id: "thread:runtime-root".into(),
            launch_request_id: "launch:runtime-source".into(),
        },
    );
}

fn agent_send(
    module: &ProjectWorkspaceModule,
    provenance: &AgentTurnProvenance,
    id: &str,
) -> Result<super::ProjectWorkspaceApplyOutcome, nodex_core_contracts::CoreError> {
    module.apply(
        &BoundModuleContext {
            adapter: AdapterKind::Agent,
            ..context()
        },
        request(
            &format!("runtime-send:{id}"),
            ProjectWorkspaceIntent::AgentCommand {
                provenance: Box::new(provenance.clone()),
                intent: Box::new(ProjectWorkspaceIntent::SendInboxMessage {
                    expected_store_epoch: None,
                    page_id: format!("page:{id}"),
                    document_id: format!("document:{id}"),
                    body: "A background result".into(),
                    title: None,
                    project_id: None,
                }),
            },
        ),
    )
}

fn runtime_provenance(
    thread_id: &str,
    turn_id: &str,
    turn_kind: nodex_core_contracts::workspace::ProjectWorkspaceAgentRuntimeTurnKind,
) -> AgentTurnProvenance {
    AgentTurnProvenance {
        profile_id: "profile-1".into(),
        authority: ProjectWorkspaceTurnAuthority {
            thread_id: thread_id.into(),
            turn_id: turn_id.into(),
            root_thread_id: "thread:runtime-root".into(),
            actor_project_id: Some("project:default".into()),
            library_id: "library-1".into(),
            store_epoch: "epoch-1".into(),
            runtime: Some(
                nodex_core_contracts::workspace::ProjectWorkspaceAgentRuntimeAuthority {
                    session_id: "session:runtime-source".into(),
                    runtime_id: "runtime:inbox".into(),
                    turn_kind,
                },
            ),
        },
    }
}

#[test]
fn runtime_child_capture_uses_its_bound_session_and_run_after_other_sessions_start() {
    use nodex_core_contracts::workspace::ProjectWorkspaceAgentRuntimeTurnKind;
    let workspace = seeded_workspace();
    let module = &workspace.module;
    runtime_session(module);
    let provenance = runtime_provenance(
        "thread:child-without-sidebar-session",
        "run:child",
        ProjectWorkspaceAgentRuntimeTurnKind::Run,
    );
    create_session_thread(module, "other", "session:other", "thread:other", None, 2);
    agent_send(module, &provenance, "runtime-child")
        .expect("child can capture while another Session runs");
    // The Session belongs to a Project, so its Agent's message waits in that Project's Inbox.
    let item = window_in(
        module,
        project_scope(),
        ProjectWorkspaceInboxWindowFilter::Inbox,
    )
    .remove(0);
    assert_eq!(
        item.source,
        ProjectWorkspaceInboxSource::Agent {
            session_id: Some("session:runtime-source".into()),
            thread_id: Some("thread:child-without-sidebar-session".into()),
            run_id: Some("run:child".into()),
            project_id: Some("project:default".into()),
            label: "Background work".into()
        }
    );
    for i in 1..super::inbox::MAX_AGENT_MESSAGES_PER_TURN {
        agent_send(module, &provenance, &format!("runtime-child:{i}")).expect("within cap");
    }
    assert_eq!(
        agent_send(module, &provenance, "runtime-over")
            .expect_err("one Run keeps one capture budget across engine restarts")
            .code,
        CoreErrorCode::ResourceExhausted
    );
    assert!(
        agent_send(module, &provenance, "runtime-child")
            .unwrap()
            .committed
            .receipt
            .mutation
            .duplicate
    );
    apply_host(
        module,
        "runtime-delete",
        ProjectWorkspaceIntent::DeleteSession {
            session_id: "session:runtime-source".into(),
        },
    );
    assert_eq!(
        agent_send(module, &provenance, "runtime-stale")
            .expect_err("a deleted Session ends its executions")
            .code,
        CoreErrorCode::Unauthorized
    );
}

#[test]
fn native_connection_capture_keeps_unknown_run_empty_with_its_own_budget() {
    use nodex_core_contracts::workspace::ProjectWorkspaceAgentRuntimeTurnKind;
    let workspace = seeded_workspace();
    let module = &workspace.module;
    runtime_session(module);
    let provenance = runtime_provenance(
        "thread:acp-child",
        "connection:one",
        ProjectWorkspaceAgentRuntimeTurnKind::NativeConnection,
    );
    agent_send(module, &provenance, "native-unknown").expect("native caller");
    let ProjectWorkspaceInboxSource::Agent {
        session_id,
        thread_id,
        run_id,
        ..
    } = window_in(
        module,
        project_scope(),
        ProjectWorkspaceInboxWindowFilter::Inbox,
    )
    .remove(0)
    .source
    else {
        panic!("source")
    };
    assert_eq!(session_id.as_deref(), Some("session:runtime-source"));
    assert_eq!(thread_id.as_deref(), Some("thread:acp-child"));
    assert_eq!(run_id, None);
    for i in 1..super::inbox::MAX_AGENT_MESSAGES_PER_TURN {
        agent_send(module, &provenance, &format!("native:{i}")).expect("connection cap");
    }
    assert_eq!(
        agent_send(module, &provenance, "native-over")
            .unwrap_err()
            .code,
        CoreErrorCode::ResourceExhausted
    );
    let next_connection = runtime_provenance(
        "thread:acp-child",
        "connection:two",
        ProjectWorkspaceAgentRuntimeTurnKind::NativeConnection,
    );
    agent_send(module, &next_connection, "native-next").expect("a new connection has its own cap");
}

#[test]
fn runtime_bound_chats_remain_suggestion_and_dispatch_targets() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    runtime_session(module);
    send(
        module,
        "runtime-target",
        "Continue the background investigation",
    );
    let ProjectWorkspaceReadValue::InboxDispatchContext { context } = read_host(
        module,
        ProjectWorkspaceRead::InboxDispatchContext {
            page_ids: vec!["page:runtime-target".into()],
        },
    ) else {
        panic!("context")
    };
    assert!(
        context
            .sessions
            .iter()
            .any(|session| session.session_id == "session:runtime-source")
    );
    let entry = pending(module).remove(0);
    propose(
        module,
        "proposal:runtime-target",
        &entry,
        ProjectWorkspaceInboxDispatchAction::SendToChat {
            session_id: "session:runtime-source".into(),
            prompt: "Continue".into(),
        },
    );
    assert_eq!(
        count(
            &workspace,
            "SELECT count(*) FROM inbox_proposals WHERE state='dispatching'"
        ),
        0
    );
    apply_host(
        module,
        "confirm:runtime-target",
        ProjectWorkspaceIntent::ConfirmInboxDispatch {
            expected_store_epoch: "epoch-1".into(),
            basis: proposal_basis(module, "proposal:runtime-target"),
            execution_selection: Some(selection()),
            proposal_id: "proposal:runtime-target".into(),
            expected_revision: 1,
            action: None,
            session_id: None,
        },
    );
    let ProjectWorkspaceReadValue::InboxDispatchOutbox { dispatches } = read_host(
        module,
        ProjectWorkspaceRead::InboxDispatchOutbox { limit: 8 },
    ) else {
        panic!("outbox")
    };
    assert_eq!(dispatches.len(), 1);
    assert_eq!(
        dispatches[0].thread_id.as_deref(),
        Some("thread:runtime-root")
    );
    let chat = window(module, ProjectWorkspaceInboxWindowFilter::Processed)
        .remove(0)
        .proposal
        .unwrap()
        .chat
        .unwrap();
    assert_eq!(chat.thread_id.as_deref(), Some("thread:runtime-root"));
    assert_eq!(chat.status, None);
}

fn page_parent(workspace: &TestWorkspace, page_id: &str) -> String {
    let page_id = page_id.to_owned();
    workspace
        .kernel
        .readers()
        .read_default(move |connection| {
            Ok(connection.query_row(
                "SELECT parent_id FROM pages WHERE block_id = ?1",
                [&page_id],
                |row| row.get::<_, String>(0),
            )?)
        })
        .expect("Page parent")
}

fn project_data_source(workspace: &TestWorkspace) -> String {
    workspace
        .kernel
        .readers()
        .read_default(|connection| {
            Ok(connection.query_row(
                "SELECT source.id FROM project_database_bindings binding \
                 JOIN data_sources source ON source.home_database_block_id = binding.database_block_id \
                 WHERE binding.project_id = 'project:default'",
                [],
                |row| row.get::<_, String>(0),
            )?)
        })
        .expect("Project Data Source")
}

fn counts(
    module: &ProjectWorkspaceModule,
) -> nodex_core_contracts::inbox::ProjectWorkspaceInboxCounts {
    let ProjectWorkspaceReadValue::InboxCounts { counts } =
        read_host(module, ProjectWorkspaceRead::InboxCounts)
    else {
        panic!("Inbox counts");
    };
    counts
}

#[test]
fn project_messages_become_project_pages_and_wait_in_the_project_inbox() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send_to(
        module,
        "idea",
        "Sidebar hover is too bright in dark mode",
        Some(PROJECT),
    );
    send(module, "loose", "Look into a weekly digest");

    // The Page is born in the Project's Database, so it is already on the Board.
    assert_eq!(
        page_parent(&workspace, "page:idea"),
        project_data_source(&workspace)
    );
    let project_items = window_in(
        module,
        project_scope(),
        ProjectWorkspaceInboxWindowFilter::Inbox,
    );
    assert_eq!(project_items.len(), 1);
    assert_eq!(project_items[0].page_id, "page:idea");
    assert_eq!(project_items[0].scope, project_scope());
    // Location is relative to the message's own Inbox, whose home is the Project's Database.
    assert_eq!(
        project_items[0].location,
        ProjectWorkspaceInboxLocation::Inbox
    );

    // Each Inbox shows and counts only its own messages.
    let library_items = window(module, ProjectWorkspaceInboxWindowFilter::Inbox);
    assert_eq!(library_items.len(), 1);
    assert_eq!(library_items[0].page_id, "page:loose");
    assert_eq!(summary_in(module, project_scope()).inbox_count, 1);
    assert_eq!(summary(module).inbox_count, 1);
    assert_eq!(
        counts(module).projects,
        vec![ProjectWorkspaceInboxProjectCount {
            project_id: PROJECT.into(),
            inbox_count: 1,
        }]
    );
    assert_eq!(counts(module).library_count, 1);

    // A Project's message can be erased from its own Inbox.
    apply_host(
        module,
        "delete:idea",
        ProjectWorkspaceIntent::DeleteInboxMessages {
            page_ids: vec!["page:idea".into()],
        },
    );
    assert!(counts(module).projects.is_empty());
}

#[test]
fn only_the_desktop_app_chooses_a_project_inbox() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    let command_line = BoundModuleContext {
        adapter: AdapterKind::NativeCli,
        project_id: None,
        ..context()
    };
    assert_eq!(
        module
            .apply(
                &command_line,
                request(
                    "cli:choose",
                    ProjectWorkspaceIntent::SendInboxMessage {
                        expected_store_epoch: None,
                        page_id: "page:cli".into(),
                        document_id: "document:cli".into(),
                        body: "Choose for me".into(),
                        title: None,
                        project_id: Some(PROJECT.into()),
                    },
                ),
            )
            .expect_err("command line chooses an Inbox")
            .code,
        CoreErrorCode::Unauthorized
    );
    assert_eq!(
        apply_host_error(
            module,
            "send:missing",
            ProjectWorkspaceIntent::SendInboxMessage {
                expected_store_epoch: None,
                page_id: "page:missing".into(),
                document_id: "document:missing".into(),
                body: "Nowhere".into(),
                title: None,
                project_id: Some("project:missing".into()),
            },
        ),
        CoreErrorCode::NotFound
    );
}

#[test]
fn filing_into_a_project_keeps_the_message_handled_in_its_own_inbox() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "task", "Document the capture shortcut");
    let entry = pending(module).remove(0);
    propose(
        module,
        "proposal:file",
        &entry,
        ProjectWorkspaceInboxDispatchAction::MoveToProject {
            project_id: PROJECT.into(),
        },
    );
    apply_host(
        module,
        "confirm:file",
        ProjectWorkspaceIntent::ConfirmInboxDispatch {
            expected_store_epoch: "epoch-1".into(),
            basis: proposal_basis(module, "proposal:file"),
            execution_selection: Some(selection()),
            proposal_id: "proposal:file".into(),
            expected_revision: 1,
            action: None,
            session_id: None,
        },
    );
    assert!(window(module, ProjectWorkspaceInboxWindowFilter::Inbox).is_empty());
    let history = window(module, ProjectWorkspaceInboxWindowFilter::Processed);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].state, ProjectWorkspaceInboxEntryState::Kept);
    assert_eq!(history[0].scope, ProjectWorkspaceInboxScope::Library);
    let ProjectWorkspaceInboxLocation::Database { project_id, .. } = &history[0].location else {
        panic!("Filed location: {:?}", history[0].location);
    };
    assert_eq!(project_id.as_deref(), Some(PROJECT));
    // Filing is the decision; it does not open again in the Project.
    assert!(
        window_in(
            module,
            project_scope(),
            ProjectWorkspaceInboxWindowFilter::Inbox
        )
        .is_empty()
    );

    // Undoing the move returns the message to the Inbox that received it.
    apply_host(
        module,
        "reopen:file",
        ProjectWorkspaceIntent::SetInboxEntryState {
            page_ids: vec!["page:task".into()],
            state: ProjectWorkspaceInboxEntryState::Open,
        },
    );
    assert_eq!(
        window(module, ProjectWorkspaceInboxWindowFilter::Inbox)[0].page_id,
        "page:task"
    );
}

#[test]
fn filing_by_hand_moves_and_records_the_pages_atomically() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "task", "Document the capture shortcut");
    let file = || ProjectWorkspaceIntent::DispatchInboxEntries {
        expected_store_epoch: "epoch-1".into(),
        basis: pages_basis(module, vec!["page:task".into()]),
        execution_selection: Some(selection()),
        proposal_id: "proposal:by-hand".into(),
        page_ids: vec!["page:task".into()],
        action: ProjectWorkspaceInboxDispatchAction::MoveToProject {
            project_id: PROJECT.into(),
        },
        session_id: None,
    };
    apply_host(module, "file:by-hand", file());
    assert!(window(module, ProjectWorkspaceInboxWindowFilter::Inbox).is_empty());
    assert_eq!(
        window(module, ProjectWorkspaceInboxWindowFilter::Processed)[0].state,
        ProjectWorkspaceInboxEntryState::Kept
    );
}

#[test]
fn a_project_inbox_routes_only_inside_its_project() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    create_session_thread(
        module,
        "project-chat",
        "session:project-chat",
        "thread:project-chat",
        Some(PROJECT),
        2,
    );
    create_session_thread(
        module,
        "loose-chat",
        "session:loose-chat",
        "thread:loose-chat",
        None,
        3,
    );
    send_to(module, "idea", "Explain the hover flicker", Some(PROJECT));
    let entry = pending(module).remove(0);
    assert_eq!(entry.scope, project_scope());

    let ProjectWorkspaceReadValue::InboxDispatchContext { context: routing } = read_host(
        module,
        ProjectWorkspaceRead::InboxDispatchContext {
            page_ids: vec![entry.page_id.clone()],
        },
    ) else {
        panic!("routing context");
    };
    assert_eq!(routing.scope, project_scope());
    assert_eq!(
        routing
            .projects
            .iter()
            .map(|project| project.project_id.as_str())
            .collect::<Vec<_>>(),
        vec![PROJECT]
    );
    assert_eq!(
        routing
            .sessions
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["session:project-chat"]
    );

    let propose_error = |id: &str, action| {
        apply_host_error(
            module,
            &format!("propose:{id}"),
            ProjectWorkspaceIntent::ProposeInboxDispatch {
                proposal_id: format!("proposal:{id}"),
                page_ids: vec![entry.page_id.clone()],
                basis: vec![entry.basis.clone()],
                action,
                entry_kind: None,
                summary: "Route it".into(),
                rationale: None,
                produced_by: None,
            },
        )
    };
    assert_eq!(
        propose_error(
            "projectless",
            ProjectWorkspaceInboxDispatchAction::NewChat {
                project_id: None,
                prompt: "Explain it".into(),
            },
        ),
        CoreErrorCode::InvalidInput
    );
    assert_eq!(
        propose_error(
            "other-chat",
            ProjectWorkspaceInboxDispatchAction::SendToChat {
                session_id: "session:loose-chat".into(),
                prompt: "Explain it".into(),
            },
        ),
        CoreErrorCode::InvalidInput
    );
    assert_eq!(
        propose_error(
            "same-project",
            ProjectWorkspaceInboxDispatchAction::MoveToProject {
                project_id: PROJECT.into(),
            },
        ),
        CoreErrorCode::InvalidInput
    );
    propose(
        module,
        "proposal:project-chat",
        &entry,
        ProjectWorkspaceInboxDispatchAction::SendToChat {
            session_id: "session:project-chat".into(),
            prompt: "Explain the hover flicker".into(),
        },
    );
}

#[test]
fn one_suggestion_pass_never_mixes_inboxes() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "first", "First loose thought");
    send_to(
        module,
        "project",
        "A thought about the Project",
        Some(PROJECT),
    );
    send(module, "second", "Second loose thought");

    let batch = pending(module);
    assert_eq!(
        batch
            .iter()
            .map(|entry| entry.page_id.as_str())
            .collect::<Vec<_>>(),
        vec!["page:first", "page:second"]
    );
    for entry in &batch {
        propose(
            module,
            &format!("proposal:{}", entry.page_id),
            entry,
            ProjectWorkspaceInboxDispatchAction::Keep,
        );
    }
    let batch = pending(module);
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].page_id, "page:project");

    assert_eq!(
        apply_host_error(
            module,
            "dispatch:mixed",
            ProjectWorkspaceIntent::DispatchInboxEntries {
                expected_store_epoch: "epoch-1".into(),
                basis: pages_basis(module, vec!["page:first".into(), "page:project".into()]),
                execution_selection: Some(selection()),
                proposal_id: "proposal:mixed".into(),
                page_ids: vec!["page:first".into(), "page:project".into()],
                action: ProjectWorkspaceInboxDispatchAction::Keep,
                session_id: None,
            },
        ),
        CoreErrorCode::InvalidInput
    );
}

fn prepare_edit(
    module: &ProjectWorkspaceModule,
    page_id: &str,
    original_body: &str,
    body: &str,
) -> Result<ProjectWorkspaceInboxMessageEdit, CoreErrorCode> {
    module
        .read(
            &host(),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::InboxMessageEdit {
                    page_id: page_id.to_owned(),
                    original_body: original_body.to_owned(),
                    body: body.to_owned(),
                },
            },
        )
        .map(|snapshot| {
            let ProjectWorkspaceReadValue::InboxMessageEdit { edit } = snapshot.value else {
                panic!("Inbox message edit");
            };
            edit
        })
        .map_err(|error| error.code)
}

/// Stands in for the Document owner applying a prepared edit; the desktop app does
/// this through an ordinary fenced Document write.
fn write_message(workspace: &TestWorkspace, edit: &ProjectWorkspaceInboxMessageEdit, text: &str) {
    let page_id = edit.basis.page_id.clone();
    let body = edit.body_markdown.clone().expect("a changed body");
    let title = edit.title_markdown.clone();
    let text = text.to_owned();
    workspace
        .kernel
        .writer()
        .call(move |connection| {
            connection.execute(
                "UPDATE document_materializations \
                 SET nfm = ?2, plain_text = ?4, title = COALESCE(?3, title) \
                 WHERE document_id = (SELECT document_id FROM pages WHERE block_id = ?1)",
                rusqlite::params![page_id, body, title, text],
            )?;
            connection.execute(
                "UPDATE documents SET head_seq = head_seq + 1 \
                 WHERE id = (SELECT document_id FROM pages WHERE block_id = ?1)",
                [&page_id],
            )?;
            Ok(())
        })
        .expect("write message");
}

fn revise(module: &ProjectWorkspaceModule, page_id: &str) {
    apply_host(
        module,
        &format!("revise:{page_id}"),
        ProjectWorkspaceIntent::ReviseInboxMessage {
            page_id: page_id.to_owned(),
        },
    );
}

fn item(module: &ProjectWorkspaceModule, page_id: &str) -> ProjectWorkspaceInboxItem {
    window(module, ProjectWorkspaceInboxWindowFilter::Inbox)
        .into_iter()
        .find(|item| item.page_id == page_id)
        .unwrap_or_else(|| panic!("{page_id} is not waiting"))
}

#[test]
fn rewriting_a_message_follows_the_rules_of_sending_it() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(
        module,
        "edit",
        "Survey onboarding flows\nKeep it read-only.",
    );
    let original = item(module, "page:edit");
    assert!(original.body_editable);
    // Lines written together stay one paragraph, broken where they were written.
    assert_eq!(
        original.body,
        "Survey onboarding flows<br>Keep it read-only."
    );

    let edit = prepare_edit(
        module,
        "page:edit",
        &original.body,
        "\n  \nCompare three onboarding flows\n\nKeep it read-only.\n\n",
    )
    .expect("prepare edit");
    let sent =
        super::inbox::message_page("Compare three onboarding flows\n\nKeep it read-only.", None)
            .expect("message page");
    assert_eq!(edit.body_markdown.as_deref(), Some(sent.body_nfm.as_str()));
    // The title is still Core's provisional label, so it follows the new opening words.
    assert_eq!(
        edit.title_markdown.as_deref(),
        Some("Compare three onboarding flows")
    );

    // Saving the same text writes nothing.
    let unchanged = prepare_edit(
        module,
        "page:edit",
        &original.body,
        "Survey onboarding flows\nKeep it read-only.\n",
    )
    .expect("unchanged edit");
    assert_eq!(
        (unchanged.body_markdown, unchanged.title_markdown),
        (None, None)
    );

    // An edit never silently overwrites text that changed underneath it, or erases it.
    assert_eq!(
        prepare_edit(module, "page:edit", "Survey onboarding flows", "Anything"),
        Err(CoreErrorCode::RevisionConflict)
    );
    assert_eq!(
        prepare_edit(module, "page:edit", &original.body, " \n "),
        Err(CoreErrorCode::InvalidInput)
    );
}

#[test]
fn rewriting_withdraws_suggestions_and_asks_again_for_their_whole_group() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "a", "Survey onboarding flows");
    send(module, "b", "Compare their empty states");
    let entries = pending(module);
    apply_host(
        module,
        "propose:group",
        ProjectWorkspaceIntent::ProposeInboxDispatch {
            proposal_id: "proposal:group".into(),
            page_ids: entries.iter().map(|entry| entry.page_id.clone()).collect(),
            basis: entries.iter().map(|entry| entry.basis.clone()).collect(),
            action: ProjectWorkspaceInboxDispatchAction::Keep,
            entry_kind: None,
            summary: "Keep both as research notes".to_owned(),
            rationale: None,
            produced_by: None,
        },
    );
    assert!(pending(module).is_empty());

    let original = item(module, "page:a");
    let edit = prepare_edit(
        module,
        "page:a",
        &original.body,
        "Survey five onboarding flows",
    )
    .expect("prepare edit");
    write_message(&workspace, &edit, "Survey five onboarding flows");
    revise(module, "page:a");

    for page_id in ["page:a", "page:b"] {
        let waiting = item(module, page_id);
        assert_eq!(
            waiting.suggestion_state,
            ProjectWorkspaceInboxSuggestionState::Pending
        );
        // The suggestion about the old text is gone.
        assert_eq!(waiting.proposal, None);
    }
    let again = pending(module);
    let rewritten = again
        .iter()
        .find(|entry| entry.page_id == "page:a")
        .expect("rewritten message waits for a suggestion");
    assert_eq!(rewritten.body, "Survey five onboarding flows");
    assert_eq!(rewritten.title, "Survey five onboarding flows");
    // Its new provisional title can still be named by the next suggestion.
    assert!(rewritten.title_provisional);
    assert!(again.iter().any(|entry| entry.page_id == "page:b"));
}

#[test]
fn only_message_shaped_waiting_messages_are_rewritten_in_place() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "rich", "Ship the changelog");
    send(module, "formatted", "Ship the changelog");
    send(module, "named", "Homepage feels like a dev tool");
    send(module, "kept", "A lovely changelog layout");
    workspace
        .kernel
        .writer()
        .call(|connection| {
            // An image moved between paragraphs on its Page leaves the message shape;
            // formatting alone does not. One was also named by an earlier suggestion.
            connection.execute(
                "UPDATE document_materializations SET nfm = \
                 'Ship the changelog\n<image source=\"nodex://files/shot\">Shot</image>\nThen tell people' \
                 WHERE document_id = 'document:rich'",
                [],
            )?;
            connection.execute(
                "UPDATE document_materializations SET nfm = '**Ship** the changelog' \
                 WHERE document_id = 'document:formatted'",
                [],
            )?;
            connection.execute(
                "UPDATE document_materializations SET title = 'Homepage positioning' \
                 WHERE document_id = 'document:named'",
                [],
            )?;
            Ok(())
        })
        .expect("shape message Pages");
    apply_host(
        module,
        "keep:kept",
        ProjectWorkspaceIntent::KeepInboxEntries {
            page_ids: vec!["page:kept".into()],
        },
    );

    let rich = item(module, "page:rich");
    assert!(!rich.body_editable);
    assert_eq!(
        prepare_edit(module, "page:rich", &rich.body, "Ship it"),
        Err(CoreErrorCode::Conflict)
    );
    let formatted = item(module, "page:formatted");
    assert!(formatted.body_editable);
    assert_eq!(formatted.body, "**Ship** the changelog");
    // A handled message is a record of what was decided.
    assert_eq!(
        prepare_edit(
            module,
            "page:kept",
            "A lovely changelog layout",
            "A denser changelog layout"
        ),
        Err(CoreErrorCode::Conflict)
    );
    assert_eq!(
        apply_host_error(
            module,
            "revise:kept",
            ProjectWorkspaceIntent::ReviseInboxMessage {
                page_id: "page:kept".into(),
            }
        ),
        CoreErrorCode::Conflict
    );

    // A name is the user's or a suggestion's choice, so an edit keeps it.
    let named = item(module, "page:named");
    let edit = prepare_edit(
        module,
        "page:named",
        &named.body,
        "Homepage should read like an assistant",
    )
    .expect("prepare edit");
    assert_eq!(edit.title_markdown, None);
    write_message(&workspace, &edit, "Homepage should read like an assistant");
    revise(module, "page:named");
    let entry = pending(module)
        .into_iter()
        .find(|entry| entry.page_id == "page:named")
        .expect("named message waits for a suggestion");
    assert_eq!(entry.title, "Homepage positioning");
    assert!(!entry.title_provisional);
}

fn selection() -> nodex_core_contracts::inbox::ProjectWorkspaceInboxExecutionSelection {
    use nodex_core_contracts::inbox::*;
    ProjectWorkspaceInboxExecutionSelection {
        model_selection: ProjectWorkspaceInboxModelSelection {
            instance_id: "agent:test".into(),
            model: "model:test".into(),
            options: None,
        },
        interaction_mode: ProjectWorkspaceInboxInteractionMode::Default,
    }
}
fn pages_basis(
    module: &ProjectWorkspaceModule,
    pages: Vec<String>,
) -> Vec<nodex_core_contracts::inbox::ProjectWorkspaceInboxPageBasis> {
    pages
        .into_iter()
        .map(|page| {
            let ProjectWorkspaceReadValue::InboxDispatchContext { context } = read_host(
                module,
                ProjectWorkspaceRead::InboxDispatchContext {
                    page_ids: vec![page],
                },
            ) else {
                panic!("context")
            };
            context.entries[0].basis.clone()
        })
        .collect()
}
fn proposal_basis(
    module: &ProjectWorkspaceModule,
    id: &str,
) -> Vec<nodex_core_contracts::inbox::ProjectWorkspaceInboxPageBasis> {
    for scope in [ProjectWorkspaceInboxScope::Library, project_scope()] {
        for filter in [
            ProjectWorkspaceInboxWindowFilter::Inbox,
            ProjectWorkspaceInboxWindowFilter::Processed,
        ] {
            for item in window_in(module, scope.clone(), filter) {
                if let Some(p) = item.proposal
                    && p.proposal_id == id
                {
                    return p.basis;
                }
            }
        }
    }
    Vec::new()
}

fn outbox(
    module: &ProjectWorkspaceModule,
) -> Vec<nodex_core_contracts::inbox::ProjectWorkspaceInboxDispatchWork> {
    let ProjectWorkspaceReadValue::InboxDispatchOutbox { dispatches } = read_host(
        module,
        ProjectWorkspaceRead::InboxDispatchOutbox { limit: 16 },
    ) else {
        panic!("outbox")
    };
    dispatches
}
fn requests(
    module: &ProjectWorkspaceModule,
) -> Vec<nodex_core_contracts::inbox::ProjectWorkspaceInboxSuggestionRequest> {
    let ProjectWorkspaceReadValue::InboxSuggestionRequests { requests } = read_host(
        module,
        ProjectWorkspaceRead::InboxSuggestionRequests { limit: 16 },
    ) else {
        panic!("requests")
    };
    requests
}
fn grouped_request(module: &ProjectWorkspaceModule, id: &str, pages: Vec<String>) {
    apply_host(
        module,
        id,
        ProjectWorkspaceIntent::RequestInboxSuggestion {
            request_id: id.into(),
            mode: nodex_core_contracts::inbox::ProjectWorkspaceInboxSuggestionMode::Grouped,
            basis: pages_basis(module, pages.clone()),
            page_ids: pages,
            proposal_id: None,
            expected_revision: None,
            correction: None,
        },
    );
}
#[test]
fn atomic_edit_fences_content_and_invalidates_the_complete_request() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "a", "Original message");
    send(module, "b", "Related thought");
    grouped_request(
        module,
        "request:group",
        vec!["page:a".into(), "page:b".into()],
    );
    let unchanged = module
        .apply(
            &host(),
            request(
                "edit:unchanged",
                ProjectWorkspaceIntent::EditInboxMessage {
                    page_id: "page:a".into(),
                    basis: pages_basis(module, vec!["page:a".into()]).remove(0),
                    original_body: "Original message".into(),
                    body: "Original message".into(),
                },
            ),
        )
        .expect("unchanged edit");
    assert!(unchanged.event.is_none());
    assert_eq!(requests(module).len(), 1);
    let before = pages_basis(module, vec!["page:a".into()]).remove(0);
    let edit = ProjectWorkspaceIntent::EditInboxMessage {
        page_id: "page:a".into(),
        basis: before.clone(),
        original_body: "Original message".into(),
        body: "Revised message".into(),
    };
    let result = module
        .apply(&host(), request("edit:atomic", edit.clone()))
        .expect("atomic edit");
    assert!(result.event.is_some());
    assert!(requests(module).is_empty());
    let items = window(module, ProjectWorkspaceInboxWindowFilter::Inbox);
    assert!(
        items
            .iter()
            .all(|i| i.suggestion_state == ProjectWorkspaceInboxSuggestionState::Pending)
    );
    assert_eq!(
        items.iter().find(|i| i.page_id == "page:a").unwrap().body,
        "Revised message"
    );
    assert_eq!(
        apply_host_error(module, "edit:stale", edit),
        CoreErrorCode::Conflict
    );
    assert_eq!(
        count(
            &workspace,
            "SELECT count(*) FROM document_versions WHERE document_id='document:a'"
        ),
        1
    );
}
#[test]
fn a_dispatched_chat_receives_the_messages_images_with_their_text() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    super::test_support::create_library_image(&workspace, "shot");
    super::test_support::create_library_image(&workspace, "detail");
    send(
        module,
        "pictured",
        "The banner is cut off\n<image source=\"nodex://files/shot\"></image>\n<image source=\"nodex://files/detail\"></image>",
    );
    // The same screenshot in a second message is sent once.
    send(
        module,
        "again",
        "Same on the pricing page\n<image source=\"nodex://files/shot\"></image>",
    );
    let pages = vec!["page:pictured".to_owned(), "page:again".to_owned()];
    apply_host(
        module,
        "dispatch:pictured",
        ProjectWorkspaceIntent::DispatchInboxEntries {
            expected_store_epoch: "epoch-1".into(),
            basis: pages_basis(module, pages.clone()),
            execution_selection: Some(selection()),
            proposal_id: "proposal:pictured".into(),
            page_ids: pages,
            action: ProjectWorkspaceInboxDispatchAction::NewChat {
                project_id: None,
                prompt: "Fix the banners".into(),
            },
            session_id: Some("session:pictured".into()),
        },
    );
    let work = outbox(module).remove(0);
    assert_eq!(
        work.image_sources,
        vec!["nodex://files/shot", "nodex://files/detail"]
    );
    let text = work.final_text.unwrap();
    assert!(text.contains("> The banner is cut off"));
    assert!(!text.contains("<image"));
}

#[test]
fn complete_handoff_and_selection_survive_retries_with_fenced_receipts() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    let body = format!("{} THE END", "complete input ".repeat(450));
    send(module, "long", &body);
    apply_host(
        module,
        "dispatch:frozen",
        ProjectWorkspaceIntent::DispatchInboxEntries {
            expected_store_epoch: "epoch-1".into(),
            basis: pages_basis(module, vec!["page:long".into()]),
            execution_selection: Some(selection()),
            proposal_id: "proposal:frozen".into(),
            page_ids: vec!["page:long".into()],
            action: ProjectWorkspaceInboxDispatchAction::NewChat {
                project_id: None,
                prompt: "Answer the question".into(),
            },
            session_id: Some("session:frozen".into()),
        },
    );
    let work = outbox(module).remove(0);
    assert!(work.final_text.as_ref().unwrap().contains(&body));
    assert_eq!(work.execution_selection, Some(selection()));
    assert_eq!(work.message_id.len(), 36);
    apply_host(
        module,
        "fail:frozen",
        ProjectWorkspaceIntent::FailInboxDispatch {
            proposal_id: work.proposal_id.clone(),
            expected_revision: work.revision,
            message_id: work.message_id.clone(),
            failure_kind:
                nodex_core_contracts::inbox::ProjectWorkspaceInboxFailureKind::Unavailable,
            message: "Runtime unavailable".into(),
        },
    );
    apply_host(
        module,
        "retry:frozen",
        ProjectWorkspaceIntent::RetryInboxDispatch {
            proposal_id: work.proposal_id.clone(),
        },
    );
    let retried = outbox(module).remove(0);
    assert_eq!(retried.message_id, work.message_id);
    assert_eq!(retried.launch_id, work.launch_id);
    assert_eq!(retried.final_text, work.final_text);
    assert_eq!(
        apply_host_error(
            module,
            "complete:stale",
            ProjectWorkspaceIntent::CompleteInboxDispatch {
                proposal_id: work.proposal_id.clone(),
                expected_revision: work.revision,
                message_id: work.message_id.clone(),
                dispatched_thread_id: Some("thread:frozen".into())
            }
        ),
        CoreErrorCode::RevisionConflict
    );
    apply_host(
        module,
        "complete:frozen",
        ProjectWorkspaceIntent::CompleteInboxDispatch {
            proposal_id: retried.proposal_id,
            expected_revision: retried.revision,
            message_id: retried.message_id,
            dispatched_thread_id: Some("thread:frozen".into()),
        },
    );
    assert!(outbox(module).is_empty());
    assert_eq!(
        count(
            &workspace,
            "SELECT length(final_text) FROM inbox_handoffs WHERE proposal_id='proposal:frozen'"
        ),
        0
    );
}

#[test]
fn replacing_a_failed_group_member_retires_its_delivery_and_reopens_the_rest() {
    use nodex_core_contracts::inbox::ProjectWorkspaceInboxFailureKind;
    for decide_again in [true, false] {
        let workspace = seeded_workspace();
        let module = &workspace.module;
        send(module, "a", "First message");
        send(module, "b", "Second message");
        let pages = vec!["page:a".into(), "page:b".into()];
        apply_host(
            module,
            "dispatch:group",
            ProjectWorkspaceIntent::DispatchInboxEntries {
                expected_store_epoch: "epoch-1".into(),
                proposal_id: "proposal:group".into(),
                basis: pages_basis(module, pages.clone()),
                page_ids: pages,
                action: ProjectWorkspaceInboxDispatchAction::NewChat {
                    project_id: None,
                    prompt: "Discuss both messages".into(),
                },
                session_id: Some("session:group".into()),
                execution_selection: Some(selection()),
            },
        );
        let work = outbox(module).remove(0);
        apply_host(
            module,
            "fail:group",
            ProjectWorkspaceIntent::FailInboxDispatch {
                proposal_id: work.proposal_id.clone(),
                expected_revision: work.revision,
                message_id: work.message_id,
                failure_kind: ProjectWorkspaceInboxFailureKind::Unavailable,
                message: "Runtime unavailable".into(),
            },
        );
        if decide_again {
            apply_host(
                module,
                "decide:a",
                ProjectWorkspaceIntent::DispatchInboxEntries {
                    expected_store_epoch: "epoch-1".into(),
                    proposal_id: "proposal:a".into(),
                    basis: pages_basis(module, vec!["page:a".into()]),
                    page_ids: vec!["page:a".into()],
                    action: ProjectWorkspaceInboxDispatchAction::Keep,
                    session_id: None,
                    execution_selection: None,
                },
            );
            assert_eq!(
                count(
                    &workspace,
                    "SELECT count(*) FROM inbox_proposals \
                     WHERE proposal_id='proposal:group' AND state='superseded'"
                ),
                1
            );
            assert_eq!(
                count(
                    &workspace,
                    "SELECT count(*) FROM inbox_handoffs WHERE proposal_id='proposal:group'"
                ),
                0
            );
            assert_eq!(
                window(module, ProjectWorkspaceInboxWindowFilter::Processed)[0].state,
                ProjectWorkspaceInboxEntryState::Kept
            );
        } else {
            // A request releases the old membership before a new proposal has settled.
            grouped_request(module, "request:a", vec!["page:a".into()]);
            assert_eq!(
                count(
                    &workspace,
                    "SELECT count(*) FROM inbox_proposals \
                     WHERE proposal_id='proposal:group' AND state='failed'"
                ),
                1
            );
        }
        let items = window(module, ProjectWorkspaceInboxWindowFilter::Inbox);
        let remaining = items.iter().find(|item| item.page_id == "page:b").unwrap();
        assert!(remaining.proposal.is_none());
        assert_eq!(remaining.state, ProjectWorkspaceInboxEntryState::Open);
        assert_eq!(
            remaining.suggestion_state,
            ProjectWorkspaceInboxSuggestionState::Pending
        );
        assert_eq!(
            apply_host_error(
                module,
                "retry:old-group",
                ProjectWorkspaceIntent::RetryInboxDispatch {
                    proposal_id: work.proposal_id,
                },
            ),
            CoreErrorCode::Conflict
        );
        assert!(outbox(module).is_empty());
    }
}

#[test]
fn grouped_settlement_is_atomic_and_refine_preserves_explicit_membership() {
    use nodex_core_contracts::inbox::*;
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "a", "A thought");
    send(module, "b", "B thought");
    let pages = vec!["page:a".into(), "page:b".into()];
    grouped_request(module, "request:ab", pages.clone());
    let settlement = ProjectWorkspaceIntent::SettleInboxSuggestion {
        request_id: "request:ab".into(),
        generation: 1,
        titles: vec![ProjectWorkspaceInboxSuggestionTitle {
            page_id: "page:a".into(),
            title: "Grouped thought".into(),
        }],
        suggestions: vec![ProjectWorkspaceInboxSuggestedDispatch {
            proposal_id: "proposal:ab".into(),
            page_ids: pages,
            action: ProjectWorkspaceInboxDispatchAction::Keep,
            entry_kind: None,
            summary: "Review together".into(),
            rationale: None,
        }],
        produced_by: Some("test model".into()),
        error: None,
    };
    apply_host(module, "settle:ab", settlement.clone());
    assert!(requests(module).is_empty());
    assert!(pending(module).is_empty());
    let idle = module
        .apply(
            &host(),
            request(
                "prepare:settled",
                ProjectWorkspaceIntent::PrepareInboxSuggestions {
                    request_id: "request:idle".into(),
                    limit: 8,
                },
            ),
        )
        .expect("idle preparation");
    assert!(idle.event.is_none());
    let a = window(module, ProjectWorkspaceInboxWindowFilter::Inbox)
        .into_iter()
        .find(|i| i.page_id == "page:a")
        .unwrap();
    assert_eq!(a.title, "Grouped thought");
    assert!(a.basis.head_seq > 1);
    assert_eq!(
        a.proposal
            .as_ref()
            .unwrap()
            .basis
            .iter()
            .find(|b| b.page_id == a.page_id)
            .unwrap(),
        &a.basis
    );
    assert_eq!(
        a.proposal.as_ref().unwrap().action,
        ProjectWorkspaceInboxDispatchAction::Keep
    );
    apply_host(
        module,
        "refine:a",
        ProjectWorkspaceIntent::RequestInboxSuggestion {
            request_id: "request:a".into(),
            mode: ProjectWorkspaceInboxSuggestionMode::Refine,
            page_ids: vec!["page:a".into()],
            basis: vec![a.basis],
            proposal_id: Some("proposal:ab".into()),
            expected_revision: Some(1),
            correction: Some("Only the first message".into()),
        },
    );
    let request = requests(module).remove(0);
    assert_eq!(request.page_ids, vec!["page:a"]);
    assert_eq!(
        request.correction.as_deref(),
        Some("Only the first message")
    );
    assert!(
        window(module, ProjectWorkspaceInboxWindowFilter::Inbox)
            .iter()
            .all(|i| i.proposal.is_none())
    );
    assert_eq!(
        apply_host_error(module, "settle:late", settlement),
        CoreErrorCode::Conflict
    );
}
#[test]
fn grouped_move_and_undo_share_one_decision_and_refuse_partial_undo() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "a", "First");
    send(module, "b", "Second");
    let pages = vec!["page:a".into(), "page:b".into()];
    let move_intent = |proposal: &str| ProjectWorkspaceIntent::DispatchInboxEntries {
        expected_store_epoch: "epoch-1".into(),
        basis: pages_basis(module, pages.clone()),
        execution_selection: None,
        proposal_id: proposal.into(),
        page_ids: pages.clone(),
        action: ProjectWorkspaceInboxDispatchAction::MoveToProject {
            project_id: PROJECT.into(),
        },
        session_id: None,
    };
    let moved = module
        .apply(
            &host(),
            request("move:group", move_intent("proposal:move-group")),
        )
        .expect("group move");
    let token = moved
        .committed
        .value
        .inbox_undo_token
        .expect("one composite undo");
    let history = window(module, ProjectWorkspaceInboxWindowFilter::Processed);
    assert_eq!(history.len(), 2);
    assert!(
        history
            .iter()
            .all(|i| matches!(i.location, ProjectWorkspaceInboxLocation::Database { .. }))
    );
    // A member's internal relocation inverse cannot consume one part of the decision.
    let member_token: String = workspace
        .kernel
        .readers()
        .read_default(|connection| {
            Ok(connection.query_row(
                "SELECT json_extract(recipe_json,'$.tokens[0]') FROM inbox_decision_undo",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("member token");
    let library = crate::library::LibraryModule::new("profile-1", "library-1", &workspace.kernel);
    let error = library
        .apply(
            &host(),
            nodex_core_contracts::ModuleApplyRequest {
                contract_version: nodex_core_contracts::LIBRARY_CONTRACT_VERSION,
                operation_id: "undo:partial".into(),
                store_epoch: nodex_core_contracts::StoreEpoch("epoch-1".into()),
                intent: nodex_core_contracts::library::LibraryIntent::UndoPageRelocation {
                    token: serde_json::from_str(&member_token).unwrap(),
                },
            },
        )
        .expect_err("member inverse is reserved");
    assert_eq!(error.code, CoreErrorCode::RevisionConflict);
    assert_eq!(
        error.message,
        "Undo this relocation through its complete decision"
    );
    apply_host(
        module,
        "undo:group",
        ProjectWorkspaceIntent::UndoInboxDecision {
            undo_token: token.clone(),
        },
    );
    assert_eq!(
        window(module, ProjectWorkspaceInboxWindowFilter::Inbox).len(),
        2
    );
    assert_eq!(
        apply_host_error(
            module,
            "undo:twice",
            ProjectWorkspaceIntent::UndoInboxDecision { undo_token: token }
        ),
        CoreErrorCode::Conflict
    );
    let moved = module
        .apply(
            &host(),
            request("move:again", move_intent("proposal:move-again")),
        )
        .expect("move again");
    apply_host(
        module,
        "done:b",
        ProjectWorkspaceIntent::SetInboxEntryState {
            page_ids: vec!["page:b".into()],
            state: ProjectWorkspaceInboxEntryState::Done,
        },
    );
    assert_eq!(
        apply_host_error(
            module,
            "undo:changed",
            ProjectWorkspaceIntent::UndoInboxDecision {
                undo_token: moved.committed.value.inbox_undo_token.unwrap()
            }
        ),
        CoreErrorCode::Conflict
    );
    assert_eq!(
        window(module, ProjectWorkspaceInboxWindowFilter::Processed).len(),
        2
    );
}
#[test]
fn deleting_a_lost_reply_capture_never_resurrects_its_page_on_replay() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    let intent = ProjectWorkspaceIntent::SendInboxMessage {
        expected_store_epoch: Some("epoch-1".into()),
        page_id: "page:lost".into(),
        document_id: "document:lost".into(),
        body: "A capture with a lost reply".into(),
        title: None,
        project_id: None,
    };
    module
        .apply(&host(), request("capture:lost", intent.clone()))
        .expect("commit capture");
    apply_host(
        module,
        "delete:lost",
        ProjectWorkspaceIntent::DeleteInboxMessages {
            page_ids: vec!["page:lost".into()],
        },
    );
    let replay = module
        .apply(&host(), request("capture:lost", intent))
        .expect("replay receipt");
    assert!(replay.committed.receipt.mutation.duplicate);
    assert_eq!(
        count(
            &workspace,
            "SELECT count(*) FROM inbox_entries WHERE page_id='page:lost'"
        ),
        0
    );
    assert_eq!(
        count(
            &workspace,
            "SELECT count(*) FROM blocks WHERE id='page:lost' AND lifecycle='active'"
        ),
        0
    );
}

#[test]
fn remote_unknown_is_not_replayed_and_new_decisions_have_new_delivery_identity() {
    use nodex_core_contracts::inbox::ProjectWorkspaceInboxFailureKind;
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "a", "Send this once");
    send(module, "b", "Keep this with the first message");
    let make = |proposal: &str, session: &str| ProjectWorkspaceIntent::DispatchInboxEntries {
        expected_store_epoch: "epoch-1".into(),
        basis: pages_basis(module, vec!["page:a".into(), "page:b".into()]),
        execution_selection: Some(selection()),
        proposal_id: proposal.into(),
        page_ids: vec!["page:a".into(), "page:b".into()],
        action: ProjectWorkspaceInboxDispatchAction::NewChat {
            project_id: None,
            prompt: "Discuss".into(),
        },
        session_id: Some(session.into()),
    };
    let mut stale = make("proposal:stale", "session:stale");
    if let ProjectWorkspaceIntent::DispatchInboxEntries {
        expected_store_epoch,
        ..
    } = &mut stale
    {
        *expected_store_epoch = "old-epoch".into();
    }
    assert_eq!(
        apply_host_error(module, "dispatch:stale-epoch", stale),
        CoreErrorCode::StaleStoreEpoch
    );
    assert_eq!(
        count(
            &workspace,
            "SELECT count(*) FROM project_sessions WHERE id='session:stale'"
        ),
        0
    );
    apply_host(
        module,
        "dispatch:unknown",
        make("proposal:unknown", "session:unknown"),
    );
    let first = outbox(module).remove(0);
    apply_host(
        module,
        "begin:unknown",
        ProjectWorkspaceIntent::BeginInboxDispatch {
            proposal_id: first.proposal_id,
            expected_revision: first.revision,
            message_id: first.message_id.clone(),
        },
    );
    assert!(outbox(module).is_empty());
    let item = window(module, ProjectWorkspaceInboxWindowFilter::Inbox).remove(0);
    assert_eq!(
        item.proposal.unwrap().failure_kind,
        Some(ProjectWorkspaceInboxFailureKind::Unknown)
    );
    let mut partial = make("proposal:partial", "session:partial");
    if let ProjectWorkspaceIntent::DispatchInboxEntries {
        page_ids, basis, ..
    } = &mut partial
    {
        page_ids.pop();
        basis.pop();
    }
    assert_eq!(
        apply_host_error(module, "dispatch:partial", partial),
        CoreErrorCode::Conflict
    );
    assert_eq!(
        window(module, ProjectWorkspaceInboxWindowFilter::Inbox).len(),
        2
    );
    assert!(outbox(module).is_empty());
    apply_host(
        module,
        "dispatch:again",
        make("proposal:again", "session:again"),
    );
    assert_ne!(outbox(module)[0].message_id, first.message_id);
}
#[test]
fn migrating_a_pending_abstention_refinement_releases_the_suggestion_lane() {
    use nodex_core_contracts::inbox::*;
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "a", "First thought");
    let entry = pending(module).remove(0);
    propose(
        module,
        "proposal:old",
        &entry,
        ProjectWorkspaceInboxDispatchAction::Keep,
    );
    apply_host(
        module,
        "refine:old",
        ProjectWorkspaceIntent::RequestInboxSuggestion {
            request_id: "request:old".into(),
            mode: ProjectWorkspaceInboxSuggestionMode::Refine,
            page_ids: vec!["page:a".into()],
            basis: vec![entry.basis],
            proposal_id: Some("proposal:old".into()),
            expected_revision: Some(1),
            correction: Some("Please give this a concrete next action".into()),
        },
    );
    assert_eq!(
        requests(module)[0].proposal_id.as_deref(),
        Some("proposal:old")
    );
    // Preserve the public-operation membership, then install only the retired stored action.
    workspace.kernel.writer().call(|connection| {
        crate::infrastructure::sqlite::with_immediate_transaction(connection, |transaction| {
            transaction.execute(
                "UPDATE inbox_proposals SET action_json='{\"type\":\"none\",\"reason\":\"Decide manually\"}' WHERE proposal_id='proposal:old'",
                [],
            )?;
            transaction.execute_batch(include_str!("../../schema/migrations/v184_to_v185.sql"))?;
            Ok(())
        })
    }).expect("migrate pending historical refinement");
    assert!(requests(module).is_empty());
    let item = window(module, ProjectWorkspaceInboxWindowFilter::Inbox).remove(0);
    assert!(item.proposal.is_none());
    assert_eq!(
        item.suggestion_state,
        ProjectWorkspaceInboxSuggestionState::Pending
    );
    apply_host(
        module,
        "prepare:concrete",
        ProjectWorkspaceIntent::PrepareInboxSuggestions {
            request_id: "request:concrete".into(),
            limit: 8,
        },
    );
    let fresh = requests(module).remove(0);
    assert_eq!(fresh.request_id, "request:concrete");
    assert_eq!(
        apply_host_error(
            module,
            "settle:old",
            ProjectWorkspaceIntent::SettleInboxSuggestion {
                request_id: "request:old".into(),
                generation: 1,
                titles: vec![],
                suggestions: vec![],
                produced_by: None,
                error: Some("Old refinement failed".into()),
            },
        ),
        CoreErrorCode::Conflict
    );
    apply_host(
        module,
        "settle:concrete",
        ProjectWorkspaceIntent::SettleInboxSuggestion {
            request_id: fresh.request_id,
            generation: fresh.generation,
            titles: vec![],
            suggestions: vec![ProjectWorkspaceInboxSuggestedDispatch {
                proposal_id: "proposal:concrete".into(),
                page_ids: fresh.page_ids,
                action: ProjectWorkspaceInboxDispatchAction::Keep,
                entry_kind: None,
                summary: "Keep this note".into(),
                rationale: None,
            }],
            produced_by: None,
            error: None,
        },
    );
    assert!(requests(module).is_empty());
    assert_eq!(
        window(module, ProjectWorkspaceInboxWindowFilter::Inbox)[0]
            .proposal
            .as_ref()
            .unwrap()
            .action,
        ProjectWorkspaceInboxDispatchAction::Keep
    );
}

#[test]
fn successful_suggestion_settlement_requires_a_concrete_action_for_every_member() {
    use nodex_core_contracts::inbox::*;
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "a", "First thought");
    send(module, "b", "Second thought");
    apply_host(
        module,
        "prepare:ab",
        ProjectWorkspaceIntent::PrepareInboxSuggestions {
            request_id: "request:ab".into(),
            limit: 8,
        },
    );
    let input = requests(module).remove(0);
    for (operation, suggestions) in [
        ("settle:empty", vec![]),
        (
            "settle:partial",
            vec![ProjectWorkspaceInboxSuggestedDispatch {
                proposal_id: "proposal:a".into(),
                page_ids: vec!["page:a".into()],
                action: ProjectWorkspaceInboxDispatchAction::Keep,
                entry_kind: None,
                summary: "Keep this note".into(),
                rationale: None,
            }],
        ),
    ] {
        assert_eq!(
            apply_host_error(
                module,
                operation,
                ProjectWorkspaceIntent::SettleInboxSuggestion {
                    request_id: input.request_id.clone(),
                    generation: input.generation,
                    titles: vec![ProjectWorkspaceInboxSuggestionTitle {
                        page_id: "page:a".into(),
                        title: "Do not apply a partial result".into(),
                    }],
                    suggestions,
                    produced_by: None,
                    error: None,
                },
            ),
            CoreErrorCode::InvalidInput
        );
        let items = window(module, ProjectWorkspaceInboxWindowFilter::Inbox);
        assert!(items.iter().all(|item| item.proposal.is_none()));
        assert_eq!(
            items
                .iter()
                .find(|item| item.page_id == "page:a")
                .unwrap()
                .title,
            "First thought"
        );
        assert_eq!(requests(module).len(), 1);
    }
    assert!(
        serde_json::from_value::<ProjectWorkspaceInboxDispatchAction>(serde_json::json!({
            "type": "none",
            "reason": "Decide manually"
        }))
        .is_err()
    );
}

#[test]
fn failed_settlement_rolls_back_titles_and_prior_suggestions() {
    use nodex_core_contracts::inbox::*;
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "a", "First thought");
    send(module, "b", "Second thought");
    apply_host(
        module,
        "prepare:ab",
        ProjectWorkspaceIntent::PrepareInboxSuggestions {
            request_id: "request:ab".into(),
            limit: 8,
        },
    );
    let input = requests(module).remove(0);
    let suggestions = input
        .page_ids
        .iter()
        .map(|page| ProjectWorkspaceInboxSuggestedDispatch {
            proposal_id: "proposal:duplicate".into(),
            page_ids: vec![page.clone()],
            action: ProjectWorkspaceInboxDispatchAction::Keep,
            entry_kind: None,
            summary: "Keep it".into(),
            rationale: None,
        })
        .collect();
    assert_eq!(
        apply_host_error(
            module,
            "settle:bad",
            ProjectWorkspaceIntent::SettleInboxSuggestion {
                request_id: input.request_id,
                generation: input.generation,
                titles: vec![ProjectWorkspaceInboxSuggestionTitle {
                    page_id: "page:a".into(),
                    title: "This must roll back".into()
                }],
                suggestions,
                produced_by: None,
                error: None
            }
        ),
        CoreErrorCode::Conflict
    );
    let items = window(module, ProjectWorkspaceInboxWindowFilter::Inbox);
    assert_eq!(
        items.iter().find(|i| i.page_id == "page:a").unwrap().title,
        "First thought"
    );
    assert!(items.iter().all(|i| i.proposal.is_none()));
    assert_eq!(requests(module).len(), 1);
}
#[test]
fn chat_target_search_reaches_older_sessions_and_binds_its_cursor_to_the_query() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    create_session_thread(
        module,
        "old-needle",
        "session:000-needle",
        "thread:needle",
        None,
        1,
    );
    for index in 0..105 {
        create_session_thread(
            module,
            &format!("new-{index}"),
            &format!("session:new-{index:03}"),
            &format!("thread:new-{index:03}"),
            None,
            index + 2,
        );
    }
    send(module, "search", "Continue the needle discussion");
    let ProjectWorkspaceReadValue::InboxDispatchContext { context: relevant } = read_host(
        module,
        ProjectWorkspaceRead::InboxDispatchContext {
            page_ids: vec!["page:search".into()],
        },
    ) else {
        panic!("context")
    };
    assert!(
        relevant
            .sessions
            .iter()
            .any(|chat| chat.session_id == "session:000-needle")
    );
    assert!(relevant.sessions.len() <= 30);
    let query = |query: &str, after: Option<String>| ProjectWorkspaceRead::InboxChatTargets {
        scope: ProjectWorkspaceInboxScope::Library,
        query: query.into(),
        window: CollectionWindowRequest {
            first: Some(1),
            after,
        },
    };
    let ProjectWorkspaceReadValue::InboxChatTargets { window: found } =
        read_host(module, query("needle", None))
    else {
        panic!("targets")
    };
    assert_eq!(found.items[0].session_id, "session:000-needle");
    let ProjectWorkspaceReadValue::InboxChatTargets { window: first } =
        read_host(module, query("", None))
    else {
        panic!("targets")
    };
    assert!(first.next_cursor.is_some());
    assert!(
        module
            .read(
                &host(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: query("other", first.next_cursor)
                }
            )
            .is_err()
    );
}

#[test]
fn stale_failure_cannot_hide_new_document_content_from_suggestions() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "a", "Original message");
    grouped_request(module, "request:old", vec!["page:a".into()]);
    let old = requests(module).remove(0);
    // The regular Page editor can change a Document without an Inbox mutation.
    let edit = prepare_edit(
        module,
        "page:a",
        "Original message",
        "Changed in the Page editor",
    )
    .expect("prepare document edit");
    write_message(&workspace, &edit, "Changed in the Page editor");
    assert_eq!(
        apply_host_error(
            module,
            "settle:old-failure",
            ProjectWorkspaceIntent::SettleInboxSuggestion {
                request_id: old.request_id,
                generation: old.generation,
                titles: vec![],
                suggestions: vec![],
                produced_by: None,
                error: Some("Provider unavailable".into()),
            }
        ),
        CoreErrorCode::Conflict
    );
    apply_host(
        module,
        "prepare:new-content",
        ProjectWorkspaceIntent::PrepareInboxSuggestions {
            request_id: "request:new".into(),
            limit: 8,
        },
    );
    let fresh = requests(module).remove(0);
    assert_eq!(fresh.request_id, "request:new");
    assert_eq!(fresh.context.entries[0].body, "Changed in the Page editor");
    apply_host(
        module,
        "settle:current-failure",
        ProjectWorkspaceIntent::SettleInboxSuggestion {
            request_id: fresh.request_id,
            generation: fresh.generation,
            titles: vec![],
            suggestions: vec![],
            produced_by: None,
            error: Some("Provider unavailable".into()),
        },
    );
    let edit = prepare_edit(
        module,
        "page:a",
        "Changed in the Page editor",
        "Changed again after the failure",
    )
    .unwrap();
    write_message(&workspace, &edit, "Changed again after the failure");
    apply_host(
        module,
        "prepare:after-failure",
        ProjectWorkspaceIntent::PrepareInboxSuggestions {
            request_id: "request:after-failure".into(),
            limit: 8,
        },
    );
    assert_eq!(requests(module)[0].request_id, "request:after-failure");
}

#[test]
fn outbox_byte_budget_never_splits_a_frozen_handoff() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    for id in ["a", "b"] {
        send(module, id, "Dispatch this complete message");
        let pages = vec![format!("page:{id}")];
        apply_host(
            module,
            &format!("dispatch:{id}"),
            ProjectWorkspaceIntent::DispatchInboxEntries {
                expected_store_epoch: "epoch-1".into(),
                basis: pages_basis(module, pages.clone()),
                execution_selection: Some(selection()),
                proposal_id: format!("proposal:{id}"),
                page_ids: pages,
                action: ProjectWorkspaceInboxDispatchAction::NewChat {
                    project_id: None,
                    prompt: "Discuss".into(),
                },
                session_id: Some(format!("session:{id}")),
            },
        );
    }
    // Storage pressure fixture: JSON escaping expands each valid persisted payload sixfold.
    workspace
        .kernel
        .writer()
        .call(|connection| {
            connection.execute(
                "UPDATE inbox_handoffs SET final_text=?1",
                ["\u{1}".repeat(1_179_000)],
            )?;
            Ok(())
        })
        .expect("install pressure payloads");
    let work = outbox(module);
    assert_eq!(work.len(), 1);
    assert_eq!(work[0].final_text.as_ref().unwrap().len(), 1_179_000);
    assert!(serde_json::to_vec(&work).unwrap().len() < 16 * 1024 * 1024);
}

#[test]
fn erasing_a_dispatch_member_preserves_unknown_receipts_without_payload() {
    use nodex_core_contracts::inbox::ProjectWorkspaceInboxFailureKind;
    for remote_begun in [false, true] {
        let workspace = seeded_workspace();
        let module = &workspace.module;
        send(module, "secret", "secret-to-erase");
        send(module, "remaining", "Keep this message visible");
        let pages = vec!["page:secret".into(), "page:remaining".into()];
        apply_host(
            module,
            "dispatch:group",
            ProjectWorkspaceIntent::DispatchInboxEntries {
                expected_store_epoch: "epoch-1".into(),
                basis: pages_basis(module, pages.clone()),
                execution_selection: Some(selection()),
                proposal_id: "proposal:group".into(),
                page_ids: pages,
                action: ProjectWorkspaceInboxDispatchAction::NewChat {
                    project_id: None,
                    prompt: "Discuss secret-to-erase".into(),
                },
                session_id: Some("session:group".into()),
            },
        );
        let delivery = outbox(module).remove(0);
        if remote_begun {
            apply_host(
                module,
                "begin:group",
                ProjectWorkspaceIntent::BeginInboxDispatch {
                    proposal_id: delivery.proposal_id.clone(),
                    expected_revision: delivery.revision,
                    message_id: delivery.message_id.clone(),
                },
            );
        }
        apply_host(
            module,
            "delete:secret",
            ProjectWorkspaceIntent::DeleteInboxMessages {
                page_ids: vec!["page:secret".into()],
            },
        );
        let remaining = item(module, "page:remaining");
        let proposal = remaining.proposal.unwrap();
        assert_eq!(proposal.page_ids, vec!["page:remaining"]);
        assert_eq!(
            proposal.failure_kind,
            Some(ProjectWorkspaceInboxFailureKind::Unknown)
        );
        assert_eq!(
            remaining.suggestion_state,
            ProjectWorkspaceInboxSuggestionState::Settled
        );
        assert!(outbox(module).is_empty());
        assert!(window(module, ProjectWorkspaceInboxWindowFilter::Processed).is_empty());
        let (action, text, message): (String, String, String) = workspace.kernel.readers().read_default(|connection| {
            Ok(connection.query_row("SELECT proposal.action_json,handoff.final_text,handoff.message_id FROM inbox_proposals proposal JOIN inbox_handoffs handoff USING(proposal_id)", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?)
        }).unwrap();
        assert!(!action.contains("secret-to-erase"));
        assert!(text.is_empty());
        assert_eq!(message, delivery.message_id);
        assert_eq!(
            apply_host_error(
                module,
                "late:complete",
                ProjectWorkspaceIntent::CompleteInboxDispatch {
                    proposal_id: delivery.proposal_id,
                    expected_revision: delivery.revision + i64::from(remote_begun),
                    message_id: delivery.message_id,
                    dispatched_thread_id: Some("thread:late".into()),
                }
            ),
            CoreErrorCode::RevisionConflict
        );
    }
}

fn send_error(module: &ProjectWorkspaceModule, id: &str, body: &str) -> CoreErrorCode {
    apply_host_error(
        module,
        &format!("send:{id}"),
        ProjectWorkspaceIntent::SendInboxMessage {
            expected_store_epoch: None,
            page_id: format!("page:{id}"),
            document_id: format!("document:{id}"),
            body: body.to_owned(),
            title: None,
            project_id: None,
        },
    )
}

#[test]
fn a_message_is_written_as_markdown_and_everyday_text_stays_literal() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(
        module,
        "written",
        "**Ship** the changelog\n* check the links\n  * in the footer\n* tag the release\nKeep a < b and [draft\nas typed: https://example.com/notes.\n\nThen tell people",
    );
    let written = item(module, "page:written");
    // Typed Markdown is real structure, written lines stay together until a blank line, and
    // text that forms no markup stays as written.
    assert_eq!(
        written.body,
        "**Ship** the changelog\n- check the links\n\t- in the footer\n- tag the release\nKeep a \\< b and \\[draft<br>as typed: [https://example.com/notes](https://example.com/notes).\nThen tell people"
    );
    assert!(written.body_editable);
    assert_eq!(written.title, "Ship the changelog");
}

#[test]
fn a_message_keeps_its_images_after_its_text() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    super::test_support::create_library_image(&workspace, "shot");
    send(
        module,
        "pictured",
        "The banner is cut off\n<image source=\"nodex://files/shot\">Banner</image>",
    );
    let pictured = item(module, "page:pictured");
    assert_eq!(
        pictured.body,
        "The banner is cut off\n<image source=\"nodex://files/shot\">Banner</image>"
    );
    assert!(pictured.body_editable);

    send(
        module,
        "picture",
        "<image source=\"nodex://files/shot\">Banner</image>",
    );
    // A message of images alone is labeled by its first caption.
    assert_eq!(item(module, "page:picture").title, "Banner");

    assert_eq!(
        send_error(
            module,
            "out-of-shape",
            "<image source=\"nodex://files/shot\">Banner</image>\nThe banner is cut off",
        ),
        CoreErrorCode::InvalidInput
    );
    // An attachment is a Library File, so an image from elsewhere is Page content, not a message.
    assert_eq!(
        send_error(
            module,
            "external",
            "The banner is cut off\n<image source=\"https://example.com/shot.png\">Banner</image>",
        ),
        CoreErrorCode::InvalidInput
    );
    assert_eq!(
        send_error(module, "empty", "\n  \n"),
        CoreErrorCode::InvalidInput
    );
}

#[test]
fn a_long_message_streams_its_opening_text_and_is_edited_as_its_page() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    let line = "A sentence that keeps the message long enough to pass the stream budget.";
    send(module, "long", &vec![line; 200].join("\n"));
    let long = item(module, "page:long");
    assert!(long.body_truncated);
    assert!(!long.body_editable);
    // Past the budget the stream shows the opening of the message's text.
    assert!(long.body.starts_with(&format!("{line} {line}")));
    assert!(long.body.len() <= 8 * 1024 + 64);
}
