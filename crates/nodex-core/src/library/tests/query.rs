use super::*;
use nodex_core_contracts::library::LibraryPageOperation;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn fixture() -> (tempfile::TempDir, SqliteStoreKernel, LibraryModule) {
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    kernel.writer().call(|connection| {
        with_immediate_transaction(connection, |transaction| {
            transaction.execute("INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)", [NOW])?;
            transaction.execute("INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library-1', 'profile-1', ?1, ?1)", [NOW])?;
            transaction.execute("INSERT INTO projects(id, library_id, name, created, updated) VALUES ('project-1', 'library-1', 'Public reads', ?1, ?1)", [NOW])?;
            transaction.execute("INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) VALUES (1, 'epoch-1', ?1, ?1)", [NOW])?;
            Ok(())
        })
    }).unwrap();
    let library = LibraryModule::new("profile-1", "library-1", &kernel);
    for (id, project) in [
        ("visible", Some(ProjectId("project-1".into()))),
        ("hidden", None),
    ] {
        library
            .apply(
                &BoundModuleContext {
                    project_id: project,
                    ..context()
                },
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: format!("create:{id}"),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    intent: LibraryIntent::CreatePage {
                        page_id: format!("page:{id}"),
                        document_id: format!("document:{id}"),
                        title: format!("Query {id}"),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .unwrap();
    }
    (directory, kernel, library)
}

#[test]
fn public_page_relations_preserve_authority_and_read_validators_without_body_on_metadata_reads() {
    let (_directory, kernel, library) = fixture();
    let bound = BoundModuleContext {
        project_id: Some(ProjectId("project-1".into())),
        ..context()
    };
    let result = library
        .read(
            &bound,
            ModuleReadRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                read: LibraryRead::PageProjectionFile {
                    page_id: "page:visible".into(),
                    file_kind: LibraryPageProjectionFileKind::BodyNestedMarkdown,
                    prepare: None,
                },
            },
        )
        .unwrap();
    let LibraryReadValue::PageProjectionFile { value: expected } = result.value else {
        panic!("Page projection");
    };
    kernel
        .readers()
        .read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let query = super::super::query::QueryContext {
                connection: &transaction,
                library_id: "library-1",
                store_epoch: "epoch-1",
                commit_head: navigation::commit_head(&transaction)?,
                context: &bound,
                page_search: &page_search::PageSearchIndexRegistry::default(),
            };
            assert_eq!(query.page_ids(None)?, ["page:visible"]);
            assert!(query.page_ids(Some("page:hidden"))?.is_empty());
            assert!(query.page_ids(Some("page:missing"))?.is_empty());
            // Denial is executable evidence that metadata does not depend on body columns.
            transaction.authorizer(Some(|context: AuthContext<'_>| match context.action {
                AuthAction::Read {
                    table_name: "document_materializations",
                    column_name:
                        "nfm" | "plain_text" | "preview" | "references_json" | "asset_refs_json",
                } => Authorization::Deny,
                _ => Authorization::Allow,
            }))?;
            let metadata = query.page_metadata("page:visible");
            let preparations = [
                LibraryPageOperation::Delete,
                LibraryPageOperation::Move { view_id: None },
            ]
            .into_iter()
            .map(|operation| {
                navigation::read(
                    &transaction,
                    "library-1",
                    "epoch-1",
                    query.commit_head,
                    &bound,
                    query.page_search,
                    LibraryRead::PreparePageOperation {
                        page_id: "page:visible".into(),
                        operation,
                    },
                )
            })
            .collect::<Result<Vec<_>, _>>();
            transaction.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
            for (prepared, operation) in preparations?.into_iter().zip([
                LibraryPagePrepareKind::PageDelete,
                LibraryPagePrepareKind::PageMove { view_id: None },
            ]) {
                let LibraryReadValue::PageOperationPreparation { value: prepared } = prepared
                else {
                    panic!("Page preparation");
                };
                let prior = page_projection::page_projection_file(
                    &transaction,
                    "library-1",
                    "epoch-1",
                    page_projection::PageProjectionFileRequest {
                        commit_head: query.commit_head,
                        requesting_project_id: Some("project-1"),
                        page_id: "page:visible",
                        kind: LibraryPageProjectionFileKind::BodyNestedMarkdown,
                        prepare: Some(operation),
                    },
                )?;
                match prepared.validators {
                    nodex_core_contracts::library::LibraryPageOperationValidators::Delete {
                        page_etag,
                    } => assert_eq!(Some(page_etag), prior.validators.page_etag),
                    nodex_core_contracts::library::LibraryPageOperationValidators::Move {
                        move_etag,
                    } => assert_eq!(Some(move_etag), prior.validators.move_etag),
                }
            }
            let metadata = metadata?;
            assert_eq!(
                metadata["title_etag"],
                json!(expected.validators.title_etag)
            );
            assert_eq!(metadata["data_source_id"], Value::Null);
            assert_eq!(metadata["file_manifest_revision"], 0);
            let document = query.page_document("page:visible")?;
            assert_eq!(document["nested_markdown"], expected.content);
            assert_eq!(document["body_etag"], json!(expected.validators.body_etag));
            let children = query.rows(
                "library_children",
                &BTreeMap::from([("parent_kind".into(), json!("library"))]),
            )?;
            assert_eq!(children.len(), 1);
            assert_eq!(children[0]["child_id"], "page:visible");
            let hits = query.search("Query", 5)?;
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0]["page_id"], "page:visible");
            assert!(query.search("Query", 0).is_err());
            assert!(
                query
                    .rows(
                        "page_files",
                        &BTreeMap::from([("page_id".into(), json!("page:visible"))])
                    )?
                    .is_empty()
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn page_file_relations_do_not_expand_independent_file_authority() {
    use nodex_core_contracts::library::{LibraryPageFileEntryChange, LibraryProjectAccessChange};
    let (directory, kernel, library) = fixture();
    let bound = BoundModuleContext {
        project_id: Some(ProjectId("project-1".into())),
        ..context()
    };
    let bytes = b"public query attachment";
    let hash = crate::document::sha256(bytes);
    std::fs::create_dir_all(directory.path().join("assets")).unwrap();
    std::fs::write(
        directory.path().join("assets").join(format!("{hash}.blob")),
        bytes,
    )
    .unwrap();
    let blob_hash = hash.clone();
    kernel.writer().call(move |connection| {
        connection.execute("INSERT INTO managed_blobs(content_hash, physical_asset_name, byte_length, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![blob_hash, format!("{blob_hash}.blob"), bytes.len() as i64, NOW])?;
        Ok(())
    }).unwrap();
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    library
        .register_prepared_file_blob(
            &bound,
            "epoch-1",
            "file:import",
            "file:receipt",
            &hash,
            &format!("{hash}.blob"),
            bytes.len() as u64,
            expires,
        )
        .unwrap();
    let apply = |ctx: &BoundModuleContext, key: &str, intent| {
        library
            .apply(
                ctx,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: key.into(),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    intent,
                },
            )
            .unwrap()
    };
    apply(
        &bound,
        "file:import",
        LibraryIntent::PutPageFileEntry {
            page_id: "page:visible".into(),
            expected_manifest_revision: 0,
            file_id: "file:query".into(),
            logical_path: "notes.txt".into(),
            mime_type: "text/plain".into(),
            prepared_blob_receipt_id: "file:receipt".into(),
            replace_entry: false,
            turn_id: None,
        },
    );
    apply(
        &context(),
        "file:revoke-direct",
        LibraryIntent::SetProjectAccess {
            target: LibraryResourceTarget::File {
                file_id: "file:query".into(),
            },
            changes: vec![LibraryProjectAccessChange {
                project_id: "project-1".into(),
                access: None,
                expected_revision: Some(1),
            }],
        },
    );
    let check = bound.clone();
    kernel
        .readers()
        .read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let query = super::super::query::QueryContext {
                connection: &transaction,
                library_id: "library-1",
                store_epoch: "epoch-1",
                commit_head: navigation::commit_head(&transaction)?,
                context: &check,
                page_search: &page_search::PageSearchIndexRegistry::default(),
            };
            let files = query.rows(
                "page_files",
                &BTreeMap::from([("page_id".into(), json!("page:visible"))]),
            )?;
            assert_eq!(files.len(), 1);
            assert_eq!(files[0]["file_id"], "file:query");
            assert_eq!(files[0]["manifest_revision"], 1);
            assert_eq!(files[0]["version"], 1);
            for relation in ["files", "file_versions", "file_usages"] {
                assert!(
                    query
                        .rows(
                            relation,
                            &BTreeMap::from([("file_id".into(), json!("file:query"))])
                        )?
                        .is_empty()
                );
            }
            Ok(())
        })
        .unwrap();
    apply(
        &bound,
        "file:remove-use",
        LibraryIntent::ApplyPageFileEntries {
            page_id: "page:visible".into(),
            expected_manifest_revision: 1,
            changes: vec![LibraryPageFileEntryChange::Remove {
                file_id: "file:query".into(),
            }],
            turn_id: None,
        },
    );
    kernel
        .readers()
        .read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let query = super::super::query::QueryContext {
                connection: &transaction,
                library_id: "library-1",
                store_epoch: "epoch-1",
                commit_head: navigation::commit_head(&transaction)?,
                context: &bound,
                page_search: &page_search::PageSearchIndexRegistry::default(),
            };
            assert!(
                query
                    .rows(
                        "page_files",
                        &BTreeMap::from([("page_id".into(), json!("page:visible"))])
                    )?
                    .is_empty()
            );
            assert_eq!(
                query.page_metadata("page:visible")?["file_manifest_revision"],
                2
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn intrinsic_properties_match_page_detail_without_loading_document_content() {
    let (_directory, kernel, library) = fixture();
    let bound = BoundModuleContext {
        project_id: Some(ProjectId("project-1".into())),
        ..context()
    };
    let detail = library
        .read(
            &bound,
            ModuleReadRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                read: LibraryRead::PageDetail {
                    page_id: "page:visible".into(),
                },
            },
        )
        .unwrap();
    let LibraryReadValue::PageDetail { value: detail } = detail.value else {
        panic!("Page detail")
    };
    let expected = Value::Object(
        detail
            .intrinsic_properties
            .into_iter()
            .map(|property| (property.key, property.value))
            .collect(),
    );
    assert!(!expected.as_object().unwrap().is_empty());
    let direct_expected = expected.clone();
    let direct_bound = bound.clone();
    kernel
        .readers()
        .read_default(move |connection| {
            connection.authorizer(Some(|context: AuthContext<'_>| match context.action {
                AuthAction::Read {
                    table_name: "document_materializations",
                    ..
                } => Authorization::Deny,
                _ => Authorization::Allow,
            }))?;
            let query = super::super::query::QueryContext {
                connection,
                library_id: "library-1",
                store_epoch: "epoch-1",
                commit_head: 0,
                context: &direct_bound,
                page_search: &page_search::PageSearchIndexRegistry::default(),
            };
            let actual = query.page_intrinsic_properties("page:visible");
            let denied = query.page_intrinsic_properties("page:hidden");
            connection.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
            assert_eq!(actual?, direct_expected);
            assert!(denied.is_err());
            Ok(())
        })
        .unwrap();
    let result = crate::query::QueryModule::new("profile-1", "library-1", &kernel)
        .read(
            &bound,
            ModuleReadRequest {
                contract_version: nodex_core_contracts::QUERY_CONTRACT_VERSION,
                read: nodex_core_contracts::query::QueryRead::Query {
                    query: nodex_core_contracts::sql::SqlQuery {
                        scope: Default::default(),
                        sql: "SELECT intrinsic_properties FROM pages WHERE page_id=:id".into(),
                        parameters: BTreeMap::from([("id".into(), json!("page:visible"))]),
                    },
                },
            },
        )
        .unwrap();
    let nodex_core_contracts::query::QueryReadValue::Query { value } = result.value else {
        panic!("SQL result")
    };
    assert_eq!(
        serde_json::from_str::<Value>(value.rows[0][0].as_str().unwrap()).unwrap(),
        expected
    );
}

