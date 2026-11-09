//! Retire text Assignee predicates at the same boundary as their stored values: a saved View or
//! personal override that matched a text Assignee now matches the Space's local Member.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

fn rewrite(value: &mut Value, member: &str) {
    match value {
        Value::Object(object) => {
            if object.get("propertyId").and_then(Value::as_str) == Some("assignee") {
                let operator = object.get("operator").and_then(Value::as_str);
                let negative = matches!(operator, Some("text_is_not" | "text_does_not_contain"));
                if matches!(
                    operator,
                    Some(
                        "text_is"
                            | "text_is_not"
                            | "text_contains"
                            | "text_does_not_contain"
                            | "text_starts_with"
                            | "text_ends_with"
                    )
                ) {
                    let empty = object
                        .get("value")
                        .and_then(Value::as_str)
                        .is_none_or(|v| v.trim().is_empty());
                    let operator = match (negative, empty) {
                        (false, false) => "equals",
                        (true, false) => "not_equals",
                        (false, true) => "is_empty",
                        (true, true) => "is_not_empty",
                    };
                    object.insert("operator".into(), operator.into());
                    if empty {
                        object.remove("value");
                    } else {
                        object.insert("value".into(), json!({"kind":"member","member_id":member}));
                    }
                }
            }
            object.values_mut().for_each(|value| rewrite(value, member));
        }
        Value::Array(values) => values.iter_mut().for_each(|value| rewrite(value, member)),
        _ => {}
    }
}

pub(super) fn migrate(connection: &Connection) -> Result<(), StoreError> {
    let views = connection.prepare("SELECT view.id,view.config_json,local.member_id FROM database_views view JOIN data_sources source ON source.id=view.data_source_id JOIN local_profile_members local ON local.library_id=source.library_id")?
        .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (view, raw, member) in views {
        let migrated = migrate_json(&raw, &member)?;
        connection.execute(
            "UPDATE database_views SET config_json=?1 WHERE id=?2",
            params![migrated, view],
        )?;
        let preferences=connection.prepare("SELECT member_id,preferences_json FROM database_view_personal_preferences WHERE view_id=?1")?.query_map([&view],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for (owner, raw) in preferences {
            connection.execute("UPDATE database_view_personal_preferences SET preferences_json=?1 WHERE member_id=?2 AND view_id=?3",params![migrate_json(&raw,&member)?,owner,view])?;
        }
    }
    reset_assignment_disclosures(connection)
}

/// Text groups have no identity in the new assignment model. Preserve other
/// View disclosures, including personal overrides that group by another field.
fn reset_assignment_disclosures(connection: &Connection) -> Result<(), StoreError> {
    let coordinates=connection.prepare("SELECT DISTINCT collapsed.member_id,view.id,view.config_json,COALESCE(preferences.preferences_json,'{}') FROM database_view_collapsed_occurrences collapsed JOIN database_views view ON view.id=collapsed.view_id LEFT JOIN database_view_personal_preferences preferences ON preferences.member_id=collapsed.member_id AND preferences.view_id=view.id")?.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (member, view, config, preferences) in coordinates {
        let config: Value = serde_json::from_str(&config).map_err(invalid_json)?;
        let preferences: Value = serde_json::from_str(&preferences).map_err(invalid_json)?;
        let assignment_axis = |axis| {
            let overridden = &preferences["presentation_override"][axis];
            let property = match overridden["kind"].as_str() {
                Some("none") => None,
                Some("property") => overridden["property_id"].as_str(),
                _ => config["presentation"][axis]["propertyId"].as_str(),
            };
            matches!(property, Some("assignee" | "owner"))
        };
        if assignment_axis("group") || assignment_axis("subgroup") {
            connection.execute(
                "DELETE FROM database_view_collapsed_occurrences WHERE member_id=?1 AND view_id=?2",
                params![member, view],
            )?;
        }
    }
    Ok(())
}

fn invalid_json(_: serde_json::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::StoreCorrupt,
        "Invalid saved View during Members migration",
        false,
    )
}

fn migrate_json(raw: &str, member: &str) -> Result<String, StoreError> {
    let mut value: Value = serde_json::from_str(raw).map_err(|_| {
        StoreError::new(
            StoreErrorCode::StoreCorrupt,
            "Invalid saved View during Members migration",
            false,
        )
    })?;
    rewrite(&mut value, member);
    Ok(value.to_string())
}
