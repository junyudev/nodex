use rusqlite::Connection;
use sha2::{Digest, Sha256};
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Transact, Update};

use crate::infrastructure::document_repository::{DocumentHeadRow, DocumentReadRepository};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::persistence::persist_nfm_derivation_upgrade;

use super::{
    BlockDocumentSchema, DocumentMaterialization, MAX_DOCUMENT_UPDATE_BYTES,
    create_compatible_document, decode_block_document, decode_state_vector_v1,
    has_pending_dependencies, materialize_decoded_document,
};

/// Reconstructs every live Yjs Document from durable updates and proves that its
/// persisted state vector and materialization are exact.
pub(crate) fn validate_restore_documents(connection: &Connection) -> Result<usize, StoreError> {
    validate_documents_for_store_revision(
        connection,
        nodex_store_format::CURRENT_STORE_VERSION.into(),
    )
}

/// A derived projection is checked with the rules that wrote it, never with a
/// newer serializer. Revisions 187/188 wrote both known encodings under v2.
pub(crate) fn validate_documents_for_store_revision(
    connection: &Connection,
    store_revision: i64,
) -> Result<usize, StoreError> {
    let repository = DocumentReadRepository::new(connection);
    let heads = repository.live_yjs_heads()?;
    for head in &heads {
        let reconstructed = reconstruct_live_yjs_document(&repository, head)?;
        assert_persisted_materialization(&repository, head, &reconstructed, store_revision)?;
    }
    Ok(heads.len())
}

/// Upgrades the NFM encoding after exact source validation. All other derived
/// fields were proven identical; canonical history, identity indexes, and
/// owner-scoped references/search/assets keep their existing state and times.
pub(crate) fn upgrade_document_nfm_derivation(
    connection: &Connection,
) -> Result<usize, StoreError> {
    let repository = DocumentReadRepository::new(connection);
    let heads = repository.live_yjs_heads()?;
    for head in &heads {
        let materialization = reconstruct_live_yjs_document(&repository, head)?;
        persist_nfm_derivation_upgrade(connection, head, &materialization.nfm)?;
    }
    Ok(heads.len())
}

pub(crate) fn materialization_derivation_for_store_revision(
    store_revision: i64,
) -> Result<i64, StoreError> {
    match store_revision {
        130..=188 => Ok(2),
        189..=190 => Ok(3),
        _ => Err(StoreError::new(
            StoreErrorCode::UnsupportedSchema,
            format!("Store v{store_revision} has no registered Document derivation"),
            false,
        )),
    }
}

fn reconstruct_live_yjs_document(
    repository: &DocumentReadRepository<'_>,
    head: &DocumentHeadRow,
) -> Result<DocumentMaterialization, StoreError> {
    let schema = BlockDocumentSchema::from_identity(&head.schema_key, head.schema_version)
        .ok_or_else(|| {
            corrupt(format!(
                "Document uses unregistered schema {}@{}",
                head.schema_key, head.schema_version
            ))
        })?;
    let snapshot = repository.latest_snapshot(&head.id, head.generation, head.head_seq)?;
    let document = create_compatible_document(&head.id);
    let snapshot_seq = if let Some(snapshot) = snapshot {
        verify_update_hash(
            &snapshot.snapshot_update,
            &snapshot.snapshot_hash,
            &head.id,
            "snapshot",
        )?;
        apply_update(&document, &snapshot.snapshot_update, &head.id, "snapshot")?;
        let expected = decode_state_vector_v1(&snapshot.state_vector)
            .map_err(|error| corrupt(format!("Document {} snapshot vector: {error}", head.id)))?;
        if document.transact().state_vector() != expected {
            return Err(corrupt(format!(
                "Document {} snapshot state vector does not match its update",
                head.id
            )));
        }
        snapshot.snapshot_seq
    } else {
        0
    };

    let updates =
        repository.updates_between(&head.id, head.generation, snapshot_seq, head.head_seq)?;
    let mut expected_seq = snapshot_seq + 1;
    for update in updates {
        if update.seq != expected_seq {
            return Err(corrupt(format!(
                "Document {} update tail is not contiguous at sequence {expected_seq}",
                head.id
            )));
        }
        verify_update_hash(&update.update_blob, &update.update_hash, &head.id, "update")?;
        apply_update(&document, &update.update_blob, &head.id, "update")?;
        expected_seq += 1;
    }
    if expected_seq - 1 != head.head_seq {
        return Err(corrupt(format!(
            "Document {} reconstruction ended at sequence {}, expected {}",
            head.id,
            expected_seq - 1,
            head.head_seq
        )));
    }

    let expected_vector = decode_state_vector_v1(&head.state_vector)
        .map_err(|error| corrupt(format!("Document {} state vector: {error}", head.id)))?;
    let transaction = document.transact();
    if transaction.state_vector() != expected_vector {
        return Err(corrupt(format!(
            "Document {} persisted state vector does not match reconstruction",
            head.id
        )));
    }
    let full_state_v1 = transaction.encode_state_as_update_v1(&StateVector::default());
    drop(transaction);
    if full_state_v1.len() > MAX_DOCUMENT_UPDATE_BYTES {
        return Err(corrupt(format!(
            "Document {} reconstructed state exceeds the Core bound",
            head.id
        )));
    }

    let decoded = decode_block_document(&document, schema)
        .map_err(|error| corrupt(format!("Document {} schema validation: {error}", head.id)))?;
    materialize_decoded_document(&decoded)
        .map_err(|error| corrupt(format!("Document {} materialization: {error}", head.id)))
}