#[test]
fn retained_history_remains_queryable_after_page_archival() {
    use nodex_core_contracts::document::DocumentRevisionKind;
    let (_directory, kernel, library) = fixture();
    let bound = BoundModuleContext {
        project_id: Some(ProjectId("project-1".into())),
        ..context()
    };
    OwnedDocumentModule::new("profile-1", "library-1", &kernel)
        .apply(
            &bound,
            ModuleApplyRequest {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                operation_id: "history:checkpoint".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: OwnedDocumentIntent::CreateCheckpoint {
                    document_id: "document:visible".into(),
                    generation: 1,
                    expected_head_seq: 1,
                    cause: "manual".into(),
                    label: Some("Before archival".into()),
                    actor: json!({"kind":"test"}),
                    revision_kind: Some(DocumentRevisionKind::Manual),
                    source_mutation_id: None,
                    source_change_seq: None,
                },
            },
        )
        .unwrap();
    library
        .apply(
            &bound,
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "history:archive".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: LibraryIntent::ApplyPageLifecycle {
                    mutation: Box::new(LibraryPageLifecycleMutation::ArchivePage {
                        page_id: "page:visible".into(),
                        expected_metadata_revision: 1,
                    }),
                },
            },
        )
        .unwrap();
    kernel
        .readers()
        .read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let query = super::super::query::QueryContext {
                connection: &transaction,
                library_id: "library-1",
                store_epoch: "epoch-1",
                commit_head: navigation::commit_head(&transaction)?,
                context: &bound,
                page_search: &page_search::PageSearchIndexRegistry::default(),
            };
            assert!(query.page_ids(Some("page:visible"))?.is_empty());
            let history = query.rows(
                "page_history",
                &BTreeMap::from([("page_id".into(), json!("page:visible"))]),
            )?;
            assert!(
                history
                    .iter()
                    .any(|row| row["event_json"]["kind"] == "document_version"
                        && row["event_json"]["version_metadata"]["label"] == "Before archival")
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn agent_sql_validates_exact_turn_and_preserves_project_visibility() {
    use nodex_core_contracts::query::{QueryRead, QueryReadValue};
    use nodex_core_contracts::sql::{SqlQuery, SqlScope};
    let (_directory, kernel, library) = fixture();
    let bound = BoundModuleContext {
        project_id: Some(ProjectId("project-1".into())),
        ..context()
    };
    let workspace = ProjectWorkspaceModule::new("profile-1", "library-1", &kernel).unwrap();
    workspace
        .apply(
            &bound,
            ModuleApplyRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                operation_id: "query-thread".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: ProjectWorkspaceIntent::UpsertThread {
                    thread_id: "thread:query".into(),
                    patch: Box::new(ProjectWorkspaceThreadPatch {
                        project_id: Some(Some("project-1".into())),
                        thread_name: Some(Some("Query".into())),
                        created_at: Some(1),
                        updated_at: Some(1),
                        linked_at: Some(NOW.into()),
                        ..Default::default()
                    }),
                },
            },
        )
        .unwrap();
    workspace
        .apply(
            &bound,
            ModuleApplyRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                operation_id: "query-turn".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: ProjectWorkspaceIntent::FreezeTurnAuthority {
                    thread_id: "thread:query".into(),
                    turn_id: "turn:query".into(),
                    root_thread_id: "thread:query".into(),
                    actor_project_id: Some("project-1".into()),
                    source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
                    read_only: true,
                    inherited_from: None,
                },
            },
        )
        .unwrap();
    let provenance = AgentTurnProvenance {
        profile_id: "profile-1".into(),
        authority: ProjectWorkspaceTurnAuthority {
            thread_id: "thread:query".into(),
            turn_id: "turn:query".into(),
            root_thread_id: "thread:query".into(),
            actor_project_id: Some("project-1".into()),
            library_id: "library-1".into(),
            store_epoch: "epoch-1".into(),
            scope: ProjectWorkspaceTurnAuthorityScope::Project,
            source: ProjectWorkspaceTurnAuthoritySource::ProjectTurn,
        },
    };
    let query = SqlQuery { scope: SqlScope::default(), sql: "SELECT pages.page_id, page_documents.nested_markdown FROM pages JOIN page_documents USING(page_id)".into(), parameters: BTreeMap::new() };
    let agent = BoundModuleContext {
        adapter: AdapterKind::Agent,
        ..bound.clone()
    };
    let module = crate::query::QueryModule::new("profile-1", "library-1", &kernel);
    let read = |provenance: AgentTurnProvenance| ModuleReadRequest {
        contract_version: nodex_core_contracts::QUERY_CONTRACT_VERSION,
        read: QueryRead::AgentQuery {
            provenance: Box::new(provenance),
            query: query.clone(),
        },
    };
    let QueryReadValue::Query { value } =
        module.read(&agent, read(provenance.clone())).unwrap().value
    else {
        panic!("query result")
    };
    assert_eq!(value.returned_count, 1);
    assert_eq!(value.rows[0][0], json!("page:visible"));
    let rejected = module
        .read(
            &agent,
            ModuleReadRequest {
                contract_version: nodex_core_contracts::QUERY_CONTRACT_VERSION,
                read: QueryRead::Query {
                    query: query.clone(),
                },
            },
        )
        .expect_err("Agent cannot borrow host admission");
    assert_eq!(rejected.code, CoreErrorCode::Unauthorized);
    for field in ["thread", "turn", "root", "project", "epoch", "profile"] {
        let mut forged = provenance.clone();
        match field {
            "thread" => forged.authority.thread_id = "other".into(),
            "turn" => forged.authority.turn_id = "other".into(),
            "root" => forged.authority.root_thread_id = "other".into(),
            "project" => forged.authority.actor_project_id = Some("other".into()),
            "epoch" => forged.authority.store_epoch = "other".into(),
            _ => forged.profile_id = "other".into(),
        }
        assert!(module.read(&agent, read(forged)).is_err(), "forged {field}");
    }
    library
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "revoke-query-page".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: LibraryIntent::SetProjectAccess {
                    target: LibraryResourceTarget::Page {
                        page_id: "page:visible".into(),
                    },
                    changes: vec![LibraryProjectAccessChange {
                        project_id: "project-1".into(),
                        access: None,
                        expected_revision: Some(1),
                    }],
                },
            },
        )
        .expect("revoke Page grant");
    let QueryReadValue::Query { value } =
        module.read(&agent, read(provenance.clone())).unwrap().value
    else {
        panic!("query result")
    };
    assert_eq!(value.returned_count, 0);
    let cli = BoundModuleContext {
        adapter: AdapterKind::NativeCli,
        ..bound
    };
    assert!(
        module.read(&cli, read(provenance)).is_err(),
        "CLI cannot select Agent admission"
    );
}
