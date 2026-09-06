use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(test)]
use super::sqlite::with_immediate_transaction;
use super::sqlite::{StoreError, StoreErrorCode};

pub const CURRENT_STORE_REVISION: i64 = nodex_store_format::CURRENT_STORE_VERSION as i64;
pub const CURRENT_SCHEMA_SQL: &str = include_str!("../../schema/current.sql");

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaObjectKey {
    pub object_type: String,
    pub name: String,
    pub table_name: String,
}

pub type SchemaInventory = BTreeMap<SchemaObjectKey, String>;

#[cfg(test)]
pub(crate) fn install_current_schema(connection: &mut Connection) -> Result<(), StoreError> {
    with_immediate_transaction(connection, |transaction| {
        install_current_schema_in_transaction(transaction)
    })
}

pub(crate) fn install_current_schema_in_transaction(
    connection: &Connection,
) -> Result<(), StoreError> {
    let current: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let object_count: i64 = connection.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    if current != 0 || object_count != 0 {
        return Err(StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            "Current schema installation requires an empty SQLite database",
            false,
        ));
    }
    connection.execute_batch(CURRENT_SCHEMA_SQL)?;
    let installed: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if installed != CURRENT_STORE_REVISION {
        return Err(StoreError::new(
            StoreErrorCode::StoreCorrupt,
            format!("Current schema artifact published v{installed}"),
            false,
        ));
    }
    Ok(())
}

pub fn read_schema_inventory(connection: &Connection) -> Result<SchemaInventory, StoreError> {
    let shadow_tables = connection
        .prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow'")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    let objects = connection
        .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema \
             WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' \
             ORDER BY type, name, tbl_name",
        )?
        .query_map([], |row| {
            Ok((
                SchemaObjectKey {
                    object_type: row.get(0)?,
                    name: row.get(1)?,
                    table_name: row.get(2)?,
                },
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(objects
        .into_iter()
        .filter(|(key, _)| {
            !shadow_tables.contains(&key.name) && !shadow_tables.contains(&key.table_name)
        })
        .map(|(key, sql)| (key, normalize_sql(&sql)))
        .collect())
}

pub fn schema_inventory_fingerprint(inventory: &SchemaInventory) -> String {
    let mut digest = Sha256::new();
    for (key, sql) in inventory {
        for value in [
            key.object_type.as_str(),
            key.name.as_str(),
            key.table_name.as_str(),
            sql.as_str(),
        ] {
            digest.update(value.as_bytes());
            digest.update([0]);
        }
    }
    format!("{:x}", digest.finalize())
}

pub fn validate_schema_identity(connection: &Connection, revision: i64) -> Result<(), StoreError> {
    let revision = u32::try_from(revision).map_err(|_| {
        StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            format!("Store revision v{revision} is not published"),
            false,
        )
    })?;
    let published = nodex_store_format::published_store_format(revision).ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            format!("Store revision v{revision} is not published"),
            false,
        )
    })?;
    let actual = schema_inventory_fingerprint(&read_schema_inventory(connection)?);
    if actual == published.schema_fingerprint {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::StoreCorrupt,
        format!(
            "v{revision} physical schema fingerprint is {actual}; expected {}",
            published.schema_fingerprint
        ),
        false,
    ))
}

