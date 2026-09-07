use super::*;
use crate::query::QueryModule;
use nodex_core_contracts::QUERY_CONTRACT_VERSION;
use nodex_core_contracts::library::{
    LibraryAccess, LibraryAgentCreatePageDraft, LibraryAgentCreatePagesRequest,
    LibraryAgentPageDestination, LibraryResourceTarget,
};
use nodex_core_contracts::query::{QueryRead, QueryReadValue};
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
    module: &QueryModule,
    scope: SqlScope,
    statement: &str,
) -> Result<nodex_core_contracts::sql::SqlResult, CoreError> {
    let snapshot = module.read(
        &context(),
        ModuleReadRequest {
            contract_version: QUERY_CONTRACT_VERSION,
            read: QueryRead::Query {
                query: SqlQuery {
                    scope,
                    sql: statement.into(),
                    parameters: BTreeMap::new(),
                },
            },
        },
    )?;
    let QueryReadValue::Query { value } = snapshot.value else {
        panic!("SQL result");
    };
    Ok(value)
}
#[test]
fn public_sql_counts_complete_windows_and_enforces_cross_source_authority() {
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    let module = seed_grouped_fixture(&kernel, vec![]);
    let query_module = QueryModule::new("profile-1", "library-1", &kernel);
    let library = LibraryModule::new("profile-1", "library-1", &kernel);
    create_rows(&library, SOURCE_ID, 205, "first");
    let count = sql(
        &query_module,
        SqlScope::default(),
        "SELECT count(*) FROM pages",
    )
    .unwrap();
    assert_eq!(count.rows, vec![vec![json!(205)]]);
    let result = sql(
        &query_module,
        SqlScope::default(),
        "SELECT page_id, page_key, title FROM pages ORDER BY title DESC LIMIT 1",
    )
    .unwrap();
    assert_eq!(result.rows[0][2], "Item 204");
    assert!(!result.rows[0][0].as_str().unwrap().is_empty());
    let schema = query_module
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: QUERY_CONTRACT_VERSION,
                read: QueryRead::Schema {
                    scope: tasks_scope(),
                    relation: Some("tasks".into()),
                },
            },
        )
        .unwrap();
    let QueryReadValue::Schema { value } = schema.value else {
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
        &query_module,
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
                            expected_membership_revision: None,
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
            &query_module,
            tasks_scope(),
            "SELECT sum(json_array_length(Links)) FROM tasks"
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
            &query_module,
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
            &query_module,
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
    seed_grouped_fixture(&kernel, vec![]);
    let query_module = QueryModule::new("profile-1", "library-1", &kernel);
    let library = LibraryModule::new("profile-1", "library-1", &kernel);
    create_rows(&library, SOURCE_ID, 2, "snapshot-before");
    let store = kernel.readers().snapshot().unwrap();
    // Establish a real Store snapshot before a concurrent public mutation.
    store
        .read(crate::infrastructure::local_commit::head)
        .unwrap();
    create_rows(&library, SOURCE_ID, 1, "snapshot-after");
    let result = crate::query::execute_test_snapshot(
        store,
        context(),
        SqlQuery {
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
        },
    )
    .unwrap();
    assert_eq!(result.rows, vec![vec![json!(2)]]);
    assert_eq!(
        sql(
            &query_module,
            SqlScope::default(),
            "SELECT count(*) FROM pages"
        )
        .unwrap()
        .rows,
        vec![vec![json!(3)]]
    );
}

fn tasks_scope() -> SqlScope {
    SqlScope {
        database_id: None,
        bindings: vec![SqlBinding {
            table: "tasks".into(),
            data_source_id: SOURCE_ID.into(),
        }],
    }
}

fn parameter_query(
    module: &QueryModule,
    statement: &str,
    parameters: &[(&str, Value)],
) -> Result<nodex_core_contracts::sql::SqlResult, CoreError> {
    let snapshot = module.read(
        &context(),
        ModuleReadRequest {
            contract_version: QUERY_CONTRACT_VERSION,
            read: QueryRead::Query {
                query: SqlQuery {
                    scope: SqlScope::default(),
                    sql: statement.into(),
                    parameters: parameters
                        .iter()
                        .map(|(name, value)| ((*name).into(), value.clone()))
                        .collect(),
                },
            },
        },
    )?;
    let QueryReadValue::Query { value } = snapshot.value else {
        panic!("SQL result")
    };
    Ok(value)
}

