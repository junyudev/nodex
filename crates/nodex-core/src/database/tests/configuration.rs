use super::*;
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
