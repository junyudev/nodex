use super::*;
use crate::document::asset_migration::migrate_document_assets;
use crate::document::genesis::prepare_yjs_genesis_with_blocks;
use crate::document::persistence::{
    persist_materialization_for_schema_migration,
    replace_document_block_index_for_schema_migration,
    replace_secondary_projections_for_schema_migration,
};
use crate::domain::block_materialization::MaterializedBlockNode;

const IMAGE_ID: &str = "019bf52d-6870-7000-8000-000000000101";
const TEXT_ID: &str = "019bf52d-6870-7000-8000-000000000102";
const MISSING_ID: &str = "019bf52d-6870-7000-8000-000000000103";

fn blocks() -> Vec<MaterializedBlockNode> {
    serde_json::from_value(json!([
        {"id":IMAGE_ID,"type":"image","props":{"url":"nodex://assets/photo.png","name":"My photo"},"children":[]},
        {"id":TEXT_ID,"type":"paragraph","props":{},"content":[
            {"type":"attachment","props":{"source":"nodex://assets/photo.png","name":"My attachment"}},
            {"type":"text","text":"nodex://assets/photo.png","styles":{"code":true}}
        ],"children":[]},
        {"id":MISSING_ID,"type":"image","props":{"url":"nodex://assets/missing.png"},"children":[]}
    ])).unwrap()
}

// Historical input deliberately bypasses today's source-admission rules.
fn install_historical_document(connection: &rusqlite::Connection) -> Result<(), StoreError> {
    let genesis = prepare_yjs_genesis_with_blocks(
        DOCUMENT_ID,
        "page",
        BlockDocumentSchema::PageV3,
        &blocks(),
    )?;
    for unit in &genesis.materialization.search_units {
        connection.execute("INSERT INTO blocks(id, library_id, type, lifecycle, placement_revision, metadata_revision, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', 1, 1, ?4, ?4)",params![unit.block_id,LIBRARY_ID,unit.block_type,NOW])?;
    }
    connection.execute(
        "UPDATE documents SET state_vector = ?1 WHERE id = ?2",
        params![genesis.state_vector_v1, DOCUMENT_ID],
    )?;
    connection.execute("UPDATE document_snapshots SET state_vector = ?1, snapshot_update = ?2, snapshot_hash = ?3 WHERE document_id = ?4",params![genesis.state_vector_v1,genesis.update_v1,sha256(&genesis.update_v1),DOCUMENT_ID])?;
    persist_materialization_for_schema_migration(
        connection,
        DOCUMENT_ID,
        1,
        1,
        &genesis.materialization,
        NOW,
    )?;
    replace_document_block_index_for_schema_migration(
        connection,
        DOCUMENT_ID,
        1,
        &genesis.materialization,
    )?;
    replace_secondary_projections_for_schema_migration(
        connection,
        DOCUMENT_ID,
        &genesis.materialization,
        1,
        NOW,
    )?;
    crate::document::history::insert_migrated_file_baselines(connection, NOW)?;
    Ok(())
}

