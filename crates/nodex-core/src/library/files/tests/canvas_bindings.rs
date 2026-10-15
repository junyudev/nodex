use super::*;
use nodex_core_contracts::CoreErrorCode;
use nodex_core_contracts::OWNED_DOCUMENT_CONTRACT_VERSION;
use nodex_core_contracts::document::{
    OwnedDocumentIntent, RecoveryDraftCapture, RecoveryDraftContent,
};
use nodex_core_contracts::library::{LibraryCanvasDestination, LibraryFileReadSource};
use serde_json::{Value, json};

const CANVAS_ID: &str = "01990000-0000-7000-8000-000000000001";
const DOCUMENT_ID: &str = "01990000-0000-7000-8000-000000000002";

fn binding(slot: &str) -> Value {
    json!({"id": slot, "mimeType": "image/png", "source": "nodex://files/file-a",
        "fileVersion": 1, "defaultName": "shared.png"})
}

fn image(slot: &str, version: i64) -> Value {
    json!({"id": format!("image:{slot}"), "type": "image", "version": version,
        "versionNonce": 1, "isDeleted": false, "fileId": slot, "x": version * 10})
}

fn document_request(
    operation: &str,
    intent: OwnedDocumentIntent,
) -> ModuleApplyRequest<OwnedDocumentIntent> {
    ModuleApplyRequest {
        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
        operation_id: operation.to_owned(),
        store_epoch: StoreEpoch("epoch-1".to_owned()),
        intent,
    }
}

fn mutate(fixture: &Fixture, operation: &str, head: i64, mutation: Value) {
    let result =
        crate::document::OwnedDocumentModule::new("profile-1", "library-1", &fixture.kernel)
            .apply(
                &bound_context(Some("project-1")),
                document_request(
                    operation,
                    OwnedDocumentIntent::ApplyCanvasMutation {
                        document_id: DOCUMENT_ID.to_owned(),
                        generation: 1,
                        expected_head_seq: head,
                        mutation,
                    },
                ),
            )
            .unwrap();
    assert_eq!(result.committed.value.head_seq, head + 1);
}

fn seed_canvas(fixture: &Fixture) {
    let library = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
    create_image(fixture, &library);
    apply_intent(
        &library,
        "create-canvas",
        LibraryIntent::CreateCanvas {
            canvas_id: CANVAS_ID.to_owned(),
            document_id: DOCUMENT_ID.to_owned(),
            display_name: "Images".to_owned(),
            destination: LibraryCanvasDestination::Library { before: None },
        },
    );
    mutate(
        fixture,
        "insert-image",
        0,
        json!({
            "elementCandidates": [image("slot", 1)], "appStateIntents": {},
            "fileAdditions": {"slot": binding("slot")},
        }),
    );
}

fn move_image(fixture: &Fixture) {
    mutate(
        fixture,
        "move-image",
        1,
        json!({
            "elementCandidates": [image("slot", 2)], "appStateIntents": {}, "fileAdditions": {},
        }),
    );
}

fn canvas_source(slot: &str) -> LibraryFileReadSource {
    LibraryFileReadSource::Canvas {
        canvas_id: CANVAS_ID.to_owned(),
        scene_file_id: slot.to_owned(),
    }
}

fn assert_image_read(fixture: &Fixture, source: &LibraryFileReadSource) {
    let library = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
    let blob = library
        .resolve_file_blob(&bound_context(Some("project-1")), "file-a", source, Some(1))
        .unwrap();
    assert_eq!(blob.default_name, "shared.png");
    assert_eq!(fs::read(blob.physical_path).unwrap(), b"alpha");
}

