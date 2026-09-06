//! Public-operation coverage for the source-forest comparison boundary.

use super::*;
use crate::document::OwnedDocumentModule;
use crate::infrastructure::sqlite::with_immediate_transaction;
use crate::infrastructure::store::SqliteStoreKernel;
use crate::library::LibraryModule;
use nodex_core_contracts::document::{
    DocumentBlockOperation as Operation, DocumentBlockUpdatePatch, DocumentOptionalValue,
    EditorHistoryBlockChange, EditorHistoryBlockState, EditorHistoryPatch, OwnedDocumentIntent,
};
use nodex_core_contracts::library::{
    LibraryIntent, LibraryStructuralEditCommand, LibraryWriteParent,
};
use nodex_core_contracts::{
    AdapterKind, CoreError, CoreErrorCode, LIBRARY_CONTRACT_VERSION, LibraryId, ModuleApplyRequest,
    OWNED_DOCUMENT_CONTRACT_VERSION, ProfileId, ProjectId, StoreEpoch,
};

const PAGE: &str = "018f0000-0000-7000-8000-000000009101";
const DATABASE: &str = "018f0000-0000-7000-8000-000000009102";
const DATA_SOURCE: &str = "018f0000-0000-7000-8000-000000009103";
const VIEW: &str = "018f0000-0000-7000-8000-000000009104";
const SIBLING: &str = "018f0000-0000-7000-8000-000000009105";
const CHILD: &str = "018f0000-0000-7000-8000-000000009106";
const DOCUMENT: &str = "document:promotion-source-guard";

