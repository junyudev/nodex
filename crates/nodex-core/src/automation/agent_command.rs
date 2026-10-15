//! Agent requests use captured execution identity, independent of the target Project.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::agent::AgentTurnProvenance;
use nodex_core_contracts::automation::AutomationIntent;
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::Connection;

pub(super) fn admit_read(
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
            "Agent Automation request does not match the current Profile",
        ));
    }
    crate::workspace::validate_persisted_turn_authority(connection, library_id, provenance)?;
    Ok(())
}
pub(super) fn admit<'a>(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    intent: &'a AutomationIntent,
) -> Result<&'a AutomationIntent, StoreError> {
    let AutomationIntent::AgentCommand { provenance, intent } = intent else {
        if context.adapter == AdapterKind::Agent {
            return Err(denied(
                "Agent Automation commands require execution provenance",
            ));
        }
        return Ok(intent);
    };
    admit_read(connection, library_id, context, provenance)?;
    if matches!(intent.as_ref(), AutomationIntent::AgentCommand { .. }) {
        return Err(denied("Agent command envelopes cannot be nested"));
    }
    Ok(intent)
}
fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}