#[test]
fn sql_retains_cte_join_null_collation_parameter_and_json_semantics() {
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    seed_grouped_fixture(&kernel, vec![]);
    let query = QueryModule::new("profile-1", "library-1", &kernel);
    let result = parameter_query(&query, "WITH p(page_id,title,amount) AS (VALUES('p1','beta',2.5),('p2','Alpha',NULL),('p3','alpha',1.5)), o(page_id,factor) AS (VALUES('p1',2),('p3',3)) SELECT p.page_id,p.amount*o.factor AS weighted FROM p LEFT JOIN o USING(page_id) WHERE p.amount IS NULL OR p.amount >= :minimum ORDER BY p.title COLLATE NOCASE,p.page_id", &[("minimum", json!(2))]).unwrap();
    assert_eq!(result.columns, vec!["page_id", "weighted"]);
    assert_eq!(
        result.rows,
        vec![
            vec![json!("p2"), Value::Null],
            vec![json!("p1"), json!(5.0)]
        ]
    );
    let result = parameter_query(&query, "WITH p(page_id,tags) AS (VALUES('p1','[\"red\",\"blue\"]'),('p2','[]')) SELECT p.page_id FROM p JOIN json_each(p.tags) t ON t.value=:tag", &[("tag", json!("red"))]).unwrap();
    assert_eq!(result.rows, vec![vec![json!("p1")]]);
    let result = sql(&query, SqlScope::default(), "WITH p(amount) AS (VALUES(2.5),(NULL),(1.5)), chosen AS (SELECT * FROM p WHERE amount IS NOT NULL) SELECT count(*),sum(amount) FROM chosen").unwrap();
    assert_eq!(result.rows, vec![vec![json!(2), json!(4.0)]]);
}

#[test]
fn sql_rejects_store_access_mutations_and_ambiguous_parameter_bindings() {
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    seed_grouped_fixture(&kernel, vec![]);
    let query = QueryModule::new("profile-1", "library-1", &kernel);
    for statement in [
        "DELETE FROM pages",
        "SELECT * FROM blocks",
        "WITH pages AS (SELECT * FROM blocks) SELECT count(*) FROM pages",
        "SELECT * FROM sqlite_master",
        "PRAGMA table_info(pages)",
        "ATTACH DATABASE ':memory:' AS extra",
        "SELECT load_extension('x')",
        "SELECT readfile('/etc/passwd')",
        "CREATE TABLE x(a)",
        "SELECT 1; SELECT 2",
        "SELECT * FROM pragma_table_info('pages')",
    ] {
        assert!(
            sql(&query, SqlScope::default(), statement).is_err(),
            "must deny {statement}"
        );
    }
    for (statement, parameters) in [
        ("SELECT :x", vec![]),
        ("SELECT 1", vec![("x", json!(1))]),
        ("SELECT ?1", vec![("x", json!(1))]),
        ("SELECT :x", vec![("x", json!([]))]),
    ] {
        assert!(
            parameter_query(&query, statement, &parameters).is_err(),
            "must reject {statement}"
        );
    }
}

#[test]
fn sql_fails_complete_results_on_output_budget_and_honors_request_deadline() {
    use crate::infrastructure::request_execution::{
        RequestExecutionClass, RequestExecutionContext, within_request_execution,
    };
    use crate::infrastructure::sqlite::QueryCancellation;
    use std::time::{Duration, Instant};
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    seed_grouped_fixture(&kernel, vec![]);
    let query = QueryModule::new("profile-1", "library-1", &kernel);
    let error = sql(&query, SqlScope::default(), "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001) SELECT x FROM n").unwrap_err();
    assert_eq!(error.code, CoreErrorCode::ResourceExhausted);
    let deadline = Instant::now() + Duration::from_millis(5);
    let error = within_request_execution(RequestExecutionContext::new(RequestExecutionClass::Interactive, QueryCancellation::new(), deadline), || {
        sql(&query, SqlScope::default(), "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT count(*) FROM n")
    }).unwrap_err();
    assert_eq!(error.code, CoreErrorCode::DeadlineExceeded, "{error:?}");
    let cancellation = QueryCancellation::new();
    cancellation.cancel();
    let error = within_request_execution(
        RequestExecutionContext::new(
            RequestExecutionClass::Interactive,
            cancellation,
            Instant::now() + Duration::from_secs(1),
        ),
        || sql(&query, SqlScope::default(), "SELECT 1"),
    )
    .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::Cancelled, "{error:?}");
}