fn context() -> BoundModuleContext {
    BoundModuleContext {
        profile_id: ProfileId("profile".into()),
        library_id: LibraryId("library".into()),
        project_id: Some(ProjectId("project".into())),
        connection_id: "promotion-guard-test".into(),
        adapter: AdapterKind::Test,
        editor_history_owner: None,
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    kernel: SqliteStoreKernel,
    library: LibraryModule,
    documents: OwnedDocumentModule,
    root: String,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let kernel = SqliteStoreKernel::open_test(directory.path()).unwrap();
        kernel.writer().call(|connection| with_immediate_transaction(connection, |transaction| {
            transaction.execute_batch("INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile', 'now', 'now');
                INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library', 'profile', 'now', 'now');
                INSERT INTO projects(id, library_id, name, created, updated) VALUES ('project', 'library', 'Promotion history', 'now', 'now');
                INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) VALUES (1, 'epoch', 'now', 'now');")?;
            Ok(())
        })).unwrap();
        let library = LibraryModule::new("profile", "library", &kernel);
        let documents = OwnedDocumentModule::new("profile", "library", &kernel);
        let mut fixture = Self {
            _directory: directory,
            kernel,
            library,
            documents,
            root: String::new(),
        };
        fixture
            .apply(LibraryIntent::CreatePage {
                page_id: PAGE.into(),
                document_id: DOCUMENT.into(),
                title: "Source title".into(),
                parent: LibraryWriteParent::Library { before: None },
            })
            .unwrap();
        fixture
            .apply(LibraryIntent::CreateDatabase {
                database_id: DATABASE.into(),
                data_source_id: DATA_SOURCE.into(),
                view_id: VIEW.into(),
                name: "Target".into(),
                parent: LibraryWriteParent::Library { before: None },
            })
            .unwrap();
        fixture.root = fixture.source().block_tree[0].id.clone();
        fixture.edit(vec![
            text_update(&fixture.root, "Promote"),
            Operation::InsertBlock {
                block: paragraph(SIBLING, "Sibling"),
                parent_block_id: None,
                before_block_id: None,
            },
            Operation::InsertBlock {
                block: paragraph(CHILD, "Child"),
                parent_block_id: Some(fixture.root.clone()),
                before_block_id: None,
            },
        ]);
        fixture
    }

    fn apply(&self, intent: LibraryIntent) -> Result<LibraryApplyOutcome, CoreError> {
        self.library.apply(
            &context(),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: crate::domain::identity::random_uuid_v7().unwrap(),
                store_epoch: StoreEpoch("epoch".into()),
                intent,
            },
        )
    }

    fn head(&self) -> LibraryBlockTransferDocumentHead {
        self.kernel
            .readers()
            .read_default(|connection| {
                let authority = read_document_authority(connection, DOCUMENT)?.unwrap();
                Ok(LibraryBlockTransferDocumentHead {
                    document_id: DOCUMENT.into(),
                    generation: authority.head.generation,
                    expected_head_seq: authority.head.head_seq,
                })
            })
            .unwrap()
    }

    fn source(&self) -> DocumentMaterialization {
        self.kernel
            .readers()
            .read_default(|connection| {
                crate::library::mutation::load_parent_document(connection, DOCUMENT)
                    .map(|parent| parent.base_materialization)
            })
            .unwrap()
    }

    fn edit(&self, operations: Vec<Operation>) {
        let head = self.head();
        self.documents
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: crate::domain::identity::random_uuid_v7().unwrap(),
                    store_epoch: StoreEpoch("epoch".into()),
                    intent: OwnedDocumentIntent::ApplyOperationBatch {
                        document_id: DOCUMENT.into(),
                        generation: head.generation,
                        expected_head_seq: head.expected_head_seq,
                        operations,
                        actor: serde_json::json!({ "kind": "test" }),
                    },
                },
            )
            .unwrap();
    }

    fn promotion_undone(&self) -> LibraryStructuralHistoryToken {
        self.promotion_undone_for(&self.root)
    }

    fn promotion_undone_for(&self, root: &str) -> LibraryStructuralHistoryToken {
        let promoted = self
            .apply(LibraryIntent::TransferBlocks {
                intent: LibraryBlockTransferLogicalIntent {
                    actor: serde_json::json!({ "kind": "test" }),
                    mode: LibraryBlockTransferMode::Move,
                    root_block_ids: vec![root.into()],
                    causal_dependencies: vec![self.head()],
                    source: LibraryBlockTransferSource::Document {
                        document_id: DOCUMENT.into(),
                    },
                    target: LibraryBlockTransferTarget::DataSource {
                        data_source_id: DATA_SOURCE.into(),
                        placement: Box::new(LibraryBlockTransferDataSourcePlacement::Direct {
                            view_id: VIEW.into(),
                            preferences_override: Default::default(),
                            group_key: None,
                            before_page_id: None,
                            sorted_property_values: Vec::new(),
                        }),
                    },
                    promotion_policy: LibraryPagePromotionPolicy::Literal,
                },
            })
            .unwrap()
            .committed
            .value
            .block_transfer
            .unwrap();
        self.reverse(promoted.history.unwrap())
            .committed
            .value
            .structural_edit
            .unwrap()
            .history
            .unwrap()
    }

    fn reverse(&self, token: LibraryStructuralHistoryToken) -> LibraryApplyOutcome {
        self.apply(LibraryIntent::ReverseStructuralEdit { token })
            .unwrap()
    }

    fn active_rows(&self) -> i64 {
        self.kernel.readers().read_default(|connection|
            connection.query_row("SELECT count(*) FROM data_source_page_memberships WHERE data_source_id = ?1 AND removed_at IS NULL", [DATA_SOURCE], |row| row.get(0)).map_err(Into::into)
        ).unwrap()
    }
}

fn rich_text(text: &str) -> Value {
    serde_json::json!([{ "type": "text", "text": text, "styles": {} }])
}

fn paragraph(id: &str, text: &str) -> Value {
    serde_json::json!({ "id": id, "type": "paragraph", "props": {}, "content": rich_text(text), "children": [] })
}

fn text_update(id: &str, text: &str) -> Operation {
    Operation::UpdateBlock {
        block_id: id.into(),
        patch: DocumentBlockUpdatePatch {
            block_type: None,
            props: None,
            content: DocumentOptionalValue::Value {
                value: rich_text(text),
            },
            unset_content: false,
        },
    }
}