#[test]
fn managed_asset_migration_preserves_content_history_and_missing_sources() {
    let seeded = seeded_module();
    let assets = seeded._directory.path().join("assets");
    fs::create_dir_all(&assets).unwrap();
    fs::write(assets.join("photo.png"), b"exact original bytes").unwrap();
    seeded
        .kernel
        .writer()
        .call(|connection| {
            with_immediate_transaction(connection, |connection| {
                install_historical_document(connection)?;
                migrate_document_assets(connection, NOW)?;
                let authority = read_document_authority(connection, DOCUMENT_ID)?.unwrap();
                let engine = crate::document::reconstruct_yjs_engine(connection, &authority.head)?;
                let materialization =
                    materialize_engine(&engine, BlockDocumentSchema::PageV3).unwrap();
                let file_source = materialization.block_tree[0].props["url"].as_str().unwrap();
                assert!(file_source.starts_with("nodex://files/"));
                assert_eq!(materialization.block_tree[0].props["name"], "My photo");
                let version_id: String = connection.query_row(
                    "SELECT version_id FROM document_versions WHERE document_id = ?1",
                    [DOCUMENT_ID],
                    |row| row.get(0),
                )?;
                let version = crate::document::history::get_document_version(
                    connection,
                    &authority,
                    &version_id,
                )?
                .unwrap();
                let historical = version.block_materialization.unwrap();
                assert_eq!(historical.block_tree, materialization.block_tree);
                let file_id = file_source.strip_prefix("nodex://files/").unwrap();
                let target = &version.file_snapshot.unwrap().files[file_id];
                assert_eq!(target.version, 1);
                assert_eq!(target.default_name, "photo.png");
                let content_hash: String = connection.query_row(
                    "SELECT blob_hash FROM file_versions WHERE file_id = ?1 AND version = 1",
                    [file_id],
                    |row| row.get(0),
                )?;
                assert_eq!(content_hash, sha256(b"exact original bytes"));
                assert_eq!(
                    materialization.block_tree[1].content.as_ref().unwrap()[0]["props"]["source"],
                    file_source
                );
                assert_eq!(
                    materialization.block_tree[1].content.as_ref().unwrap()[1]["text"],
                    "nodex://assets/photo.png"
                );
                assert_eq!(
                    materialization.block_tree[2].props["url"],
                    "nodex://assets/missing.png"
                );
                assert_eq!(
                    connection.query_row("SELECT count(*) FROM library_files", [], |r| r
                        .get::<_, i64>(0))?,
                    1
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM document_version_file_refs",
                        [],
                        |r| r.get::<_, i64>(0)
                    )?,
                    1
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT body_usage_revision FROM page_file_manifests WHERE page_id = ?1",
                        [OWNER_BLOCK_ID],
                        |r| r.get::<_, i64>(0)
                    )?,
                    1
                );
                let epoch: String = connection.query_row(
                    "SELECT store_epoch FROM block_store_metadata",
                    [],
                    |r| r.get(0),
                )?;
                assert_ne!(epoch, STORE_EPOCH);
                crate::document::integrity::validate_restore_documents(connection)?;
                validate_current_store(connection)?;
                migrate_document_assets(connection, NOW)?;
                assert_eq!(
                    connection.query_row(
                        "SELECT store_epoch FROM block_store_metadata",
                        [],
                        |r| r.get::<_, String>(0)
                    )?,
                    epoch
                );
                assert_eq!(
                    connection.query_row("SELECT count(*) FROM library_files", [], |r| r
                        .get::<_, i64>(0))?,
                    1
                );
                Ok(())
            })
        })
        .unwrap();
    assert_eq!(
        fs::read(assets.join("photo.png")).unwrap(),
        b"exact original bytes"
    );
}

#[test]
fn document_commands_reject_temporary_media_without_committing() {
    for source in [
        "nodex://assets/photo.png",
        "blob:local-image",
        "app://fs/tmp/photo.png",
    ] {
        let seeded = seeded_module();
        let block = json!({"id":IMAGE_ID,"type":"image","props":{"url":source},"children":[]});
        let result = seeded.module.apply(
            &context(),
            ModuleApplyRequest {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                operation_id: "reject-temporary-image".to_owned(),
                store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                intent: OwnedDocumentIntent::ApplyOperationBatch {
                    document_id: DOCUMENT_ID.to_owned(),
                    generation: 1,
                    expected_head_seq: 1,
                    operations: vec![ContractDocumentBlockOperation::InsertBlock {
                        block,
                        parent_block_id: None,
                        before_block_id: None,
                    }],
                    actor: json!({"kind":"test"}),
                },
            },
        );
        assert_eq!(
            result.expect_err("temporary source must be rejected").code,
            CoreErrorCode::InvalidInput
        );
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                assert_eq!(
                    connection.query_row(
                        "SELECT head_seq FROM documents WHERE id = ?1",
                        [DOCUMENT_ID],
                        |r| r.get::<_, i64>(0)
                    )?,
                    1
                );
                Ok::<_, StoreError>(())
            })
            .unwrap();
    }
}

#[test]
fn managed_asset_migration_rejects_non_regular_sources_atomically() {
    let seeded = seeded_module();
    let assets = seeded._directory.path().join("assets");
    fs::create_dir_all(assets.join("photo.png")).unwrap();
    seeded
        .kernel
        .writer()
        .call(|connection| {
            with_immediate_transaction(connection, |transaction| {
                install_historical_document(transaction)
            })
        })
        .unwrap();
    let error = seeded
        .kernel
        .writer()
        .call(|connection| {
            with_immediate_transaction(connection, |connection| {
                migrate_document_assets(connection, NOW).map(|_| ())
            })
        })
        .expect_err("directory cannot become File bytes");
    assert_eq!(
        error.code,
        crate::infrastructure::sqlite::StoreErrorCode::StoreCorrupt
    );
    seeded
        .kernel
        .readers()
        .read_default(|connection| {
            assert_eq!(
                connection.query_row("SELECT count(*) FROM library_files", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            assert_eq!(
                connection.query_row("SELECT store_epoch FROM block_store_metadata", [], |r| {
                    r.get::<_, String>(0)
                })?,
                STORE_EPOCH
            );
            crate::document::integrity::validate_restore_documents(connection)?;
            Ok::<_, StoreError>(())
        })
        .unwrap();
}