fn assert_persisted_materialization(
    repository: &DocumentReadRepository<'_>,
    head: &DocumentHeadRow,
    actual: &DocumentMaterialization,
    store_revision: i64,
) -> Result<(), StoreError> {
    let persisted = repository
        .materialization(&head.id)?
        .ok_or_else(|| corrupt(format!("Document {} has no materialization", head.id)))?;
    let rich_title = serde_json::to_value(&actual.rich_title).map_err(internal_json)?;
    let block_tree = serde_json::to_value(&actual.block_tree).map_err(internal_json)?;
    let references = serde_json::to_value(&actual.references).map_err(internal_json)?;
    let asset_refs = serde_json::to_value(&actual.asset_refs).map_err(internal_json)?;
    let derivation_version = repository.connection().query_row(
        "SELECT materialization_derivation_version \
         FROM document_materializations WHERE document_id = ?1",
        [&head.id],
        |row| row.get::<_, i64>(0),
    )?;
    let current_nfm_matches = store_revision >= 187 && persisted.nfm == actual.nfm;
    let nfm_matches = if current_nfm_matches || store_revision >= 189 {
        current_nfm_matches
    } else {
        let legacy =
            crate::domain::nfm::materialize_nfm_before_paragraph_protection(&actual.block_tree)
                .map_err(|error| {
                    corrupt(format!("Document {} predecessor NFM: {error}", head.id))
                })?;
        persisted.nfm == legacy.nfm
    };
    let mismatched_fields = [
        (persisted.generation != head.generation, "generation"),
        (persisted.projected_seq != head.head_seq, "projected_seq"),
        (
            persisted.schema_version != i64::from(actual.schema_version),
            "schema_version",
        ),
        (persisted.title != actual.title, "title"),
        (persisted.rich_title != rich_title, "rich_title"),
        (!nfm_matches, "nfm"),
        (persisted.plain_text != actual.plain_text, "plain_text"),
        (persisted.preview != actual.preview, "preview"),
        (persisted.block_tree != block_tree, "block_tree"),
        (persisted.references != references, "references"),
        (persisted.asset_refs != asset_refs, "asset_refs"),
        (
            derivation_version != materialization_derivation_for_store_revision(store_revision)?,
            "materialization_derivation_version",
        ),
    ]
    .into_iter()
    .filter_map(|(mismatched, field)| mismatched.then_some(field))
    .collect::<Vec<_>>();
    if mismatched_fields.is_empty() {
        return Ok(());
    }
    Err(corrupt(format!(
        "Document {} persisted materialization does not match Yrs reconstruction (fields: {})",
        head.id,
        mismatched_fields.join(", ")
    )))
}

fn apply_update(
    document: &yrs::Doc,
    bytes: &[u8],
    document_id: &str,
    label: &str,
) -> Result<(), StoreError> {
    if bytes.len() > MAX_DOCUMENT_UPDATE_BYTES {
        return Err(corrupt(format!(
            "Document {document_id} {label} exceeds the update bound"
        )));
    }
    let update = Update::decode_v1(bytes)
        .map_err(|error| corrupt(format!("Document {document_id} {label}: {error}")))?;
    let mut transaction = document.transact_mut();
    transaction
        .apply_update(update)
        .map_err(|error| corrupt(format!("Document {document_id} {label}: {error}")))?;
    if has_pending_dependencies(&transaction) {
        return Err(corrupt(format!(
            "Document {document_id} {label} has unresolved causal dependencies"
        )));
    }
    Ok(())
}

fn verify_update_hash(
    update: &[u8],
    expected: &str,
    document_id: &str,
    label: &str,
) -> Result<(), StoreError> {
    if hex::encode(Sha256::digest(update)) == expected {
        return Ok(());
    }
    Err(corrupt(format!(
        "Document {document_id} {label} hash does not match its bytes"
    )))
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal_json(error: serde_json::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::Internal,
        format!("Could not serialize materialization comparison: {error}"),
        false,
    )
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use crate::infrastructure::store::SqliteStoreKernel;

    use super::*;

    #[test]
    fn every_published_store_has_an_explicit_document_derivation() {
        for format in nodex_store_format::PUBLISHED_STORE_FORMATS {
            materialization_derivation_for_store_revision(format.revision.into()).unwrap();
        }
        assert_eq!(
            materialization_derivation_for_store_revision(
                nodex_store_format::CURRENT_STORE_VERSION.into()
            )
            .unwrap(),
            crate::document::CURRENT_DOCUMENT_MATERIALIZATION_DERIVATION_VERSION,
        );
        assert!(
            materialization_derivation_for_store_revision(
                i64::from(nodex_store_format::CURRENT_STORE_VERSION) + 1
            )
            .is_err()
        );
    }

    #[test]
    fn fresh_store_has_exact_restore_documents() {
        let home = tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(home.path()).expect("fresh Store");
        kernel
            .readers()
            .read_default(|connection| validate_restore_documents(connection))
            .expect("current Document integrity");
    }
}
