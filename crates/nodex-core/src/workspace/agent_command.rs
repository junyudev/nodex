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
    admit_read_caller(connection, library_id, context, provenance)?;
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
            | ProjectWorkspaceIntent::SettlePageWorkLaunch { .. }
    ) {
        return Err(denied("Work launches belong to the Desktop Host"));
    }
    if matches!(intent.as_ref(), ProjectWorkspaceIntent::AgentCommand { .. }) {
        return Err(denied("Agent command envelopes cannot be nested"));
    }
    if matches!(
        intent.as_ref(),
        ProjectWorkspaceIntent::CreateAgentRuntimeSession {
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

