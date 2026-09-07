use super::*;

#[test]
fn observed_membership_rejects_leave_and_return_and_rolls_back_other_edits() {
    let directory = tempdir().unwrap();
    let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).unwrap();
    let module = seed_grouped_fixture(&kernel, vec![]);
    let library = LibraryModule::new("profile-1", "library-1", &kernel);
    let apply = |key: &str, intent| {
        module.apply(
            &context(),
            ModuleApplyRequest {
                contract_version: DATABASE_CONTRACT_VERSION,
                operation_id: key.to_owned(),
                store_epoch: StoreEpoch("epoch-1".into()),
                intent,
            },
        )
    };
    for page_id in ["page:observed-a", "page:observed-b"] {
        library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: format!("create:{page_id}"),
                    store_epoch: StoreEpoch("epoch-1".into()),
                    intent: LibraryIntent::CreatePage {
                        page_id: page_id.into(),
                        document_id: format!("document:{page_id}"),
                        title: page_id.into(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .unwrap();
        apply(
            &format!("join:{page_id}"),
            vec![DatabaseIntent::TransferPage {
                page_id: page_id.into(),
                expected_parent_revision: 1,
                expected_active_membership_revision: 0,
                target: DatabaseTransferTarget::DataSource {
                    data_source_id: SOURCE_ID.into(),
                },
            }],
        )
        .unwrap();
    }
    apply(
        "add:observed-number",
        vec![DatabaseIntent::PutProperty {
            data_source_id: SOURCE_ID.into(),
            property_id: "p_observe0".into(),
            expected_data_source_revision: 1,
            expected_property_revision: 0,
            name: "Observed number".into(),
            schema: DatabasePropertySchema::Number {
                format: Default::default(),
            },
            before_property_id: None,
        }],
    )
    .unwrap();
    apply(
        "leave:observed-a",
        vec![DatabaseIntent::TransferPage {
            page_id: "page:observed-a".into(),
            expected_parent_revision: 2,
            expected_active_membership_revision: 1,
            target: DatabaseTransferTarget::Library {
                library_id: "library-1".into(),
            },
        }],
    )
    .unwrap();
    apply(
        "return:observed-a",
        vec![DatabaseIntent::TransferPage {
            page_id: "page:observed-a".into(),
            expected_parent_revision: 3,
            expected_active_membership_revision: 0,
            target: DatabaseTransferTarget::DataSource {
                data_source_id: SOURCE_ID.into(),
            },
        }],
    )
    .unwrap();
    let edit = |page_id: &str, membership| DatabasePropertyValueMutation {
        expected_membership_revision: membership,
        address: DatabasePagePropertyAddress {
            page_id: page_id.into(),
            data_source_id: SOURCE_ID.into(),
            property_id: "p_observe0".into(),
        },
        edit: DatabasePropertyValueEdit::Replace {
            expected_value_revision: 0,
            value: DatabasePropertyValueInput::Number { value: 42.0 },
        },
    };
    let error = apply(
        "stale:observed-membership",
        vec![DatabaseIntent::EditPropertyValues {
            edits: vec![
                edit("page:observed-b", Some(1)),
                edit("page:observed-a", Some(1)),
            ],
        }],
    )
    .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::RevisionConflict);
    // The earlier valid edit remains at revision zero after atomic rejection.
    let edits = vec![
        edit("page:observed-b", Some(1)),
        edit("page:observed-a", Some(3)),
    ];
    apply(
        "fresh:observed-membership",
        vec![DatabaseIntent::EditPropertyValues { edits }],
    )
    .unwrap();
}
