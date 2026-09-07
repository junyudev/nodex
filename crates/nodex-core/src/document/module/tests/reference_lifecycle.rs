use super::*;
use crate::database::DatabaseModule;
use nodex_core_contracts::database::{DATABASE_CONTRACT_VERSION, DatabaseIntent};

fn view_reference(id: &str, target: &str) -> DocumentBlockOperation {
    DocumentBlockOperation::InsertBlock {
        block: MaterializedBlockNode {
            id: id.to_owned(),
            block_type: "databaseViewRef".to_owned(),
            props: BTreeMap::from([("databaseViewId".to_owned(), json!(target))]),
            content: None,
            children: Vec::new(),
        },
        parent_block_id: None,
        before_block_id: None,
    }
}

#[test]
fn deleted_view_reference_does_not_freeze_document_edits() {
    let seeded = seeded_module();
    move_seeded_page_under_database(&seeded);
    let (head, engine) = synced_page_engine(&seeded);
    seeded
        .module
        .apply(
            &context(),
            apply_request(
                "reference:insert",
                head,
                raw_document_operation_update(
                    &engine,
                    &[view_reference(CREATED_REFERENCE_BLOCK_ID, VIEW_ID_A)],
                ),
            ),
        )
        .expect("insert readable View reference");

    DatabaseModule::new(PROFILE_ID, LIBRARY_ID, &seeded.kernel)
        .apply(
            &library_context_for("view:delete", AdapterKind::Test),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "reference:delete-view".to_owned(),
                store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                intent: vec![DatabaseIntent::DeleteView {
                    database_id: DATABASE_ID.to_owned(),
                    view_id: VIEW_ID_A.to_owned(),
                    expected_revision: 1,
                }],
            },
        )
        .expect("delete referenced View");

    let (head, engine) = synced_page_engine(&seeded);
    seeded
        .module
        .apply(
            &context(),
            apply_request(
                "reference:edit",
                head,
                raw_document_operation_update(
                    &engine,
                    &[
                        DocumentBlockOperation::SetTitle {
                            title: "Still editable".to_owned(),
                        },
                        DocumentBlockOperation::UpdateBlock {
                            block_id: CREATED_REFERENCE_BLOCK_ID.to_owned(),
                            patch: DocumentBlockUpdatePatch {
                                block_type: None,
                                props: Some(BTreeMap::from([
                                    ("databaseViewId".to_owned(), json!(VIEW_ID_A)),
                                    ("displayHint".to_owned(), json!("Deleted View")),
                                ])),
                                content: None,
                                unset_content: false,
                            },
                        },
                    ],
                ),
            ),
        )
        .expect("edit text and display hint while retaining unavailable reference");
    let (head, engine) = synced_page_engine(&seeded);
    let materialization = materialize_engine(&engine, BlockDocumentSchema::PageV3).unwrap();
    assert_eq!(materialization.title, "Still editable");
    assert_eq!(materialization.references.len(), 1);
    let error = seeded
        .module
        .apply(
            &context(),
            apply_request(
                "reference:duplicate",
                head,
                raw_document_operation_update(
                    &engine,
                    &[view_reference(CREATED_CONTENT_BLOCK_ID, VIEW_ID_A)],
                ),
            ),
        )
        .expect_err("new occurrence cannot inherit old reference validity");
    assert_eq!(error.code, CoreErrorCode::InvalidInput);
    assert_eq!(synced_page_engine(&seeded).0, head);
    seeded
        .module
        .apply(
            &context(),
            apply_request(
                "reference:remove",
                head,
                raw_document_operation_update(
                    &engine,
                    &[DocumentBlockOperation::DeleteBlock {
                        block_id: CREATED_REFERENCE_BLOCK_ID.to_owned(),
                    }],
                ),
            ),
        )
        .expect("remove unavailable reference");
    let (_, engine) = synced_page_engine(&seeded);
    assert!(
        materialize_engine(&engine, BlockDocumentSchema::PageV3)
            .unwrap()
            .references
            .is_empty()
    );
}

