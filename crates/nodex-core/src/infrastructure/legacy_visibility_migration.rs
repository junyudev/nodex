//! Historical schema upgrades temporarily satisfy the retired visibility triggers.
//! Current Stores have no content authorization graph or maintenance context.
use super::sqlite::{StoreError, StoreErrorCode};
use rusqlite::{Connection, OptionalExtension};
fn has_legacy_context(connection: &Connection) -> Result<bool, StoreError> {
    Ok(connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='local_commit_visibility_context')",[],|row|row.get(0))?)
}
pub(crate) fn enter_migration_maintenance_context(
    connection: &Connection,
) -> Result<bool, StoreError> {
    if !has_legacy_context(connection)? {
        return Ok(false);
    }
    let existing = connection
        .query_row(
            "SELECT mode, store_epoch, commit_seq FROM local_commit_visibility_context WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()?;
    match existing {
        None => {
            connection.execute(
                "INSERT INTO local_commit_visibility_context(id, mode, store_epoch, commit_seq) \
                 VALUES (1, 'maintenance', NULL, NULL)",
                [],
            )?;
            Ok(true)
        }
        Some((mode, None, None)) if mode == "maintenance" => Ok(false),
        Some(_) => Err(corrupt(
            "Store migration cannot borrow an active legacy visibility migration context",
        )),
    }
}

pub(crate) fn leave_migration_maintenance_context(
    connection: &Connection,
    owned: bool,
) -> Result<(), StoreError> {
    if !owned || !has_legacy_context(connection)? {
        return Ok(());
    }
    let changed = connection.execute(
        "DELETE FROM local_commit_visibility_context \
         WHERE id = 1 AND mode = 'maintenance' AND store_epoch IS NULL AND commit_seq IS NULL",
        [],
    )?;
    if changed == 1 {
        return Ok(());
    }
    Err(corrupt(
        "Store migration legacy visibility migration context diverged",
    ))
}

#[cfg(test)]
pub(crate) fn install_test_maintenance_context(connection: &Connection) -> Result<(), StoreError> {
    if !has_legacy_context(connection)? {
        return Ok(());
    }
    connection.execute("INSERT INTO local_commit_visibility_context(id,mode,store_epoch,commit_seq) VALUES(1,'maintenance',NULL,NULL) ON CONFLICT(id) DO UPDATE SET mode='maintenance',store_epoch=NULL,commit_seq=NULL",[])?;
    Ok(())
}
fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
