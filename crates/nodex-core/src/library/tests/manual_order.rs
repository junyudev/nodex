//! Public Library order lifecycle coverage; only physical rebalance is driven
//! directly through storage to exercise the retained-generation seam.

use super::*;
use nodex_core_contracts::library::{
    LibraryFileChange, LibraryPageContent, LibraryPagePromotionPolicy,
    LibraryStructuralEditCommand, LibraryStructuralReplacement, LibraryStructuralReplacementBlock,
    LibraryStructuralSelection,
};

const DATABASE: &str = "018f0000-0000-7000-8000-000000009001";
const SOURCE: &str = "018f0000-0000-7000-8000-000000009002";
const VIEW: &str = "018f0000-0000-7000-8000-000000009003";
const PAGE: &str = "018f0000-0000-7000-8000-000000009004";

fn context() -> BoundModuleContext {
    BoundModuleContext {
        project_id: Some(ProjectId("project-1".into())),
        ..super::context()
    }
}

fn fixture() -> (
    tempfile::TempDir,
    SqliteStoreKernel,
    LibraryModule,
    DatabaseModule,
) {
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    kernel.writer().call(|connection| {
        with_immediate_transaction(connection, |transaction| {
            transaction.execute("INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)", [NOW])?;
            transaction.execute("INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library-1', 'profile-1', ?1, ?1)", [NOW])?;
            transaction.execute("INSERT INTO projects(id, library_id, name, created, updated) VALUES ('project-1', 'library-1', 'Order lifecycle', ?1, ?1)", [NOW])?;
            transaction.execute("INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) VALUES (1, 'epoch-1', ?1, ?1)", [NOW])?;
            Ok(())
        })
    }).unwrap();
    let library = LibraryModule::new("profile-1", "library-1", &kernel);
    let database = DatabaseModule::new("profile-1", "library-1", &kernel);
    apply(
        &library,
        "create-database",
        LibraryIntent::CreateDatabase {
            database_id: DATABASE.into(),
            data_source_id: SOURCE.into(),
            view_id: VIEW.into(),
            name: "Order lifecycle".into(),
            parent: LibraryWriteParent::Library { before: None },
        },
    );
    (directory, kernel, library, database)
}

fn apply(library: &LibraryModule, operation: &str, intent: LibraryIntent) -> LibraryApplyOutcome {
    library
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: operation.into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent,
            },
        )
        .unwrap_or_else(|error| panic!("{operation}: {error:?}"))
}

fn create_page(library: &LibraryModule, page: &str) {
    apply(
        library,
        &format!("create-page-{}", &page[page.len() - 4..]),
        LibraryIntent::CreatePage {
            page_id: page.into(),
            document_id: format!("document:{page}"),
            title: "Order entry".into(),
            parent: LibraryWriteParent::Library { before: None },
        },
    );
}

fn content(library: &LibraryModule, page: &str) -> LibraryPageContent {
    let result = library
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                read: LibraryRead::PageContent {
                    page_id: page.into(),
                },
            },
        )
        .unwrap();
    let LibraryReadValue::PageContent { value } = result.value else {
        panic!("Page content")
    };
    *value
}

fn target() -> LibraryBlockTransferTarget {
    LibraryBlockTransferTarget::DataSource {
        data_source_id: SOURCE.into(),
        placement: Box::new(LibraryBlockTransferDataSourcePlacement::Direct {
            view_id: VIEW.into(),
            preferences_override: Default::default(),
            group_key: None,
            before_page_id: None,
            sorted_property_values: Vec::new(),
        }),
    }
}