#[test]
fn library_reads_page_references_from_canonical_document_commits() {
    use nodex_core_contracts::library::{LibraryContentReference, LibraryRead, LibraryReadValue};
    let seeded = seeded_module();
    let (head, engine) = synced_page_engine(&seeded);
    seeded
        .module
        .apply(
            &context(),
            apply_request(
                "reference:page",
                head,
                raw_document_operation_update(
                    &engine,
                    &[DocumentBlockOperation::InsertBlock {
                        block: MaterializedBlockNode {
                            id: CREATED_REFERENCE_BLOCK_ID.to_owned(),
                            block_type: "pageRef".to_owned(),
                            props: BTreeMap::from([(
                                "targetBlockId".to_owned(),
                                json!(TARGET_PAGE_BLOCK_ID),
                            )]),
                            content: None,
                            children: Vec::new(),
                        },
                        parent_block_id: None,
                        before_block_id: None,
                    }],
                ),
            ),
        )
        .expect("commit canonical Page reference");
    let library = LibraryModule::new(PROFILE_ID, LIBRARY_ID, &seeded.kernel);
    let LibraryReadValue::PageContent { value } = library
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                read: LibraryRead::PageContent {
                    page_id: OWNER_BLOCK_ID.to_owned(),
                },
            },
        )
        .expect("read Page containing Page references")
        .value
    else {
        panic!("Page content");
    };
    assert!(
        matches!(&value.references[..], [LibraryContentReference::Page {
        target_page_id, occurrence_count: 1, ..
    }] if target_page_id == TARGET_PAGE_BLOCK_ID)
    );
}

#[test]
fn deleted_thread_mentions_allow_text_edits_but_not_more_mentions() {
    let seeded = seeded_module();
    let thread = seed_agent_turn(&seeded, "reference:thread");
    let mention = json!({"type": "threadMention", "props": {"uuid": thread.authority.thread_id}});
    let (head, engine) = synced_page_engine(&seeded);
    seeded
        .module
        .apply(
            &context(),
            apply_request(
                "reference:thread-insert",
                head,
                raw_document_operation_update(
                    &engine,
                    &[DocumentBlockOperation::InsertBlock {
                        block: MaterializedBlockNode {
                            id: CREATED_REFERENCE_BLOCK_ID.to_owned(),
                            block_type: "paragraph".to_owned(),
                            props: BTreeMap::new(),
                            content: Some(json!([mention])),
                            children: Vec::new(),
                        },
                        parent_block_id: None,
                        before_block_id: None,
                    }],
                ),
            ),
        )
        .expect("insert readable Thread mention");
    ProjectWorkspaceModule::new(PROFILE_ID, LIBRARY_ID, &seeded.kernel)
        .unwrap()
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                operation_id: "reference:thread-delete".to_owned(),
                store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                intent: ProjectWorkspaceIntent::DeleteThread {
                    thread_id: thread.authority.thread_id,
                },
            },
        )
        .expect("delete mentioned Thread");
    let (head, engine) = synced_page_engine(&seeded);
    let content_update = |content| DocumentBlockOperation::UpdateBlock {
        block_id: CREATED_REFERENCE_BLOCK_ID.to_owned(),
        patch: DocumentBlockUpdatePatch {
            block_type: None,
            props: None,
            content: Some(content),
            unset_content: false,
        },
    };
    seeded
        .module
        .apply(
            &context(),
            apply_request(
                "reference:thread-text",
                head,
                raw_document_operation_update(
                    &engine,
                    &[content_update(json!([
                        {"type": "text", "text": "Keep writing ", "styles": {}}, mention
                    ]))],
                ),
            ),
        )
        .expect("edit text around unavailable mention");
    let (head, engine) = synced_page_engine(&seeded);
    let error = seeded
        .module
        .apply(
            &context(),
            apply_request(
                "reference:thread-duplicate",
                head,
                raw_document_operation_update(
                    &engine,
                    &[content_update(json!([mention, mention]))],
                ),
            ),
        )
        .expect_err("additional inline occurrence requires current target validation");
    assert_eq!(error.code, CoreErrorCode::InvalidInput);
    assert_eq!(synced_page_engine(&seeded).0, head);
}
