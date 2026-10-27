use std::path::PathBuf;

use nodex_core::document::{
    BlockDocumentSchema, create_compatible_document, decode_block_document, encode_block_document,
    has_pending_dependencies, materialize_decoded_document,
};
use nodex_core::domain::block_tree::PortableValue;
use yrs::sync::{Awareness, AwarenessUpdate};
use yrs::updates::decoder::Decode;
use yrs::{ClientID, GetString, Map, ReadTxn, StateVector, Transact, Update};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/yjs-yrs")
        .join(name)
}

#[test]
fn accepts_complete_yjs_page_updates_without_pending_dependencies() {
    let document = create_compatible_document("nodex-yjs-yrs-complete");
    for name in ["base.bin", "first.bin", "second.bin"] {
        let bytes = std::fs::read(fixture(name)).expect("fixture exists");
        let update = Update::decode_v1(bytes.as_slice()).expect("valid Yjs V1 update");
        let mut transaction = document.transact_mut();
        transaction.apply_update(update).expect("update applies");
        assert!(!has_pending_dependencies(&transaction), "fixture {name}");
    }
}

#[test]
fn detects_an_incremental_update_with_a_missing_causal_base() {
    let bytes = std::fs::read(fixture("missing-dependency.bin")).expect("fixture exists");
    let update = Update::decode_v1(bytes.as_slice()).expect("valid Yjs V1 update");
    let document = create_compatible_document("nodex-yjs-yrs-pending");
    let mut transaction = document.transact_mut();
    transaction
        .apply_update(update)
        .expect("Yrs retains a causally incomplete update");
    assert!(has_pending_dependencies(&transaction));
    assert!(transaction.store().pending_update().is_some());
}

#[test]
fn registered_schema_matrix_survives_checkpoint_and_history_reconstruction() {
    let base = std::fs::read(fixture("matrix-base.bin")).expect("matrix base exists");
    let expected_vector = StateVector::decode_v1(
        std::fs::read(fixture("matrix-state-vector.bin"))
            .expect("matrix state vector exists")
            .as_slice(),
    )
    .expect("valid Yjs state vector");
    let document = create_compatible_document("nodex-yjs-yrs-schema-matrix");
    document
        .transact_mut()
        .apply_update(Update::decode_v1(&base).expect("valid matrix update"))
        .expect("matrix applies");

    let title = document.get_or_insert_text("title");
    let before = document.transact();
    assert_eq!(before.state_vector(), expected_vector);
    let expected_title = title.get_string(&before);
    let checkpoint = before.encode_state_as_update_v1(&StateVector::default());
    drop(before);
    let expected_block_tree = decode_block_document(&document, BlockDocumentSchema::PageV3)
        .expect("matrix checkpoint decodes")
        .block_tree;

    let after = std::fs::read(fixture("matrix-after.bin")).expect("matrix delta exists");
    let mut transaction = document.transact_mut();
    transaction
        .apply_update(Update::decode_v1(&after).expect("valid matrix delta"))
        .expect("matrix delta applies");
    assert!(!has_pending_dependencies(&transaction));
    drop(transaction);

    let restored = create_compatible_document("nodex-yjs-yrs-restored-snapshot");
    restored
        .transact_mut()
        .apply_update(Update::decode_v1(&checkpoint).expect("valid checkpoint update"))
        .expect("checkpoint update applies");
    let restored_title = restored.get_or_insert_text("title");
    let restored_transaction = restored.transact();
    assert_eq!(
        restored_title.get_string(&restored_transaction),
        expected_title
    );
    drop(restored_transaction);
    assert_eq!(
        decode_block_document(&restored, BlockDocumentSchema::PageV3)
            .expect("restored checkpoint decodes")
            .block_tree,
        expected_block_tree
    );
}

#[test]
fn awareness_join_and_leave_updates_are_y_protocol_compatible() {
    let mut awareness = Awareness::new(create_compatible_document("nodex-awareness-rust"));
    let added = AwarenessUpdate::decode_v1(
        std::fs::read(fixture("awareness-added.bin"))
            .expect("awareness join exists")
            .as_slice(),
    )
    .expect("valid y-protocol awareness join");
    let added_summary = awareness
        .apply_update_summary(added)
        .expect("join applies")
        .expect("join changes state");
    let fixture_client = ClientID::new(1_201);
    assert_eq!(added_summary.added, vec![fixture_client]);
    assert_eq!(
        awareness.state::<serde_json::Value>(fixture_client),
        Some(serde_json::json!({
            "user": { "id": "fixture-user", "name": "迁移 😀" },
            "cursor": { "anchor": 3, "head": 5 },
        }))
    );

    let removed = AwarenessUpdate::decode_v1(
        std::fs::read(fixture("awareness-removed.bin"))
            .expect("awareness leave exists")
            .as_slice(),
    )
    .expect("valid y-protocol awareness leave");
    let removed_summary = awareness
        .apply_update_summary(removed)
        .expect("leave applies")
        .expect("leave changes state");
    assert_eq!(removed_summary.removed, vec![fixture_client]);
    assert_eq!(awareness.state::<serde_json::Value>(fixture_client), None);
}