// Physical maintenance is deliberately the only direct post-bootstrap mutation.
fn rebalance(kernel: &SqliteStoreKernel, database: &DatabaseModule) {
    let before = generation(kernel);
    kernel
        .writer()
        .call(|connection| {
            assert_eq!(connection.execute(
            "UPDATE database_view_order_state SET pending_generation = generation_clock + 1,
             generation_clock = generation_clock + 1, phase = 'rebalance', cursor_rank = '',
             cursor_page_id = '', next_ordinal = 0, source_revision = order_revision
             WHERE view_id = ?1 AND phase = 'ready'", [VIEW])?, 1);
            Ok(())
        })
        .unwrap();
    for _ in 0..100 {
        if !database.maintain_view_orders().unwrap() {
            break;
        }
    }
    let after = generation(kernel);
    assert!(after.0 > before.0, "physical generation advances");
    assert_eq!(after.1, before.1, "semantic reset epoch is unchanged");
}

fn generation(kernel: &SqliteStoreKernel) -> (i64, i64) {
    kernel.readers().read_default(|connection| Ok(connection.query_row(
        "SELECT active_generation, semantic_reset_epoch FROM database_view_order_state WHERE view_id = ?1",
        [VIEW], |row| Ok((row.get(0)?, row.get(1)?)),
    )?)).unwrap()
}

fn promotion_round_trip(mode: LibraryBlockTransferMode) {
    let (directory, kernel, library, database) = fixture();
    create_page(&library, PAGE);
    let initial = content(&library, PAGE);
    let document = initial.document_id.clone();
    let lookup = document.clone();
    let root = kernel
        .readers()
        .read_default(move |connection| {
            Ok(connection.query_row(
        "SELECT block_id FROM document_block_index WHERE document_id = ?1 ORDER BY ordinal LIMIT 1",
        [lookup], |row| row.get::<_, String>(0),
    )?)
        })
        .unwrap();
    let bytes = b"shared file bytes";
    let hash = crate::document::sha256(bytes);
    std::fs::create_dir_all(directory.path().join("assets")).unwrap();
    std::fs::write(
        directory.path().join("assets").join(format!("{hash}.blob")),
        bytes,
    )
    .unwrap();
    let blob_hash = hash.clone();
    kernel.writer().call(move |connection| {
        connection.execute("INSERT INTO managed_blobs(content_hash, physical_asset_name, byte_length, created_at) VALUES (?1, ?2, ?3, ?4)", params![blob_hash, format!("{blob_hash}.blob"), bytes.len() as i64, NOW])?;
        Ok(())
    }).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    library
        .register_prepared_file_blob(
            &context(),
            "epoch-1",
            "create-file",
            "receipt",
            &hash,
            &format!("{hash}.blob"),
            bytes.len() as u64,
            now + 60_000,
        )
        .unwrap();
    apply(
        &library,
        "create-file",
        LibraryIntent::ApplyFileChange {
            change: LibraryFileChange::Create {
                file_id: "shared-file".into(),
                default_name: "before.png".into(),
                mime_type: "image/png".into(),
                prepared_blob_receipt_id: "receipt".into(),
            },
            turn_id: None,
        },
    );
    let root = apply(
        &library,
        "place-image",
        LibraryIntent::ApplyStructuralEdit {
            command: Box::new(LibraryStructuralEditCommand::ReplaceSelection {
                selection: LibraryStructuralSelection {
                    source_document_id: document.clone(),
                    root_block_ids: vec![root],
                    source_head: LibraryDocumentHead {
                        document_id: document.clone(),
                        generation: initial.document_generation,
                        head_seq: initial.document_head_seq,
                    },
                },
                replacement: LibraryStructuralReplacement::Blocks {
                    blocks: vec![
                        LibraryStructuralReplacementBlock {
                            block_type: "image".into(),
                            props: std::collections::BTreeMap::from([(
                                "url".into(),
                                serde_json::json!("nodex://files/shared-file"),
                            )]),
                            content: None,
                            children: Vec::new(),
                        },
                        LibraryStructuralReplacementBlock {
                            block_type: "paragraph".into(),
                            props: Default::default(),
                            content: Some(serde_json::json!([])),
                            children: Vec::new(),
                        },
                    ],
                },
            }),
        },
    )
    .committed
    .value
    .structural_edit
    .unwrap()
    .result_root_block_ids[0]
        .clone();
    let promoted = apply(
        &library,
        "promote",
        LibraryIntent::TransferBlocks {
            intent: LibraryBlockTransferLogicalIntent {
                actor: serde_json::json!({"kind": "test"}),
                mode,
                root_block_ids: vec![root],
                causal_dependencies: document_heads(&kernel, &[&document]),
                source: LibraryBlockTransferSource::Document {
                    document_id: document,
                },
                target: target(),
                promotion_policy: LibraryPagePromotionPolicy::Literal,
            },
        },
    )
    .committed
    .value
    .block_transfer
    .unwrap();
    let promoted_page = promoted.result_root_block_ids[0].clone();
    let before = content(&library, &promoted_page);
    let undone = apply(
        &library,
        "undo-promotion",
        LibraryIntent::UndoBlockTransfer {
            token: promoted.undo_token.unwrap(),
        },
    )
    .committed
    .value
    .block_transfer_undo
    .unwrap();
    apply(
        &library,
        "rename-shared-file",
        LibraryIntent::ApplyFileChange {
            change: LibraryFileChange::Rename {
                file_id: "shared-file".into(),
                expected_revision: 1,
                default_name: "current.png".into(),
            },
            turn_id: None,
        },
    );
    rebalance(&kernel, &database);
    apply(
        &library,
        "redo-promotion",
        LibraryIntent::ReverseStructuralEdit {
            token: undone
                .history
                .expect("promotion supports symmetric history"),
        },
    );
    let after = content(&library, &promoted_page);
    assert_eq!(after.page_id, before.page_id);
    assert_eq!(after.document_id, before.document_id);
    assert_eq!(after.body_nfm, before.body_nfm);
    assert_eq!(after.title, before.title);
    assert!(after.body_nfm.contains("nodex://files/shared-file"));
    let file = library
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                read: LibraryRead::File {
                    file_id: "shared-file".into(),
                },
            },
        )
        .unwrap();
    let LibraryReadValue::File { value: file } = file.value else {
        panic!("shared File")
    };
    assert_eq!(file.default_name, "current.png");
    assert_eq!(file.revision, 2);
}

