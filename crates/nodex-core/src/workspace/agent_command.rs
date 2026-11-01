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
    if matches!(intent.as_ref(), ProjectWorkspaceIntent::AgentCommand { .. }) {
        return Err(denied("Agent command envelopes cannot be nested"));
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