#[test]
fn checkpoints_preserve_yjs_bigint_wire_types() {
    // Yjs distinguishes BigInt from Number even when both represent a small integer.
    for number in [1_i64, -1, 9_007_199_254_740_992, i64::MAX] {
        let encoded = [vec![122], number.to_be_bytes().to_vec()].concat();
        let value = yrs::Any::decode(&mut yrs::encoding::read::Cursor::new(&encoded))
            .expect("valid Yjs BigInt");
        let document = create_compatible_document("numeric-wire-types");
        document
            .get_or_insert_map("values")
            .insert(&mut document.transact_mut(), "value", value);
        let checkpoint = document
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let restored = create_compatible_document("numeric-wire-types-restored");
        restored
            .transact_mut()
            .apply_update(Update::decode_v1(&checkpoint).expect("valid checkpoint"))
            .expect("checkpoint applies");
        let Some(yrs::Out::Any(value)) = restored
            .get_or_insert_map("values")
            .get(&restored.transact(), "value")
        else {
            panic!("checkpoint must retain the numeric value");
        };
        let mut roundtrip = Vec::new();
        value.encode(&mut roundtrip);
        assert_eq!(roundtrip, encoded, "BigInt {number} must retain its type");
    }
}

#[test]
fn generated_client_identifiers_fit_yjs_13() {
    let document = create_compatible_document("nodex-small-client");
    assert!(document.client_id().get() <= u64::from(u32::MAX));
}

#[test]
fn materializes_page_and_body_only_schema_roots_without_hidden_state() {
    let expected: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture("root-materializations.json")).expect("root oracle exists"),
    )
    .expect("valid root oracle");
    for (fixture_name, schema, oracle_key) in [
        ("empty-page.bin", BlockDocumentSchema::PageV3, "emptyPage"),
        (
            "empty-synced-block.bin",
            BlockDocumentSchema::SyncedBlockV2,
            "emptySyncedBlock",
        ),
        (
            "reusable-template.bin",
            BlockDocumentSchema::ReusableTemplateV2,
            "reusableTemplate",
        ),
    ] {
        let document = create_compatible_document(oracle_key);
        let bytes = std::fs::read(fixture(fixture_name)).expect("root fixture exists");
        document
            .transact_mut()
            .apply_update(Update::decode_v1(&bytes).expect("valid root update"))
            .expect("root fixture applies");
        let decoded = decode_block_document(&document, schema).expect("registered schema decodes");
        let actual = serde_json::to_value(
            materialize_decoded_document(&decoded).expect("root materialization"),
        )
        .expect("serialize root materialization");

        for field in [
            "schemaVersion",
            "title",
            "richTitle",
            "blockTree",
            "nfm",
            "plainText",
            "preview",
            "references",
            "assetRefs",
        ] {
            assert_eq!(
                actual[field], expected[oracle_key][field],
                "{fixture_name} field {field}"
            );
        }
        assert_eq!(decoded.title.is_some(), schema.has_title());
    }
}

#[test]
fn portable_json_undefined_and_binary_attributes_survive_a_rust_round_trip() {
    let document = create_compatible_document("portable-matrix-source");
    let bytes = std::fs::read(fixture("matrix-base.bin")).expect("matrix fixture exists");
    document
        .transact_mut()
        .apply_update(Update::decode_v1(&bytes).expect("valid matrix update"))
        .expect("matrix fixture applies");
    let decoded = decode_block_document(&document, BlockDocumentSchema::PageV3)
        .expect("matrix document decodes");
    let Some(PortableValue::Object(probe)) =
        decoded.block_tree.root_attributes.get("portableProbe")
    else {
        panic!("portable probe must remain an object");
    };
    assert_eq!(
        probe.get("binaryValue"),
        Some(&PortableValue::Binary(vec![0, 1, 127, 255]))
    );
    assert_eq!(probe.get("undefinedValue"), Some(&PortableValue::Undefined));
    assert!(matches!(
        probe.get("arrayValue"),
        Some(PortableValue::Array(values))
            if values.first() == Some(&PortableValue::Undefined)
    ));

    let roundtrip = encode_block_document(
        "portable-matrix-roundtrip",
        decoded.schema,
        decoded.title.as_deref(),
        &decoded.block_tree,
    )
    .expect("portable document encodes");
    let roundtrip = decode_block_document(&roundtrip, BlockDocumentSchema::PageV3)
        .expect("portable roundtrip decodes");
    assert_eq!(roundtrip.block_tree, decoded.block_tree);
}
