use super::*;

fn file_block(block_type: &str, file_id: &str) -> DocumentBlockOperation {
    DocumentBlockOperation::InsertBlock {
        block: MaterializedBlockNode {
            id: CREATED_CONTENT_BLOCK_ID.to_owned(),
            block_type: if block_type == "image" { "image" } else { "paragraph" }.to_owned(),
            props: if block_type == "image" {
                BTreeMap::from([("url".to_owned(), json!(format!("nodex://files/{file_id}")))])
            } else { BTreeMap::new() },
            content: (block_type != "image").then(|| json!([{"type": "attachment", "props": {
                "kind": "file", "mode": "materialized", "source": format!("nodex://files/{file_id}"), "name": "pasted.txt"
            }}])),
            children: Vec::new(),
        },
        parent_block_id: None,
        before_block_id: None,
    }
}

#[test]
fn standalone_page_accepts_imported_files_without_project_grants_or_entries() {
    for block_type in ["image", "attachment"] {
        let seeded = seeded_module();
        let access = library_context_for("standalone-editor", AdapterKind::ElectronHost);
        create_file(&seeded, &access, "file:paste", b"pasted bytes");
        let (head, engine) = synced_page_engine(&seeded);
        let request = apply_request(
            "paste:file",
            head,
            raw_document_operation_update(&engine, &[file_block(block_type, "file:paste")]),
        );
        let committed = seeded
            .module
            .apply(&access, request.clone())
            .expect("paste into standalone Page");
        assert_eq!(committed.committed.value.head_seq, head + 1);
        seeded.module.apply(&access, request).expect("exact retry");
        let (next_head, engine) = synced_page_engine(&seeded);
        assert_eq!(next_head, head + 1);
        assert_eq!(
            materialize_engine(&engine, BlockDocumentSchema::PageV3)
                .unwrap()
                .file_ids(),
            vec!["file:paste"]
        );
        seeded.kernel.readers().read_default(|connection| {
            assert_eq!(connection.query_row("SELECT count(*) FROM page_file_entries WHERE file_id = 'file:paste'", [], |r| r.get::<_, i64>(0))?, 0);
            assert_eq!(connection.query_row("SELECT count(*) FROM project_resource_grants WHERE root_kind = 'file' AND root_id = 'file:paste'", [], |r| r.get::<_, i64>(0))?, 0);
            assert_eq!(connection.query_row("SELECT count(*) FROM block_asset_refs WHERE file_id = 'file:paste'", [], |r| r.get::<_, i64>(0))?, 1);
            Ok::<_, StoreError>(())
        }).unwrap();
    }
}

#[test]
fn project_cannot_insert_a_library_file_without_read_authority() {
    let seeded = seeded_module();
    create_file(
        &seeded,
        &library_context_for("library-import", AdapterKind::ElectronHost),
        "file:private",
        b"private bytes",
    );
    let (head, engine) = synced_page_engine(&seeded);
    let error = seeded
        .module
        .apply(
            &context(),
            apply_request(
                "paste:private",
                head,
                raw_document_operation_update(&engine, &[file_block("image", "file:private")]),
            ),
        )
        .expect_err("File identity and Page write do not authorize File reads");
    assert_eq!(error.code, CoreErrorCode::InvalidInput);
    assert_eq!(synced_page_engine(&seeded).0, head);
}

#[test]
fn project_accepts_a_new_file_with_a_direct_read_grant() {
    let seeded = seeded_module();
    create_file(&seeded, &context(), "file:granted", b"project bytes");
    let (head, engine) = synced_page_engine(&seeded);
    seeded
        .module
        .apply(
            &context(),
            apply_request(
                "paste:granted",
                head,
                raw_document_operation_update(&engine, &[file_block("image", "file:granted")]),
            ),
        )
        .expect("creator Project can insert its imported File");
    assert_eq!(synced_page_engine(&seeded).0, head + 1);
}

