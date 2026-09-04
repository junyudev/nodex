use super::*;
use crate::infrastructure::sqlite::with_immediate_transaction;
use crate::infrastructure::store::SqliteStoreKernel;
use crate::library::LibraryModule;
use nodex_core_contracts::library::{LibraryDocumentHead, LibraryIntent, LibraryWriteParent};
use nodex_core_contracts::{
    AdapterKind, LIBRARY_CONTRACT_VERSION, LibraryId, ModuleApplyRequest, ProfileId, ProjectId,
    StoreEpoch,
};

const HOST: &str = "018f0000-0000-7000-8000-000000000781";
const CHILD: &str = "018f0000-0000-7000-8000-000000000782";

#[derive(Debug)]
struct StorageBytes {
    active_inverse: i64,
    retained_receipt: i64,
    terminal_payload: i64,
    minimal_evidence: i64,
    page_history_body: i64,
}

fn storage_bytes(connection: &Connection) -> Result<StorageBytes, StoreError> {
    let sum = |sql| connection.query_row(sql, [], |row| row.get::<_, i64>(0));
    Ok(StorageBytes {
        active_inverse: sum(
            "SELECT coalesce(sum(octet_length(payload.payload_chunk)), 0) FROM structural_history_payloads payload JOIN structural_history_recipes recipe USING(recipe_operation_id) WHERE recipe.state = 'available'",
        )?,
        retained_receipt: sum(
            "SELECT coalesce(sum(bytes), 0) FROM (SELECT octet_length(result_json) AS bytes FROM core_module_receipts UNION ALL SELECT octet_length(result_json) FROM detached_module_receipts)",
        )?,
        terminal_payload: sum(
            "SELECT coalesce(sum(octet_length(payload.payload_chunk)), 0) FROM structural_history_payloads payload JOIN structural_history_recipes recipe USING(recipe_operation_id) WHERE recipe.state <> 'available'",
        )?,
        // Encoded semantic evidence bytes, not SQLite page allocation. Capability
        // markers and ledger action descriptors survive detachable body cleanup.
        minimal_evidence: sum(
            "SELECT coalesce(sum(bytes), 0) FROM (
              SELECT octet_length(json_array(recipe_operation_id, library_id, project_id, store_epoch, recipe_hash, payload_ref_json, state, created_at, consumed_at)) AS bytes FROM structural_history_recipes
              UNION ALL SELECT octet_length(json_array(mutation_id, project_id, store_epoch, mutation_kind, actor_json, request_hash, request_json, field_intents_json, outcome, result_json, change_log_seq, recorded_at)) FROM block_mutations)",
        )?,
        page_history_body: sum(
            "SELECT coalesce(sum(octet_length(full_update_blob)), 0) FROM document_versions",
        )?,
    })
}

fn request(id: &str, intent: LibraryIntent) -> ModuleApplyRequest<LibraryIntent> {
    ModuleApplyRequest {
        contract_version: LIBRARY_CONTRACT_VERSION,
        operation_id: id.to_owned(),
        store_epoch: StoreEpoch("epoch-1".to_owned()),
        intent,
    }
}

