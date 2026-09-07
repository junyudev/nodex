use super::*;
use nodex_core_contracts::library::{
    LibraryAccess, LibraryAgentCreatePageDraft, LibraryAgentCreatePagesRequest,
    LibraryAgentPageDestination, LibraryResourceTarget,
};
use nodex_core_contracts::sql::{SqlBinding, SqlQuery, SqlScope};

fn create_rows(library: &LibraryModule, source: &str, count: usize, key: &str) {
    for start in (0..count).step_by(16) {
        library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: format!("sql:{key}:{start}"),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    intent: LibraryIntent::CreatePagesFromNfm {
                        request: LibraryAgentCreatePagesRequest {
                            destination: LibraryAgentPageDestination::DataSource {
                                data_source_id: source.into(),
                                values: vec![],
                                view_id: None,
                                group_key: None,
                                at: None,
                            },
                            pages: (start..(start + 16).min(count))
                                .map(|index| LibraryAgentCreatePageDraft {
                                    title_markdown: format!("Item {index:03}"),
                                    nfm: String::new(),
                                    values: vec![],
                                })
                                .collect(),
                            include_block_ids: false,
                            include_etags: false,
                        },
                    },
                },
            )
            .unwrap();
    }
}
fn sql(
    module: &DatabaseModule,
    scope: SqlScope,
    statement: &str,
) -> Result<nodex_core_contracts::sql::SqlResult, CoreError> {
    let snapshot = module.read(
        &context(),
        ModuleReadRequest {
            contract_version: DATABASE_CONTRACT_VERSION,
            read: DatabaseRead::SqlQuery {
                query: SqlQuery {
                    scope,
                    sql: statement.into(),
                    parameters: BTreeMap::new(),
                },
            },
        },
    )?;
    let DatabaseReadValue::SqlQuery { value } = snapshot.value else {
        panic!("SQL result");
    };
    Ok(value)
}
#[test]
fn public_sql_counts_complete_windows_and_enforces_cross_source_authority() {
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    let module = seed_grouped_fixture(&kernel, vec![]);
    let library = LibraryModule::new("profile-1", "library-1", &kernel);
    create_rows(&library, SOURCE_ID, 205, "first");
    let count = sql(&module, SqlScope::default(), "SELECT count(*) FROM pages").unwrap();
    assert_eq!(count.rows, vec![vec![json!(205)]]);
    let result = sql(
        &module,
        SqlScope::default(),
        "SELECT page_id, page_key, title FROM pages ORDER BY title DESC LIMIT 1",
    )
    .unwrap();
    assert_eq!(result.rows[0][2], "Item 204");
    assert!(!result.rows[0][0].as_str().unwrap().is_empty());
    let schema = module
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::SqlSchema {
                    scope: SqlScope::default(),
                },
            },
        )
        .unwrap();
    let DatabaseReadValue::SqlSchema { value } = schema.value else {
        panic!("schema");
    };
    assert!(
        value.tables[0]
            .columns
            .iter()
            .any(|column| column.property_id.as_deref() == Some("status")
                && !column.options.is_empty())
    );
    let DatabaseReadValue::DataSource { value: source } = module
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::DataSource {
                    data_source_id: SOURCE_ID.into(),
                },
            },
        )
        .unwrap()
        .value
    else {
        panic!("source");
    };
    module
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "sql:relation-property".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: vec![DatabaseIntent::PutProperty {
                    data_source_id: SOURCE_ID.into(),
                    property_id: "p_sqlrel01".into(),
                    expected_data_source_revision: source.data_source.schema_revision,
                    expected_property_revision: 0,
                    name: "Links".into(),
                    schema: DatabasePropertySchema::Relation {
                        target_data_source_id: SOURCE_ID.into(),
                        cardinality:
                            nodex_core_contracts::database::DatabaseRelationCardinality::Many,
                    },
                    before_property_id: None,
                }],
            },
        )
        .unwrap();
    let selected = sql(
        &module,
        SqlScope::default(),
        "SELECT page_id FROM pages ORDER BY title LIMIT 102",
    )
    .unwrap();
    let owner = selected.rows[0][0].as_str().unwrap().to_owned();
    let targets = selected.rows[1..]
        .iter()
        .map(|row| row[0].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    for (index, targets) in targets.chunks(100).enumerate() {
        module
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: format!("sql:relations:{index}"),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    intent: vec![DatabaseIntent::EditPropertyValues {
                        edits: vec![DatabasePropertyValueMutation {
                            address: DatabasePagePropertyAddress {
                                page_id: owner.clone(),
                                data_source_id: SOURCE_ID.into(),
                                property_id: "p_sqlrel01".into(),
                            },
                            edit: DatabasePropertyValueEdit::PatchSet {
                                delta: DatabasePropertySetDelta::Relation {
                                    add_page_ids: targets.to_vec(),
                                    remove_edge_ids: vec![],
                                },
                            },
                        }],
                    }],
                },
            )
            .unwrap();
    }
    assert_eq!(
        sql(
            &module,
            SqlScope::default(),
            "SELECT sum(json_array_length(Links)) FROM pages"
        )
        .unwrap()
        .rows,
        vec![vec![json!(101)]]
    );
    let second_db = "018f1000-0000-7000-8000-000000000011";
    let second_source = "018f1000-0000-7000-8000-000000000012";
    library
        .apply(
            &library_context(AdapterKind::Test),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "sql:other-database".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: LibraryIntent::CreateDatabase {
                    database_id: second_db.into(),
                    data_source_id: second_source.into(),
                    view_id: "018f1000-0000-7000-8000-000000000013".into(),
                    name: "Other".into(),
                    parent: LibraryWriteParent::Library { before: None },
                },
            },
        )
        .unwrap();
    let scope = SqlScope {
        database_id: None,
        bindings: vec![
            SqlBinding {
                table: "left_pages".into(),
                data_source_id: SOURCE_ID.into(),
            },
            SqlBinding {
                table: "right_pages".into(),
                data_source_id: second_source.into(),
            },
        ],
    };
    assert_eq!(
        sql(
            &module,
            scope.clone(),
            "SELECT count(*) FROM left_pages CROSS JOIN right_pages"
        )
        .unwrap_err()
        .code,
        CoreErrorCode::Unauthorized
    );
    library
        .apply(
            &library_context(AdapterKind::Test),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "sql:grant-other".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: LibraryIntent::GrantProjectAccess {
                    project_id: "project-1".into(),
                    target: LibraryResourceTarget::Database {
                        database_id: second_db.into(),
                    },
                    access: LibraryAccess::ReadWrite,
                },
            },
        )
        .unwrap();
    library
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "sql:second-page".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: LibraryIntent::CreatePageFromNfm {
                    title_markdown: "Other page".into(),
                    nfm: String::new(),
                    destination:
                        nodex_core_contracts::library::LibraryPageWriteDestination::DataSource {
                            data_source_id: second_source.into(),
                            view_id: None,
                            group: None,
                            at: None,
                        },
                },
            },
        )
        .unwrap();
    assert_eq!(
        sql(
            &module,
            scope,
            "SELECT count(*) FROM left_pages JOIN right_pages ON right_pages.title='Other page'"
        )
        .unwrap()
        .rows,
        vec![vec![json!(205)]]
    );
}