fn measured_sql(
    kernel: &SqliteStoreKernel,
    scope: SqlScope,
    statement: &str,
    parameters: &[(&str, Value)],
) -> (
    nodex_core_contracts::sql::SqlResult,
    crate::query::QueryStats,
) {
    crate::query::execute_test_snapshot_with_stats(
        kernel.readers().snapshot().unwrap(),
        context(),
        SqlQuery {
            scope,
            sql: statement.into(),
            parameters: parameters
                .iter()
                .map(|(name, value)| ((*name).into(), value.clone()))
                .collect(),
        },
    )
    .unwrap()
}

#[test]
fn public_sql_reads_only_selected_documents_and_caches_search_under_repeated_joins() {
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    seed_grouped_fixture(&kernel, vec![]);
    let library = LibraryModule::new("profile-1", "library-1", &kernel);
    create_rows(&library, SOURCE_ID, 35, "lazy");
    let (identities, stats) = measured_sql(
        &kernel,
        tasks_scope(),
        "SELECT page_id FROM tasks ORDER BY page_id LIMIT 1",
        &[],
    );
    assert_eq!(stats.document_loads, 0);
    assert_eq!(stats.metadata_loads, 0);
    let id = identities.rows[0][0].clone();
    let (metadata, stats) = measured_sql(
        &kernel,
        tasks_scope(),
        "SELECT page_id,title FROM tasks WHERE page_id=:id",
        &[("id", id.clone())],
    );
    assert_eq!(metadata.rows.len(), 1);
    assert_eq!(
        stats.source_rows, 1,
        "an identity lookup must not scan unrelated Source members"
    );
    assert_eq!(stats.metadata_loads, 1);
    assert_eq!(stats.document_loads, 0);
    let (document, stats) = measured_sql(
        &kernel,
        SqlScope::default(),
        "SELECT nested_markdown,body_etag FROM page_documents WHERE page_id=:id",
        &[("id", id)],
    );
    assert_eq!(document.rows.len(), 1);
    assert_eq!(
        stats.document_loads, 1,
        "body and validator share one document read"
    );
    assert_eq!(stats.source_rows, 0);
    let (limited, stats) = measured_sql(
        &kernel,
        tasks_scope(),
        "WITH chosen AS MATERIALIZED (SELECT page_id FROM tasks ORDER BY page_id LIMIT 10) SELECT chosen.page_id,d.nested_markdown,d.body_etag FROM chosen JOIN page_documents d USING(page_id)",
        &[],
    );
    assert_eq!(limited.rows.len(), 10);
    assert_eq!(
        stats.document_loads, 10,
        "read bodies after choosing the ten Page identities"
    );
    let (hits, stats) = measured_sql(
        &kernel,
        tasks_scope(),
        "SELECT t.page_id,d.nested_markdown,d.body_etag FROM tasks t CROSS JOIN search_hits(:query,5) s JOIN page_documents d ON d.page_id=s.page_id WHERE t.page_id=s.page_id",
        &[("query", json!("Item"))],
    );
    assert_eq!(hits.rows.len(), 5);
    assert_eq!(stats.source_rows, 35);
    assert_eq!(
        stats.search_calls, 1,
        "the same non-correlated top-K search must not rerun per Source row"
    );
    assert_eq!(stats.document_loads, 5);
}

