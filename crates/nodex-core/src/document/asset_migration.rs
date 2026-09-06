//! One-way import of filename-addressed Document media into Library Files.
//! The migration reads only canonical source fields, publishes immutable bytes,
//! and rebuilds Yrs state and its projections together. Missing source bytes are
//! preserved as unresolved references; cache paths never substitute for them.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use serde::Serialize;
use yrs::updates::encoder::Encode;
use yrs::{ReadTxn, StateVector, Transact};

use crate::domain::block_materialization::dematerialize_block_tree;
use crate::domain::files::{FileSnapshotTarget, remap_block_asset_sources};
use crate::infrastructure::document_repository::{DocumentHeadRow, DocumentReadRepository};
use crate::infrastructure::managed_blobs::BlobWriter;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::persistence::{
    persist_materialization_for_schema_migration,
    replace_document_block_index_for_schema_migration,
    replace_secondary_projections_for_schema_migration,
};
use super::{
    BlockDocumentSchema, DocumentMaterialization, decode_block_document, encode_block_document,
    materialize_decoded_document, reconstruct_yjs_engine, sha256,
};

const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetMigrationEvidence {
    imported_files: usize,
    changed_documents: usize,
    changed_versions: usize,
    missing_sources: usize,
}

#[derive(Clone)]
struct ImportedFile {
    id: String,
    target: FileSnapshotTarget,
}

pub(super) struct AssetImports<'a> {
    connection: &'a Connection,
    root: PathBuf,
    now: &'a str,
    files: BTreeMap<(String, String), Option<ImportedFile>>,
    missing: BTreeSet<String>,
}

impl<'a> AssetImports<'a> {
    fn new(connection: &'a Connection, now: &'a str) -> Result<Self, StoreError> {
        let database_path: String = connection.query_row(
            "SELECT file FROM pragma_database_list WHERE name = 'main'",
            [],
            |row| row.get(0),
        )?;
        let home = Path::new(&database_path)
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or_else(|| corrupt("Asset migration requires a Profile directory"))?;
        Ok(Self {
            connection,
            root: home.join("assets"),
            now,
            files: BTreeMap::new(),
            missing: BTreeSet::new(),
        })
    }

    /// Returns exact bindings for sources actually rewritten in this materialization.
    pub(super) fn rewrite(
        &mut self,
        library_id: &str,
        materialization: &mut DocumentMaterialization,
    ) -> Result<BTreeMap<String, FileSnapshotTarget>, StoreError> {
        let mut sources = BTreeMap::new();
        let mut targets = BTreeMap::new();
        for reference in &materialization.asset_refs {
            let Some(name) = reference.managed_file_name.as_deref() else {
                continue;
            };
            let Some(file) = self.import(library_id, name)? else {
                continue;
            };
            sources.insert(
                reference.source.clone(),
                format!("nodex://files/{}", file.id),
            );
            targets.insert(file.id, file.target);
        }
        remap_block_asset_sources(&mut materialization.block_tree, &sources);
        Ok(targets)
    }

    fn import(&mut self, library_id: &str, name: &str) -> Result<Option<ImportedFile>, StoreError> {
        let key = (library_id.to_owned(), name.to_owned());
        if let Some(file) = self.files.get(&key) {
            return Ok(file.clone());
        }
        let file = self.publish(library_id, name)?;
        self.files.insert(key, file.clone());
        Ok(file)
    }

    fn publish(
        &mut self,
        library_id: &str,
        name: &str,
    ) -> Result<Option<ImportedFile>, StoreError> {
        // The canonical parser already validates safe single-component names.
        // Reject links and special files before opening the Profile-owned source.
        let source = self.root.join(name);
        let metadata = match std::fs::symlink_metadata(&source) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.missing.insert(name.to_owned());
                return Ok(None);
            }
            Err(error) => return Err(io_error(error)),
        };
        if !metadata.is_file() || metadata.len() > MAX_ASSET_BYTES {
            return Err(corrupt("Document asset must be a bounded regular file"));
        }
        let mut input = File::open(&source).map_err(io_error)?;
        let mut writer = BlobWriter::new(&self.root, MAX_ASSET_BYTES)?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let length = input.read(&mut buffer).map_err(io_error)?;
            if length == 0 {
                break;
            }
            writer.write_chunk(&buffer[..length])?;
        }
        let blob = writer.finish()?;
        let id = format!(
            "file:imported-asset:{}",
            sha256(format!("{library_id}\0{name}").as_bytes())
        );
        let default_name = crate::domain::file_path::normalize_file_name(name)?;
        self.connection.execute(
            "INSERT OR IGNORE INTO managed_blobs(content_hash, physical_asset_name, byte_length, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![blob.content_hash, blob.physical_asset_name, blob.byte_length as i64, self.now],
        )?;
        self.connection.execute(
            "INSERT INTO library_files(file_id, library_id, default_name, head_version, revision,
               lifecycle, created_by_actor_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, 1, 'live', 'store-migration:v160', ?4, ?4)",
            params![id, library_id, default_name, self.now],
        )?;
        self.connection.execute(
            "INSERT INTO file_versions(file_id, version, library_id, blob_hash, mime_type,
               byte_length, actor_id, operation_id, occurred_at)
             VALUES (?1, 1, ?2, ?3, ?4, ?5, 'store-migration:v160', ?6, ?7)",
            params![
                id,
                library_id,
                blob.content_hash,
                crate::infrastructure::library_files_migration::infer_mime_type(name),
                blob.byte_length as i64,
                format!("import-document-asset:{id}"),
                self.now
            ],
        )?;
        Ok(Some(ImportedFile {
            id,
            target: FileSnapshotTarget {
                version: 1,
                default_name,
            },
        }))
    }
}

