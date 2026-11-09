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
    // An Agent configures Sources and retries their Problems for its Member, as that person
    // could; polling, ingestion and delivery settlement remain the Desktop Host's own work.
    if matches!(intent.as_ref(), ProjectWorkspaceIntent::Source { command } if !matches!(command,nodex_core_contracts::sources::SourceCommand::FollowThread{..}|nodex_core_contracts::sources::SourceCommand::ReplyToOrigin{..}|nodex_core_contracts::sources::SourceCommand::ConfigureSource{..}|nodex_core_contracts::sources::SourceCommand::RetryProblem{..}))
    {
        return Err(denied(
            "Source polling and delivery belong to the Desktop Host",
        ));
    }
    admit_read_caller(connection, library_id, context, provenance)?;
    if matches!(intent.as_ref(), ProjectWorkspaceIntent::Source { .. }) {
        if !matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::Test
        ) || context.agent_attribution.is_some()
        {
            return Err(denied(
                "Agent Source commands come through the Desktop Host's tools",
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
        again,
        expected_readiness_epoch,
        ..
    } = intent.as_ref()
    {
        // The Host's start_work tool freezes the launch; Core binds it to the calling Turn. A
        // Turn-fenced start must be the Agent's Member's own Turn. Whether the person asked for
        // this start is the Agent's judgement, not Core's.
        if !matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::Test
        ) || context.agent_attribution.is_some()
            || *again
            || expected_readiness_epoch.is_some()
        {
            return Err(denied("Work launches belong to the Desktop Host"));
        }
        return Ok(intent);
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
    // Claiming marks a Turn notification shown on one of the person's devices.
    if matches!(
        intent.as_ref(),
        ProjectWorkspaceIntent::ClaimTurnNotification { .. }
    ) {
        return Err(denied("Turn notifications belong to the person's devices"));
    }
    // Whether Nodex may start a person's own requests is that person's setting.
    if matches!(
        intent.as_ref(),
        ProjectWorkspaceIntent::SetInboxRoutingConsent { .. }
    ) {
        return Err(denied(
            "Only the person can change whether Nodex starts their requests",
        ));
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