#[test]
fn library_file_placement_rejects_missing_trashed_and_retired_files() {
    use nodex_core_contracts::library::{
        LIBRARY_CONTRACT_VERSION, LibraryFileChange, LibraryIntent,
    };
    let seeded = seeded_module();
    let access = library_context_for("standalone-editor", AdapterKind::ElectronHost);
    let library = crate::library::LibraryModule::new(PROFILE_ID, LIBRARY_ID, &seeded.kernel);
    create_file(&seeded, &access, "file:unavailable", b"unavailable bytes");
    let (head, engine) = synced_page_engine(&seeded);
    for (index, file_id) in ["file:missing", "file:unavailable", "file:unavailable"]
        .into_iter()
        .enumerate()
    {
        if index > 0 {
            let change = if index == 1 {
                LibraryFileChange::Trash {
                    file_id: file_id.to_owned(),
                    expected_revision: 1,
                }
            } else {
                LibraryFileChange::Purge {
                    file_id: file_id.to_owned(),
                    expected_revision: 2,
                }
            };
            library
                .apply(
                    &access,
                    ModuleApplyRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        operation_id: format!("file:lifecycle:{index}"),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        intent: LibraryIntent::ApplyFileChange {
                            change,
                            turn_id: None,
                        },
                    },
                )
                .unwrap();
        }
        let error = seeded
            .module
            .apply(
                &access,
                apply_request(
                    &format!("paste:unavailable:{index}"),
                    head,
                    raw_document_operation_update(&engine, &[file_block("image", file_id)]),
                ),
            )
            .expect_err("Library authority cannot revive an unavailable File");
        assert_eq!(error.code, CoreErrorCode::InvalidInput);
        assert_eq!(synced_page_engine(&seeded).0, head);
    }
}

#[test]
fn projectless_untrusted_adapters_cannot_claim_library_file_authority() {
    let seeded = seeded_module();
    let trusted = library_context_for("library-import", AdapterKind::ElectronHost);
    create_file(&seeded, &trusted, "file:private", b"private bytes");
    let (head, engine) = synced_page_engine(&seeded);
    for adapter in [AdapterKind::Agent, AdapterKind::LoopbackHttp] {
        let access = library_context_for("untrusted", adapter);
        let error = seeded
            .module
            .apply(
                &access,
                apply_request(
                    "paste:untrusted",
                    head,
                    raw_document_operation_update(&engine, &[file_block("image", "file:private")]),
                ),
            )
            .expect_err("no Project is not Library authority");
        assert_eq!(error.code, CoreErrorCode::Unauthorized);
        assert_eq!(synced_page_engine(&seeded).0, head);
    }
}

#[test]
fn standalone_structural_replacement_accepts_readable_file_references() {
    use nodex_core_contracts::library::{
        LIBRARY_CONTRACT_VERSION, LibraryDocumentHead, LibraryIntent, LibraryStructuralEditCommand,
        LibraryStructuralReplacement, LibraryStructuralReplacementBlock,
        LibraryStructuralSelection,
    };
    let seeded = seeded_module();
    let access = library_context_for("standalone-editor", AdapterKind::ElectronHost);
    create_file(&seeded, &access, "file:structural", b"structural bytes");
    let (head, engine) = synced_page_engine(&seeded);
    let materialization = materialize_engine(&engine, BlockDocumentSchema::PageV3).unwrap();
    crate::library::LibraryModule::new(PROFILE_ID, LIBRARY_ID, &seeded.kernel)
        .apply(
            &access,
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "paste:structural".to_owned(),
                store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                intent: LibraryIntent::ApplyStructuralEdit {
                    command: Box::new(LibraryStructuralEditCommand::ReplaceSelection {
                        selection: LibraryStructuralSelection {
                            source_document_id: DOCUMENT_ID.to_owned(),
                            root_block_ids: vec![materialization.block_tree[0].id.clone()],
                            source_head: LibraryDocumentHead {
                                document_id: DOCUMENT_ID.to_owned(),
                                generation: 1,
                                head_seq: head,
                            },
                        },
                        replacement: LibraryStructuralReplacement::Blocks {
                            blocks: vec![LibraryStructuralReplacementBlock {
                                block_type: "image".to_owned(),
                                props: BTreeMap::from([(
                                    "url".to_owned(),
                                    json!("nodex://files/file:structural"),
                                )]),
                                content: None,
                                children: Vec::new(),
                            }],
                        },
                    }),
                },
            },
        )
        .expect("Library structural paste uses bound authority");
    let (_, engine) = synced_page_engine(&seeded);
    assert_eq!(
        materialize_engine(&engine, BlockDocumentSchema::PageV3)
            .unwrap()
            .file_ids(),
        vec!["file:structural"]
    );
}
