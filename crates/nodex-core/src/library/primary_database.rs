//! A primary Database is the home its owner depends on: a Project's, or the Library Inbox's.

use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::StoreError;

/// SQL that is true while `database_id` names a primary Database whose owner is active. Such a
/// Database is ordinary Library content but cannot be archived.
pub(super) fn active_primary_database_sql(database_id: &str) -> String {
    format!(
        "(EXISTS (SELECT 1 FROM project_database_bindings \
            WHERE database_block_id = {database_id} AND lifecycle = 'active') \
          OR EXISTS (SELECT 1 FROM projects \
            WHERE database_block_id = {database_id} AND lifecycle = 'active') \
          OR EXISTS (SELECT 1 FROM inbox_registry WHERE database_block_id = {database_id}))"
    )
}

/// Renames the active bound Database only while its stored name matches.
pub(crate) fn rename_bound_primary_database_if_named(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    current_name: &str,
    next_name: &str,
    now: &str,
) -> Result<Option<String>, StoreError> {
    if current_name == next_name {
        return Ok(None);
    }
    let database_id: Option<String> = connection
        .query_row(
            "UPDATE database_containers
             SET name = ?1, metadata_revision = metadata_revision + 1, updated_at = ?2
             WHERE library_id = ?3 AND lifecycle = 'active' AND name = ?4
               AND block_id = (
                 SELECT binding.database_block_id FROM project_database_bindings binding
                 JOIN blocks block ON block.id = binding.database_block_id
                   AND block.library_id = binding.library_id
                 WHERE binding.project_id = ?5 AND binding.library_id = ?3
                   AND binding.lifecycle = 'active' AND block.type = 'database'
                   AND block.lifecycle = 'active'
               )
             RETURNING block_id",
            params![next_name, now, library_id, current_name, project_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(database_id) = &database_id {
        connection.execute(
            "UPDATE blocks SET metadata_revision = metadata_revision + 1, updated_at = ?1
             WHERE id = ?2",
            params![now, database_id],
        )?;
    }
    Ok(database_id)
}
