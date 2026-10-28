use super::agent_surface::Fixture;
use super::*;
use crate::document::OwnedDocumentModule;
use nodex_core_contracts::OWNED_DOCUMENT_CONTRACT_VERSION;
use nodex_core_contracts::agent::AgentPreparedExecution;
use nodex_core_contracts::document::{
    AgentDocumentSemanticMutation, AgentDocumentSemanticSnapshot, DocumentSemanticCommand,
    OwnedDocumentRead, OwnedDocumentReadValue,
};

fn snapshot(fixture: &Fixture, document: &OwnedDocumentModule) -> AgentDocumentSemanticSnapshot {
    let read = document
        .read(
            &fixture.execution_context(),
            ModuleReadRequest {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                read: OwnedDocumentRead::AgentSemanticSnapshot {
                    store_epoch: StoreEpoch("epoch-1".into()),
                    authorization: Box::new(fixture.authorization.clone()),
                    document_id: "document:target".into(),
                    target_block_id: "page:target".into(),
                    prepare_title: true,
                    prepare_body: true,
                    block_guards: vec![],
                    max_depth: None,
                    cursor: None,
                    limit: None,
                },
            },
        )
        .expect("projectless canonical content and validators");
    let OwnedDocumentReadValue::AgentSemanticSnapshot { snapshot } = read.value else {
        panic!("semantic snapshot")
    };
    *snapshot
}

#[test]
fn projectless_agent_authority_reads_writes_and_replays_without_creating_a_project() {
    let fixture = Fixture::projectless();
    let document = OwnedDocumentModule::new("profile-1", "library-1", &fixture.kernel);
    let before = snapshot(&fixture, &document);
    let mutation = AgentDocumentSemanticMutation {
        document_id: before.document_id,
        generation: before.generation,
        expected_head_seq: before.head_seq,
        commands: vec![DocumentSemanticCommand::SetTitle {
            inline_markdown: "Written without a Project".into(),
            expected_etag: before.title_etag.expect("title validator"),
        }],
    };
    let prepared = document
        .read(
            &fixture.execution_context(),
            ModuleReadRequest {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                read: OwnedDocumentRead::PrepareAgentSemanticMutation {
                    operation_id: "projectless:write".into(),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    authorization: Box::new(fixture.authorization.clone()),
                    mutation: Box::new(mutation.clone()),
                },
            },
        )
        .expect("projectless write preparation");
    let OwnedDocumentReadValue::AgentSemanticMutationPreparation {
        preparation,
        committed: None,
    } = prepared.value
    else {
        panic!("new preparation")
    };
    let execute = |authorization: AgentExecutionAuthorization, token| ModuleApplyRequest {
        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
        operation_id: "projectless:write".into(),
        store_epoch: StoreEpoch("epoch-1".into()),
        intent: OwnedDocumentIntent::ExecutePreparedAgentSemanticMutation {
            authorization: Box::new(AgentPreparedExecution {
                authorization,
                token,
            }),
            mutation: Box::new(mutation.clone()),
        },
    };
    let committed = document
        .apply(
            &fixture.execution_context(),
            execute(fixture.authorization.clone(), preparation.token),
        )
        .expect("write with actual absent actor");
    assert!(!committed.committed.receipt.mutation.duplicate);
    let restarted = OwnedDocumentModule::new("profile-1", "library-1", &fixture.kernel);
    let replay = restarted
        .apply(
            &fixture.execution_context(),
            execute(fixture.authorization.clone(), None),
        )
        .expect("receipt survives a fresh Module");
    assert!(replay.committed.receipt.mutation.duplicate);
    assert_eq!(
        replay.committed.value.head_seq,
        committed.committed.value.head_seq
    );
    assert_eq!(
        snapshot(&fixture, &restarted).title,
        "Written without a Project"
    );
    let mut forged = fixture.authorization.clone();
    forged.provenance.authority.turn_id = "not-admitted".into();
    assert!(
        restarted
            .apply(&fixture.execution_context(), execute(forged, None))
            .is_err(),
        "a duplicate receipt cannot bypass exact execution identity"
    );
    drop(restarted);
    drop(document);
    let fixture = fixture.restart();
    let reopened_document = OwnedDocumentModule::new("profile-1", "library-1", &fixture.kernel);
    let persisted = reopened_document
        .apply(
            &fixture.execution_context(),
            execute(fixture.authorization.clone(), None),
        )
        .expect("receipt survives a full Store restart");
    assert!(persisted.committed.receipt.mutation.duplicate);
    assert_eq!(
        snapshot(&fixture, &reopened_document).title,
        "Written without a Project"
    );
    fixture.kernel.readers().read_default(|connection| {
        assert_eq!(connection.query_row("SELECT count(*) FROM projects", [], |row| row.get::<_, i64>(0))?, 1);
        assert_eq!(connection.query_row("SELECT count(*) FROM nodex_agent_turn_authorities", [], |row| row.get::<_, i64>(0))?, 1);
        assert_eq!(connection.query_row("SELECT count(*) FROM change_log WHERE project_id IS NOT NULL AND operation_id <> 'test:rootless-default-project:v1'", [], |row| row.get::<_, i64>(0))?, 0);
        assert_eq!(connection.query_row("SELECT count(*) FROM local_commit_documents WHERE project_id IS NOT NULL AND document_id = 'document:target'", [], |row| row.get::<_, i64>(0))?, 0);
        assert_eq!(connection.query_row("SELECT count(*) FROM document_updates WHERE document_id = 'document:target'", [], |row| row.get::<_, i64>(0))?, 2);
        Ok::<_, StoreError>(())
    }).unwrap();
}

