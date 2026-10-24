use super::*;
use crate::document::{prepare_page_yjs_genesis_with_content, sha256};
use crate::infrastructure::document_repository::DocumentReadRepository;
use crate::infrastructure::sqlite::open_writer;

const NOW: &str = "2026-10-01T00:00:00.000Z";
const LEGACY_NFM: &str = "- literal list\n# literal heading\n1. literal number\n  indented text\n<callout icon=\"💡\">\n\t+ literal callout\n</callout>";
const CURRENT_NFM: &str = "\\- literal list\n\\# literal heading\n1\\. literal number\n\\  indented text\n<callout icon=\"💡\">\n\t\\+ literal callout\n</callout>";

/// An explicit historical storage fixture: canonical Yrs bytes plus the exact
/// predecessor projection. No private Profile or current parser output is used
/// as the expected legacy text.
fn add_predecessor_document(connection: &Connection, document_id: &str, nfm: &str) {
    let library_id: String = connection
        .query_row("SELECT id FROM libraries LIMIT 1", [], |row| row.get(0))
        .unwrap();
    crate::infrastructure::legacy_visibility_migration::install_test_maintenance_context(
        connection,
    )
    .unwrap();
    let mut ordinal = 0;
    let genesis = prepare_page_yjs_genesis_with_content(document_id, &[], CURRENT_NFM, &mut || {
        ordinal += 1;
        format!("{document_id}:block:{ordinal}")
    })
    .unwrap();
    assert_eq!(genesis.materialization.nfm, CURRENT_NFM);
    connection.execute(
        "INSERT INTO documents(id,library_id,generation,head_seq,schema_key,schema_version,state_vector,state_hash,readiness,authority,created_at,updated_at,sync_engine)
         VALUES (?1,?2,1,0,'nodex.page',3,?3,'','ready','ydoc_primary',?4,?4,'yjs')",
        params![document_id,library_id,genesis.state_vector_v1,NOW],
    ).unwrap();
    connection.execute(
        "INSERT INTO document_snapshots(document_id,generation,snapshot_seq,state_vector,snapshot_update,snapshot_hash,schema_version,created_at) VALUES (?1,1,0,?2,?3,?4,3,?5)",
        params![document_id,genesis.state_vector_v1,genesis.update_v1,sha256(&genesis.update_v1),NOW],
    ).unwrap();
    for unit in &genesis.materialization.search_units {
        connection.execute(
            "INSERT INTO blocks(id,library_id,type,lifecycle,placement_revision,metadata_revision,created_at,updated_at) VALUES (?1,?2,?3,'active',1,1,?4,?4)",
            params![unit.block_id,library_id,unit.block_type,NOW],
        ).unwrap();
    }
    let materialization = &genesis.materialization;
    let title = serde_json::to_string(&materialization.rich_title).unwrap();
    connection.execute(
        "INSERT INTO document_materializations(document_id,generation,projected_seq,schema_version,title,title_rich_json,title_rich_hash,nfm,plain_text,preview,block_tree_json,updated_at,materialization_derivation_version)
         VALUES (?1,1,0,3,?2,?3,?4,?5,?6,?7,?8,?9,2)",
        params![document_id,materialization.title,title,sha256(title.as_bytes()),nfm,
            materialization.plain_text,materialization.preview,serde_json::to_string(&materialization.block_tree).unwrap(),NOW],
    ).unwrap();
}

fn source_profile(revision: i64) -> tempfile::TempDir {
    let profile = tempfile::tempdir().unwrap();
    if revision == 188 {
        fs::write(
            profile.path().join("nodex.db"),
            include_bytes!("../../tests/fixtures/store-v188.db"),
        )
        .unwrap();
    } else {
        super::tests::install_intermediate_fixture(profile.path(), revision);
    }
    profile
}

/// Tests that seed historical Stores through today's public writers explicitly
/// freeze the old projection contract after authoring their canonical content.
pub(super) fn rewrite_as_predecessor(connection: &Connection, revision: i64) {
    let repository = DocumentReadRepository::new(connection);
    for head in repository.live_yjs_heads().unwrap() {
        let row = repository.materialization(&head.id).unwrap().unwrap();
        let blocks: Vec<crate::domain::block_materialization::MaterializedBlockNode> =
            serde_json::from_value(row.block_tree).unwrap();
        let nfm = if revision < 187 {
            crate::domain::nfm::materialize_nfm_before_paragraph_protection(&blocks)
                .unwrap()
                .nfm
        } else {
            row.nfm
        };
        connection.execute("UPDATE document_materializations SET materialization_derivation_version=2,nfm=?1 WHERE document_id=?2",params![nfm,head.id]).unwrap();
    }
}