#[test]
fn sql_view_occurrences_preserve_multivalue_groups_nested_parents_and_distinct_counts() {
    use nodex_core_contracts::database::{DatabasePropertyValueInput, DatabaseViewGroup};
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    let database = seed_grouped_fixture(&kernel, vec![]);
    let query = QueryModule::new("profile-1", "library-1", &kernel);
    let library = LibraryModule::new("profile-1", "library-1", &kernel);
    create_rows(&library, SOURCE_ID, 2, "occurrences");
    let ids = sql(
        &query,
        tasks_scope(),
        "SELECT page_id,value_revisions FROM tasks ORDER BY title",
    )
    .unwrap();
    let parent = ids.rows[0][0].as_str().unwrap();
    let child = ids.rows[1][0].as_str().unwrap();
    apply_task_parent(&database, "sql:nest", &[(child, 1)], Some(parent), None).unwrap();
    let DatabaseReadValue::PropertyWindow { properties } = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::PropertyWindow {
                    data_source_id: SOURCE_ID.into(),
                    window: CollectionWindowRequest {
                        first: Some(200),
                        after: None,
                    },
                },
            },
        )
        .unwrap()
        .value
    else {
        panic!("properties")
    };
    let tags = properties
        .items
        .iter()
        .find(|property| property.property_id == "tags")
        .unwrap();
    for (offset, (id, name)) in [("o_sqlone01", "First"), ("o_sqltwo02", "Second")]
        .into_iter()
        .enumerate()
    {
        database
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    operation_id: format!("sql:tag:{offset}"),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    intent: vec![DatabaseIntent::PutOption {
                        data_source_id: SOURCE_ID.into(),
                        property_id: "tags".into(),
                        option_id: id.into(),
                        name: name.into(),
                        color: None,
                        expected_property_revision: tags.revision + offset as i64,
                    }],
                },
            )
            .unwrap();
    }
    database
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "sql:tag-pages".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: vec![DatabaseIntent::EditPropertyValues {
                    edits: [parent, child]
                        .into_iter()
                        .map(|page| DatabasePropertyValueMutation {
                            expected_membership_revision: None,
                            address: DatabasePagePropertyAddress {
                                data_source_id: SOURCE_ID.into(),
                                page_id: page.into(),
                                property_id: "tags".into(),
                            },
                            edit: DatabasePropertyValueEdit::Replace {
                                expected_value_revision: {
                                    let observed =
                                        ids.rows.iter().find(|row| row[0] == page).unwrap();
                                    let revisions: Value =
                                        serde_json::from_str(observed[1].as_str().unwrap())
                                            .unwrap();
                                    revisions["tags"].as_i64().unwrap()
                                },
                                value: DatabasePropertyValueInput::MultiSelect {
                                    option_ids: vec!["o_sqlone01".into(), "o_sqltwo02".into()],
                                },
                            },
                        })
                        .collect(),
                }],
            },
        )
        .unwrap();
    let DatabaseReadValue::View { value: mut view } = database
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                read: DatabaseRead::View {
                    view_id: VIEW_ID.into(),
                },
            },
        )
        .unwrap()
        .value
    else {
        panic!("View")
    };
    view.definition.presentation.group = Some(DatabaseViewGroup {
        property_id: "tags".into(),
    });
    view.definition.presentation.hierarchy.show_sub_pages = true;
    view.definition.presentation.hierarchy.nested_sub_pages = true;
    database
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "sql:group-view".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: vec![DatabaseIntent::PutView {
                    database_id: DATABASE_ID.into(),
                    data_source_id: SOURCE_ID.into(),
                    view_id: VIEW_ID.into(),
                    expected_revision: view.revision,
                    name: view.name,
                    layout: DatabaseViewLayout::List,
                    definition: view.definition,
                    is_default: true,
                    before_view_id: None,
                }],
            },
        )
        .unwrap();
    let result = parameter_query(&query, "SELECT occurrence_id,page_id,group_key,parent_occurrence_id,ordinal FROM view_rows(:view) ORDER BY ordinal", &[("view",json!(VIEW_ID))]).unwrap();
    assert_eq!(result.rows.len(), 4);
    let mut group_counts = BTreeMap::new();
    for (ordinal, row) in result.rows.iter().enumerate() {
        assert_eq!(row[4], json!(ordinal));
        *group_counts.entry(row[2].as_str().unwrap()).or_insert(0) += 1;
        if row[1] == parent {
            assert_eq!(row[3], Value::Null);
            continue;
        }
        assert_eq!(row[1], child);
        let parent_occurrence = result
            .rows
            .iter()
            .find(|candidate| candidate[1] == parent && candidate[2] == row[2])
            .unwrap();
        assert_eq!(row[3], parent_occurrence[0]);
        assert!(parent_occurrence[4].as_u64().unwrap() < row[4].as_u64().unwrap());
    }
    assert_eq!(
        group_counts,
        BTreeMap::from([("o_sqlone01", 2), ("o_sqltwo02", 2)])
    );
    let totals = parameter_query(
        &query,
        "SELECT count(*),count(DISTINCT page_id) FROM view_rows(:view)",
        &[("view", json!(VIEW_ID))],
    )
    .unwrap();
    assert_eq!(totals.rows, vec![vec![json!(4), json!(2)]]);
}

