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
            page_id: format!("page:{id}"),
            document_id: format!("document:{id}"),
            text: text.to_owned(),
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
    // The whole message is the body, including its own blank line; the title only labels it.
    assert_eq!(
        newest.body,
        "Fix the sidebar flicker\n\nIt happens on hover."
    );
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
                    page_id: "page:cross-project".into(),
                    document_id: "document:cross-project".into(),
                    text: "Shared Profile message".into(),
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
        CoreErrorCode::Conflict
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
fn move_suggestions_complete_only_after_the_page_moves() {
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
    assert_eq!(
        apply_host_error(
            module,
            "confirm:move",
            ProjectWorkspaceIntent::ConfirmInboxDispatch {
                proposal_id: "proposal:move".into(),
                expected_revision: 1,
                action: None,
                session_id: None,
            },
        ),
        CoreErrorCode::Conflict
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
            page_id: format!("page:{id}"),
            document_id: format!("document:{id}"),
            text: "The settings buttons are missing accessible labels".into(),
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
        page_id: format!("page:{id}"),
        document_id: format!("document:{id}"),
        text: "Benchmark search on the large fixture".into(),
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
            proposal_id: "proposal:ab".into(),
            page_ids: vec!["page:a".into(), "page:b".into()],
            action: ProjectWorkspaceInboxDispatchAction::NewChat {
                project_id: None,
                prompt: "Survey onboarding flows and their empty states".into(),
            },
            session_id: Some("session:ab".into()),
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
                    page_id: format!("page:{id}"),
                    document_id: format!("document:{id}"),
                    text: "A background result".into(),
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
                        page_id: "page:cli".into(),
                        document_id: "document:cli".into(),
                        text: "Choose for me".into(),
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
                page_id: "page:missing".into(),
                document_id: "document:missing".into(),
                text: "Nowhere".into(),
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
    // The user's own Library relocation, which the desktop app performs before confirming.
    let data_source = project_data_source(&workspace);
    workspace
        .kernel
        .writer()
        .call(move |connection| {
            connection.execute(
                "UPDATE pages SET parent_id = ?1 WHERE block_id = 'page:task'",
                [&data_source],
            )?;
            Ok(())
        })
        .expect("relocate Page");
    apply_host(
        module,
        "confirm:file",
        ProjectWorkspaceIntent::ConfirmInboxDispatch {
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
fn filing_by_hand_records_the_move_the_user_made() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "task", "Document the capture shortcut");
    let file = || ProjectWorkspaceIntent::DispatchInboxEntries {
        proposal_id: "proposal:by-hand".into(),
        page_ids: vec!["page:task".into()],
        action: ProjectWorkspaceInboxDispatchAction::MoveToProject {
            project_id: PROJECT.into(),
        },
        session_id: None,
    };
    // Filing never moves content itself; the user's Library relocation comes first.
    assert_eq!(
        apply_host_error(module, "file:early", file()),
        CoreErrorCode::Conflict
    );
    let data_source = project_data_source(&workspace);
    workspace
        .kernel
        .writer()
        .call(move |connection| {
            connection.execute(
                "UPDATE pages SET parent_id = ?1 WHERE block_id = 'page:task'",
                [&data_source],
            )?;
            Ok(())
        })
        .expect("relocate Page");
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
    original_text: &str,
    text: &str,
) -> Result<ProjectWorkspaceInboxMessageEdit, CoreErrorCode> {
    module
        .read(
            &host(),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read: ProjectWorkspaceRead::InboxMessageEdit {
                    page_id: page_id.to_owned(),
                    original_text: original_text.to_owned(),
                    text: text.to_owned(),
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
    assert_eq!(original.body, "Survey onboarding flows\nKeep it read-only.");

    let edit = prepare_edit(
        module,
        "page:edit",
        &original.body,
        "\n  \nCompare three onboarding flows  \n\nKeep it read-only.\n\n",
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
fn only_plain_waiting_messages_are_rewritten_in_place() {
    let workspace = seeded_workspace();
    let module = &workspace.module;
    send(module, "rich", "Ship the changelog");
    send(module, "named", "Homepage feels like a dev tool");
    send(module, "kept", "A lovely changelog layout");
    workspace
        .kernel
        .writer()
        .call(|connection| {
            // Made richer on its Page, and named by an earlier suggestion.
            connection.execute(
                "UPDATE document_materializations SET nfm = '**Ship** the changelog' \
                 WHERE document_id = 'document:rich'",
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
