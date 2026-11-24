use nodex_core_contracts::automation::{AutomationEventFilter, AutomationTrigger};
use rusqlite::{Connection, params};
use serde_json::Value;

use super::sqlite::{StoreError, StoreErrorCode};

// Scheduled tasks could omit a rule before Core required a clock trigger.
pub(crate) const LEGACY_DEFAULT_RRULE: &str = "FREQ=HOURLY;INTERVAL=24;BYMINUTE=0";

pub(super) fn migrate(connection: &Connection) -> Result<(), StoreError> {
    rewrite_rows(
        connection,
        "SELECT automation_id, filter_json FROM automation_event_filters",
        "UPDATE automation_event_filters SET filter_json=?2 WHERE automation_id=?1",
        false,
        |filter| {
            *filter = serde_json::to_value(upgrade_filter(filter.take())?).map_err(invalid_json)?;
            Ok(true)
        },
    )?;
    connection.execute(
        "UPDATE automations SET rrule=?1
         WHERE (rrule IS NULL OR trim(rrule)='') AND NOT EXISTS (
            SELECT 1 FROM automation_event_filters filter
            WHERE filter.automation_id=automations.automation_id
         )",
        [LEGACY_DEFAULT_RRULE],
    )?;
    connection.execute_batch(include_str!("../../schema/migrations/v217_to_v218.sql"))?;
    rewrite_rows(
        connection,
        "SELECT dispatch_id, frozen_action_json FROM automation_decisions
         WHERE json_type(frozen_action_json, '$.typed_condition') = 'object'",
        "UPDATE automation_decisions SET frozen_action_json=?2 WHERE dispatch_id=?1",
        false,
        upgrade_automation,
    )?;
    rewrite_rows(
        connection,
        "SELECT request_id, automations_json FROM automation_assessment_requests
         WHERE json_array_length(automations_json) > 0",
        "UPDATE automation_assessment_requests SET automations_json=?2 WHERE request_id=?1",
        false,
        upgrade_automations,
    )?;

    // Receipt size includes the encoded result. Keep retirement accounting exact
    // after replacing its bytes, even for receipts with detached commit evidence.
    let mut receipt_bytes_delta = 0;
    for table in ["core_module_receipts", "detached_module_receipts"] {
        receipt_bytes_delta += rewrite_rows(
            connection,
            &format!(
                "SELECT operation_id, result_json FROM {table} WHERE module_name='automation'
                 AND (json_array_length(result_json, '$.value.automations') > 0
                   OR json_array_length(result_json, '$.value.claimed_leases') > 0)"
            ),
            &format!(
                "UPDATE {table} SET result_json=?2 WHERE module_name='automation' AND operation_id=?1"
            ),
            true,
            upgrade_receipt,
        )?;
    }
    connection.execute(
        "UPDATE operational_journal_state
         SET retained_receipt_bytes=retained_receipt_bytes+?1 WHERE id=1",
        [receipt_bytes_delta],
    )?;
    Ok(())
}

fn upgrade_filter(value: Value) -> Result<AutomationEventFilter, StoreError> {
    let Value::Object(mut filter) = value else {
        return Err(corrupt("Legacy Automation event filter is invalid"));
    };
    let events = filter
        .remove("kinds")
        .ok_or_else(|| corrupt("Legacy Automation event filter is missing kinds"))?;
    filter.insert("events".into(), events);
    if filter.get("actor_class").is_none_or(Value::is_null) {
        filter.insert("actor_class".into(), Value::String("any".into()));
    }
    serde_json::from_value(Value::Object(filter)).map_err(invalid_json)
}

fn upgrade_automation(value: &mut Value) -> Result<bool, StoreError> {
    let Value::Object(automation) = value else {
        return Err(corrupt("Legacy Automation snapshot is invalid"));
    };
    // Earlier migrations can freeze snapshots directly in the current shape.
    if automation.contains_key("trigger") {
        return Ok(false);
    }
    let condition = automation
        .remove("typed_condition")
        .ok_or_else(|| corrupt("Legacy Automation snapshot is missing typed_condition"))?;
    let next = automation.remove("next_run_at_ms").unwrap_or(Value::Null);
    automation.remove("rrule");
    let trigger = match condition["kind"].as_str() {
        Some("clock") => AutomationTrigger::Clock {
            rrule: serde_json::from_value(condition["rrule"].clone()).map_err(invalid_json)?,
            timezone: serde_json::from_value(condition["timezone"].clone())
                .map_err(invalid_json)?,
            next_run_at_ms: serde_json::from_value(next).map_err(invalid_json)?,
        },
        Some("source") => AutomationTrigger::Event {
            filter: upgrade_filter(condition["filters"].clone())?,
        },
        _ => {
            return Err(corrupt(
                "Legacy Automation snapshot has an invalid trigger kind",
            ));
        }
    };
    automation.insert(
        "trigger".into(),
        serde_json::to_value(trigger).map_err(invalid_json)?,
    );
    Ok(true)
}

fn upgrade_automations(values: &mut Value) -> Result<bool, StoreError> {
    let values = values
        .as_array_mut()
        .ok_or_else(|| corrupt("Stored Automation snapshot list is invalid"))?;
    let mut changed = false;
    for value in values {
        changed |= upgrade_automation(value)?;
    }
    Ok(changed)
}

fn upgrade_receipt(receipt: &mut Value) -> Result<bool, StoreError> {
    let mut changed = false;
    if let Some(automations) = receipt.pointer_mut("/value/automations") {
        changed |= upgrade_automations(automations)?;
    }
    let Some(leases) = receipt
        .pointer_mut("/value/claimed_leases")
        .and_then(Value::as_array_mut)
    else {
        return Ok(changed);
    };
    for lease in leases {
        let Some(snapshot) = lease
            .get_mut("execution_automation")
            .filter(|value| !value.is_null())
        else {
            continue;
        };
        changed |= upgrade_automation(snapshot)?;
    }
    Ok(changed)
}

fn rewrite_rows(
    connection: &Connection,
    select: &str,
    update: &str,
    receipt: bool,
    upgrade: impl Fn(&mut Value) -> Result<bool, StoreError>,
) -> Result<i64, StoreError> {
    let rows = connection
        .prepare(select)?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut update = connection.prepare(update)?;
    let mut adjust_receipt_size = connection.prepare(
        "UPDATE module_receipt_retention_metadata SET receipt_bytes=receipt_bytes+?2
         WHERE module_name='automation' AND operation_id=?1",
    )?;
    let mut receipt_bytes_delta = 0;
    for (id, raw) in rows {
        let mut value = serde_json::from_str(&raw).map_err(invalid_json)?;
        if !upgrade(&mut value)? {
            continue;
        }
        let rewritten = value.to_string();
        update.execute(params![id, rewritten])?;
        if !receipt {
            continue;
        }
        let delta = rewritten.len() as i64 - raw.len() as i64;
        if adjust_receipt_size.execute(params![id, delta])? == 1 {
            receipt_bytes_delta += delta;
        }
    }
    Ok(receipt_bytes_delta)
}

fn invalid_json(error: serde_json::Error) -> StoreError {
    corrupt(format!(
        "Stored Automation trigger JSON is invalid: {error}"
    ))
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
