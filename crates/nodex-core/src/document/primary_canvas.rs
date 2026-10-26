use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::canvas::ensure_canvas_scene;
use super::canvas_scene::{CANVAS_OWNER_TYPE, CANVAS_SCHEMA_KEY, CANVAS_SCHEMA_VERSION};
use super::persistence::read_document_authority;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PrimaryCanvasIdentity {
    pub(crate) block_id: String,
    pub(crate) document_id: String,
}

pub(crate) fn primary_canvas_block_id(project_id: &str) -> String {
    format!("canvas:primary:{project_id}")
}

pub(crate) fn primary_canvas_document_id(project_id: &str) -> String {
    format!("document:canvas:primary:{project_id}")
}

pub(crate) fn is_primary_canvas_block_id(canvas_id: &str, project_id: &str) -> bool {
    canvas_id == primary_canvas_block_id(project_id)
}

pub(crate) fn create_primary_canvas(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    display_name: &str,
    now: &str,
    assets_root: &Path,
) -> Result<PrimaryCanvasIdentity, StoreError> {
    let identity = PrimaryCanvasIdentity {
        block_id: primary_canvas_block_id(project_id),
        document_id: primary_canvas_document_id(project_id),
    };
    let collision = connection
        .query_row(
            "SELECT 1 WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?1) \
             OR EXISTS (SELECT 1 FROM documents WHERE id = ?2)",
            params![identity.block_id, identity.document_id],
            |_| Ok(()),
        )
        .optional()?;
    if collision.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::AlreadyOwned,
            "The deterministic primary Canvas identity already exists",
            false,
        ));
    }
    connection.execute(
        "INSERT INTO blocks(\
           id, library_id, type, lifecycle, placement_revision, metadata_revision, \
           created_at, updated_at\
         ) VALUES (?1, ?2, ?3, 'active', 1, 1, ?4, ?4)",
        params![identity.block_id, library_id, CANVAS_OWNER_TYPE, now],
    )?;
    connection.execute(
        "INSERT INTO block_properties(\
           block_id, library_id, property_key, value_type, value_json, revision, updated_at\
         ) VALUES (?1, ?2, 'document.display_name', 'string', ?3, 1, ?4)",
        params![
            identity.block_id,
            library_id,
            serde_json::to_string(display_name)
                .map_err(|_| internal("Primary Canvas display name"))?,
            now
        ],
    )?;
    crate::library::insert_library_placement(
        connection,
        library_id,
        &identity.block_id,
        crate::library::LibraryRootPosition::First,
        now,
    )?;
    connection.execute(
        "INSERT INTO documents(\
           id, library_id, generation, head_seq, schema_key, schema_version, state_vector, \
           state_hash, sync_engine, readiness, authority, genesis_source_revision, \
           created_at, updated_at\
         ) VALUES (?1, ?2, 1, 0, ?3, ?4, X'', ?5, 'canvas_scene', 'ready', \
           'ydoc_primary', NULL, ?6, ?6)",
        params![
            identity.document_id,
            library_id,
            CANVAS_SCHEMA_KEY,
            CANVAS_SCHEMA_VERSION,
            "0".repeat(64),
            now
        ],
    )?;
    connection.execute(
        "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![identity.block_id, identity.document_id, library_id, now],
    )?;
    connection.execute(
        "INSERT INTO canvas_owners(block_id, library_id, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?3)",
        params![identity.block_id, library_id, now],
    )?;
    let authority = read_document_authority(connection, &identity.document_id)?
        .ok_or_else(|| corrupt("Primary Canvas has no Document authority"))?;
    let (_, created) = ensure_canvas_scene(connection, &authority, assets_root)?;
    if !created {
        return Err(corrupt("Primary Canvas reused existing scene authority"));
    }
    Ok(identity)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

#[cfg(test)]
mod tests {
    use super::{is_primary_canvas_block_id, primary_canvas_block_id, primary_canvas_document_id};

    #[test]
    fn derives_and_recognizes_primary_canvas_identities() {
        assert_eq!(
            primary_canvas_block_id("project:default"),
            "canvas:primary:project:default"
        );
        assert_eq!(
            primary_canvas_document_id("project:default"),
            "document:canvas:primary:project:default"
        );
        assert!(is_primary_canvas_block_id(
            "canvas:primary:project:default",
            "project:default"
        ));
        assert!(!is_primary_canvas_block_id(
            "canvas:primary:project:other",
            "project:default"
        ));
    }
}
