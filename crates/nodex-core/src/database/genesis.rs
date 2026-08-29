use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::property_semantics::PRIORITY_OPTIONS;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

#[allow(clippy::too_many_arguments)]
pub(crate) fn create_database_authority_records(
    connection: &Connection,
    library_id: &str,
    database_id: &str,
    data_source_id: &str,
    view_id: &str,
    name: &str,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO database_containers(\
           block_id, library_id, name, lifecycle, default_view_id, access_revision, \
           metadata_revision, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, 'active', NULL, 1, 1, ?4, ?4)",
        params![database_id, library_id, name, now],
    )?;
    connection.execute(
        "INSERT INTO data_sources(\
           id, library_id, home_database_block_id, name, schema_key, schema_revision, \
           lifecycle, rank_key, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, 'nodex.database', 1, 'active', ?5, ?6, ?6)",
        params![
            data_source_id,
            library_id,
            database_id,
            name,
            fractional_rank(1, 1),
            now
        ],
    )?;
    let initial_properties = initial_property_definitions(true);
    let initial_property_count = initial_properties.len();
    for (index, (id, property_name, value_type, config)) in
        initial_properties.into_iter().enumerate()
    {
        connection.execute(
            "INSERT INTO data_source_properties(\
               data_source_id, id, name, value_type, config_json, rank_key, lifecycle, \
               schema_revision, created_at, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 1, ?7, ?7)",
            params![
                data_source_id,
                id,
                property_name,
                value_type,
                serde_json::to_string(&config).map_err(|_| internal("Initial Property config"))?,
                fractional_rank(index + 1, initial_property_count),
                now,
            ],
        )?;
    }
    connection.execute(
        "INSERT INTO data_source_page_layouts(data_source_id, revision, created_at, updated_at) \
         VALUES (?1, 1, ?2, ?2)",
        params![data_source_id, now],
    )?;
    connection.execute(
        "INSERT INTO data_source_page_layout_entries(\
           data_source_id, property_id, rank_key, visibility\
         ) SELECT ?1, id, rank_key, 'always_show' FROM data_source_properties \
           WHERE data_source_id = ?1 AND lifecycle = 'active'",
        params![data_source_id],
    )?;
    connection.execute(
        "INSERT INTO data_source_relation_properties(\
           data_source_id, property_id, target_data_source_id, cardinality\
         ) VALUES (?1, ?2, ?1, 'one')",
        params![
            data_source_id,
            super::property_semantics::TASK_PARENT_PROPERTY_ID
        ],
    )?;
    let current_view_config = json!({
        "schemaKey": "nodex.database-view",
        "schemaVersion": 6,
        "rules": {
            "propertyFilters": [],
            "advancedFilter": null,
            "sorts": [{
                "field": { "kind": "manual" },
                "direction": "asc",
                "nulls": "last"
            }]
        },
        "presentation": {
            "group": { "propertyId": "status" },
            "subgroup": null,
            "groupDirection": "asc",
            "completion": { "range": "all", "orderByRecency": false },
            "hierarchy": { "showSubPages": true, "nestedSubPages": false },
            "display": {
                "fields": [
                    { "kind": "property", "propertyId": "status" },
                    { "kind": "property", "propertyId": "priority" },
                    { "kind": "property", "propertyId": "estimate" },
                    { "kind": "property", "propertyId": "tags" }
                ],
                "showEmptyGroups": false,
                "showDescription": true
            }
        }
    });
    connection.execute(
        "INSERT INTO database_views(\
           id, database_block_id, data_source_id, name, layout, config_json, revision, \
           rank_key, lifecycle, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, 'Board', 'board', ?4, 1, ?5, 'active', ?6, ?6)",
        params![
            view_id,
            database_id,
            data_source_id,
            serde_json::to_string(&current_view_config)
                .map_err(|_| internal("Initial View config"))?,
            fractional_rank(1, 1),
            now,
        ],
    )?;
    let changed = connection.execute(
        "UPDATE database_containers SET default_view_id = ?1 WHERE block_id = ?2",
        params![view_id, database_id],
    )?;
    if changed == 1 {
        return Ok(());
    }
    Err(corrupt("Created Database Container disappeared"))
}

fn initial_property_definitions(
    includes_task_parent: bool,
) -> Vec<(&'static str, &'static str, &'static str, Value)> {
    let mut definitions = vec![
        (
            "status",
            "Status",
            "select",
            json!({
                "options": [
                    { "id": "triage", "name": "Triage" },
                    { "id": "plan", "name": "Plan" },
                    { "id": "build", "name": "Build" },
                    { "id": "review", "name": "Review" },
                    { "id": "ship", "name": "Ship" }
                ]
            }),
        ),
        (
            "priority",
            "Priority",
            "select",
            json!({
                "options": PRIORITY_OPTIONS.map(|(id, name)| json!({
                    "id": id,
                    "name": name,
                }))
            }),
        ),
        (
            "estimate",
            "Estimate",
            "select",
            json!({
                "options": [
                    { "id": "xs", "name": "XS" },
                    { "id": "s", "name": "S" },
                    { "id": "m", "name": "M" },
                    { "id": "l", "name": "L" },
                    { "id": "xl", "name": "XL" }
                ]
            }),
        ),
        ("tags", "Tags", "multi_select", json!({ "options": [] })),
        ("due_date", "Due date", "date", json!({})),
        ("scheduled_start", "Scheduled start", "datetime", json!({})),
        ("scheduled_end", "Scheduled end", "datetime", json!({})),
        ("assignee", "Assignee", "text", json!({})),
    ];
    if includes_task_parent {
        definitions.push((
            super::property_semantics::TASK_PARENT_PROPERTY_ID,
            "Parent",
            "relation",
            json!({}),
        ));
    }
    definitions
}

fn fractional_rank(ordinal: usize, total: usize) -> String {
    let divisor = (total + 1) as u128;
    let ordinal = ordinal as u128;
    let value = (u128::MAX / divisor) * ordinal + ((u128::MAX % divisor) * ordinal) / divisor;
    format!("{value:032x}")
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}