#[test]
fn promotion_redo_accepts_a_semantic_text_history_round_trip() {
    let fixture = Fixture::new();
    let redo = fixture.promotion_undone();
    let before = fixture.source();
    let head = fixture.head();
    let sibling = &before.block_tree[1];
    let observed = EditorHistoryBlockState {
        block_type: sibling.block_type.clone(),
        props: sibling.props.clone(),
        content: sibling.content.clone(),
        parent_block_id: None,
        before_block_id: None,
    };
    let restored = EditorHistoryBlockState {
        content: Some(rich_text("Earlier text")),
        ..observed.clone()
    };
    let text_undo = fixture
        .apply(LibraryIntent::ApplyStructuralEdit {
            command: Box::new(LibraryStructuralEditCommand::RestoreEditorHistory {
                document_id: DOCUMENT.into(),
                generation: head.generation,
                patch: EditorHistoryPatch {
                    changes: vec![EditorHistoryBlockChange {
                        block_id: SIBLING.into(),
                        before: Some(restored),
                        after: Some(observed),
                    }],
                },
            }),
        })
        .unwrap()
        .committed
        .value
        .structural_edit
        .unwrap()
        .history
        .unwrap();
    fixture.reverse(text_undo);
    assert!(fixture.head().expected_head_seq > head.expected_head_seq);
    assert_eq!(fixture.source(), before);
    fixture.reverse(redo);
    assert_eq!(fixture.active_rows(), 1);
    assert_eq!(fixture.source().block_tree[0].id, SIBLING);
}

#[test]
fn promotion_redo_preserves_unrelated_source_fields_in_its_next_inverse() {
    let fixture = Fixture::new();
    let redo = fixture.promotion_undone();
    fixture.edit(vec![
        text_update(SIBLING, "Unrelated current text"),
        Operation::SetTitle {
            title: "Current title".into(),
        },
    ]);
    let before = fixture.source();
    let undo = fixture
        .reverse(redo)
        .committed
        .value
        .structural_edit
        .unwrap()
        .history
        .unwrap();
    let promoted = fixture.source();
    assert_eq!(promoted.title, "Current title");
    assert_eq!(promoted.block_tree, vec![before.block_tree[1].clone()]);
    fixture.reverse(undo);
    assert_eq!(fixture.source(), before);
    assert_eq!(fixture.active_rows(), 0);
}

#[test]
fn promotion_redo_rejects_changed_selected_content_descendants_and_placement_atomically() {
    for change in ["root", "child", "placement"] {
        let fixture = Fixture::new();
        let redo = fixture.promotion_undone();
        let operation = match change {
            "root" => text_update(&fixture.root, "Changed promoted text"),
            "child" => text_update(CHILD, "Changed child"),
            _ => Operation::MoveBlock {
                block_id: fixture.root.clone(),
                parent_block_id: None,
                before_block_id: None,
            },
        };
        fixture.edit(vec![operation]);
        let before = fixture.source();
        let head = fixture.head();
        let result = fixture.apply(LibraryIntent::ReverseStructuralEdit { token: redo });
        assert_eq!(
            result.unwrap_err().code,
            CoreErrorCode::RevisionConflict,
            "{change}"
        );
        assert_eq!(fixture.source(), before, "{change}");
        assert_eq!(
            fixture.head().expected_head_seq,
            head.expected_head_seq,
            "{change}"
        );
        assert_eq!(fixture.active_rows(), 0, "{change}");
    }
}

#[test]
fn promotion_redo_rejects_placement_drift_of_a_restored_roots_parent() {
    let fixture = Fixture::new();
    let redo = fixture.promotion_undone_for(CHILD);
    fixture.edit(vec![Operation::MoveBlock {
        block_id: fixture.root.clone(),
        parent_block_id: None,
        before_block_id: None,
    }]);
    let before = fixture.source();
    let head = fixture.head();
    let error = fixture
        .apply(LibraryIntent::ReverseStructuralEdit { token: redo })
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::RevisionConflict);
    assert_eq!(fixture.source(), before);
    assert_eq!(fixture.head().expected_head_seq, head.expected_head_seq);
    assert_eq!(fixture.active_rows(), 0);
}