type UnchangedDocumentState = Vec<(String, Vec<Vec<rusqlite::types::Value>>)>;

fn unchanged_document_state(connection: &Connection) -> UnchangedDocumentState {
    [
        "document_block_index",
        "block_search_units",
        "block_asset_refs",
        "document_page_references",
        "document_updates",
        "document_snapshots",
        "document_versions",
    ]
    .into_iter()
    .map(|table| {
        let mut statement = connection
            .prepare(&format!("SELECT * FROM {table}"))
            .unwrap();
        let columns = statement.column_count();
        let mut rows = statement
            .query_map([], |row| {
                (0..columns)
                    .map(|column| row.get(column))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows.sort_by_key(|row| format!("{row:?}"));
        (table.into(), rows)
    })
    .collect()
}

fn canonical_document(connection: &Connection, id: &str) -> (Vec<u8>, Vec<u8>, i64, i64, String) {
    connection.query_row(
        "SELECT document.state_vector,snapshot.snapshot_update,document.generation,document.head_seq,document.updated_at FROM documents document JOIN document_snapshots snapshot ON snapshot.document_id=document.id WHERE document.id=?1",
        [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
    ).unwrap()
}

#[test]
fn source_derivation_validates_clone_and_upgrades_once_without_changing_yrs() {
    for revision in [174, 183, 187, 188] {
        let profile = source_profile(revision);
        let mut connection = open_writer(&profile.path().join("nodex.db")).unwrap();
        add_predecessor_document(&connection, "document:legacy", LEGACY_NFM);
        if revision == 188 {
            connection.execute("UPDATE document_materializations SET nfm=?1 WHERE document_id IN (SELECT document_id FROM block_documents)", [LEGACY_NFM]).unwrap();
            connection
                .execute(
                    "UPDATE page_read_model SET description_length=?1,updated_at='2026-11-01T00:00:00.000Z'",
                    [LEGACY_NFM.len() as i64],
                )
                .unwrap();
        }
        if revision >= 187 {
            add_predecessor_document(&connection, "document:protected", CURRENT_NFM);
        }
        let canonical = canonical_document(&connection, "document:legacy");
        let source_nfm: String = connection
            .query_row(
                "SELECT nfm FROM document_materializations WHERE document_id='document:legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            validate_profile_clone_source(&connection).unwrap(),
            revision
        );
        assert_eq!(
            canonical_document(&connection, "document:legacy"),
            canonical
        );
        assert_eq!(source_nfm, LEGACY_NFM);
        let unaffected = unchanged_document_state(&connection);
        let preparation = prepare_profile_store(&mut connection, profile.path()).unwrap();
        assert_eq!(preparation.migrated_from_version, Some(revision));
        assert_eq!(
            canonical_document(&connection, "document:legacy"),
            canonical
        );
        let materialization = DocumentReadRepository::new(&connection)
            .materialization("document:legacy")
            .unwrap()
            .unwrap();
        assert_eq!(materialization.nfm, CURRENT_NFM);
        assert_eq!(materialization.updated_at, NOW);
        validate_restore_documents(&connection).unwrap();
        if revision == 188 {
            assert_eq!(unchanged_document_state(&connection), unaffected);
            let (nfm, length, updated_at): (String,i64,String) = connection.query_row(
                "SELECT materialization.nfm,page.description_length,page.updated_at FROM page_read_model page JOIN document_materializations materialization ON materialization.document_id=page.document_id", [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
            assert_eq!(updated_at, "2026-11-01T00:00:00.000Z");
            assert_eq!(nfm, CURRENT_NFM);
            assert_eq!(length, CURRENT_NFM.len() as i64);
        }
        assert_eq!(
            validate_profile_clone_source(&connection).unwrap(),
            CURRENT_STORE_REVISION
        );
        let backup_count = fs::read_dir(profile.path().join("backups/core-migrations"))
            .unwrap()
            .count();
        assert_eq!(backup_count, 1);
        let history: i64 = connection
            .query_row(
                "SELECT count(*) FROM core_store_migration_history",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        let mut reopened = open_writer(&profile.path().join("nodex.db")).unwrap();
        assert_eq!(
            prepare_profile_store(&mut reopened, profile.path())
                .unwrap()
                .migrated_from_version,
            None
        );
        assert_eq!(canonical_document(&reopened, "document:legacy"), canonical);
        assert_eq!(
            reopened
                .query_row(
                    "SELECT count(*) FROM core_store_migration_history",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            history
        );
        assert_eq!(
            fs::read_dir(profile.path().join("backups/core-migrations"))
                .unwrap()
                .count(),
            backup_count
        );
    }
}

#[test]
fn predecessor_derivation_rejects_corruption_before_clone_backup_or_upgrade() {
    for (revision, corruption) in [
        (
            174,
            "UPDATE document_materializations SET nfm='unrelated content' WHERE document_id='document:legacy'",
        ),
        (
            183,
            "UPDATE document_materializations SET plain_text='unrelated content' WHERE document_id='document:legacy'",
        ),
        (
            188,
            "UPDATE document_materializations SET materialization_derivation_version=99 WHERE document_id='document:legacy'",
        ),
        (
            188,
            "UPDATE document_snapshots SET snapshot_hash=printf('%064d',0) WHERE document_id='document:legacy'",
        ),
    ] {
        let profile = source_profile(revision);
        let mut connection = open_writer(&profile.path().join("nodex.db")).unwrap();
        add_predecessor_document(&connection, "document:legacy", LEGACY_NFM);
        connection.execute_batch(corruption).unwrap();
        assert_eq!(
            validate_profile_clone_source(&connection).unwrap_err().code,
            StoreErrorCode::StoreCorrupt
        );
        assert_eq!(
            prepare_profile_store(&mut connection, profile.path())
                .unwrap_err()
                .code,
            StoreErrorCode::StoreCorrupt
        );
        assert!(!profile.path().join("backups/core-migrations").exists());
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            revision
        );
    }
}

#[test]
fn source_contract_does_not_accept_new_encoding_before_it_was_published() {
    let profile = source_profile(183);
    let connection = open_writer(&profile.path().join("nodex.db")).unwrap();
    add_predecessor_document(&connection, "document:legacy", CURRENT_NFM);
    let error = validate_profile_clone_source(&connection).unwrap_err();
    assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
    assert!(error.message.contains("fields: nfm"));
}

#[test]
fn derivation_rebuild_rolls_back_every_projection_and_retries_from_verified_backup() {
    let profile = source_profile(188);
    let mut connection = open_writer(&profile.path().join("nodex.db")).unwrap();
    add_predecessor_document(&connection, "document:legacy", LEGACY_NFM);
    let canonical = canonical_document(&connection, "document:legacy");
    let mut steps = resolve_migration_path(188, CURRENT_STORE_REVISION, MIGRATION_STEPS).unwrap();
    steps.last_mut().unwrap().apply = |connection, context| {
        migrate_v188_to_v189(connection, context)?;
        Err(corrupt(
            "injected failure after complete derivation rebuild",
        ))
    };
    assert_eq!(
        migrate_store(&mut connection, profile.path(), &mut |_| {}, 188, &steps)
            .unwrap_err()
            .code,
        StoreErrorCode::StoreCorrupt
    );
    assert_eq!(validate_profile_clone_source(&connection).unwrap(), 188);
    assert_eq!(
        canonical_document(&connection, "document:legacy"),
        canonical
    );
    assert_eq!(
        DocumentReadRepository::new(&connection)
            .materialization("document:legacy")
            .unwrap()
            .unwrap()
            .nfm,
        LEGACY_NFM
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM document_block_index WHERE document_id='document:legacy'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM core_store_migration_history WHERE target_revision=189",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let backup = fs::read_dir(profile.path().join("backups/core-migrations"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    validate_migration_backup(&backup, 188).unwrap();
    prepare_profile_store(&mut connection, profile.path()).unwrap();
    validate_restore_documents(&connection).unwrap();
    assert_eq!(
        canonical_document(&connection, "document:legacy"),
        canonical
    );
}
