use super::*;
use crate::infrastructure::document_repository::DocumentReadRepository;
use crate::infrastructure::sqlite::open_writer;

/// Historical storage tests deliberately downgrade schema coordinates after authoring
/// canonical Blocks. The final migration rebuilds their disposable text projections.
pub(super) fn rewrite_as_predecessor(connection: &Connection, _revision: i64) {
    let repository = DocumentReadRepository::new(connection);
    for head in repository.live_yjs_heads().unwrap() {
        let row = repository.materialization(&head.id).unwrap().unwrap();
        let source_version = match head.schema_key.as_str() {
            "nodex.page" => 3,
            "nodex.synced-block" | "nodex.reusable-template" => 2,
            _ => unreachable!(),
        };
        connection
            .execute(
                "UPDATE documents SET schema_version=?1 WHERE id=?2",
                params![source_version, head.id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE document_snapshots SET schema_version=?1 WHERE document_id=?2",
                params![source_version, head.id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE document_versions SET schema_version=?1 WHERE document_id=?2",
                params![source_version, head.id],
            )
            .unwrap();
        let column = crate::document::schema_migration::stored_markdown_column(connection).unwrap();
        connection.execute(&format!("UPDATE document_materializations SET materialization_derivation_version=2,{column}=?1,schema_version=?3 WHERE document_id=?2"),params![row.markdown,head.id,source_version]).unwrap();
        connection
            .execute(
                "UPDATE page_read_model SET document_schema_version=?1 WHERE document_id=?2",
                params![source_version, head.id],
            )
            .unwrap();
    }
}

#[test]
fn frozen_predecessor_rebuilds_the_complete_current_projection_bundle() {
    let profile = nodex_platform::test_support::tempdir().unwrap();
    nodex_platform::private_fs::write(
        profile.path().join("nodex.db"),
        include_bytes!("../../tests/fixtures/store-v188.db"),
    )
    .unwrap();
    let mut connection = open_writer(&profile.path().join("nodex.db")).unwrap();
    assert_eq!(
        prepare_profile_store(&mut connection, profile.path())
            .unwrap()
            .migrated_from_version,
        Some(188)
    );
    crate::document::integrity::validate_restore_documents(&connection).unwrap();
    let repository = DocumentReadRepository::new(&connection);
    for head in repository.live_yjs_heads().unwrap() {
        let row = repository.materialization(&head.id).unwrap().unwrap();
        let blocks: Vec<crate::domain::block_materialization::MaterializedBlockNode> =
            serde_json::from_value(row.block_tree).unwrap();
        let expected = crate::domain::markdown::materialize_markdown(&blocks).unwrap();
        assert_eq!(row.markdown, expected.markdown);
        assert_eq!(row.plain_text, expected.plain_text);
        assert_eq!(row.preview, expected.preview);
    }
}

#[test]
fn canonical_projection_corruption_is_rejected_before_backup() {
    let profile = nodex_platform::test_support::tempdir().unwrap();
    nodex_platform::private_fs::write(
        profile.path().join("nodex.db"),
        include_bytes!("../../tests/fixtures/store-v191.db"),
    )
    .unwrap();
    let mut connection = open_writer(&profile.path().join("nodex.db")).unwrap();
    connection
        .execute(
            "UPDATE document_materializations SET block_tree_json='[]'",
            [],
        )
        .unwrap();
    assert_eq!(
        prepare_profile_store(&mut connection, profile.path())
            .unwrap_err()
            .code,
        StoreErrorCode::StoreCorrupt
    );
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        191
    );
    assert!(!profile.path().join("backups").exists());
}

#[test]
fn language_migration_rolls_back_column_content_and_epoch_together() {
    let profile = nodex_platform::test_support::tempdir().unwrap();
    nodex_platform::private_fs::write(
        profile.path().join("nodex.db"),
        include_bytes!("../../tests/fixtures/store-v191.db"),
    )
    .unwrap();
    let mut connection = open_writer(&profile.path().join("nodex.db")).unwrap();
    let epoch: String = connection
        .query_row(
            "SELECT store_epoch FROM block_store_metadata WHERE id=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let heads = connection
        .prepare("SELECT snapshot_hash FROM document_snapshots ORDER BY document_id")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    connection.execute_batch("CREATE TRIGGER reject_language_projection BEFORE INSERT ON document_materializations BEGIN SELECT RAISE(ABORT,'projection failure'); END").unwrap();
    let result = with_schema_rebuild_transaction(&mut connection, |transaction| {
        crate::document::migrate_nodex_markdown_contract(transaction, 1_793_145_600_000)
    });
    assert!(result.is_err());
    assert_eq!(
        crate::document::schema_migration::stored_markdown_column(&connection).unwrap(),
        "nfm"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT store_epoch FROM block_store_metadata WHERE id=1",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        epoch
    );
    assert_eq!(
        connection
            .prepare("SELECT snapshot_hash FROM document_snapshots ORDER BY document_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap(),
        heads
    );
    connection
        .execute_batch("DROP TRIGGER reject_language_projection")
        .unwrap();
    prepare_profile_store(&mut connection, profile.path()).unwrap();
}

#[test]
fn migration_normalizes_legacy_cleanup_time_without_changing_its_instant() {
    let profile = nodex_platform::test_support::tempdir().unwrap();
    let mut connection = open_writer(&profile.path().join("nodex.db")).unwrap();
    prepare_profile_store(&mut connection, profile.path()).unwrap();
    // v202 changes the timestamp contract without changing the SQL schema.
    connection.pragma_update(None, "user_version", 201).unwrap();
    connection
        .execute(
            "INSERT INTO nodex_agent_runtime_execution_cleanups
                (cleanup_id, library_id, session_id, runtime_id, runtime_thread_id, created_at)
             VALUES ('cleanup', 'library', 'session', 'runtime', 'thread', '2026-01-02 03:04:05')",
            [],
        )
        .unwrap();

    let result = prepare_profile_store(&mut connection, profile.path()).unwrap();
    assert_eq!(result.migrated_from_version, Some(201));
    let timestamp = connection
        .query_row(
            "SELECT created_at FROM nodex_agent_runtime_execution_cleanups WHERE cleanup_id='cleanup'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(timestamp, "2026-01-02T03:04:05.000Z");
    validate_current_store(&connection).unwrap();
}

#[test]
fn migration_rebuilds_predecessor_markdown_from_verified_document_authority() {
    let profile = nodex_platform::test_support::tempdir().unwrap();
    nodex_platform::private_fs::write(
        profile.path().join("nodex.db"),
        include_bytes!("../../tests/fixtures/store-v191.db"),
    )
    .unwrap();
    let mut connection = open_writer(&profile.path().join("nodex.db")).unwrap();
    prepare_profile_store(&mut connection, profile.path()).unwrap();
    let (id, expected) = connection
        .query_row(
            "SELECT document_id, markdown FROM document_materializations
             WHERE markdown <> '' AND document_id IN (SELECT document_id FROM page_read_model)
             ORDER BY document_id LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    with_schema_rebuild_transaction(&mut connection, |transaction| {
        rewind_v201_to_v200(transaction)?;
        transaction.pragma_update(None, "user_version", 199)?;
        transaction.execute(
            "DELETE FROM core_store_migration_history WHERE source_revision>=199",
            [],
        )?;
        transaction.execute(
            "UPDATE document_materializations SET materialization_derivation_version=4",
            [],
        )?;
        transaction.execute(
            "UPDATE document_materializations SET markdown='Old serializer projection'
             WHERE document_id=?1",
            [&id],
        )?;
        transaction.execute(
            "UPDATE page_read_model SET description_length=length('Old serializer projection')
             WHERE document_id=?1",
            [&id],
        )?;
        Ok(())
    })
    .unwrap();

    let result = prepare_profile_store(&mut connection, profile.path()).unwrap();
    assert_eq!(result.migrated_from_version, Some(199));
    let actual = DocumentReadRepository::new(&connection)
        .materialization(&id)
        .unwrap()
        .unwrap();
    assert_eq!(actual.markdown, expected);
    validate_restore_documents(&connection).unwrap();
}