#[test]
fn source_property_values_do_not_alias_cached_page_metadata_fields() {
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    let database = seed_grouped_fixture(&kernel, vec![]);
    let query = QueryModule::new("profile-1", "library-1", &kernel);
    let library = LibraryModule::new("profile-1", "library-1", &kernel);
    create_rows(&library, SOURCE_ID, 1, "metadata-collision");
    let DatabaseReadValue::DataSource { value } = database
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
        panic!("Source")
    };
    database
        .apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "sql:metadata-property".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: vec![DatabaseIntent::PutProperty {
                    data_source_id: SOURCE_ID.into(),
                    property_id: "p_cache001".into(),
                    expected_data_source_revision: value.data_source.schema_revision,
                    expected_property_revision: 0,
                    name: "title_etag".into(),
                    schema: DatabasePropertySchema::Text,
                    before_property_id: None,
                }],
            },
        )
        .unwrap();
    let result = sql(&query, tasks_scope(), "SELECT title,title_etag FROM tasks").unwrap();
    assert_eq!(
        result.rows,
        vec![vec![json!("Item 000"), Value::Null]],
        "a Property may share a name with a field exposed only on pages"
    );
}

#[test]
fn query_schema_avoids_management_scans_and_value_revisions_are_read_once_per_page() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    let _module = seed_grouped_fixture(&kernel, vec![]);
    let library = LibraryModule::new("profile-1", "library-1", &kernel);
    create_rows(&library, SOURCE_ID, 2, "revision-cost");
    kernel
        .readers()
        .read_default(move |connection| {
            let bound = context();
            let query = crate::database::query::QueryContext {
                connection,
                library_id: "library-1",
                commit_head: crate::infrastructure::local_commit::head(connection)?,
                context: &bound,
            };
            connection.authorizer(Some(|context: AuthContext<'_>| match context.action {
                AuthAction::Read {
                    table_name: "data_source_property_values" | "database_views",
                    ..
                } => Authorization::Deny,
                _ => Authorization::Allow,
            }))?;
            let properties = query.source_properties(SOURCE_ID);
            let options = query.property_options(SOURCE_ID, "status");
            connection.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
            assert!(properties?.len() > 1);
            assert!(!options?.is_empty());
            let reads = Arc::new(AtomicUsize::new(0));
            let observed = reads.clone();
            connection.authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(
                    context.action,
                    AuthAction::Read {
                        table_name: "data_source_property_values",
                        column_name: "revision",
                        ..
                    }
                ) {
                    observed.fetch_add(1, Ordering::Relaxed);
                }
                Authorization::Allow
            }))?;
            let rows = query.rows(
                "property_values",
                &BTreeMap::from([("data_source_id".into(), json!(SOURCE_ID))]),
            );
            connection.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
            assert!(rows?.len() > 2);
            assert_eq!(
                reads.load(Ordering::Relaxed),
                4,
                "each Page reads one shared revision map and its task-parent Relation revision"
            );
            Ok(())
        })
        .unwrap();
}