#[test]
fn all_sql_sources_share_the_enclosing_read_snapshot() {
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    let module = seed_grouped_fixture(&kernel, vec![]);
    let library = LibraryModule::new("profile-1", "library-1", &kernel);
    create_rows(&library, SOURCE_ID, 2, "snapshot-before");
    let result = kernel
        .readers()
        .read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let head = crate::infrastructure::local_commit::head(&transaction)?;
            // Establish a real Store snapshot, then commit new public content on
            // the writer connection before resolving either SQL binding.
            super::super::sql::schema(
                &transaction,
                "library-1",
                head,
                &context(),
                SqlScope::default(),
            )?;
            create_rows(&library, SOURCE_ID, 1, "snapshot-after");
            let query = SqlQuery {
                scope: SqlScope {
                    database_id: None,
                    bindings: vec![
                        SqlBinding {
                            table: "a".into(),
                            data_source_id: SOURCE_ID.into(),
                        },
                        SqlBinding {
                            table: "b".into(),
                            data_source_id: SOURCE_ID.into(),
                        },
                    ],
                },
                sql: "SELECT count(*) FROM a JOIN b USING(page_id)".into(),
                parameters: BTreeMap::new(),
            };
            let result =
                super::super::sql::query(&transaction, "library-1", head, &context(), query)?;
            transaction.commit()?;
            Ok(result)
        })
        .unwrap();
    assert_eq!(result.rows, vec![vec![json!(2)]]);
    assert_eq!(
        sql(&module, SqlScope::default(), "SELECT count(*) FROM pages")
            .unwrap()
            .rows,
        vec![vec![json!(3)]]
    );
}