#[test]
fn canvas_file_reads_survive_geometry_and_app_state_edits() {
    let fixture = fixture();
    seed_canvas(&fixture);
    assert_image_read(&fixture, &canvas_source("slot"));
    move_image(&fixture);
    assert_image_read(&fixture, &canvas_source("slot"));
    mutate(
        &fixture,
        "change-grid",
        2,
        json!({
            "elementCandidates": [], "fileAdditions": {},
            "appStateIntents": {"gridSize": {"expected": {"kind": "absent"}, "value": {"kind": "value", "value": 20}}},
        }),
    );
    assert_image_read(&fixture, &canvas_source("slot"));
    fixture.kernel.readers().read_default(|connection| {
        let coordinates = connection.query_row(
            "SELECT reference.projected_seq, head.projected_head_seq FROM canvas_scene_file_refs reference
             JOIN canvas_scene_projection_heads head ON head.document_id = reference.document_id
             WHERE reference.document_id = ?1 AND reference.file_id = 'slot'",
            [DOCUMENT_ID], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;
        assert_eq!(coordinates, (1, 3), "unchanged image rows must remain incremental");
        Ok(())
    }).unwrap();
}

#[test]
fn canvas_binding_reuse_survives_edits_without_direct_file_access() {
    let fixture = fixture();
    seed_canvas(&fixture);
    move_image(&fixture);
    mutate(
        &fixture,
        "reuse-image",
        2,
        json!({
            "elementCandidates": [image("reused", 1)], "appStateIntents": {},
            "fileAdditions": {"reused": binding("reused")},
        }),
    );
    for slot in ["slot", "reused"] {
        assert_image_read(&fixture, &canvas_source(slot));
    }
    let library = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
    let direct = library
        .resolve_file_blob(
            &bound_context(Some("project-1")),
            "file-a",
            &LibraryFileReadSource::Direct,
            None,
        )
        .unwrap();
    assert_eq!(std::fs::read(direct.physical_path).unwrap(), b"alpha");
}

#[test]
fn canvas_recovery_captures_unchanged_bindings_without_direct_file_access() {
    let fixture = fixture();
    seed_canvas(&fixture);
    move_image(&fixture);
    let scene = fixture
        .kernel
        .readers()
        .read_default(|connection| {
            let authority =
                crate::document::read_document_authority(connection, DOCUMENT_ID)?.unwrap();
            Ok(crate::document::load_canvas_scene(connection, &authority)?
                .scene
                .canonical_value())
        })
        .unwrap();
    crate::document::OwnedDocumentModule::new("profile-1", "library-1", &fixture.kernel)
        .apply(&bound_context(Some("project-1")), document_request("capture", OwnedDocumentIntent::CaptureRecovery {
            capture: Box::new(RecoveryDraftCapture {
                draft_id: "draft:canvas".to_owned(), document_id: DOCUMENT_ID.to_owned(),
                source_store_epoch: "epoch-1".to_owned(), generation: 1, base_head_seq: 2,
                created_at: NOW.to_owned(), schema_key: crate::document::CANVAS_SCHEMA_KEY.to_owned(),
                schema_version: crate::document::CANVAS_SCHEMA_VERSION,
                content: RecoveryDraftContent::Canvas {
                    scene: Some(scene), mutations: vec![json!({"elementCandidates": [image("slot", 3)], "appStateIntents": {}, "fileAdditions": {}})],
                },
                source: json!({}),
            }),
        })).unwrap();
    assert_image_read(
        &fixture,
        &LibraryFileReadSource::CanvasRecovery {
            document_id: DOCUMENT_ID.to_owned(),
            draft_id: "draft:canvas".to_owned(),
            scene_file_id: "slot".to_owned(),
        },
    );
}

#[test]
fn canvas_file_reads_reject_invalid_projection_evidence() {
    for corruption in [
        "DELETE FROM canvas_scene_projection_heads",
        "UPDATE canvas_scene_projection_heads SET projected_head_seq = 0",
        "UPDATE canvas_scene_projection_heads SET generation = generation + 1",
        "UPDATE canvas_scene_file_refs SET document_generation = document_generation + 1",
        "UPDATE canvas_scene_file_refs SET projected_seq = projected_seq + 1",
        "UPDATE canvas_scene_file_refs SET default_name = 'other.png'",
        "UPDATE canvas_scene_file_refs SET mime_type = 'image/jpeg'",
        "UPDATE canvas_scene_file_refs SET asset_uri = 'nodex://files/other'",
        "UPDATE canvas_scene_file_refs SET byte_length = byte_length + 1",
        "UPDATE canvas_scene_file_refs SET asset_hash = printf('%064d', 0)",
        "DELETE FROM canvas_scene_file_refs",
    ] {
        let fixture = fixture();
        seed_canvas(&fixture);
        fixture
            .kernel
            .writer()
            .call(move |connection| {
                connection.execute(corruption, [])?;
                Ok(())
            })
            .unwrap();
        let library = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        let error = library
            .resolve_file_blob(
                &bound_context(Some("project-1")),
                "file-a",
                &canvas_source("slot"),
                None,
            )
            .expect_err(corruption);
        assert_eq!(
            error.code,
            CoreErrorCode::StoreCorrupt,
            "{corruption}: {error:?}"
        );
    }
}
