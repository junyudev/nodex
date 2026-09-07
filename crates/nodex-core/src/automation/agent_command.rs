//! Definition access is checked against current Turn authority before receipt replay.
use nodex_core_contracts::agent::AgentTurnProvenance;
use nodex_core_contracts::automation::{AutomationDefinitionKind, AutomationIntent};
use nodex_core_contracts::workspace::ProjectWorkspaceTurnAuthorityScope;
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::{Connection, OptionalExtension};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

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
        || context.project_id.as_ref().map(|id| id.0.as_str())
            != provenance.authority.actor_project_id.as_deref()
    {
        return Err(denied(
            "Agent Automation request does not match its bound Project",
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
        if matches!(context.adapter, AdapterKind::Agent) {
            return Err(denied("Agent Automation commands require Turn provenance"));
        }
        return Ok(intent);
    };
    admit_read(connection, library_id, context, provenance)?;
    if crate::workspace::turn_is_read_only(
        connection,
        &provenance.authority.thread_id,
        &provenance.authority.turn_id,
    )? {
        return Err(denied("Read-only Turns cannot change Automations"));
    }
    let input = match intent.as_ref() {
        AutomationIntent::CreateDefinition {
            automation_id,
            definition,
        } => {
            if super::read::read_definition(connection, automation_id)?.is_some() {
                require_existing(connection, provenance, automation_id)?;
            }
            Some(definition)
        }
        AutomationIntent::UpdateDefinition {
            automation_id,
            definition,
            ..
        } => {
            require_existing(connection, provenance, automation_id)?;
            Some(definition)
        }
        AutomationIntent::DeleteDefinition { automation_id, .. } => {
            require_existing(connection, provenance, automation_id)?;
            None
        }
        _ => return Err(denied("This Automation command is not available to Agents")),
    };
    if let Some(input) = input {
        require_target(
            connection,
            provenance,
            input.kind,
            input.project_id.as_deref(),
            input.target_session_id.as_deref(),
        )?;
    }
    Ok(intent)
}

fn require_existing(
    connection: &Connection,
    provenance: &AgentTurnProvenance,
    automation_id: &str,
) -> Result<(), StoreError> {
    let definition = super::read::read_definition(connection, automation_id)?
        .ok_or_else(|| denied("Automation is unavailable"))?;
    require_target(
        connection,
        provenance,
        definition.kind,
        definition.project_id.as_deref(),
        definition.target_session_id.as_deref(),
    )
}

pub(super) fn require_target(
    connection: &Connection,
    provenance: &AgentTurnProvenance,
    kind: AutomationDefinitionKind,
    project_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<(), StoreError> {
    let target_project = match kind {
        AutomationDefinitionKind::Cron => project_id.map(str::to_owned),
        AutomationDefinitionKind::Heartbeat => {
            let session_id =
                session_id.ok_or_else(|| denied("Heartbeat requires a target Session"))?;
            connection
                .query_row(
                    "SELECT project_id FROM project_sessions WHERE id = ?1",
                    [session_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .ok_or_else(|| denied("Heartbeat Session is unavailable"))?
        }
    };
    if provenance.authority.scope == ProjectWorkspaceTurnAuthorityScope::Library
        || target_project.as_deref() == provenance.authority.actor_project_id.as_deref()
    {
        return Ok(());
    }
    Err(denied(
        "Automation target is outside the Turn's authorized Project",
    ))
}

fn denied(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}