fn prepared_library_write(
    fixture: &Fixture,
    operation: &str,
    read: LibraryRead,
    intent: impl Fn(AgentPreparedExecution) -> LibraryIntent,
) -> LibraryCommitValue {
    let prepared = fixture
        .library
        .read(
            &fixture.execution_context(),
            ModuleReadRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                read,
            },
        )
        .expect("prepare projectless content operation")
        .value;
    let token = match prepared {
        LibraryReadValue::AgentCreatePagesPreparation { value } => value.preparation.token,
        LibraryReadValue::AgentPageCopyPreparation { value } => value.preparation.token,
        LibraryReadValue::AgentMovePagesPreparation { value } => value.preparation.token,
        _ => panic!("content preparation"),
    };
    let apply = |token| {
        fixture.library.apply(
            &fixture.execution_context(),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: operation.into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: intent(AgentPreparedExecution {
                    authorization: fixture.authorization.clone(),
                    token,
                }),
            },
        )
    };
    let committed = apply(token).unwrap_or_else(|error| panic!("execute {operation}: {error:?}"));
    assert!(!committed.committed.receipt.mutation.duplicate);
    let replay = apply(None).expect("replay without duplicate effects");
    assert!(replay.committed.receipt.mutation.duplicate);
    assert_eq!(replay.committed.value, committed.committed.value);
    committed.committed.value
}

