//! The v196 vocabulary cutover touches only workflow coordinates, never user text.

use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::database::{
    DatabaseListProjectionRow, DatabaseViewAdvancedFilterOverrideInput,
    DatabaseViewCompletedRangeInput, DatabaseViewCompletionOverrideInput,
    DatabaseViewHierarchyOverrideInput, DatabaseViewPreferencesOverrideInput,
};
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::sqlite::{StoreError, StoreErrorCode};

fn renamed_id(id: &str) -> &str {
    match id {
        "build" => "doing",
        "ship" => "done",
        _ => id,
    }
}

fn previous_id(id: &str) -> &str {
    match id {
        "doing" => "build",
        "done" => "ship",
        _ => id,
    }
}

fn rewrite_id(value: &mut Value) {
    let Some(id) = value.as_str() else { return };
    let renamed = renamed_id(id);
    if id != renamed {
        *value = Value::String(renamed.to_owned());
    }
}

fn parse(raw: &str) -> Result<Value, StoreError> {
    serde_json::from_str(raw).map_err(|_| corrupt("Invalid workflow migration JSON"))
}

fn encode(value: &impl Serialize) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|_| corrupt("Cannot encode workflow migration JSON"))
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

/// View rules and conditional colors share Property-typed clauses. Other
/// Properties, text filters, identifiers and labels retain their exact values.
fn rewrite_clauses(value: &mut Value) {
    match value {
        Value::Object(object) => {
            let status_select = object.get("propertyId").and_then(Value::as_str) == Some("status")
                && matches!(
                    object.get("operator").and_then(Value::as_str),
                    Some("select_is" | "select_is_not")
                );
            if status_select && let Some(value) = object.get_mut("value") {
                rewrite_id(value);
            }
            object.values_mut().for_each(rewrite_clauses);
        }
        Value::Array(values) => values.iter_mut().for_each(rewrite_clauses),
        _ => {}
    }
}

pub(super) fn migrate(connection: &Connection) -> Result<Value, StoreError> {
    let registries = connection
        .prepare(
            "SELECT data_source_id, config_json FROM data_source_properties WHERE id='status'",
        )?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (source, raw) in registries {
        let mut config = parse(&raw)?;
        let options = config
            .get_mut("options")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| corrupt("Workflow Property has no option registry"))?;
        for option in options {
            let old_id = option.get("id").and_then(Value::as_str).unwrap_or_default();
            let default_names = match old_id {
                "build" => Some(("Build", "Doing")),
                "ship" => Some(("Ship", "Done")),
                _ => None,
            };
            if let Some((old, new)) = default_names
                && option.get("name").and_then(Value::as_str) == Some(old)
            {
                option["name"] = Value::String(new.to_owned());
            }
            if let Some(id) = option.get_mut("id") {
                rewrite_id(id);
            }
        }
        connection.execute("UPDATE data_source_properties SET config_json=?1 WHERE data_source_id=?2 AND id='status'", params![encode(&config)?, source])?;
    }
    // Includes removed memberships: restoring or undoing a move reuses their values.
    let values = connection.execute(
        "UPDATE data_source_property_values SET value_json=json_quote(CASE json_extract(value_json,'$') WHEN 'build' THEN 'doing' ELSE 'done' END) WHERE property_id='status' AND json_extract(value_json,'$') IN ('build','ship')", [],
    )?;
    let projections = connection.execute(
        "UPDATE page_read_model SET database_values_json=json_set(database_values_json,'$.status',CASE json_extract(database_values_json,'$.status') WHEN 'build' THEN 'doing' ELSE 'done' END) WHERE json_extract(database_values_json,'$.status') IN ('build','ship')", [],
    )?;
    connection.execute(
        "UPDATE page_read_model SET view_group_key=CASE view_group_key WHEN 'build' THEN 'doing' ELSE 'done' END WHERE view_group_key IN ('build','ship') AND view_id IN (SELECT id FROM database_views WHERE json_extract(config_json,'$.presentation.group.propertyId')='status')", [],
    )?;
    let views = connection
        .prepare("SELECT id,config_json FROM database_views")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, raw) in views {
        let mut config = parse(&raw)?;
        rewrite_clauses(&mut config);
        if config != parse(&raw)? {
            connection.execute(
                "UPDATE database_views SET config_json=?1 WHERE id=?2",
                params![encode(&config)?, id],
            )?;
        }
    }
    let preferences = connection
        .prepare(
            "SELECT profile_id,view_id,preferences_json FROM database_view_personal_preferences",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (profile, view, raw) in preferences {
        let mut config = parse(&raw)?;
        rewrite_clauses(&mut config);
        if config != parse(&raw)? {
            connection.execute("UPDATE database_view_personal_preferences SET preferences_json=?1 WHERE profile_id=?2 AND view_id=?3", params![encode(&config)?, profile, view])?;
        }
    }
    let disclosures = migrate_disclosures(connection)?;
    let delete_receipts = migrate_delete_evidence(connection)?;
    Ok(
        serde_json::json!({"workflow_status_vocabulary":true,"property_values":values,"page_projections":projections,"collapsed_occurrences":disclosures,"delete_receipts":delete_receipts}),
    )
}