#[test]
fn copied_promotion_redo_survives_physical_order_rebalance() {
    promotion_round_trip(LibraryBlockTransferMode::Copy);
}

#[test]
fn moved_promotion_redo_survives_physical_order_rebalance() {
    promotion_round_trip(LibraryBlockTransferMode::Move);
}

fn ordered_pages(database: &DatabaseModule) -> Vec<String> {
    ordered_pages_in(database, VIEW)
}

fn ordered_pages_in(database: &DatabaseModule, view: &str) -> Vec<String> {
    view_rows(database, view)
        .into_iter()
        .map(|row| row.page_id)
        .collect()
}

fn view_rows(
    database: &DatabaseModule,
    view: &str,
) -> Vec<nodex_core_contracts::database::DatabaseRowSummary> {
    let result = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ViewWindow {
                    target: DatabaseViewReadTarget::View {
                        view_id: view.into(),
                    },
                    window: Default::default(),
                    group_scope: None,
                },
            },
        )
        .unwrap();
    let DatabaseReadValue::ViewWindow { value } = result.value else {
        panic!("View window")
    };
    value.rows.items
}

#[test]
fn whole_database_clipboard_copy_preserves_explicit_and_implicit_order() {
    use nodex_core_contracts::database::DatabasePagePosition;
    use nodex_core_contracts::library::LibraryStructuralTarget;
    const HOST: &str = "018f0000-0000-7000-8000-000000009020";
    const TARGET_PAGE: &str = "018f0000-0000-7000-8000-000000009021";
    const NESTED_DB: &str = "018f0000-0000-7000-8000-000000009022";
    const NESTED_SOURCE: &str = "018f0000-0000-7000-8000-000000009023";
    const INITIAL_VIEW: &str = "018f0000-0000-7000-8000-000000009024";
    const MIXED_VIEW: &str = "018f0000-0000-7000-8000-000000009025";
    const ROWS: [&str; 5] = [
        "018f0000-0000-7000-8000-000000009026",
        "018f0000-0000-7000-8000-000000009027",
        "018f0000-0000-7000-8000-000000009028",
        "018f0000-0000-7000-8000-000000009029",
        "018f0000-0000-7000-8000-000000009030",
    ];
    let (_directory, kernel, library, database) = fixture();
    create_page(&library, HOST);
    create_page(&library, TARGET_PAGE);
    let host = content(&library, HOST);
    apply(
        &library,
        "create-embedded-database",
        LibraryIntent::CreateDatabase {
            database_id: NESTED_DB.into(),
            data_source_id: NESTED_SOURCE.into(),
            view_id: INITIAL_VIEW.into(),
            name: "Complete ordered Database".into(),
            parent: LibraryWriteParent::Page {
                page_id: HOST.into(),
                expected_document_generation: host.document_generation,
                expected_document_head_seq: host.document_head_seq,
                before: None,
                insertion: None,
            },
        },
    );
    let populate = |pages: &[&str]| {
        for page in pages {
            create_page(&library, page);
            apply(
                &library,
                &format!("populate-embedded-database-{}", &page[page.len() - 4..]),
                LibraryIntent::TransferBlocks {
                    intent: LibraryBlockTransferLogicalIntent {
                        actor: serde_json::json!({"kind": "test"}),
                        mode: LibraryBlockTransferMode::Move,
                        root_block_ids: vec![(*page).into()],
                        causal_dependencies: Vec::new(),
                        source: LibraryBlockTransferSource::Library {
                            library_id: "library-1".into(),
                        },
                        target: LibraryBlockTransferTarget::DataSource {
                            data_source_id: NESTED_SOURCE.into(),
                            placement: Box::new(LibraryBlockTransferDataSourcePlacement::Direct {
                                view_id: INITIAL_VIEW.into(),
                                preferences_override: Default::default(),
                                group_key: None,
                                before_page_id: None,
                                sorted_property_values: Vec::new(),
                            }),
                        },
                        promotion_policy: LibraryPagePromotionPolicy::Literal,
                    },
                },
            );
        }
    };
    populate(&ROWS[..3]);
    database
        .apply(
            &super::context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "create-implicit-view".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: vec![DatabaseIntent::DuplicateView {
                    database_id: NESTED_DB.into(),
                    source_view_id: INITIAL_VIEW.into(),
                    expected_revision: 1,
                    new_view_id: MIXED_VIEW.into(),
                }],
            },
        )
        .unwrap();
    for _ in 0..100 {
        if !database.maintain_view_orders().unwrap() {
            break;
        }
    }
    let implicit = ordered_pages_in(&database, MIXED_VIEW);
    assert_eq!(implicit.len(), 3);
    database
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "make-one-position-explicit".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: vec![DatabaseIntent::PositionPages {
                    view_id: MIXED_VIEW.into(),
                    pages: vec![DatabasePagePosition {
                        page_id: implicit[2].clone(),
                        expected_position_revision: 0,
                    }],
                    before_page_id: Some(implicit[0].clone()),
                }],
            },
        )
        .unwrap();
    // Positioning freezes the prior default run. Later arrivals stay implicit
    // in this View because the transfer explicitly positions only INITIAL_VIEW.
    populate(&ROWS[3..]);
    let expected = vec![
        implicit[2].clone(),
        implicit[0].clone(),
        implicit[1].clone(),
        ROWS[3].into(),
        ROWS[4].into(),
    ];
    assert_eq!(ordered_pages_in(&database, MIXED_VIEW), expected);
    let rows = view_rows(&database, MIXED_VIEW);
    assert_eq!(
        rows.iter()
            .filter(|row| row.position_revision.is_some())
            .count(),
        3
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row.position_revision.is_none())
            .count(),
        2
    );
    let host = content(&library, HOST);
    let captured = apply(
        &library,
        "capture-complete-database",
        LibraryIntent::ApplyStructuralEdit {
            command: Box::new(LibraryStructuralEditCommand::CaptureClipboard {
                selection: LibraryStructuralSelection {
                    source_document_id: host.document_id.clone(),
                    root_block_ids: vec![NESTED_DB.into()],
                    source_head: LibraryDocumentHead {
                        document_id: host.document_id,
                        generation: host.document_generation,
                        head_seq: host.document_head_seq,
                    },
                },
            }),
        },
    )
    .committed
    .value
    .structural_edit
    .unwrap();
    let target = content(&library, TARGET_PAGE);
    let pasted = apply(
        &library,
        "paste-complete-database",
        LibraryIntent::ApplyStructuralEdit {
            command: Box::new(LibraryStructuralEditCommand::PasteClipboard {
                bundle: captured.clipboard.unwrap(),
                target: LibraryStructuralTarget {
                    target_document_id: target.document_id.clone(),
                    parent_block_id: None,
                    before_block_id: None,
                    target_head: LibraryDocumentHead {
                        document_id: target.document_id,
                        generation: target.document_generation,
                        head_seq: target.document_head_seq,
                    },
                },
            }),
        },
    )
    .committed
    .value
    .structural_edit
    .unwrap();
    let copied_database = pasted.copied_block_ids[NESTED_DB].clone();
    let source_view = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::View {
                    view_id: MIXED_VIEW.into(),
                },
            },
        )
        .unwrap();
    let DatabaseReadValue::View { value: source_view } = source_view.value else {
        panic!("source View")
    };
    let copied_views = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::ViewDescriptorWindow {
                    database_id: copied_database.clone(),
                    window: Default::default(),
                },
            },
        )
        .unwrap();
    let DatabaseReadValue::ViewDescriptorWindow { views } = copied_views.value else {
        panic!("copied Views")
    };
    assert_eq!(views.items.len(), 2);
    let copied_view = &views
        .items
        .iter()
        .find(|view| view.name == source_view.name)
        .unwrap()
        .view_id;
    let copied_order = expected
        .iter()
        .map(|page| pasted.copied_block_ids[page].clone())
        .collect::<Vec<_>>();
    assert_eq!(ordered_pages_in(&database, copied_view), copied_order);
    assert_eq!(ordered_pages_in(&database, MIXED_VIEW), expected);

    let rebalanced_view = copied_view.to_owned();
    let before_generation = kernel.writer().call(move |connection| {
        let before: (i64, i64) = connection.query_row(
            "SELECT active_generation, semantic_reset_epoch FROM database_view_order_state WHERE view_id = ?1",
            [&rebalanced_view], |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(connection.execute(
            "UPDATE database_view_order_state SET pending_generation = generation_clock + 1,
             generation_clock = generation_clock + 1, phase = 'rebalance', cursor_rank = '',
             cursor_page_id = '', next_ordinal = 0, source_revision = order_revision
             WHERE view_id = ?1 AND phase = 'ready'", [&rebalanced_view])?, 1);
        Ok(before)
    }).unwrap();
    for _ in 0..100 {
        if !database.maintain_view_orders().unwrap() {
            break;
        }
    }
    let rebalanced_view = copied_view.to_owned();
    let after_generation = kernel.readers().read_default(move |connection| {
        Ok(connection.query_row(
            "SELECT active_generation, semantic_reset_epoch FROM database_view_order_state WHERE view_id = ?1",
            [&rebalanced_view], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?)
    }).unwrap();
    assert!(after_generation.0 > before_generation.0);
    assert_eq!(after_generation.1, before_generation.1);
    let undone = apply(
        &library,
        "undo-rebalanced-database-paste",
        LibraryIntent::ReverseStructuralEdit {
            token: pasted.history.clone().expect("Database paste inverse"),
        },
    )
    .committed
    .value
    .structural_edit
    .unwrap();
    let missing = library
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                read: LibraryRead::PageContent {
                    page_id: pasted.copied_block_ids[ROWS[0]].clone(),
                },
            },
        )
        .expect_err("Undo retires the copied Database row");
    assert_eq!(missing.code, CoreErrorCode::NotFound);
    apply(
        &library,
        "redo-rebalanced-database-paste",
        LibraryIntent::ReverseStructuralEdit {
            token: undone.history.expect("Database paste Redo"),
        },
    );
    assert_eq!(ordered_pages_in(&database, copied_view), copied_order);
    assert_eq!(ordered_pages_in(&database, MIXED_VIEW), expected);
    for page in ROWS {
        let copied_page = &pasted.copied_block_ids[page];
        assert_ne!(copied_page, page);
        let original = content(&library, page);
        let copied = content(&library, copied_page);
        assert_ne!(copied.document_id, original.document_id);
        assert_eq!(
            copied.document_id,
            pasted.copied_document_ids[&original.document_id]
        );
        assert_eq!(copied.title, original.title);
        assert_eq!(copied.plain_text, original.plain_text);
    }

    let copied_page = pasted.copied_block_ids[ROWS[0]].clone();
    let read_request = ModuleReadRequest {
        contract_version: LIBRARY_CONTRACT_VERSION,
        read: LibraryRead::PageContent {
            page_id: copied_page.clone(),
        },
    };
    let stamp = library
        .read(&context(), read_request.clone())
        .unwrap()
        .authorization
        .expect("copied Page authorization stamp");
    for root in [
        nodex_core_contracts::events::ResourceKey::Page {
            page_id: copied_page.clone(),
        },
        nodex_core_contracts::events::ResourceKey::Database {
            database_id: copied_database,
        },
        nodex_core_contracts::events::ResourceKey::Page {
            page_id: TARGET_PAGE.into(),
        },
    ] {
        assert!(stamp.authorization_dependencies.contains(&root));
    }
    assert!(stamp.authorization_dependencies.iter().any(|root| matches!(
        root,
        nodex_core_contracts::events::ResourceKey::DataSource { .. }
    )));

    // Copied rows have no independent grant: both reads and writes must track
    // the host Page's current grant, including downgrade and revocation.
    apply(
        &library,
        "downgrade-copy-host",
        LibraryIntent::GrantProjectAccess {
            project_id: "project-1".into(),
            target: LibraryResourceTarget::Page {
                page_id: TARGET_PAGE.into(),
            },
            access: LibraryAccess::Read,
        },
    );
    let read_only_page = content(&library, &copied_page);
    let denied = library
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "write-read-only-copied-row".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: LibraryIntent::CreatePage {
                    page_id: "018f0000-0000-7000-8000-000000009031".into(),
                    document_id: "document:denied-copied-row-child".into(),
                    title: "Must not be created".into(),
                    parent: LibraryWriteParent::Page {
                        page_id: copied_page,
                        expected_document_generation: read_only_page.document_generation,
                        expected_document_head_seq: read_only_page.document_head_seq,
                        before: None,
                        insertion: None,
                    },
                },
            },
        )
        .expect_err("read-only inherited access cannot mutate copied rows");
    assert_eq!(denied.code, CoreErrorCode::NotFound);
    library
        .apply(
            &super::context(),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "revoke-copy-host".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: LibraryIntent::SetProjectAccess {
                    target: LibraryResourceTarget::Page {
                        page_id: TARGET_PAGE.into(),
                    },
                    changes: vec![LibraryProjectAccessChange {
                        project_id: "project-1".into(),
                        access: None,
                        expected_revision: Some(2),
                    }],
                },
            },
        )
        .expect("trusted Library authority revokes host access");
    let denied = library
        .read(&context(), read_request)
        .expect_err("revoking host access revokes copied rows");
    assert_eq!(denied.code, CoreErrorCode::NotFound);
}

