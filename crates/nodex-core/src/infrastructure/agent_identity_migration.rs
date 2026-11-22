use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use nodex_core_contracts::agent::AgentBackendBinding;
use rusqlite::{Connection, params};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::sqlite::{StoreError, StoreErrorCode};

/// v215 identified an Agent profile by a host-generated configuration key.
/// Reproduce the instance ID that the Runtime already uses for that profile.
pub(crate) fn legacy_binding(
    kind: &str,
    definition_id: Option<&str>,
    config_id: Option<&str>,
) -> Result<AgentBackendBinding, StoreError> {
    let driver = match kind {
        "codex" => return Ok(AgentBackendBinding::default()),
        "claude" => "claudeAgent",
        "opencode" => "opencode",
        "antigravity" => "antigravity",
        "acp" => "acpRegistry",
        _ => return Err(corrupt("Invalid legacy Agent driver")),
    };
    let (prefix, identity) = match config_id {
        Some(id) => (kind, id),
        // An ACP definition with no profile could not execute. Preserve its binding
        // for history under an ID that no configured profile can claim.
        None if kind == "acp" => (
            "acp_unconfigured",
            definition_id.ok_or_else(|| corrupt("Missing legacy ACP definition"))?,
        ),
        None => return Err(corrupt("Missing legacy Agent profile")),
    };
    let bytes = serde_json::to_vec(&[prefix, identity])
        .map_err(|_| corrupt("Invalid legacy Agent identity"))?;
    Ok(AgentBackendBinding {
        driver: driver.to_owned(),
        instance_id: format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(Sha256::digest(bytes))),
    })
}

pub(super) fn migrate(connection: &Connection) -> Result<(), StoreError> {
    for (table, key, driver, definition, instance) in [
        (
            "codex_threads",
            "thread_id",
            "agent_backend_kind",
            "agent_backend_definition_id",
            "agent_backend_instance_config_id",
        ),
        (
            "automations",
            "automation_id",
            "agent_backend_kind",
            "agent_backend_definition_id",
            "agent_backend_instance_config_id",
        ),
        (
            "thread_backend_sessions",
            "thread_id",
            "backend_kind",
            "agent_definition_id",
            "instance_config_id",
        ),
    ] {
        connection.execute_batch(&format!(
            "CREATE TEMP TABLE agent_identity_{table} AS SELECT * FROM {table};
             CREATE INDEX temp.agent_identity_{table}_key ON agent_identity_{table}({key});"
        ))?;
        let mut select = connection.prepare(&format!(
            "SELECT {key}, {driver}, {definition}, {instance} FROM {table}"
        ))?;
        let mut rows = select.query([])?;
        let mut update = connection.prepare(&format!(
            "UPDATE agent_identity_{table} SET {driver}=?2, {instance}=?3 WHERE {key}=?1"
        ))?;
        while let Some(row) = rows.next()? {
            let binding = legacy_binding(
                &row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?.as_deref(),
                row.get::<_, Option<String>>(3)?.as_deref(),
            )?;
            update.execute(params![
                row.get::<_, String>(0)?,
                binding.driver,
                binding.instance_id
            ])?;
        }
    }
    connection.execute_batch(include_str!("../../schema/migrations/v215_to_v216.sql"))?;
    migrate_stored_json(connection)
}

fn upgrade_binding(value: &mut Value) -> Result<bool, StoreError> {
    let Some(kind) = value["kind"].as_str() else {
        return Ok(false);
    };
    let binding = legacy_binding(
        kind,
        value["agent_definition_id"].as_str(),
        value["instance_config_id"].as_str(),
    )?;
    *value = serde_json::to_value(binding).map_err(|_| corrupt("Invalid stored Agent identity"))?;
    Ok(true)
}

fn migrate_stored_json(connection: &Connection) -> Result<(), StoreError> {
    let mut select = connection.prepare(
        "SELECT dispatch_id, frozen_action_json FROM automation_decisions
         WHERE json_type(frozen_action_json, '$.backend_binding.kind') = 'text'",
    )?;
    let rows = select
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut update = connection
        .prepare("UPDATE automation_decisions SET frozen_action_json=?2 WHERE dispatch_id=?1")?;
    for (id, json) in rows {
        let mut action: Value =
            serde_json::from_str(&json).map_err(|_| corrupt("Invalid frozen Automation action"))?;
        if upgrade_binding(&mut action["backend_binding"])? {
            update.execute(params![id, action.to_string()])?;
        }
    }
    for table in ["core_module_receipts", "detached_module_receipts"] {
        let mut select = connection.prepare(&format!(
            "SELECT operation_id, result_json FROM {table}
             WHERE module_name='automation'
               AND json_array_length(result_json, '$.value.automations') > 0",
        ))?;
        let rows = select
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut update = connection.prepare(&format!(
            "UPDATE {table} SET result_json=?2 WHERE module_name='automation' AND operation_id=?1",
        ))?;
        for (operation, json) in rows {
            let mut receipt: Value =
                serde_json::from_str(&json).map_err(|_| corrupt("Invalid Automation receipt"))?;
            let Some(automations) = receipt["value"]["automations"].as_array_mut() else {
                continue;
            };
            let mut changed = false;
            for automation in automations {
                if let Some(binding) = automation.get_mut("backend_binding") {
                    changed |= upgrade_binding(binding)?;
                }
            }
            if changed {
                update.execute(params![operation, receipt.to_string()])?;
            }
        }
    }
    Ok(())
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_ids_match_the_host_migration_vectors() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/agent-identity-vectors.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            let binding = legacy_binding(
                vector["kind"].as_str().unwrap(),
                vector["definitionId"].as_str(),
                vector["configId"].as_str(),
            )
            .unwrap();
            assert_eq!(binding.driver, vector["driver"]);
            assert_eq!(binding.instance_id, vector["instanceId"]);
        }
    }
}
