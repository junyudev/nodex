use std::collections::BTreeMap;

use super::*;
use crate::document::{BlockDocumentSchema, materialize_decoded_document};
use crate::infrastructure::document_repository::DocumentReadRepository;
use crate::infrastructure::sqlite::open_writer;

const NOW: &str = "2026-10-31T08:30:00.000Z";
const STALE: &str = r"Hello\, a (b) c\. (add it\, they) agree\!";

fn predecessor() -> (tempfile::TempDir, Connection) {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("nodex.db");
    fs::write(&path, include_bytes!("../../tests/fixtures/store-v199.db")).unwrap();
    let connection = open_writer(&path).unwrap();
    (home, connection)
}

/// Storage-shape fixture: create retained heads with canonical Yrs authority and
/// stale text only. Their Block identity is already indexed by an owned Document.
fn plant_retained_heads(connection: &Connection) {
    let library: String = connection
        .query_row("SELECT id FROM libraries LIMIT 1", [], |r| r.get(0))
        .unwrap();
    let indexed_id: String = connection
        .query_row(
            "SELECT block_id FROM document_block_index LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let page = crate::document::prepare_page_yjs_genesis_with_content(
        "document:serializer:seed",
        &[],
        STALE,
        &mut || indexed_id.clone(),
    )
    .unwrap();
    assert_ne!(
        page.materialization.markdown, STALE,
        "fixture must require a serializer rebuild with either writer"
    );
    for schema in [
        BlockDocumentSchema::PageV4,
        BlockDocumentSchema::SyncedBlockV3,
        BlockDocumentSchema::ReusableTemplateV3,
    ] {
        let metadata = crate::document::schema_metadata(schema);
        let owner = metadata.owner_type.as_str();
        let id = format!("document:serializer:{owner}");
        let genesis = crate::document::prepare_yjs_clone_genesis(
            &id,
            owner,
            schema,
            None,
            &page.materialization.block_tree,
        )
        .unwrap();
        let value = &genesis.materialization;
        connection.execute(
            "INSERT INTO documents(id,library_id,generation,head_seq,schema_key,schema_version,state_vector,state_hash,readiness,authority,created_at,updated_at,sync_engine) VALUES (?1,?2,1,0,?3,?4,?5,'','ready','ydoc_primary',?6,?6,'yjs')",
            params![id,library,schema.schema_key(),schema.schema_version(),genesis.state_vector_v1,NOW],
        ).unwrap();
        connection.execute(
            "INSERT INTO document_snapshots(document_id,generation,snapshot_seq,state_vector,snapshot_update,snapshot_hash,schema_version,created_at) VALUES (?1,1,0,?2,?3,?4,?5,?6)",
            params![id,genesis.state_vector_v1,genesis.update_v1,crate::document::sha256(&genesis.update_v1),schema.schema_version(),NOW],
        ).unwrap();
        let title = serde_json::to_string(&value.rich_title).unwrap();
        connection.execute(
            "INSERT INTO document_materializations(document_id,generation,projected_seq,schema_version,title,title_rich_json,title_rich_hash,markdown,plain_text,preview,block_tree_json,references_json,asset_refs_json,updated_at,materialization_derivation_version) VALUES (?1,1,0,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,4)",
            params![id,schema.schema_version(),value.title,title,crate::document::sha256(title.as_bytes()),STALE,value.plain_text,value.preview,serde_json::to_string(&value.block_tree).unwrap(),serde_json::to_string(&value.references).unwrap(),serde_json::to_string(&value.asset_refs).unwrap(),NOW],
        ).unwrap();
    }
}