fn normalize_sql(sql: &str) -> String {
    static SIMPLE_QUOTED_IDENTIFIER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"\"([A-Za-z_][A-Za-z0-9_]*)\""#).expect("quoted identifier regex")
    });
    let whitespace_normalized = sql
        .trim_end_matches(';')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    SIMPLE_QUOTED_IDENTIFIER
        .replace_all(&whitespace_normalized, "$1")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use crate::infrastructure::sqlite::open_writer;

    use super::*;

    #[test]
    fn schema_inventory_ignores_fts_shadow_implementation_objects() {
        let directory = tempdir().expect("schema store");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        install_current_schema(&mut connection).expect("current schema");
        let inventory = read_schema_inventory(&connection).expect("inventory");
        assert!(
            inventory
                .keys()
                .all(|key| !key.name.starts_with("block_search_units_fts_"))
        );
        assert!(
            inventory
                .keys()
                .all(|key| !key.name.starts_with("thread_search"))
        );
    }

    #[test]
    fn manual_order_projection_exposes_only_explicit_active_generation_positions() {
        let mut connection = Connection::open_in_memory().expect("Store");
        install_current_schema(&mut connection).expect("current schema");
        // Exercise the physical projection without unrelated content aggregates.
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        crate::infrastructure::visibility_delta_journal::install_test_maintenance_context(
            &connection,
        )
        .unwrap();
        connection.execute_batch(
            "INSERT INTO database_views(id, database_block_id, data_source_id, name, layout, rank_key, created_at, updated_at) \
             VALUES ('view', 'database', 'source', 'Order', 'list', 'a', 'created', 'updated'); \
             INSERT INTO database_view_order_rows(view_id, generation, page_block_id, rank_key, default_epoch, revision, is_active, is_task_root, created_at, updated_at) VALUES \
             ('view', 1, 'implicit', '11111111111111111111111111111111', 1, 0, 1, 1, 'created', 'updated'), \
             ('view', 1, 'explicit', '22222222222222222222222222222222', NULL, 0, 1, 1, 'created', 'updated'), \
             ('view', 2, 'future', '33333333333333333333333333333333', NULL, 8, 1, 1, 'created', 'updated');"
        ).expect("physical order fixture");
        let positions = || {
            connection.prepare("SELECT page_block_id, revision FROM database_view_page_positions ORDER BY page_block_id").unwrap()
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))).unwrap()
            .collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(positions(), vec![("explicit".into(), 1)]);
        connection
            .execute(
                "UPDATE database_view_order_state SET default_epoch = 2 WHERE view_id = 'view'",
                [],
            )
            .unwrap();
        assert_eq!(
            positions(),
            vec![("explicit".into(), 1), ("implicit".into(), 1)]
        );
        assert!(
            connection
                .execute("DELETE FROM database_view_page_positions", [])
                .is_err()
        );
    }

    #[test]
    fn current_schema_artifact_matches_catalog() {
        assert_eq!(CURRENT_STORE_REVISION, 160);
        let mut artifact = Connection::open_in_memory().expect("artifact Store");
        install_current_schema(&mut artifact).expect("current schema artifact");
        let artifact_inventory = read_schema_inventory(&artifact).expect("artifact inventory");
        assert_eq!(
            schema_inventory_fingerprint(&artifact_inventory),
            nodex_store_format::CURRENT_STORE_SCHEMA_FINGERPRINT,
        );
        for table in [
            "codex_queued_follow_up_ledgers",
            "codex_queued_follow_up_entries",
            "codex_queued_follow_up_payload_manifests",
            "codex_queued_follow_up_payload_asset_refs",
            "project_session_pages",
            "workspace_sidebar_sections",
            "workspace_sidebar_section_items",
            "workspace_sidebar_section_host_links",
            "workspace_subagent_universes",
            "workspace_subagent_discovery_pages",
            "workspace_subagent_descendants",
            "workspace_subagent_status_evidence",
            "workspace_subagent_pending_status_evidence",
            "workspace_subagent_lifecycle_operations",
            "workspace_subagent_lifecycle_members",
            "structural_clipboard_bundles",
            "structural_clipboard_leases",
            "structural_cut_claims",
            "structural_history_recipes",
            "editor_history_owners",
            "editor_history_recipes",
            "structural_retention_members",
            "document_version_retention_index",
            "document_version_retention_members",
            "block_retention_state",
            "block_retention_deferrals",
        ] {
            assert!(
                artifact_inventory
                    .keys()
                    .any(|key| key.object_type == "table" && key.name == table),
                "missing {table}"
            );
        }
    }
}