#[test]
fn projectless_agent_authority_creates_copies_and_moves_pages_with_exact_receipts() {
    use nodex_core_contracts::library::{
        LibraryAgentCreatePageDraft, LibraryAgentCreatePagesRequest, LibraryAgentMovePagesRequest,
        LibraryAgentPageCopyRequest, LibraryAgentPageDestination,
    };
    let fixture = Fixture::projectless();
    let create = LibraryAgentCreatePagesRequest {
        destination: LibraryAgentPageDestination::Library { at: None },
        pages: vec![LibraryAgentCreatePageDraft {
            title_markdown: "Created".into(),
            markdown: "Body".into(),
            values: vec![],
        }],
        include_block_ids: true,
        include_etags: true,
    };
    let created = prepared_library_write(
        &fixture,
        "projectless:create",
        LibraryRead::PrepareAgentCreatePages {
            operation_id: "projectless:create".into(),
            store_epoch: "epoch-1".into(),
            authorization: Box::new(fixture.authorization.clone()),
            request: Box::new(create.clone()),
        },
        |authorization| LibraryIntent::ExecutePreparedAgentCreatePages {
            authorization: Box::new(authorization),
            request: Box::new(create.clone()),
        },
    );
    let page = &created.agent_create_pages.unwrap().pages[0];
    assert!(page.etags.is_some());
    assert!(!page.block_ids.is_empty());
    let copy = LibraryAgentPageCopyRequest {
        source_page_id: page.page_id.clone(),
        destination: LibraryAgentPageDestination::Page {
            page_id: "page:target".into(),
            at: None,
        },
        include_block_map: true,
        include_etags: true,
    };
    let copied = prepared_library_write(
        &fixture,
        "projectless:copy",
        LibraryRead::PrepareAgentPageCopy {
            operation_id: "projectless:copy".into(),
            store_epoch: "epoch-1".into(),
            authorization: Box::new(fixture.authorization.clone()),
            request: Box::new(copy.clone()),
        },
        |authorization| LibraryIntent::ExecutePreparedAgentPageCopy {
            authorization: Box::new(authorization),
            request: Box::new(copy.clone()),
        },
    );
    let copy_result = copied.agent_page_copy.unwrap();
    assert_ne!(copy_result.page_id, page.page_id);
    assert!(copy_result.etags.is_some());
    fixture.apply(
        "destination-database",
        LibraryIntent::CreateDatabase {
            database_id: "01980000-0000-7000-8000-000000000041".into(),
            data_source_id: "01980000-0000-7000-8000-000000000042".into(),
            view_id: "01980000-0000-7000-8000-000000000043".into(),
            name: "Destination".into(),
            parent: LibraryWriteParent::Library { before: None },
        },
    );
    let movement = LibraryAgentMovePagesRequest {
        page_ids: vec![copy_result.page_id],
        destination: LibraryAgentPageDestination::DataSource {
            data_source_id: "01980000-0000-7000-8000-000000000042".into(),
            values: vec![],
            view_id: None,
            group_key: None,
            at: None,
        },
    };
    let moved = prepared_library_write(
        &fixture,
        "projectless:move",
        LibraryRead::PrepareAgentMovePages {
            operation_id: "projectless:move".into(),
            store_epoch: "epoch-1".into(),
            authorization: Box::new(fixture.authorization.clone()),
            request: Box::new(movement.clone()),
        },
        |authorization| LibraryIntent::ExecutePreparedAgentMovePages {
            authorization: Box::new(authorization),
            request: Box::new(movement.clone()),
        },
    );
    assert!(moved.agent_move_pages.is_some());
    fixture
        .kernel
        .readers()
        .read_default(|connection| {
            assert_eq!(
                connection.query_row(
                    "SELECT count(*) FROM block_relocations WHERE project_id IS NOT NULL",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            assert_eq!(
                connection.query_row("SELECT count(*) FROM projects", [], |row| row
                    .get::<_, i64>(0))?,
                1
            );
            Ok::<_, StoreError>(())
        })
        .unwrap();
}

#[test]
fn projectless_agent_authority_keeps_relocation_source_foreign_keys_mandatory() {
    let fixture = Fixture::projectless();
    fixture.kernel.writer().call(|connection| {
        let rejected = connection.execute("INSERT INTO block_relocation_source_states(
            relocation_id,document_id,project_id,library_id,generation,head_seq,pre_state_vector,
            pre_full_update,pre_full_update_byte_length,pre_state_hash,captured_at)
            VALUES ('missing-relocation','document:target',NULL,'library-1',1,0,x'01',x'02',1,?1,'today')", ["a".repeat(64)]).unwrap_err();
        assert_eq!(rejected.sqlite_error().unwrap().extended_code, rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY);
        Ok(())
    }).unwrap();
}
