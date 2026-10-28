use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::document::{MAX_DOCUMENT_UPDATE_BYTES, MAX_STATE_VECTOR_BYTES};
use crate::domain::rich_text::{MAX_RICH_TEXT_BYTES, MAX_TITLE_UTF16_LENGTH};

use super::sqlite::{StoreError, StoreErrorCode};

const MAX_IDENTIFIER_BYTES: usize = 512;
const MAX_SCHEMA_KEY_BYTES: usize = 128;
const MAX_JSON_BYTES: usize = MAX_DOCUMENT_UPDATE_BYTES;
const MAX_TEXT_BYTES: usize = MAX_DOCUMENT_UPDATE_BYTES;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_TOUCHED_BLOCK_IDS: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentReadiness {
    PendingGenesis,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentAuthority {
    LegacyShadow,
    YdocPrimary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentSyncEngine {
    Yjs,
    CanvasScene,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentHeadRow {
    pub id: String,
    pub library_id: String,
    pub generation: i64,
    pub head_seq: i64,
    pub schema_key: String,
    pub schema_version: i64,
    pub state_vector: Vec<u8>,
    pub state_hash: String,
    pub readiness: DocumentReadiness,
    pub authority: DocumentAuthority,
    pub genesis_source_revision: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub sync_engine: DocumentSyncEngine,
}

impl DocumentHeadRow {
    pub fn is_live_yjs_authority(&self) -> bool {
        self.readiness == DocumentReadiness::Ready
            && self.authority == DocumentAuthority::YdocPrimary
            && self.sync_engine == DocumentSyncEngine::Yjs
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentUpdateRow {
    pub document_id: String,
    pub generation: i64,
    pub seq: i64,
    pub update_id: String,
    pub client_session_id: String,
    pub base_head_seq: i64,
    pub touched_block_ids: Vec<String>,
    pub update_blob: Vec<u8>,
    pub update_hash: String,
    pub committed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentSnapshotRow {
    pub document_id: String,
    pub generation: i64,
    pub snapshot_seq: i64,
    pub state_vector: Vec<u8>,
    pub snapshot_update: Vec<u8>,
    pub snapshot_hash: String,
    pub schema_version: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocumentMaterializationRow {
    pub document_id: String,
    pub generation: i64,
    pub projected_seq: i64,
    pub schema_version: i64,
    pub title: String,
    pub rich_title: Value,
    pub rich_title_hash: String,
    pub markdown: String,
    pub plain_text: String,
    pub preview: String,
    pub block_tree: Value,
    pub references: Value,
    pub asset_refs: Value,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentUpdateReceiptRow {
    pub document_id: String,
    pub generation: i64,
    pub seq: i64,
    pub update_id: String,
    pub client_session_id: String,
    pub base_head_seq: i64,
    pub client_touched_block_ids: Vec<String>,
    pub derived_touched_block_ids: Vec<String>,
    pub derivation_version: i64,
    pub update_hash: String,
    pub update_byte_length: i64,
    pub committed_at: String,
}

pub struct DocumentReadRepository<'connection> {
    connection: &'connection Connection,
}

impl<'connection> DocumentReadRepository<'connection> {
    pub fn new(connection: &'connection Connection) -> Self {
        Self { connection }
    }

    pub(crate) fn connection(&self) -> &'connection Connection {
        self.connection
    }

    pub fn document_heads(&self) -> Result<Vec<DocumentHeadRow>, StoreError> {
        let rows = self
            .connection
            .prepare(
                "SELECT id, library_id, generation, head_seq, schema_key, schema_version, \
                        state_vector, state_hash, readiness, authority, genesis_source_revision, \
                        created_at, updated_at, sync_engine \
                 FROM documents ORDER BY id",
            )?
            .query_map([], |row| {
                Ok(RawDocumentHead {
                    id: row.get(0)?,
                    library_id: row.get(1)?,
                    generation: row.get(2)?,
                    head_seq: row.get(3)?,
                    schema_key: row.get(4)?,
                    schema_version: row.get(5)?,
                    state_vector: row.get(6)?,
                    state_hash: row.get(7)?,
                    readiness: row.get(8)?,
                    authority: row.get(9)?,
                    genesis_source_revision: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                    sync_engine: row.get(13)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| corrupt_row("documents", "column types do not match the schema"))?;
        rows.into_iter().map(DocumentHeadRow::try_from).collect()
    }

    pub fn document_head(&self, document_id: &str) -> Result<Option<DocumentHeadRow>, StoreError> {
        validate_identifier(document_id, "documents.id")?;
        let raw = self
            .connection
            .query_row(
                "SELECT id, library_id, generation, head_seq, schema_key, schema_version, \
                        state_vector, state_hash, readiness, authority, genesis_source_revision, \
                        created_at, updated_at, sync_engine \
                 FROM documents WHERE id = ?1",
                [document_id],
                |row| {
                    Ok(RawDocumentHead {
                        id: row.get(0)?,
                        library_id: row.get(1)?,
                        generation: row.get(2)?,
                        head_seq: row.get(3)?,
                        schema_key: row.get(4)?,
                        schema_version: row.get(5)?,
                        state_vector: row.get(6)?,
                        state_hash: row.get(7)?,
                        readiness: row.get(8)?,
                        authority: row.get(9)?,
                        genesis_source_revision: row.get(10)?,
                        created_at: row.get(11)?,
                        updated_at: row.get(12)?,
                        sync_engine: row.get(13)?,
                    })
                },
            )
            .optional()
            .map_err(|_| corrupt_row("documents", "column types do not match the schema"))?;
        raw.map(DocumentHeadRow::try_from).transpose()
    }

    pub fn live_yjs_heads(&self) -> Result<Vec<DocumentHeadRow>, StoreError> {
        Ok(self
            .document_heads()?
            .into_iter()
            .filter(DocumentHeadRow::is_live_yjs_authority)
            .collect())
    }

    pub fn latest_snapshot(
        &self,
        document_id: &str,
        generation: i64,
        through_seq: i64,
    ) -> Result<Option<DocumentSnapshotRow>, StoreError> {
        validate_identifier(document_id, "document_snapshots.document_id")?;
        validate_positive(generation, "document_snapshots.generation")?;
        validate_non_negative(through_seq, "document_snapshots.snapshot_seq")?;
        let raw = self
            .connection
            .query_row(
                "SELECT document_id, generation, snapshot_seq, state_vector, snapshot_update, \
                        snapshot_hash, schema_version, created_at \
                 FROM document_snapshots WHERE document_id = ?1 AND generation = ?2 \
                   AND snapshot_seq <= ?3 ORDER BY snapshot_seq DESC LIMIT 1",
                params![document_id, generation, through_seq],
                |row| {
                    Ok(RawDocumentSnapshot {
                        document_id: row.get(0)?,
                        generation: row.get(1)?,
                        snapshot_seq: row.get(2)?,
                        state_vector: row.get(3)?,
                        snapshot_update: row.get(4)?,
                        snapshot_hash: row.get(5)?,
                        schema_version: row.get(6)?,
                        created_at: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(|_| {
                corrupt_row("document_snapshots", "column types do not match the schema")
            })?;
        raw.map(DocumentSnapshotRow::try_from).transpose()
    }

    pub fn updates_between(
        &self,
        document_id: &str,
        generation: i64,
        after_seq: i64,
        through_seq: i64,
    ) -> Result<Vec<DocumentUpdateRow>, StoreError> {
        validate_identifier(document_id, "document_updates.document_id")?;
        validate_positive(generation, "document_updates.generation")?;
        validate_non_negative(after_seq, "document_updates.seq")?;
        validate_non_negative(through_seq, "document_updates.seq")?;
        if after_seq > through_seq {
            return Err(corrupt_row(
                "document_updates",
                "requested sequence range is inverted",
            ));
        }
        let rows = self
            .connection
            .prepare(
                "SELECT document_id, generation, seq, update_id, client_session_id, \
                        base_head_seq, touched_block_ids_json, update_blob, update_hash, committed_at \
                 FROM document_updates WHERE document_id = ?1 AND generation = ?2 \
                   AND seq > ?3 AND seq <= ?4 ORDER BY seq",
            )?
            .query_map(
                params![document_id, generation, after_seq, through_seq],
                |row| {
                    Ok(RawDocumentUpdate {
                        document_id: row.get(0)?,
                        generation: row.get(1)?,
                        seq: row.get(2)?,
                        update_id: row.get(3)?,
                        client_session_id: row.get(4)?,
                        base_head_seq: row.get(5)?,
                        touched_block_ids_json: row.get(6)?,
                        update_blob: row.get(7)?,
                        update_hash: row.get(8)?,
                        committed_at: row.get(9)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| {
                corrupt_row("document_updates", "column types do not match the schema")
            })?;
        rows.into_iter().map(DocumentUpdateRow::try_from).collect()
    }

    pub fn update_by_identity(
        &self,
        document_id: &str,
        generation: i64,
        update_id: &str,
    ) -> Result<Option<DocumentUpdateRow>, StoreError> {
        validate_identifier(document_id, "document_updates.document_id")?;
        validate_positive(generation, "document_updates.generation")?;
        validate_identifier(update_id, "document_updates.update_id")?;
        let raw = self
            .connection
            .query_row(
                "SELECT document_id, generation, seq, update_id, client_session_id, \
                        base_head_seq, touched_block_ids_json, update_blob, update_hash, committed_at \
                 FROM document_updates WHERE document_id = ?1 AND generation = ?2 \
                   AND update_id = ?3",
                params![document_id, generation, update_id],
                |row| {
                    Ok(RawDocumentUpdate {
                        document_id: row.get(0)?,
                        generation: row.get(1)?,
                        seq: row.get(2)?,
                        update_id: row.get(3)?,
                        client_session_id: row.get(4)?,
                        base_head_seq: row.get(5)?,
                        touched_block_ids_json: row.get(6)?,
                        update_blob: row.get(7)?,
                        update_hash: row.get(8)?,
                        committed_at: row.get(9)?,
                    })
                },
            )
            .optional()
            .map_err(|_| {
                corrupt_row("document_updates", "column types do not match the schema")
            })?;
        raw.map(DocumentUpdateRow::try_from).transpose()
    }

    pub fn materialization(
        &self,
        document_id: &str,
    ) -> Result<Option<DocumentMaterializationRow>, StoreError> {
        validate_identifier(document_id, "document_materializations.document_id")?;
        let markdown_column =
            super::super::document::schema_migration::stored_markdown_column(self.connection)?;
        let raw = self
            .connection
            .query_row(
                &format!(
                    "SELECT document_id, generation, projected_seq, schema_version, title, \
                        title_rich_json, title_rich_hash, {markdown_column}, plain_text, preview, \
                        block_tree_json, references_json, asset_refs_json, updated_at \
                 FROM document_materializations WHERE document_id = ?1"
                ),
                [document_id],
                |row| {
                    Ok(RawDocumentMaterialization {
                        document_id: row.get(0)?,
                        generation: row.get(1)?,
                        projected_seq: row.get(2)?,
                        schema_version: row.get(3)?,
                        title: row.get(4)?,
                        rich_title_json: row.get(5)?,
                        rich_title_hash: row.get(6)?,
                        markdown: row.get(7)?,
                        plain_text: row.get(8)?,
                        preview: row.get(9)?,
                        block_tree_json: row.get(10)?,
                        references_json: row.get(11)?,
                        asset_refs_json: row.get(12)?,
                        updated_at: row.get(13)?,
                    })
                },
            )
            .optional()
            .map_err(|_| {
                corrupt_row(
                    "document_materializations",
                    "column types do not match the schema",
                )
            })?;
        raw.map(DocumentMaterializationRow::try_from).transpose()
    }

    pub fn update_receipt(
        &self,
        document_id: &str,
        update_id: &str,
    ) -> Result<Option<DocumentUpdateReceiptRow>, StoreError> {
        validate_identifier(document_id, "document_update_receipts.document_id")?;
        validate_identifier(update_id, "document_update_receipts.update_id")?;
        let raw = self
            .connection
            .query_row(
                "SELECT document_id, generation, seq, update_id, client_session_id, \
                        base_head_seq, client_touched_block_ids_json, \
                        derived_touched_block_ids_json, derivation_version, update_hash, \
                        update_byte_length, committed_at \
                 FROM document_update_receipts WHERE document_id = ?1 AND update_id = ?2",
                params![document_id, update_id],
                |row| {
                    Ok(RawDocumentUpdateReceipt {
                        document_id: row.get(0)?,
                        generation: row.get(1)?,
                        seq: row.get(2)?,
                        update_id: row.get(3)?,
                        client_session_id: row.get(4)?,
                        base_head_seq: row.get(5)?,
                        client_touched_block_ids_json: row.get(6)?,
                        derived_touched_block_ids_json: row.get(7)?,
                        derivation_version: row.get(8)?,
                        update_hash: row.get(9)?,
                        update_byte_length: row.get(10)?,
                        committed_at: row.get(11)?,
                    })
                },
            )
            .optional()
            .map_err(|_| {
                corrupt_row(
                    "document_update_receipts",
                    "column types do not match the schema",
                )
            })?;
        raw.map(DocumentUpdateReceiptRow::try_from).transpose()
    }
}

struct RawDocumentHead {
    id: String,
    library_id: String,
    generation: i64,
    head_seq: i64,
    schema_key: String,
    schema_version: i64,
    state_vector: Vec<u8>,
    state_hash: String,
    readiness: String,
    authority: String,
    genesis_source_revision: Option<i64>,
    created_at: String,
    updated_at: String,
    sync_engine: String,
}

impl TryFrom<RawDocumentHead> for DocumentHeadRow {
    type Error = StoreError;

    fn try_from(raw: RawDocumentHead) -> Result<Self, Self::Error> {
        validate_identifier(&raw.id, "documents.id")?;
        validate_identifier(&raw.library_id, "documents.library_id")?;
        validate_positive(raw.generation, "documents.generation")?;
        validate_non_negative(raw.head_seq, "documents.head_seq")?;
        validate_bounded_text(
            &raw.schema_key,
            1,
            MAX_SCHEMA_KEY_BYTES,
            "documents.schema_key",
        )?;
        validate_positive(raw.schema_version, "documents.schema_version")?;
        validate_blob_bound(
            &raw.state_vector,
            MAX_STATE_VECTOR_BYTES,
            "documents.state_vector",
            true,
        )?;
        if !raw.state_hash.is_empty() {
            validate_sha256(&raw.state_hash, "documents.state_hash")?;
        }
        let readiness = parse_readiness(&raw.readiness)?;
        let authority = parse_authority(&raw.authority)?;
        let sync_engine = parse_sync_engine(&raw.sync_engine)?;
        if authority == DocumentAuthority::YdocPrimary && readiness != DocumentReadiness::Ready {
            return Err(corrupt_row(
                "documents",
                "ydoc_primary authority requires ready state",
            ));
        }
        if let Some(revision) = raw.genesis_source_revision {
            validate_non_negative(revision, "documents.genesis_source_revision")?;
        }
        validate_timestamp(&raw.created_at, "documents.created_at")?;
        validate_timestamp(&raw.updated_at, "documents.updated_at")?;
        Ok(Self {
            id: raw.id,
            library_id: raw.library_id,
            generation: raw.generation,
            head_seq: raw.head_seq,
            schema_key: raw.schema_key,
            schema_version: raw.schema_version,
            state_vector: raw.state_vector,
            state_hash: raw.state_hash,
            readiness,
            authority,
            genesis_source_revision: raw.genesis_source_revision,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
            sync_engine,
        })
    }
}

struct RawDocumentUpdate {
    document_id: String,
    generation: i64,
    seq: i64,
    update_id: String,
    client_session_id: String,
    base_head_seq: i64,
    touched_block_ids_json: String,
    update_blob: Vec<u8>,
    update_hash: String,
    committed_at: String,
}

impl TryFrom<RawDocumentUpdate> for DocumentUpdateRow {
    type Error = StoreError;

    fn try_from(raw: RawDocumentUpdate) -> Result<Self, Self::Error> {
        validate_identifier(&raw.document_id, "document_updates.document_id")?;
        validate_positive(raw.generation, "document_updates.generation")?;
        validate_positive(raw.seq, "document_updates.seq")?;
        validate_identifier(&raw.update_id, "document_updates.update_id")?;
        validate_identifier(&raw.client_session_id, "document_updates.client_session_id")?;
        validate_non_negative(raw.base_head_seq, "document_updates.base_head_seq")?;
        let touched_block_ids = parse_identifier_array(
            &raw.touched_block_ids_json,
            "document_updates.touched_block_ids_json",
        )?;
        validate_blob_bound(
            &raw.update_blob,
            MAX_DOCUMENT_UPDATE_BYTES,
            "document_updates.update_blob",
            false,
        )?;
        validate_sha256(&raw.update_hash, "document_updates.update_hash")?;
        validate_timestamp(&raw.committed_at, "document_updates.committed_at")?;
        Ok(Self {
            document_id: raw.document_id,
            generation: raw.generation,
            seq: raw.seq,
            update_id: raw.update_id,
            client_session_id: raw.client_session_id,
            base_head_seq: raw.base_head_seq,
            touched_block_ids,
            update_blob: raw.update_blob,
            update_hash: raw.update_hash,
            committed_at: raw.committed_at,
        })
    }
}

struct RawDocumentSnapshot {
    document_id: String,
    generation: i64,
    snapshot_seq: i64,
    state_vector: Vec<u8>,
    snapshot_update: Vec<u8>,
    snapshot_hash: String,
    schema_version: i64,
    created_at: String,
}

impl TryFrom<RawDocumentSnapshot> for DocumentSnapshotRow {
    type Error = StoreError;

    fn try_from(raw: RawDocumentSnapshot) -> Result<Self, Self::Error> {
        validate_identifier(&raw.document_id, "document_snapshots.document_id")?;
        validate_positive(raw.generation, "document_snapshots.generation")?;
        validate_non_negative(raw.snapshot_seq, "document_snapshots.snapshot_seq")?;
        validate_blob_bound(
            &raw.state_vector,
            MAX_STATE_VECTOR_BYTES,
            "document_snapshots.state_vector",
            true,
        )?;
        validate_blob_bound(
            &raw.snapshot_update,
            MAX_DOCUMENT_UPDATE_BYTES,
            "document_snapshots.snapshot_update",
            false,
        )?;
        validate_sha256(&raw.snapshot_hash, "document_snapshots.snapshot_hash")?;
        validate_positive(raw.schema_version, "document_snapshots.schema_version")?;
        validate_timestamp(&raw.created_at, "document_snapshots.created_at")?;
        Ok(Self {
            document_id: raw.document_id,
            generation: raw.generation,
            snapshot_seq: raw.snapshot_seq,
            state_vector: raw.state_vector,
            snapshot_update: raw.snapshot_update,
            snapshot_hash: raw.snapshot_hash,
            schema_version: raw.schema_version,
            created_at: raw.created_at,
        })
    }
}

struct RawDocumentMaterialization {
    document_id: String,
    generation: i64,
    projected_seq: i64,
    schema_version: i64,
    title: String,
    rich_title_json: String,
    rich_title_hash: String,
    markdown: String,
    plain_text: String,
    preview: String,
    block_tree_json: String,
    references_json: String,
    asset_refs_json: String,
    updated_at: String,
}

impl TryFrom<RawDocumentMaterialization> for DocumentMaterializationRow {
    type Error = StoreError;

    fn try_from(raw: RawDocumentMaterialization) -> Result<Self, Self::Error> {
        validate_identifier(&raw.document_id, "document_materializations.document_id")?;
        validate_positive(raw.generation, "document_materializations.generation")?;
        validate_non_negative(raw.projected_seq, "document_materializations.projected_seq")?;
        validate_positive(
            raw.schema_version,
            "document_materializations.schema_version",
        )?;
        if raw.title.encode_utf16().count() > MAX_TITLE_UTF16_LENGTH {
            return Err(corrupt_row(
                "document_materializations",
                "title exceeds the canonical UTF-16 bound",
            ));
        }
        validate_bounded_text(
            &raw.rich_title_json,
            2,
            MAX_RICH_TEXT_BYTES,
            "document_materializations.title_rich_json",
        )?;
        validate_sha256(
            &raw.rich_title_hash,
            "document_materializations.title_rich_hash",
        )?;
        validate_bounded_text(
            &raw.markdown,
            0,
            MAX_TEXT_BYTES,
            "document_materializations.markdown",
        )?;
        validate_bounded_text(
            &raw.plain_text,
            0,
            MAX_TEXT_BYTES,
            "document_materializations.plain_text",
        )?;
        validate_bounded_text(
            &raw.preview,
            0,
            MAX_TEXT_BYTES,
            "document_materializations.preview",
        )?;
        let rich_title = parse_json_array(
            &raw.rich_title_json,
            "document_materializations.title_rich_json",
        )?;
        let block_tree = parse_json_array(
            &raw.block_tree_json,
            "document_materializations.block_tree_json",
        )?;
        let references = parse_json_array(
            &raw.references_json,
            "document_materializations.references_json",
        )?;
        let asset_refs = parse_json_array(
            &raw.asset_refs_json,
            "document_materializations.asset_refs_json",
        )?;
        validate_timestamp(&raw.updated_at, "document_materializations.updated_at")?;
        Ok(Self {
            document_id: raw.document_id,
            generation: raw.generation,
            projected_seq: raw.projected_seq,
            schema_version: raw.schema_version,
            title: raw.title,
            rich_title,
            rich_title_hash: raw.rich_title_hash,
            markdown: raw.markdown,
            plain_text: raw.plain_text,
            preview: raw.preview,
            block_tree,
            references,
            asset_refs,
            updated_at: raw.updated_at,
        })
    }
}

struct RawDocumentUpdateReceipt {
    document_id: String,
    generation: i64,
    seq: i64,
    update_id: String,
    client_session_id: String,
    base_head_seq: i64,
    client_touched_block_ids_json: String,
    derived_touched_block_ids_json: String,
    derivation_version: i64,
    update_hash: String,
    update_byte_length: i64,
    committed_at: String,
}

impl TryFrom<RawDocumentUpdateReceipt> for DocumentUpdateReceiptRow {
    type Error = StoreError;

    fn try_from(raw: RawDocumentUpdateReceipt) -> Result<Self, Self::Error> {
        validate_identifier(&raw.document_id, "document_update_receipts.document_id")?;
        validate_positive(raw.generation, "document_update_receipts.generation")?;
        validate_positive(raw.seq, "document_update_receipts.seq")?;
        validate_identifier(&raw.update_id, "document_update_receipts.update_id")?;
        validate_identifier(
            &raw.client_session_id,
            "document_update_receipts.client_session_id",
        )?;
        validate_non_negative(raw.base_head_seq, "document_update_receipts.base_head_seq")?;
        let client_touched_block_ids = parse_identifier_array(
            &raw.client_touched_block_ids_json,
            "document_update_receipts.client_touched_block_ids_json",
        )?;
        let derived_touched_block_ids = parse_identifier_array(
            &raw.derived_touched_block_ids_json,
            "document_update_receipts.derived_touched_block_ids_json",
        )?;
        if !matches!(raw.derivation_version, 0 | 1) {
            return Err(corrupt_row(
                "document_update_receipts",
                "derivation_version is outside the supported enum",
            ));
        }
        validate_sha256(&raw.update_hash, "document_update_receipts.update_hash")?;
        validate_positive(
            raw.update_byte_length,
            "document_update_receipts.update_byte_length",
        )?;
        if raw.update_byte_length > MAX_DOCUMENT_UPDATE_BYTES as i64 {
            return Err(corrupt_row(
                "document_update_receipts",
                "update_byte_length exceeds the document update bound",
            ));
        }
        validate_timestamp(&raw.committed_at, "document_update_receipts.committed_at")?;
        Ok(Self {
            document_id: raw.document_id,
            generation: raw.generation,
            seq: raw.seq,
            update_id: raw.update_id,
            client_session_id: raw.client_session_id,
            base_head_seq: raw.base_head_seq,
            client_touched_block_ids,
            derived_touched_block_ids,
            derivation_version: raw.derivation_version,
            update_hash: raw.update_hash,
            update_byte_length: raw.update_byte_length,
            committed_at: raw.committed_at,
        })
    }
}

fn parse_readiness(value: &str) -> Result<DocumentReadiness, StoreError> {
    match value {
        "pending_genesis" => Ok(DocumentReadiness::PendingGenesis),
        "ready" => Ok(DocumentReadiness::Ready),
        "failed" => Ok(DocumentReadiness::Failed),
        _ => Err(corrupt_row(
            "documents",
            "readiness is outside the supported enum",
        )),
    }
}

fn parse_authority(value: &str) -> Result<DocumentAuthority, StoreError> {
    match value {
        "legacy_shadow" => Ok(DocumentAuthority::LegacyShadow),
        "ydoc_primary" => Ok(DocumentAuthority::YdocPrimary),
        _ => Err(corrupt_row(
            "documents",
            "authority is outside the supported enum",
        )),
    }
}

fn parse_sync_engine(value: &str) -> Result<DocumentSyncEngine, StoreError> {
    match value {
        "yjs" => Ok(DocumentSyncEngine::Yjs),
        "canvas_scene" => Ok(DocumentSyncEngine::CanvasScene),
        _ => Err(corrupt_row(
            "documents",
            "sync_engine is outside the supported enum",
        )),
    }
}

fn validate_identifier(value: &str, column: &str) -> Result<(), StoreError> {
    validate_bounded_text(value, 1, MAX_IDENTIFIER_BYTES, column)?;
    if value.trim() != value || value.chars().any(char::is_control) {
        return Err(corrupt_column(column, "identifier is not canonical"));
    }
    Ok(())
}

fn validate_positive(value: i64, column: &str) -> Result<(), StoreError> {
    if (1..=MAX_SAFE_INTEGER).contains(&value) {
        return Ok(());
    }
    Err(corrupt_column(
        column,
        "integer is outside the positive safe range",
    ))
}

fn validate_non_negative(value: i64, column: &str) -> Result<(), StoreError> {
    if (0..=MAX_SAFE_INTEGER).contains(&value) {
        return Ok(());
    }
    Err(corrupt_column(
        column,
        "integer is outside the non-negative safe range",
    ))
}

fn validate_sha256(value: &str, column: &str) -> Result<(), StoreError> {
    if value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Ok(());
    }
    Err(corrupt_column(column, "value is not a lowercase SHA-256"))
}

fn validate_blob_bound(
    value: &[u8],
    maximum: usize,
    column: &str,
    allow_empty: bool,
) -> Result<(), StoreError> {
    if value.len() <= maximum && (allow_empty || !value.is_empty()) {
        return Ok(());
    }
    Err(corrupt_column(column, "BLOB is empty or exceeds its bound"))
}

fn validate_bounded_text(
    value: &str,
    minimum: usize,
    maximum: usize,
    column: &str,
) -> Result<(), StoreError> {
    if (minimum..=maximum).contains(&value.len()) {
        return Ok(());
    }
    Err(corrupt_column(column, "text length is outside its bound"))
}

fn parse_identifier_array(value: &str, column: &str) -> Result<Vec<String>, StoreError> {
    validate_bounded_text(value, 2, MAX_JSON_BYTES, column)?;
    let identifiers: Vec<String> = serde_json::from_str(value)
        .map_err(|_| corrupt_column(column, "JSON is not an array of identifiers"))?;
    if identifiers.len() > MAX_TOUCHED_BLOCK_IDS {
        return Err(corrupt_column(column, "identifier array exceeds its bound"));
    }
    for identifier in &identifiers {
        validate_identifier(identifier, column)?;
    }
    Ok(identifiers)
}

fn parse_json_array(value: &str, column: &str) -> Result<Value, StoreError> {
    validate_bounded_text(value, 2, MAX_JSON_BYTES, column)?;
    let parsed: Value =
        serde_json::from_str(value).map_err(|_| corrupt_column(column, "JSON is invalid"))?;
    if parsed.is_array() {
        return Ok(parsed);
    }
    Err(corrupt_column(column, "JSON value is not an array"))
}

fn validate_timestamp(value: &str, column: &str) -> Result<(), StoreError> {
    let bytes = value.as_bytes();
    let valid_shape = matches!(bytes.len(), 10 | 20 | 24)
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && (bytes.len() == 10
            || (bytes.get(10) == Some(&b'T')
                && bytes.get(13) == Some(&b':')
                && bytes.get(16) == Some(&b':')
                && bytes.last() == Some(&b'Z')
                && (bytes.len() == 20 || bytes.get(19) == Some(&b'.'))));
    if !valid_shape || !timestamp_digits_are_valid(bytes) {
        return Err(corrupt_column(
            column,
            "timestamp is not canonical UTC ISO-8601",
        ));
    }
    Ok(())
}

fn timestamp_digits_are_valid(bytes: &[u8]) -> bool {
    let digit_ranges: &[(usize, usize)] = if bytes.len() == 10 {
        &[(0, 4), (5, 7), (8, 10)]
    } else if bytes.len() == 20 {
        &[(0, 4), (5, 7), (8, 10), (11, 13), (14, 16), (17, 19)]
    } else {
        &[
            (0, 4),
            (5, 7),
            (8, 10),
            (11, 13),
            (14, 16),
            (17, 19),
            (20, 23),
        ]
    };
    if digit_ranges
        .iter()
        .any(|(start, end)| !bytes[*start..*end].iter().all(u8::is_ascii_digit))
    {
        return false;
    }
    let parse = |start: usize, end: usize| {
        bytes[start..end]
            .iter()
            .fold(0_u32, |value, digit| value * 10 + u32::from(digit - b'0'))
    };
    let year = parse(0, 4);
    let month = parse(5, 7);
    let day = parse(8, 10);
    if year == 0 || !(1..=12).contains(&month) {
        return false;
    }
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let maximum_day = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day == 0 || day > maximum_day {
        return false;
    }
    bytes.len() == 10 || (parse(11, 13) <= 23 && parse(14, 16) <= 59 && parse(17, 19) <= 59)
}

fn corrupt_column(column: &str, reason: &str) -> StoreError {
    StoreError::new(
        StoreErrorCode::StoreCorrupt,
        format!("Malformed SQLite row at {column}: {reason}"),
        false,
    )
}

fn corrupt_row(table: &str, reason: &str) -> StoreError {
    StoreError::new(
        StoreErrorCode::StoreCorrupt,
        format!("Malformed SQLite {table} row: {reason}"),
        false,
    )
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rusqlite::params;

    use super::*;
    use crate::infrastructure::migration::prepare_test_current_store;

    const NOW: &str = "2026-07-18T00:00:00.000Z";
    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn seeded_store() -> Connection {
        let mut connection = Connection::open_in_memory().expect("memory store");
        prepare_test_current_store(&mut connection, Path::new("/__document_repository_test__"))
            .expect("current schema");
        connection
            .execute(
                "INSERT INTO profiles(id, created_at, updated_at) \
                 VALUES ('profile:1', ?1, ?1);",
                [NOW],
            )
            .expect("Profile");
        connection
            .execute(
                "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                 VALUES ('library:1', 'profile:1', ?1, ?1)",
                [NOW],
            )
            .expect("Library");
        connection
            .execute(
                "INSERT INTO documents(\
                   id, library_id, generation, head_seq, schema_key, schema_version, state_vector, \
                   state_hash, readiness, authority, created_at, updated_at, sync_engine\
                 ) VALUES ('document:1', 'library:1', 1, 1, 'nodex.page', 4, X'00', '', \
                   'ready', 'ydoc_primary', ?1, ?1, 'yjs')",
                [NOW],
            )
            .expect("Document");
        connection
            .execute(
                "INSERT INTO document_updates(\
                   document_id, generation, seq, update_id, client_session_id, base_head_seq, \
                   touched_block_ids_json, update_blob, update_hash, committed_at\
                 ) VALUES ('document:1', 1, 1, 'update:1', 'session:1', 0, \
                   '[\"block:1\"]', X'01', ?1, ?2)",
                params![HASH, NOW],
            )
            .expect("Update");
        connection
            .execute(
                "INSERT INTO document_update_receipts(\
                   document_id, generation, seq, update_id, client_session_id, base_head_seq, \
                   client_touched_block_ids_json, derived_touched_block_ids_json, \
                   derivation_version, update_hash, update_byte_length, committed_at\
                 ) VALUES ('document:1', 1, 1, 'update:1', 'session:1', 0, \
                   '[\"block:1\"]', '[\"block:1\"]', 1, ?1, 1, ?2)",
                params![HASH, NOW],
            )
            .expect("Receipt");
        connection
            .execute(
                "INSERT INTO document_snapshots(\
                   document_id, generation, snapshot_seq, state_vector, snapshot_update, \
                   snapshot_hash, schema_version, created_at\
                 ) VALUES ('document:1', 1, 1, X'00', X'01', ?1, 2, ?2)",
                params![HASH, NOW],
            )
            .expect("Snapshot");
        connection
            .execute(
                "INSERT INTO document_materializations(\
                   document_id, generation, projected_seq, schema_version, title, title_rich_json, \
                   title_rich_hash, markdown, plain_text, preview, block_tree_json, references_json, \
                   asset_refs_json, updated_at\
                 ) VALUES ('document:1', 1, 1, 2, '', '[]', ?1, '', '', '', '[]', '[]', '[]', ?2)",
                params![HASH, NOW],
            )
            .expect("Materialization");
        connection
    }

    #[test]
    fn reads_the_document_vertical_slice_through_typed_rows() {
        let connection = seeded_store();
        let repository = DocumentReadRepository::new(&connection);
        let heads = repository.live_yjs_heads().expect("heads");
        assert_eq!(heads.len(), 1);
        assert_eq!(heads[0].head_seq, 1);
        assert_eq!(
            repository
                .latest_snapshot("document:1", 1, 1)
                .expect("snapshot")
                .expect("snapshot row")
                .snapshot_update,
            vec![1]
        );
        assert_eq!(
            repository
                .updates_between("document:1", 1, 0, 1)
                .expect("updates")[0]
                .touched_block_ids,
            vec!["block:1"]
        );
        assert!(
            repository
                .materialization("document:1")
                .expect("materialization")
                .is_some()
        );
        assert_eq!(
            repository
                .update_receipt("document:1", "update:1")
                .expect("receipt")
                .expect("receipt row")
                .update_byte_length,
            1
        );
    }

    #[test]
    fn malformed_integer_is_a_stable_corruption_error() {
        let connection = seeded_store();
        connection
            .pragma_update(None, "ignore_check_constraints", true)
            .expect("test bypasses SQLite checks");
        connection
            .execute(
                "UPDATE documents SET generation = 0 WHERE id = 'document:1'",
                [],
            )
            .expect("malformed row");
        let error = DocumentReadRepository::new(&connection)
            .document_heads()
            .expect_err("malformed integer must fail");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
        assert_eq!(
            error.message,
            "Malformed SQLite row at documents.generation: integer is outside the positive safe range"
        );
    }

    #[test]
    fn malformed_json_enum_and_timestamp_fail_at_the_row_boundary() {
        let cases = [
            ("document_updates", "touched_block_ids_json", "'{}'"),
            ("documents", "sync_engine", "'unknown'"),
            ("documents", "updated_at", "'2026-02-30T00:00:00.000Z'"),
        ];
        for (table, column, value) in cases {
            let connection = seeded_store();
            connection
                .pragma_update(None, "ignore_check_constraints", true)
                .expect("test bypasses SQLite checks");
            if column == "sync_engine" {
                connection
                    .execute_batch("DROP TRIGGER documents_sync_engine_immutable")
                    .expect("test bypasses immutable-engine trigger");
            }
            let identity_column = if table == "documents" {
                "id"
            } else {
                "document_id"
            };
            connection
                .execute_batch(&format!(
                    "UPDATE {table} SET {column} = {value} WHERE {identity_column} = 'document:1'"
                ))
                .expect("malformed row");
            let repository = DocumentReadRepository::new(&connection);
            let error = if table == "document_updates" {
                repository
                    .updates_between("document:1", 1, 0, 1)
                    .expect_err("malformed update must fail")
            } else {
                repository
                    .document_heads()
                    .expect_err("malformed head must fail")
            };
            assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
        }
    }
}
