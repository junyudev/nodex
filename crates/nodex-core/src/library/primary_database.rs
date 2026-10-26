//! A primary Database is the home its owner depends on: a Project's, or the Library Inbox's.

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