fn occurrence_key(kind: &str, value: &impl Serialize) -> Result<String, StoreError> {
    Ok(format!(
        "{kind}_{}",
        hex::encode(Sha256::digest(encode(value)?.as_bytes()))
    ))
}

fn effective_group(config: &Value, preferences: &Value, group: &str) -> bool {
    let override_group = &preferences["presentation_override"][group];
    if override_group.is_object() {
        return override_group["kind"] == "property" && override_group["property_id"] == "status";
    }
    config["presentation"][group]["propertyId"] == "status"
}

/// Occurrence identities hash group paths. Recompute their old identities from
/// the current semantic graph; replacing text cannot repair these keys.
fn migrate_disclosures(connection: &Connection) -> Result<usize, StoreError> {
    let coordinates = connection.prepare(
        "SELECT DISTINCT collapsed.profile_id,view.id,container.library_id,view.layout,view.config_json,COALESCE(preferences.preferences_json,'{}'),view.lifecycle='active' AND container.lifecycle='active' AND source.lifecycle='active' FROM database_view_collapsed_occurrences collapsed JOIN database_views view ON view.id=collapsed.view_id JOIN database_containers container ON container.block_id=view.database_block_id JOIN data_sources source ON source.id=view.data_source_id LEFT JOIN database_view_personal_preferences preferences ON preferences.profile_id=collapsed.profile_id AND preferences.view_id=view.id",
    )?.query_map([], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, String>(3)?,row.get::<_, String>(4)?,row.get::<_, String>(5)?,row.get::<_, bool>(6)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if coordinates.is_empty() {
        return Ok(0);
    }
    let mut changed = 0;
    for (profile, view, library, layout, raw, prefs_raw, active) in coordinates {
        let config = parse(&raw)?;
        let prefs_value = parse(&prefs_raw)?;
        let group_is_status = effective_group(&config, &prefs_value, "group");
        let subgroup_is_status = effective_group(&config, &prefs_value, "subgroup");
        if !group_is_status && !subgroup_is_status {
            continue;
        }
        let mut keys = BTreeMap::new();
        if group_is_status {
            for (old, new) in [("build", "doing"), ("ship", "done")] {
                keys.insert(
                    occurrence_key("GROUP", &old)?,
                    occurrence_key("GROUP", &new)?,
                );
                keys.insert(
                    format!("GROUP_{}", encode(&old)?),
                    format!("GROUP_{}", encode(&new)?),
                );
            }
        }
        let has_pages: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM database_view_collapsed_occurrences WHERE profile_id=?1 AND view_id=?2 AND target_kind='page')", params![profile,view], |row| row.get(0))?;
        let mut live_page_keys = BTreeSet::new();
        if layout == "list" && has_pages && active {
            let epoch: String = connection.query_row(
                "SELECT store_epoch FROM block_store_metadata WHERE id=1",
                [],
                |row| row.get(0),
            )?;
            let mut preferences: DatabaseViewPreferencesOverrideInput = if prefs_raw == "{}" {
                DatabaseViewPreferencesOverrideInput::default()
            } else {
                serde_json::from_value(prefs_value)
                    .map_err(|_| corrupt("Invalid View preferences during workflow migration"))?
            };
            // Include collapsed Pages hidden by current rules, completion or hierarchy display.
            preferences.presentation_override.hierarchy =
                Some(DatabaseViewHierarchyOverrideInput {
                    show_sub_pages: Some(true),
                    nested_sub_pages: None,
                });
            preferences.rules_override.property_filters = Some(Vec::new());
            preferences.rules_override.advanced_filter =
                Some(DatabaseViewAdvancedFilterOverrideInput::None);
            preferences.presentation_override.completion =
                Some(DatabaseViewCompletionOverrideInput {
                    range: Some(DatabaseViewCompletedRangeInput::All),
                    order_by_recency: None,
                });
            let projection = crate::database::presented_list_projection(
                connection,
                &library,
                &view,
                &preferences,
                &epoch,
                None,
            )?;
            for row in projection.graph.rows {
                let DatabaseListProjectionRow::Page {
                    occurrence_key: new_key,
                    summary,
                    mut group_path,
                    ancestor_page_ids,
                    ..
                } = row
                else {
                    continue;
                };
                for (index, is_status) in [group_is_status, subgroup_is_status]
                    .into_iter()
                    .enumerate()
                {
                    if !is_status {
                        continue;
                    }
                    if let Some(Some(id)) = group_path.get_mut(index) {
                        *id = previous_id(id).to_owned();
                    }
                }
                let old_key =
                    occurrence_key("ITEM", &(&group_path, &ancestor_page_ids, &summary.page_id))?;
                live_page_keys.insert(new_key.clone());
                keys.insert(old_key, new_key);
            }
        }
        for (old, new) in keys {
            if old == new {
                continue;
            }
            connection.execute("INSERT INTO database_view_collapsed_occurrences(profile_id,view_id,target_kind,occurrence_key,collapsed_at) SELECT profile_id,view_id,target_kind,?1,collapsed_at FROM database_view_collapsed_occurrences WHERE profile_id=?2 AND view_id=?3 AND occurrence_key=?4 ON CONFLICT(profile_id,view_id,target_kind,occurrence_key) DO UPDATE SET collapsed_at=MAX(collapsed_at,excluded.collapsed_at)", params![new,profile,view,old])?;
            changed += connection.execute("DELETE FROM database_view_collapsed_occurrences WHERE profile_id=?1 AND view_id=?2 AND occurrence_key=?3", params![profile,view,old])?;
        }
        // Hashes of unreachable occurrences cannot be inverted. Discard stale
        // disclosure state rather than retaining keys tied to retired stages.
        let page_keys = connection.prepare("SELECT occurrence_key FROM database_view_collapsed_occurrences WHERE profile_id=?1 AND view_id=?2 AND target_kind='page'")?
            .query_map(params![profile,view], |row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for key in page_keys
            .into_iter()
            .filter(|key| !live_page_keys.contains(key))
        {
            changed += connection.execute("DELETE FROM database_view_collapsed_occurrences WHERE profile_id=?1 AND view_id=?2 AND target_kind='page' AND occurrence_key=?3",params![profile,view,key])?;
        }
    }
    Ok(changed)
}

/// Delete receipts are live restore authority, not just audit history. General
/// journal payloads and Document snapshots remain byte-for-byte historical.
fn migrate_delete_evidence(connection: &Connection) -> Result<usize, StoreError> {
    let rows = connection.prepare("SELECT operation_id,result_json,local_commit_seq FROM core_module_receipts WHERE module_name='library' AND operation_kind='delete_page'")?
        .query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<i64>>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut changed = 0;
    for (operation, raw, commit) in rows {
        let mut result = parse(&raw)?;
        let Some(status) =
            result.pointer_mut("/value/page_lifecycle/delete_evidence/membership/status")
        else {
            continue;
        };
        rewrite_id(status);
        if result == parse(&raw)? {
            continue;
        }
        let encoded = encode(&result)?;
        connection.execute("UPDATE core_module_receipts SET result_json=?1 WHERE module_name='library' AND operation_id=?2", params![encoded,operation])?;
        let delta = encoded.len() as i64 - raw.len() as i64;
        let tracked = connection.execute("UPDATE module_receipt_retention_metadata SET receipt_bytes=receipt_bytes+?1 WHERE module_name='library' AND operation_id=?2", params![delta,operation])?;
        if tracked != 0 {
            connection.execute("UPDATE operational_journal_state SET retained_receipt_bytes=retained_receipt_bytes+?1 WHERE id=1", [delta])?;
        }
        if let Some(commit) = commit {
            super::local_commit::refresh_migrated_receipt(
                connection,
                commit,
                &hex::encode(Sha256::digest(encoded.as_bytes())),
            )?;
        }
        changed += 1;
    }
    Ok(changed)
}