pub(crate) fn migrate_document_assets(
    connection: &Connection,
    now: &str,
) -> Result<AssetMigrationEvidence, StoreError> {
    if connection.is_autocommit() {
        return Err(corrupt(
            "Document asset migration requires an outer transaction",
        ));
    }
    let mut imports = AssetImports::new(connection, now)?;
    let mut evidence = AssetMigrationEvidence::default();
    for head in DocumentReadRepository::new(connection).live_yjs_heads()? {
        if migrate_current_document(connection, &head, &mut imports, now)? {
            evidence.changed_documents += 1;
        }
    }
    evidence.changed_versions =
        super::history::migrate_managed_asset_versions(connection, &mut imports)?;
    evidence.imported_files = imports.files.values().filter(|file| file.is_some()).count();
    evidence.missing_sources = imports.missing.len();
    if evidence.changed_documents > 0 || evidence.changed_versions > 0 {
        // Old renderer Yrs caches and structural Undo tokens cannot replay their
        // pre-import source identities into the normalized Document generation.
        let epoch = crate::domain::identity::random_uuid_v7()
            .map_err(|_| corrupt("Asset migration epoch entropy failed"))?;
        connection.execute(
            "UPDATE block_store_metadata SET store_epoch = ?1, updated_at = ?2 WHERE id = 1",
            params![format!("epoch:{epoch}"), now],
        )?;
    }
    Ok(evidence)
}

fn migrate_current_document(
    connection: &Connection,
    head: &DocumentHeadRow,
    imports: &mut AssetImports<'_>,
    now: &str,
) -> Result<bool, StoreError> {
    let schema = BlockDocumentSchema::from_identity(&head.schema_key, head.schema_version)
        .ok_or_else(|| corrupt("Document asset migration encountered an unsupported schema"))?;
    let engine = reconstruct_yjs_engine(connection, head)?;
    let mut decoded = decode_block_document(engine.document(), schema).map_err(document_error)?;
    let mut materialization = materialize_decoded_document(&decoded).map_err(document_error)?;
    if imports
        .rewrite(&head.library_id, &mut materialization)?
        .is_empty()
    {
        return Ok(false);
    }

    decoded.block_tree.blocks = dematerialize_block_tree(&materialization.block_tree)
        .map_err(document_error)?
        .blocks;
    let document = encode_block_document(
        &head.id,
        schema,
        decoded.title.as_deref(),
        &decoded.block_tree,
    )
    .map_err(document_error)?;
    let decoded = decode_block_document(&document, schema).map_err(document_error)?;
    let materialization = materialize_decoded_document(&decoded).map_err(document_error)?;
    let transaction = document.transact();
    let state = transaction.encode_state_as_update_v1(&StateVector::default());
    let vector = transaction.state_vector().encode_v1();
    connection.execute(
        "UPDATE documents SET state_vector = ?1, state_hash = '' WHERE id = ?2",
        params![vector, head.id],
    )?;
    connection.execute(
        "DELETE FROM document_snapshots WHERE document_id = ?1 AND generation = ?2",
        params![head.id, head.generation],
    )?;
    connection.execute(
        "INSERT INTO document_snapshots(document_id, generation, snapshot_seq, state_vector,
           snapshot_update, snapshot_hash, schema_version, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            head.id,
            head.generation,
            head.head_seq,
            vector,
            state,
            sha256(&state),
            head.schema_version,
            now
        ],
    )?;
    persist_materialization_for_schema_migration(
        connection,
        &head.id,
        head.generation,
        head.head_seq,
        &materialization,
        now,
    )?;
    replace_document_block_index_for_schema_migration(
        connection,
        &head.id,
        head.head_seq,
        &materialization,
    )?;
    replace_secondary_projections_for_schema_migration(
        connection,
        &head.id,
        &materialization,
        head.head_seq,
        now,
    )?;
    connection.execute(
        "UPDATE page_file_manifests SET body_usage_revision = body_usage_revision + 1, updated_at = ?1
         WHERE page_id IN (SELECT block_id FROM block_documents WHERE document_id = ?2)",
        params![now, head.id],
    )?;
    Ok(true)
}

fn document_error(error: impl std::fmt::Display) -> StoreError {
    corrupt(format!("Document asset migration: {error}"))
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::Internal,
        format!("Document asset import failed: {error}"),
        true,
    )
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message.into(), false)
}