#[test]
fn relocated_page_undo_restores_logical_neighbors_after_rebalance() {
    const MIDDLE: &str = "018f0000-0000-7000-8000-000000009005";
    const LAST: &str = "018f0000-0000-7000-8000-000000009006";
    let (_directory, kernel, library, database) = fixture();
    for (index, page) in [PAGE, MIDDLE, LAST].into_iter().enumerate() {
        create_page(&library, page);
        apply(
            &library,
            &format!("place-page-{index}"),
            LibraryIntent::TransferBlocks {
                intent: LibraryBlockTransferLogicalIntent {
                    actor: serde_json::json!({"kind": "test"}),
                    mode: LibraryBlockTransferMode::Move,
                    root_block_ids: vec![page.into()],
                    causal_dependencies: Vec::new(),
                    source: LibraryBlockTransferSource::Library {
                        library_id: "library-1".into(),
                    },
                    target: target(),
                    promotion_policy: LibraryPagePromotionPolicy::Literal,
                },
            },
        );
    }
    assert_eq!(ordered_pages(&database), [PAGE, MIDDLE, LAST]);
    let before = content(&library, MIDDLE);
    let moved = apply(
        &library,
        "move-middle-to-library",
        LibraryIntent::MovePage {
            page_id: MIDDLE.into(),
            destination: LibraryPageWriteDestination::Library { at: None },
            expected_etag: prepare_page_move_etag(&library, &context(), MIDDLE),
        },
    )
    .committed
    .value
    .block_transfer
    .unwrap();
    assert_eq!(ordered_pages(&database), [PAGE, LAST]);
    rebalance(&kernel, &database);
    apply(
        &library,
        "undo-middle-relocation",
        LibraryIntent::UndoPageRelocation {
            token: moved.undo_token.unwrap(),
        },
    );
    assert_eq!(ordered_pages(&database), [PAGE, MIDDLE, LAST]);
    let after = content(&library, MIDDLE);
    assert_eq!(after.document_id, before.document_id);
    assert_eq!(after.body_nfm, before.body_nfm);
}
