use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

pub(crate) fn project_primary_database(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<Option<String>, StoreError> {
    let project = connection
        .query_row(
            "SELECT database_block_id, lifecycle FROM projects \
             WHERE id = ?1 AND library_id = ?2",
            params![project_id, library_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((database_id, lifecycle)) = project else {
        return Err(not_found("Bound Project is unavailable in this Library"));
    };
    if lifecycle != "active" {
        return Err(not_found("Bound Project is not active"));
    }
    if database_id.is_some() {
        return Ok(database_id);
    }
    connection
        .query_row(
            "SELECT database_block_id FROM project_database_bindings \
             WHERE project_id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
            params![project_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StoreError::from)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}
