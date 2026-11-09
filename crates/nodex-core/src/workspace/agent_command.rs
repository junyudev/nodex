//! Authenticated Agent operations retain their captured execution identity through commit.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::agent::AgentTurnProvenance;
use nodex_core_contracts::workspace::ProjectWorkspaceIntent;
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::Connection;

pub(super) fn admit<'a>(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    intent: &'a ProjectWorkspaceIntent,
) -> Result<&'a ProjectWorkspaceIntent, StoreError> {
    let ProjectWorkspaceIntent::AgentCommand { provenance, intent } = intent else {
        if context.adapter == AdapterKind::Agent {
            return Err(denied(
                "Agent Workspace commands require execution provenance",
            ));
        }
        return Ok(intent);
    };
    if matches!(intent.as_ref(), ProjectWorkspaceIntent::Source { command } if !matches!(command,nodex_core_contracts::sources::SourceCommand::FollowThread{..}|nodex_core_contracts::sources::SourceCommand::ReplyToOrigin{..}))
    {
        return Err(denied("Sources belong to a person and the Desktop Host"));
    }
    admit_read_caller(connection, library_id, context, provenance)?;
    if matches!(intent.as_ref(), ProjectWorkspaceIntent::Source { .. }) {
        if !matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::Test
        ) || context.agent_attribution.is_some()
        {
            return Err(denied(
                "Follow verification belongs to the Host's managed-chat tool",
            ));
        }
        if matches!(
            intent.as_ref(),
            ProjectWorkspaceIntent::Source {
                command: nodex_core_contracts::sources::SourceCommand::FollowThread { .. }
            }
        ) {
            super::thread_follows::managed_page(connection, library_id, provenance)?;
        }
    }
    if let ProjectWorkspaceIntent::StartPageWork {
        page_id,
        selection,
        again,
        expected_readiness_epoch,
        expected_turn_episode,
        ..
    } = intent.as_ref()
    {
        // The Host's start_work tool freezes the launch; Core binds it to the calling Turn.
        if !matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::Test
        ) || context.agent_attribution.is_some()
            || *again
            || expected_readiness_epoch.is_some()
            || expected_turn_episode.is_some()
        {
            return Err(denied("Work launches belong to the Desktop Host"));
        }
        let session = crate::infrastructure::actors::turn_session(connection, provenance)?;
        if crate::infrastructure::actors::is_coordinator(connection, &session)? {
            require_standing_consent(connection, library_id, page_id, selection.as_ref())?;
        }
        return Ok(intent);
    }
    if automation_confirmation(connection, intent)? {
        return Err(denied(
            "Only the Automation Owner may confirm or retry this decision",
        ));
    }

    if matches!(
        intent.as_ref(),
        ProjectWorkspaceIntent::ConfirmInboxDispatch {
            confirmed_by: nodex_core_contracts::inbox::InboxConfirmedBy::Nodex,
            ..
        } | ProjectWorkspaceIntent::BeginInboxRouting { .. }
    ) {
        return Err(denied(
            "Automatic Inbox dispatch and routing belong to the Desktop Host",
        ));
    }
    if matches!(
        intent.as_ref(),
        ProjectWorkspaceIntent::HoldAutomationDecision { .. }
            | ProjectWorkspaceIntent::RefreshAutomationDecision { .. }
            | ProjectWorkspaceIntent::RecordChatDelivery { .. }
            | ProjectWorkspaceIntent::BindChatInbound { .. }
            | ProjectWorkspaceIntent::RecordSessionExecution { .. }
            | ProjectWorkspaceIntent::SettlePageWorkLaunch { .. }
            | ProjectWorkspaceIntent::ClaimPageWorkspace { .. }
            | ProjectWorkspaceIntent::BindPageWorkspace { .. }
            | ProjectWorkspaceIntent::RecordPageWorkspaceReady { .. }
            | ProjectWorkspaceIntent::RecordPageWorkspaceFailed { .. }
            | ProjectWorkspaceIntent::RequestPageWorkspaceCleanup { .. }
            | ProjectWorkspaceIntent::MarkPageWorkspaceRemoved { .. }
            | ProjectWorkspaceIntent::UpsertPagePullRequest { .. }
    ) {
        return Err(denied("Work launches belong to the Desktop Host"));
    }
    if matches!(
        intent.as_ref(),
        ProjectWorkspaceIntent::SetInboxRoutingConsent { .. }
            | ProjectWorkspaceIntent::AcceptPageWork { .. }
            | ProjectWorkspaceIntent::PauseWork { .. }
            | ProjectWorkspaceIntent::ResumeWork { .. }
    ) {
        return Err(denied("Only a person may accept Page work"));
    }
    if matches!(intent.as_ref(), ProjectWorkspaceIntent::AgentCommand { .. }) {
        return Err(denied("Agent command envelopes cannot be nested"));
    }
    if matches!(
        intent.as_ref(),
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
            agent_selection: None,
            coordinator: true,
            ..
        }
    ) {
        return Err(denied("Only the Desktop Host can create the Coordinator"));
    }
    if matches!(
        intent.as_ref(),
        ProjectWorkspaceIntent::MutateSession {
            intent: nodex_core_contracts::workspace::ProjectSessionIntent::ConsumeReminder { .. }
                | nodex_core_contracts::workspace::ProjectSessionIntent::DeferReminderDelivery { .. }
                | nodex_core_contracts::workspace::ProjectSessionIntent::CompleteReminderDelivery { .. }
                | nodex_core_contracts::workspace::ProjectSessionIntent::RecordUserMessage { .. },
            ..
        }
    ) {
        return Err(denied(
            "Reminder delivery and user-message acceptance belong to the Desktop Host",
        ));
    }
    Ok(intent)
}

