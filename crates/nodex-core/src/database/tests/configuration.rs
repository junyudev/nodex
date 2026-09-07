use super::*;
use nodex_core_contracts::CoreErrorCode;
use nodex_core_contracts::database::DatabaseViewPropertyFilter;
use nodex_core_contracts::database_configuration::DatabaseConfigurationScript;

fn fixture() -> (tempfile::TempDir, SqliteStoreKernel, DatabaseModule) {
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    kernel.writer().call(|connection| {
        connection.execute("INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)", [NOW])?;
        connection.execute("INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library-1', 'profile-1', ?1, ?1)", [NOW])?;
        connection.execute("INSERT INTO projects(id, library_id, name, created, updated) VALUES ('project-1', 'library-1', 'Configuration', ?1, ?1)", [NOW])?;
        connection.execute("INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) VALUES (1, 'epoch-1', ?1, ?1)", [NOW])?;
        Ok(())
    }).unwrap();
    LibraryModule::new("profile-1", "library-1", &kernel)
        .apply(
            &library_context(AdapterKind::Test),
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "configuration:database".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: LibraryIntent::CreateDatabase {
                    database_id: DATABASE_ID.into(),
                    data_source_id: SOURCE_ID.into(),
                    view_id: VIEW_ID.into(),
                    name: "Work".into(),
                    parent: LibraryWriteParent::Library { before: None },
                },
            },
        )
        .unwrap();
    let module = DatabaseModule::new("profile-1", "library-1", &kernel);
    (directory, kernel, module)
}
fn request(id: &str, operations: Value, revision: i64) -> ModuleApplyRequest<Vec<DatabaseIntent>> {
    let script: DatabaseConfigurationScript =
        serde_json::from_value(json!({"if_schema_revision":revision,"operations":operations}))
            .unwrap();
    ModuleApplyRequest {
        contract_version: DATABASE_CONTRACT_VERSION,
        operation_id: id.into(),
        store_epoch: StoreEpoch("epoch-1".into()),
        intent: vec![DatabaseIntent::Configure {
            data_source_id: SOURCE_ID.into(),
            script,
        }],
    }
}
fn source_revision(kernel: &SqliteStoreKernel) -> i64 {
    kernel
        .writer()
        .call(|connection| {
            connection
                .query_row(
                    "SELECT schema_revision FROM data_sources WHERE id = ?1",
                    [SOURCE_ID],
                    |row| row.get(0),
                )
                .map_err(StoreError::from)
        })
        .unwrap()
}
#[test]
fn configuration_is_atomic_and_replay_survives_property_and_option_renames() {
    let (_directory, kernel, module) = fixture();
    let context = library_context(AdapterKind::Test);
    let create = request(
        "config:create",
        json!([
            {"kind":"add_property","name":"Risk","schema":{"kind":"select"},"options":["Low","High"]},
            {"kind":"create_view","name":"Risk board","layout":"board","group_by":"Risk"}
        ]),
        source_revision(&kernel),
    );
    let result = module.apply(&context, create.clone()).unwrap();
    module
        .apply(
            &context,
            request(
                "config:rename",
                json!([
                    {"kind":"rename_option","property":"Risk","option":"High","name":"Critical"},
                    {"kind":"rename_property","property":"Risk","name":"Exposure"}
                ]),
                source_revision(&kernel),
            ),
        )
        .unwrap();
    let replay = module.apply(&context, create).unwrap();
    assert!(replay.committed.receipt.mutation.duplicate);
    assert_eq!(replay.committed.commit_seq, result.committed.commit_seq);
    let before = source_revision(&kernel);
    let failed = module.apply(
        &context,
        request(
            "config:invalid",
            json!([
                {"kind":"add_property","name":"Discarded","schema":{"kind":"text"}},
                {"kind":"create_view","name":"Invalid board","layout":"board","group_by":"Missing"}
            ]),
            before,
        ),
    );
    assert!(failed.is_err());
    assert_eq!(source_revision(&kernel), before);
    let count: i64 = kernel
        .writer()
        .call(|connection| {
            connection
                .query_row(
                    "SELECT count(*) FROM data_source_properties WHERE name = 'Discarded'",
                    [],
                    |row| row.get(0),
                )
                .map_err(StoreError::from)
        })
        .unwrap();
    assert_eq!(count, 0);
    let duplicate = module.apply(
        &context,
        request(
            "config:duplicate-normalized-name",
            json!([
                {"kind":"add_property","name":"Normalized","schema":{"kind":"text"}},
                {"kind":"add_property","name":" Normalized ","schema":{"kind":"text"}}
            ]),
            before,
        ),
    );
    assert!(duplicate.is_err());
    assert_eq!(source_revision(&kernel), before);
}
#[test]
fn partial_view_script_preserves_presentation_and_rejects_stale_revision() {
    let (_directory, kernel, module) = fixture();
    let context = library_context(AdapterKind::Test);
    let config = |kernel: &SqliteStoreKernel| {
        kernel
            .writer()
            .call(|connection| {
                connection
                    .query_row(
                        "SELECT config_json FROM database_views WHERE id = ?1",
                        [VIEW_ID],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(StoreError::from)
            })
            .unwrap()
    };
    let before = super::super::view_contract::decode_definition_json(&config(&kernel)).unwrap();
    let operations = json!([{"kind":"update_view","view":"Board","if_revision":1,"sorts":[{"property":"Priority","direction":"desc"}]}]);
    module
        .apply(
            &context,
            request("config:sort", operations.clone(), source_revision(&kernel)),
        )
        .unwrap();
    let after = super::super::view_contract::decode_definition_json(&config(&kernel)).unwrap();
    assert_eq!(before.presentation, after.presentation);
    assert_eq!(
        after.rules.sorts[0].field,
        DatabaseViewSortField::Property {
            property_id: "priority".into()
        }
    );
    assert!(
        module
            .apply(
                &context,
                request("config:stale", operations, source_revision(&kernel))
            )
            .is_err()
    );
}

fn view_state(kernel: &SqliteStoreKernel, name: &str) -> (String, i64, DatabaseViewDefinition) {
    let name = name.to_owned();
    kernel
        .writer()
        .call(move |connection| {
            let (id, revision, config) = connection.query_row(
                "SELECT id, revision, config_json FROM database_views WHERE name = ?1",
                [&name],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )?;
            Ok((
                id,
                revision,
                super::super::view_contract::decode_definition_json(&config).unwrap(),
            ))
        })
        .unwrap()
}

#[test]
fn configuration_filters_resolve_in_transaction_preserve_on_omission_and_clear_explicitly() {
    let (_directory, kernel, module) = fixture();
    let context = library_context(AdapterKind::Test);
    let original = view_state(&kernel, "Board");
    let create = request(
        "config:filtered",
        json!([
            {"kind":"add_property","name":"Risk","schema":{"kind":"multi_select"},"options":["Low","High"]},
            {"kind":"create_view","name":"Review queue","layout":"list","filter":{
                "kind":"group","operator":"or","children":[
                    {"kind":"clause","propertyId":"Status","operator":"select_is","value":"Review"},
                    {"kind":"clause","propertyId":"Risk","operator":"multi_select_contains_all","value":["High","Low"]}
                ]
            },"sorts":[{"property":"title","direction":"asc"}]}
        ]),
        source_revision(&kernel),
    );
    let committed = module.apply(&context, create.clone()).unwrap();
    let (id, revision, definition) = view_state(&kernel, "Review queue");
    let filter = serde_json::to_value(&definition.rules.advanced_filter).unwrap();
    assert_eq!(
        filter["children"][0],
        json!({"kind":"clause","propertyId":"status","operator":"select_is","value":"review"})
    );
    let risk_id = filter["children"][1]["propertyId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(risk_id, "Risk");
    assert!(
        filter["children"][1]["value"]
            .as_array()
            .unwrap()
            .iter()
            .all(|id| id.as_str().unwrap().starts_with("o_"))
    );
    assert_eq!(view_state(&kernel, "Board"), original);
    module.apply(&context, request("config:rename-filtered", json!([
        {"kind":"rename_property","property":"Risk","name":"Exposure"},
        {"kind":"rename_option","property":"Exposure","option":"High","name":"Critical"},
        {"kind":"update_view","view":id,"if_revision":revision,"name":"Triage queue"}
    ]), source_revision(&kernel))).unwrap();
    let (_, renamed_revision, renamed) = view_state(&kernel, "Triage queue");
    assert_eq!(renamed, definition);
    let replay = module.apply(&context, create).unwrap();
    assert!(replay.committed.receipt.mutation.duplicate);
    assert_eq!(replay.committed.commit_seq, committed.committed.commit_seq);

    // A preexisting quick filter and an advanced tree are one complete saved filter.
    let mut with_quick_filter = renamed.clone();
    with_quick_filter.rules.property_filters.push(DatabaseViewPropertyFilter {
        filter_id: "quick-status".into(),
        clause: serde_json::from_value(json!({"kind":"clause","propertyId":"status","operator":"select_is_not","value":"ship"})).unwrap(),
    });
    module
        .apply(
            &context,
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: "config:quick-filter".into(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent: vec![DatabaseIntent::PutView {
                    database_id: DATABASE_ID.into(),
                    data_source_id: SOURCE_ID.into(),
                    view_id: id.clone(),
                    expected_revision: renamed_revision,
                    name: "Triage queue".into(),
                    layout: DatabaseViewLayout::List,
                    definition: with_quick_filter,
                    is_default: false,
                    before_view_id: None,
                }, serde_json::from_value(json!({
                    "kind":"put_view_personal_preferences", "view_id":id, "expected_revision":0,
                    "rules_override":{"advanced_filter":{"kind":"filter","filter":{
                        "kind":"group","operator":"and","children":[
                            {"kind":"clause","propertyId":"status","operator":"select_is","value":"triage"}
                        ]
                    }}}, "presentation_override":{}
                })).unwrap()],
            },
        )
        .unwrap();
    let (_, revision, before_clear) = view_state(&kernel, "Triage queue");
    let read_preferences = || {
        module
            .read(
                &context,
                ModuleReadRequest {
                    contract_version: DATABASE_CONTRACT_VERSION,
                    read: DatabaseRead::ViewPersonalPreferences {
                        view_id: id.clone(),
                    },
                },
            )
            .unwrap()
            .value
    };
    let personal_before = read_preferences();
    module
        .apply(
            &context,
            request(
                "config:clear-filter",
                json!([
                    {"kind":"update_view","view":id,"if_revision":revision,"filter":null}
                ]),
                source_revision(&kernel),
            ),
        )
        .unwrap();
    let (_, _, cleared) = view_state(&kernel, "Triage queue");
    assert!(cleared.rules.property_filters.is_empty());
    assert_eq!(cleared.rules.advanced_filter, None);
    assert_eq!(cleared.rules.sorts, before_clear.rules.sorts);
    assert_eq!(cleared.presentation, before_clear.presentation);
    assert_eq!(read_preferences(), personal_before);
    assert_eq!(view_state(&kernel, "Board"), original);
}

#[test]
fn invalid_or_incomplete_configuration_filters_roll_back_every_operation() {
    let (_directory, kernel, module) = fixture();
    let context = library_context(AdapterKind::Test);
    let before = view_state(&kernel, "Board");
    let revision = source_revision(&kernel);
    let invalid_filters = [
        json!({"kind":"clause","propertyId":"Status","operator":"select_is","value":"No such option"}),
        json!({"kind":"clause","propertyId":"No such property","operator":"is_empty"}),
        json!({"kind":"clause","propertyId":"Status","operator":"number_equals","value":3}),
        json!({"kind":"clause","propertyId":"Discarded","operator":"select_is","value":"Review"}),
        json!({"kind":"clause","propertyId":"Status","operator":"select_is","value":3}),
        json!({"kind":"clause","propertyId":"Status","operator":"select_is","value":null}),
        json!({"kind":"clause","propertyId":"Status","operator":"select_is","value":""}),
        json!({"kind":"clause","propertyId":"Status","operator":"select_is"}),
        json!({"kind":"clause","propertyId":"Status","operator":"is_empty","value":null}),
        json!({"kind":"group","operator":"or","children":[]}),
    ];
    for (index, filter) in invalid_filters.into_iter().enumerate() {
        let error = module.apply(&context, request(&format!("config:bad-filter:{index}"), json!([
            {"kind":"add_property","name":"Discarded","schema":{"kind":"text"}},
            {"kind":"create_view","name":"Discarded queue","layout":"list","filter":filter}
        ]), revision)).unwrap_err();
        assert_eq!(error.code, CoreErrorCode::InvalidInput, "{error:?}");
        assert_eq!(source_revision(&kernel), revision);
        assert_eq!(view_state(&kernel, "Board"), before);
        let leftovers: i64 = kernel.writer().call(|connection| connection.query_row(
            "SELECT (SELECT count(*) FROM database_views WHERE name = 'Discarded queue') + (SELECT count(*) FROM data_source_properties WHERE name = 'Discarded')", [], |row| row.get(0)
        ).map_err(StoreError::from)).unwrap();
        assert_eq!(leftovers, 0);
    }
}

#[test]
fn configuration_filters_reject_ambiguous_names_and_prefer_exact_ids() {
    let (_directory, kernel, module) = fixture();
    let context = library_context(AdapterKind::Test);
    module
        .apply(
            &context,
            request(
                "config:duplicate-labels",
                json!([
                    {"kind":"rename_option","property":"status","option":"review","name":"Queue"},
                    {"kind":"rename_option","property":"status","option":"triage","name":"Queue"},
                    {"kind":"rename_property","property":"status","name":"Choice"},
                    {"kind":"rename_property","property":"priority","name":"Choice"}
                ]),
                source_revision(&kernel),
            ),
        )
        .unwrap();
    for (index, property, option) in [(0, "Choice", "review"), (1, "status", "Queue")] {
        let rejected = module.apply(&context, request(&format!("config:ambiguous:{index}"), json!([
            {"kind":"create_view","name":"Ambiguous","layout":"list","filter":{"kind":"clause","propertyId":property,"operator":"select_is","value":option}}
        ]), source_revision(&kernel))).unwrap_err();
        assert_eq!(rejected.code, CoreErrorCode::InvalidInput);
        assert!(rejected.message.contains("ambiguous"));
    }
    module.apply(&context, request("config:id-over-label", json!([
        {"kind":"rename_option","property":"status","option":"triage","name":"review"},
        {"kind":"rename_property","property":"priority","name":"status"},
        {"kind":"create_view","name":"Exact identity","layout":"list","filter":{"kind":"clause","propertyId":"status","operator":"select_is","value":"review"}}
    ]), source_revision(&kernel))).unwrap();
    let (_, _, definition) = view_state(&kernel, "Exact identity");
    assert_eq!(
        serde_json::to_value(definition.rules.advanced_filter).unwrap(),
        json!({
            "kind":"group","operator":"and","children":[
                {"kind":"clause","propertyId":"status","operator":"select_is","value":"review"}
            ]
        })
    );
}