#[test]
fn history_payload_storage_lifetime_preserves_replay_and_page_history() {
    let home = tempfile::tempdir().expect("disposable Profile");
    let kernel = SqliteStoreKernel::open_test(home.path()).expect("Store");
    kernel.writer().call(|connection| {
        with_immediate_transaction(connection, |transaction| {
            transaction.execute_batch("INSERT INTO profiles VALUES ('profile-1', '2026-01-01', '2026-01-01');
                INSERT INTO libraries VALUES ('library-1', 'profile-1', '2026-01-01', '2026-01-01');
                INSERT INTO projects(id, library_id, name, created, updated) VALUES ('project-1', 'library-1', 'Storage lifetime', '2026-01-01', '2026-01-01');
                INSERT INTO block_store_metadata VALUES (1, 'epoch-1', '2026-01-01', '2026-01-01');")?;
            Ok(())
        })
    }).expect("Profile identities");
    let context = BoundModuleContext {
        editor_history_owner: None,
        profile_id: ProfileId("profile-1".to_owned()),
        library_id: LibraryId("library-1".to_owned()),
        project_id: Some(ProjectId("project-1".to_owned())),
        connection_id: "storage-lifetime".to_owned(),
        adapter: AdapterKind::Test,
    };
    let module = LibraryModule::new("profile-1", "library-1", &kernel);
    module
        .apply(
            &context,
            request(
                "storage:create-host",
                LibraryIntent::CreatePage {
                    page_id: HOST.to_owned(),
                    document_id: "document:storage-host".to_owned(),
                    title: "Host".to_owned(),
                    parent: LibraryWriteParent::Library { before: None },
                },
            ),
        )
        .expect("create host Page");
    module
        .apply(
            &context,
            request(
                "storage:create-child",
                LibraryIntent::CreatePage {
                    page_id: CHILD.to_owned(),
                    document_id: "document:storage-child".to_owned(),
                    title: "Retained title".to_owned(),
                    parent: LibraryWriteParent::Page {
                        page_id: HOST.to_owned(),
                        expected_document_generation: 1,
                        expected_document_head_seq: 1,
                        before: None,
                        insertion: None,
                    },
                },
            ),
        )
        .expect("create child Page");
    let head = kernel
        .readers()
        .read_default(|connection| {
            Ok(connection.query_row(
                "SELECT head_seq FROM documents WHERE id = 'document:storage-host'",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .expect("current host head");
    let forward = request(
        "storage:turn",
        LibraryIntent::ApplyStructuralEdit {
            command: Box::new(LibraryStructuralEditCommand::TurnSelectionInto {
                selection: LibraryStructuralSelection {
                    source_document_id: "document:storage-host".to_owned(),
                    root_block_ids: vec![CHILD.to_owned()],
                    source_head: LibraryDocumentHead {
                        document_id: "document:storage-host".to_owned(),
                        generation: 1,
                        head_seq: head,
                    },
                },
                target: LibraryStructuralTurnIntoTarget::ToggleList,
            }),
        },
    );
    let committed = module
        .apply(&context, forward.clone())
        .expect("turn Page into toggle");
    let mut token = committed
        .committed
        .value
        .structural_edit
        .clone()
        .unwrap()
        .history
        .unwrap();
    for step in 0..4 {
        let inverse = request(
            &format!("storage:inverse-{step}"),
            LibraryIntent::ReverseStructuralEdit { token },
        );
        let result = module
            .apply(&context, inverse.clone())
            .expect("repeated Undo/Redo");
        let mut replay = module
            .apply(&context, inverse)
            .expect("exact inverse replay");
        assert!(replay.committed.receipt.mutation.duplicate);
        replay.committed.receipt.mutation.duplicate = false;
        assert_eq!(
            serde_json::to_value(&result.committed).unwrap(),
            serde_json::to_value(&replay.committed).unwrap()
        );
        token = result
            .committed
            .value
            .structural_edit
            .unwrap()
            .history
            .unwrap();
    }
    let checkpoint_head = kernel
        .readers()
        .read_default(|connection| {
            Ok(connection.query_row(
                "SELECT head_seq FROM documents WHERE id = 'document:storage-host'",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .expect("checkpoint head");
    crate::document::OwnedDocumentModule::new("profile-1", "library-1", &kernel)
        .apply(
            &context,
            ModuleApplyRequest {
                contract_version: nodex_core_contracts::OWNED_DOCUMENT_CONTRACT_VERSION,
                operation_id: "storage:checkpoint".to_owned(),
                store_epoch: StoreEpoch("epoch-1".to_owned()),
                intent: nodex_core_contracts::document::OwnedDocumentIntent::CreateCheckpoint {
                    document_id: "document:storage-host".to_owned(),
                    generation: 1,
                    expected_head_seq: checkpoint_head,
                    cause: "manual".to_owned(),
                    label: Some("Retained Page History".to_owned()),
                    actor: serde_json::json!({ "kind": "test" }),
                    revision_kind: Some(
                        nodex_core_contracts::document::DocumentRevisionKind::Manual,
                    ),
                    source_mutation_id: None,
                    source_change_seq: None,
                },
            },
        )
        .expect("public Page History checkpoint");
    let initial = kernel
        .readers()
        .read_default(storage_bytes)
        .expect("active storage categories");
    assert!(
        initial.active_inverse > 0 && initial.terminal_payload > 0 && initial.retained_receipt > 0
    );
    assert!(initial.page_history_body > 0 && initial.minimal_evidence > 0);
    eprintln!("history storage before maintenance: {initial:?}");

    // Storage-lifetime subject: advance only terminal-payload eligibility. A
    // valid receipt still protects exact replay; the available inverse has no TTL.
    kernel
        .writer()
        .call(|connection| {
            connection.execute(
                "UPDATE structural_history_payload_gc SET terminal_at_ms = 0, check_after_ms = 0",
                [],
            )?;
            Ok(())
        })
        .expect("controlled payload horizon");
    for _ in 0..16 {
        module
            .maintain_editor_history_owners(|_| true)
            .expect("bounded maintenance");
    }
    let protected = kernel.readers().read_default(storage_bytes).unwrap();
    assert_eq!(protected.active_inverse, initial.active_inverse);
    assert_eq!(protected.terminal_payload, initial.terminal_payload);
    let mut replay = module
        .apply(&context, forward)
        .expect("forward exact replay remains valid");
    assert!(replay.committed.receipt.mutation.duplicate);
    replay.committed.receipt.mutation.duplicate = false;
    assert_eq!(
        serde_json::to_value(&committed.committed).unwrap(),
        serde_json::to_value(&replay.committed).unwrap()
    );

    module
        .apply(
            &context,
            request(
                "storage:release",
                LibraryIntent::ApplyStructuralEdit {
                    command: Box::new(LibraryStructuralEditCommand::ReleaseHistory {
                        tokens: vec![token.clone()],
                    }),
                },
            ),
        )
        .expect("release last inverse");
    for _ in 0..16 {
        module
            .maintain_editor_history_owners(|_| true)
            .expect("release terminal roots");
    }
    let released = kernel.readers().read_default(storage_bytes).unwrap();
    assert_eq!(released.active_inverse, 0);
    assert!(released.terminal_payload > 0);
    let history_before = kernel
        .readers()
        .read_default(|connection| {
            crate::library::history::page_history(
                connection,
                "library-1",
                Some("project-1"),
                HOST,
                None,
                Some(100),
            )
        })
        .expect("Page History before collection");
    // No receipt is deleted directly: expire retention metadata, then let the
    // Operational Journal retire receipts and history maintenance reclaim chunks.
    kernel
        .writer()
        .call(|connection| {
            connection.execute(
                "UPDATE module_receipt_retention_metadata SET expires_at_ms = issued_at_ms",
                [],
            )?;
            connection.execute(
                "UPDATE structural_history_payload_gc SET terminal_at_ms = 0, check_after_ms = 0",
                [],
            )?;
            Ok(())
        })
        .expect("controlled receipt expiry");
    for _ in 0..32 {
        kernel
            .writer()
            .call(|connection| {
                crate::infrastructure::operational_journal::run_bounded_pass(connection)?;
                Ok(())
            })
            .expect("bounded receipt collection");
        module
            .maintain_editor_history_owners(|_| true)
            .expect("bounded payload collection");
    }
    let collected = kernel.readers().read_default(storage_bytes).unwrap();
    eprintln!("history storage released, awaiting expiry: {released:?}");
    eprintln!("history storage after expiry and GC: {collected:?}");
    assert_eq!(collected.active_inverse, 0);
    assert_eq!(collected.terminal_payload, 0);
    assert_eq!(collected.retained_receipt, 0);
    assert_eq!(collected.minimal_evidence, released.minimal_evidence);
    assert_eq!(collected.page_history_body, released.page_history_body);
    let history_after = kernel
        .readers()
        .read_default(|connection| {
            crate::library::history::page_history(
                connection,
                "library-1",
                Some("project-1"),
                HOST,
                None,
                Some(100),
            )
        })
        .expect("Page History after collection");
    assert_eq!(
        serde_json::to_value(history_before).unwrap(),
        serde_json::to_value(history_after).unwrap()
    );
    let issued_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        + 1;
    let stale = module
        .apply(
            &context,
            request(
                &format!("cli-{issued_at_ms}-late-inverse"),
                LibraryIntent::ReverseStructuralEdit { token },
            ),
        )
        .expect_err("released capability stays terminal after payload collection");
    assert_eq!(
        stale.code,
        nodex_core_contracts::CoreErrorCode::RevisionConflict
    );
}