pub(super) fn admit_read_caller(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    provenance: &AgentTurnProvenance,
) -> Result<(), StoreError> {
    if !matches!(
        context.adapter,
        AdapterKind::Agent | AdapterKind::ElectronHost | AdapterKind::Test
    ) || provenance.profile_id != context.profile_id.0
    {
        return Err(denied(
            "Agent Workspace request does not match the current Profile",
        ));
    }
    super::validate_persisted_turn_authority(connection, library_id, provenance)?;
    Ok(())
}
fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

/// Nodex may start a Page only on the consent the scheduler uses: its prerequisites are
/// satisfied and a person let its assigned Agent start on its own. Any other Page's Turn
/// asks that person.
fn require_standing_consent(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
    selection: Option<&nodex_core_contracts::library::AgentWorkSelection>,
) -> Result<(), StoreError> {
    let ready = crate::database::work_graph::ready_page(connection, library_id, page_id)?;
    let consented = ready.is_some_and(|page| {
        page.page_work.auto_start
            && selection.is_none_or(|selection| {
                page.page_work
                    .assignee
                    .as_ref()
                    .and_then(|assignee| assignee.agent_selection())
                    .as_ref()
                    == Some(selection)
            })
    });
    if consented && crate::infrastructure::actors::work_grant(connection, page_id)?.is_some() {
        return Ok(());
    }
    Err(denied(
        "Nodex starts only Pages that start on their own; this Page's Turn asks the person to start it",
    ))
}

fn automation_confirmation(
    connection: &Connection,
    intent: &ProjectWorkspaceIntent,
) -> Result<bool, StoreError> {
    use nodex_core_contracts::inbox::ProjectWorkspaceInboxDispatchAction;
    let proposal = match intent {
        ProjectWorkspaceIntent::ConfirmInboxDispatch {
            proposal_id,
            action,
            ..
        } => {
            if matches!(
                action,
                Some(ProjectWorkspaceInboxDispatchAction::ExecuteDecision { .. })
            ) {
                return Ok(true);
            }
            Some(proposal_id)
        }
        ProjectWorkspaceIntent::RetryInboxDispatch { proposal_id } => Some(proposal_id),
        ProjectWorkspaceIntent::DispatchInboxEntries {
            page_ids, action, ..
        } => {
            if matches!(
                action,
                ProjectWorkspaceInboxDispatchAction::ExecuteDecision { .. }
            ) {
                return Ok(true);
            }
            let ids = serde_json::to_string(page_ids)
                .map_err(|_| denied("Invalid Automation decision pages"))?;
            return Ok(connection.query_row("SELECT EXISTS(SELECT 1 FROM automation_decisions WHERE page_id IN(SELECT value FROM json_each(?1)))",[ids],|r|r.get(0))?);
        }
        _ => None,
    };
    let Some(proposal) = proposal else {
        return Ok(false);
    };
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM inbox_proposals WHERE proposal_id=?1 AND (origin='automation' OR json_extract(action_json,'$.type')='execute_decision'))",
        [proposal],
        |r| r.get(0),
    )?)
}