fn plant_inbox_snapshot(connection: &Connection) -> (String, String, String) {
    use crate::workspace::inbox_content::MessageContent;
    let (page, library): (String, String) = connection
        .query_row(
            "SELECT block_id,library_id FROM pages ORDER BY block_id LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    connection.execute("INSERT INTO inbox_entries(page_id,library_id,seq,submitted_at,source_kind,updated_at) VALUES (?1,?2,1,?3,'user',?3)",params![page,library,NOW]).unwrap();
    let content = MessageContent {
        markdown: format!("{STALE}\n\n![<div>](nodex://files/frozen)"),
        images: vec![
            nodex_core_contracts::inbox::ProjectWorkspaceInboxMessageImage {
                source: "nodex://files/frozen".into(),
                file_id: "frozen".into(),
                content_hash: "a".repeat(64),
            },
        ],
    };
    let mut frozen =
        crate::workspace::frozen_input_for_content(connection, &library, &page, content, 0)
            .unwrap();
    // The old Agent body is an equivalent exact spelling, independent of the live Page.
    let expected_body = frozen.input.body.clone();
    frozen.input.body = frozen.input.body.replacen("Hello,", r"Hello\,", 1);
    let basis = serde_json::to_string(&vec![frozen.input.basis.clone()]).unwrap();
    let inputs = serde_json::to_string(&vec![frozen]).unwrap();
    connection.execute("INSERT INTO inbox_suggestion_requests(request_id,library_id,mode,state,basis_json,created_at,updated_at,inputs_json) VALUES ('request:serializer',?1,'auto','pending',?2,?3,?3,?4)",params![library,basis,NOW,inputs]).unwrap();
    connection.execute("INSERT INTO inbox_suggestion_request_pages(request_id,page_id,position) VALUES ('request:serializer',?1,0)",[&page]).unwrap();
    for (proposal, value) in [
        ("proposal:serializer", basis.clone()),
        (
            "proposal:stale",
            json!([{"page_id":page,"content_hash":"0".repeat(64)}]).to_string(),
        ),
    ] {
        connection.execute("INSERT INTO inbox_proposals(proposal_id,library_id,origin,state,action_json,summary,basis_json,created_at,updated_at) VALUES (?1,?2,'user','open','{\"type\":\"keep\"}','Keep',?3,?4,?4)",params![proposal,library,value,NOW]).unwrap();
    }
    connection.execute("INSERT INTO inbox_handoffs(proposal_id,store_epoch,final_text,launch_id,message_id) SELECT 'proposal:serializer',store_epoch,?1,'launch:serializer','message:serializer' FROM block_store_metadata WHERE id=1",[format!("Authored dispatch\n> {STALE}")]).unwrap();
    (page, basis, expected_body)
}

fn rows(connection: &Connection, query: &str) -> Vec<Vec<rusqlite::types::Value>> {
    let mut statement = connection.prepare(query).unwrap();
    let columns = statement.column_count();
    statement
        .query_map([], |row| (0..columns).map(|i| row.get(i)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// Compare all durable tables, including FTS backing tables, execution receipts,
/// immutable history, File bindings, recovery packages, indexes and timestamps.
/// Later upgrades in the same run rebuild Session ordering (v201); its own migration tests cover it.
const REBUILT_AFTER_SERIALIZER: &str =
    "'project_sessions','workspace_sidebar_lanes','workspace_sidebar_positions'";

/// Tables, and planner statistics for them, that the serializer upgrade must leave intact.
fn unaffected(connection: &Connection) -> BTreeMap<String, Vec<Vec<rusqlite::types::Value>>> {
    let tables = connection.prepare(&format!("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('document_materializations','core_store_migration_history','inbox_suggestion_requests','inbox_proposals','core_automation_firings',{REBUILT_AFTER_SERIALIZER}) ORDER BY name")).unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    tables
        .into_iter()
        .map(|name| {
            let count = connection
                .prepare(&format!("SELECT * FROM \"{name}\""))
                .unwrap()
                .column_count();
            let order = (1..=count)
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let only_stable = if name.starts_with("sqlite_stat") {
                format!(" WHERE tbl NOT IN ({REBUILT_AFTER_SERIALIZER})")
            } else {
                String::new()
            };
            let values = rows(
                connection,
                &format!("SELECT * FROM \"{name}\"{only_stable} ORDER BY {order}"),
            );
            (name, values)
        })
        .collect()
}

#[test]
fn serializer_upgrade_rebuilds_exact_text_without_content_or_identity_changes() {
    let (home, mut connection) = predecessor();
    plant_retained_heads(&connection);
    let (page, old_basis, expected_body) = plant_inbox_snapshot(&connection);
    assert_eq!(validate_profile_clone_source(&connection).unwrap(), 199);
    let before = unaffected(&connection);
    assert!(!before["document_block_index"].is_empty());
    assert!(!before["block_search_units"].is_empty());
    assert!(!before["document_versions"].is_empty());
    let fields = "SELECT document_id,generation,projected_seq,schema_version,title,title_rich_json,title_rich_hash,plain_text,preview,block_tree_json,references_json,asset_refs_json,updated_at FROM document_materializations ORDER BY document_id";
    let materializations = rows(&connection, fields);
    let request_fields = rows(
        &connection,
        "SELECT request_id,state,created_at,updated_at,generation FROM inbox_suggestion_requests",
    );
    let proposal_fields = rows(
        &connection,
        "SELECT proposal_id,revision,state,created_at,updated_at FROM inbox_proposals ORDER BY proposal_id",
    );
    let expected = DocumentReadRepository::new(&connection)
        .live_yjs_heads()
        .unwrap()
        .into_iter()
        .map(|head| {
            let repository = DocumentReadRepository::new(&connection);
            let snapshot = repository
                .latest_snapshot(&head.id, head.generation, head.head_seq)
                .unwrap()
                .unwrap();
            let mut engine = crate::document::YrsDocumentEngine::from_full_state_v1(
                &head.id,
                &snapshot.snapshot_update,
            )
            .unwrap();
            for update in repository
                .updates_between(
                    &head.id,
                    head.generation,
                    snapshot.snapshot_seq,
                    head.head_seq,
                )
                .unwrap()
            {
                let candidate = engine.prepare_update_v1(&update.update_blob).unwrap();
                engine.commit_candidate(candidate).unwrap();
            }
            let schema =
                BlockDocumentSchema::from_identity(&head.schema_key, head.schema_version).unwrap();
            let decoded =
                crate::document::decode_block_document(engine.document(), schema).unwrap();
            (
                head.id,
                materialize_decoded_document(&decoded).unwrap().markdown,
            )
        })
        .collect::<BTreeMap<_, _>>();
    let epoch = crate::document::read_store_epoch(&connection).unwrap();
    let stale_etag = crate::document::mint_document_projection_etags(
        &connection,
        None,
        &epoch,
        "document:serializer:page",
        json!([]),
        STALE,
    )
    .unwrap()
    .1;
    let prepared = prepare_profile_store(&mut connection, home.path()).unwrap();
    assert_eq!(prepared.migrated_from_version, Some(199));
    assert_eq!(prepared.schema_version, CURRENT_STORE_REVISION);
    assert_eq!(unaffected(&connection), before);
    assert_eq!(rows(&connection, fields), materializations);
    assert_eq!(
        rows(
            &connection,
            "SELECT request_id,state,created_at,updated_at,generation FROM inbox_suggestion_requests"
        ),
        request_fields
    );
    assert_eq!(
        rows(
            &connection,
            "SELECT proposal_id,revision,state,created_at,updated_at FROM inbox_proposals ORDER BY proposal_id"
        ),
        proposal_fields
    );
    for head in DocumentReadRepository::new(&connection)
        .live_yjs_heads()
        .unwrap()
    {
        let row = DocumentReadRepository::new(&connection)
            .materialization(&head.id)
            .unwrap()
            .unwrap();
        assert_eq!(row.markdown, expected[&head.id]);
    }
    let row = DocumentReadRepository::new(&connection)
        .materialization("document:serializer:page")
        .unwrap()
        .unwrap();
    let actual_etag = crate::document::mint_document_projection_etags(
        &connection,
        None,
        &epoch,
        &row.document_id,
        row.rich_title.clone(),
        &row.markdown,
    )
    .unwrap()
    .1;
    let expected_etag = crate::document::mint_document_projection_etags(
        &connection,
        None,
        &epoch,
        &row.document_id,
        row.rich_title,
        &expected[&row.document_id],
    )
    .unwrap()
    .1;
    assert_eq!(actual_etag, expected_etag);
    assert_ne!(actual_etag, stale_etag);
    let saved: String = connection.query_row("SELECT inputs_json FROM inbox_suggestion_requests WHERE request_id='request:serializer'",[],|r|r.get(0)).unwrap();
    let frozen: Vec<crate::workspace::FrozenSuggestionInput> =
        serde_json::from_str(&saved).unwrap();
    let canonical = nodex_markdown::write(
        &nodex_markdown::read(
            &format!("{STALE}\n\n![<div>](nodex://files/frozen)"),
            nodex_markdown::ReadOptions::EXACT,
        )
        .unwrap(),
    );
    assert_eq!(frozen[0].content.markdown, canonical);
    assert_eq!(frozen[0].input.body, expected_body);
    assert_eq!(frozen[0].content.images[0].content_hash, "a".repeat(64));
    assert_eq!(
        frozen[0].input.basis.content_hash,
        frozen[0].content.fingerprint()
    );
    let new_basis = serde_json::to_value(vec![frozen[0].input.basis.clone()]).unwrap();
    assert_ne!(
        serde_json::from_str::<Value>(&old_basis).unwrap(),
        new_basis
    );
    for query in [
        "SELECT basis_json FROM inbox_suggestion_requests WHERE request_id='request:serializer'",
        "SELECT basis_json FROM inbox_proposals WHERE proposal_id='proposal:serializer'",
    ] {
        assert_eq!(
            serde_json::from_str::<Value>(
                &connection
                    .query_row(query, [], |r| r.get::<_, String>(0))
                    .unwrap()
            )
            .unwrap(),
            new_basis
        );
    }
    assert_eq!(
        connection
            .query_row(
                "SELECT basis_json FROM inbox_proposals WHERE proposal_id='proposal:stale'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        json!([{"page_id":page,"content_hash":"0".repeat(64)}]).to_string()
    );
    crate::document::integrity::validate_restore_documents(&connection).unwrap();
    let backups = fs::read_dir(home.path().join("backups")).unwrap().count();
    let all_current = rows(
        &connection,
        "SELECT * FROM document_materializations ORDER BY document_id",
    );
    drop(connection);
    let mut connection = open_writer(&home.path().join("nodex.db")).unwrap();
    assert_eq!(
        prepare_profile_store(&mut connection, home.path())
            .unwrap()
            .migrated_from_version,
        None
    );
    assert_eq!(
        rows(
            &connection,
            "SELECT * FROM document_materializations ORDER BY document_id"
        ),
        all_current
    );
    assert_eq!(unaffected(&connection), before);
    assert_eq!(
        fs::read_dir(home.path().join("backups")).unwrap().count(),
        backups
    );
    assert_eq!(connection.query_row("SELECT count(*) FROM core_store_migration_history WHERE source_revision=199 AND target_revision=200",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}

#[test]
fn serializer_preflight_rejects_changed_content_and_unaffected_projection_corruption() {
    for mutation in [
        "UPDATE document_materializations SET markdown='Different content' WHERE document_id LIKE 'document:serializer:%'",
        "UPDATE document_materializations SET plain_text='Different content' WHERE document_id LIKE 'document:serializer:%'",
        "UPDATE inbox_suggestion_requests SET inputs_json=json_set(inputs_json,'$[0].content.markdown','Different content')",
        "UPDATE inbox_suggestion_requests SET inputs_json=json_set(inputs_json,'$[0].input.body','Different content')",
    ] {
        let (home, mut connection) = predecessor();
        plant_retained_heads(&connection);
        plant_inbox_snapshot(&connection);
        connection.execute(mutation, []).unwrap();
        assert_eq!(
            validate_profile_clone_source(&connection).unwrap_err().code,
            StoreErrorCode::StoreCorrupt
        );
        assert_eq!(
            prepare_profile_store(&mut connection, home.path())
                .unwrap_err()
                .code,
            StoreErrorCode::StoreCorrupt
        );
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            199
        );
        assert!(!home.path().join("backups").exists());
    }
}

#[test]
fn serializer_failure_rolls_back_inbox_text_document_text_and_revision_together() {
    let (home, mut connection) = predecessor();
    plant_retained_heads(&connection);
    plant_inbox_snapshot(&connection);
    let before = rows(
        &connection,
        "SELECT * FROM document_materializations ORDER BY document_id",
    );
    let inbox = rows(&connection, "SELECT * FROM inbox_suggestion_requests");
    let history = rows(
        &connection,
        "SELECT * FROM core_store_migration_history ORDER BY target_revision",
    );
    connection.execute_batch("CREATE TRIGGER reject_serializer BEFORE UPDATE ON document_materializations BEGIN SELECT RAISE(ABORT,'serializer failure'); END").unwrap();
    let format = published_format(199).unwrap();
    let result = with_schema_rebuild_transaction(&mut connection, |transaction| {
        migrate_v199_to_v200(
            transaction,
            &MigrationContext {
                source_revision: 199,
                target_revision: 200,
                backup_name: "rollback.db".into(),
                source_schema_fingerprint: format.schema_fingerprint,
                target_schema_fingerprint: format.schema_fingerprint,
                completed_at_unix_ms: 1_793_145_600_000,
            },
        )
    });
    assert!(result.is_err());
    assert_eq!(
        rows(
            &connection,
            "SELECT * FROM document_materializations ORDER BY document_id"
        ),
        before
    );
    assert_eq!(
        rows(&connection, "SELECT * FROM inbox_suggestion_requests"),
        inbox
    );
    assert_eq!(
        rows(
            &connection,
            "SELECT * FROM core_store_migration_history ORDER BY target_revision"
        ),
        history
    );
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        199
    );
    connection
        .execute_batch("DROP TRIGGER reject_serializer")
        .unwrap();
    prepare_profile_store(&mut connection, home.path()).unwrap();
}
