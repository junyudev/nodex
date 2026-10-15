use nodex_core_contracts::agent::{AgentExecutionAuthorization, AgentTurnProvenance};
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::Connection;

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

/// Content commands preserve the exact live execution identity, independently of Project routing.
pub(crate) fn validate_execution(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    execution: &AgentExecutionAuthorization,
) -> Result<String, StoreError> {
    validate_transport_context(context, &execution.provenance)?;
    if execution.call_id.is_empty() || execution.call_id.len() > 512 {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            "Agent call identity is invalid",
            false,
        ));
    }
    crate::workspace::validate_persisted_turn_authority(
        connection,
        library_id,
        &execution.provenance,
    )
}

pub(super) fn validate_transport_context(
    context: &BoundModuleContext,
    provenance: &AgentTurnProvenance,
) -> Result<(), StoreError> {
    if !matches!(
        context.adapter,
        AdapterKind::Agent | AdapterKind::ElectronHost | AdapterKind::Test
    ) || context.profile_id.0 != provenance.profile_id
        || context.library_id.0 != provenance.authority.library_id
        || context.connection_id.is_empty()
        || context.connection_id.len() > 512
    {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Agent execution does not match the bound Profile context",
            false,
        ));
    }
    Ok(())
}
