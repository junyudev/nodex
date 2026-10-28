//! Agent requests use captured execution identity, independent of the target Project.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::agent::AgentTurnProvenance;
use nodex_core_contracts::automation::{AutomationIntent, AutomationLaunch};
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
    let escalation = match intent.as_ref() {
        AutomationIntent::CreateDefinition { definition, .. } => {
            definition.launch == Some(AutomationLaunch::Automatic)
        }
        AutomationIntent::UpdateDefinition {
            automation_id,
            definition,
            ..
        } => {
            definition.launch == Some(AutomationLaunch::Automatic)
                && super::read::read_definition(connection, automation_id)?
                    .is_some_and(|current| current.launch == AutomationLaunch::Ask)
        }
        _ => false,
    };
    if escalation {
        return Err(denied(
            "Only the user can let a scheduled task run without asking. Suggest this change so they can apply it.",
        ));
    }
    Ok(intent)
}
fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}
