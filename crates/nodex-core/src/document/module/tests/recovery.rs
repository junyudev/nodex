use super::*;
use nodex_core_contracts::document::*;
use yrs::Text;

fn capture(state: Vec<u8>) -> RecoveryDraftCapture {
    RecoveryDraftCapture {
        draft_id: "draft:test".to_owned(),
        document_id: DOCUMENT_ID.to_owned(),
        source_store_epoch: STORE_EPOCH.to_owned(),
        generation: 1,
        base_head_seq: 1,
        created_at: NOW.to_owned(),
        schema_key: crate::document::PAGE_SCHEMA_KEY.to_owned(),
        schema_version: crate::document::PAGE_SCHEMA_VERSION.into(),
        content: RecoveryDraftContent::Yjs {
            state,
            unintegrated_updates: vec![],
        },
        source: json!({"knownCoverage": null}),
    }
}
fn request(
    operation: &str,
    intent: OwnedDocumentIntent,
) -> ModuleApplyRequest<OwnedDocumentIntent> {
    ModuleApplyRequest {
        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
        operation_id: operation.to_owned(),
        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
        intent,
    }
}
fn inspect_draft(seeded: &SeededModule) -> RecoveryDraftInspection {
    let result = seeded
        .module
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                read: OwnedDocumentRead::Recovery {
                    read: RecoveryRead::Inspect {
                        draft_id: "draft:test".to_owned(),
                    },
                },
            },
        )
        .expect("inspect");
    let OwnedDocumentReadValue::Recovery {
        value: RecoveryReadValue::Inspect { inspection },
    } = result.value
    else {
        panic!("inspection expected")
    };
    *inspection
}
fn resolve(inspection: &RecoveryDraftInspection, choice: RecoveryChoice) -> OwnedDocumentIntent {
    OwnedDocumentIntent::ResolveRecovery {
        resolve: RecoveryDraftResolve {
            draft_id: inspection.summary.draft_id.clone(),
            revision: inspection.summary.revision,
            expected_generation: inspection.current_generation,
            expected_head_seq: inspection.current_head_seq,
            choice,
        },
    }
}
fn changed_state(seeded: &SeededModule) -> Vec<u8> {
    let mut engine =
        YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &seeded.full_state).expect("engine");
    let update = title_update(&seeded.full_state, &seeded.state_vector, "Retained edits");
    let candidate = engine.prepare_update_v1(&update).expect("candidate");
    engine.commit_candidate(candidate).expect("apply");
    engine.full_state_v1()
}

#[test]
fn received_draft_is_immutable_and_soft_discard_is_reversible() {
    let seeded = seeded_module();
    let capture = capture(changed_state(&seeded));
    let command = request(
        "capture:1",
        OwnedDocumentIntent::CaptureRecovery {
            capture: Box::new(capture.clone()),
        },
    );
    seeded
        .module
        .apply(&context(), command.clone())
        .expect("capture");
    assert!(
        seeded
            .module
            .apply(&context(), command)
            .expect("capture retry")
            .committed
            .receipt
            .mutation
            .duplicate
    );
    let pending = inspect_draft(&seeded);
    assert!(pending.summary.resolution.is_none());
    assert!(pending.can_restore);
    let mut changed = capture;
    changed.source = json!({"changed":true});
    assert_eq!(
        seeded
            .module
            .apply(
                &context(),
                request(
                    "capture:2",
                    OwnedDocumentIntent::CaptureRecovery {
                        capture: Box::new(changed)
                    }
                )
            )
            .expect_err("immutable identity")
            .code,
        CoreErrorCode::IdempotencyKeyReused
    );
    seeded
        .module
        .apply(
            &context(),
            request("discard:1", resolve(&pending, RecoveryChoice::Discard)),
        )
        .expect("discard");
    assert!(
        seeded
            .module
            .apply(
                &context(),
                request("discard:race", resolve(&pending, RecoveryChoice::Discard))
            )
            .is_err()
    );
    let discarded = inspect_draft(&seeded);
    assert_eq!(
        discarded.summary.resolution,
        Some(RecoveryResolution::Discarded)
    );
    seeded
        .module
        .apply(
            &context(),
            request("reopen:1", resolve(&discarded, RecoveryChoice::Reopen)),
        )
        .expect("undo discard");
    assert!(inspect_draft(&seeded).summary.resolution.is_none());
}

#[test]
fn full_crdt_containment_resolves_saved_edits_but_not_delete_only_edits() {
    let seeded = seeded_module();
    seeded
        .module
        .apply(
            &context(),
            request(
                "capture:saved",
                OwnedDocumentIntent::CaptureRecovery {
                    capture: Box::new(capture(seeded.full_state.clone())),
                },
            ),
        )
        .expect("capture saved");
    assert_eq!(
        inspect_draft(&seeded).summary.resolution,
        Some(RecoveryResolution::AlreadySaved)
    );

    let seeded = seeded_module();
    let state = changed_state(&seeded);
    seeded
        .module
        .apply(
            &context(),
            apply_request("canonical:title", 1, state.clone()),
        )
        .expect("canonical text");
    let engine = YrsDocumentEngine::from_full_state_v1(DOCUMENT_ID, &state).expect("engine");
    let vector = engine.state_vector_v1();
    let title = engine.document().get_or_insert_text("title");
    {
        let mut tx = engine.document().transact_mut();
        let len = title.len(&tx);
        title.remove_range(&mut tx, 0, len);
    }
    assert_eq!(vector, engine.state_vector_v1());
    let mut draft = capture(engine.full_state_v1());
    draft.base_head_seq = 2;
    seeded
        .module
        .apply(
            &context(),
            request(
                "capture:deletion",
                OwnedDocumentIntent::CaptureRecovery {
                    capture: Box::new(draft),
                },
            ),
        )
        .expect("capture deletion");
    let inspection = inspect_draft(&seeded);
    assert!(!inspection.already_saved);
    assert!(inspection.summary.resolution.is_none());
    assert!(inspection.can_restore);
}

#[test]
fn restore_and_resolution_survive_lost_ack_without_applying_twice() {
    let seeded = seeded_module();
    seeded
        .module
        .apply(
            &context(),
            request(
                "capture:pending",
                OwnedDocumentIntent::CaptureRecovery {
                    capture: Box::new(capture(changed_state(&seeded))),
                },
            ),
        )
        .expect("capture");
    let inspection = inspect_draft(&seeded);
    let command = request(
        "restore:pending",
        resolve(&inspection, RecoveryChoice::Restore),
    );
    seeded
        .module
        .fail_after_commit
        .store(true, Ordering::SeqCst);
    assert!(seeded.module.apply(&context(), command.clone()).is_err());
    let result = seeded
        .module
        .apply(&context(), command)
        .expect("same restore retry");
    assert!(result.committed.receipt.mutation.duplicate);
    assert_eq!(
        result.committed.value.recovery.unwrap().resolution,
        Some(RecoveryResolution::Restored)
    );
    let after = inspect_draft(&seeded);
    assert!(
        matches!(after.current, Some(RecoveryPreview::Document { ref title, .. }) if title == "Retained edits")
    );
    assert_eq!(after.current_head_seq, Some(2));
}

#[test]
fn copy_has_independent_identities_and_retries_return_the_same_page() {
    let seeded = seeded_module();
    let mut draft = capture(changed_state(&seeded));
    draft.source_store_epoch = "earlier-world".to_owned();
    seeded
        .module
        .apply(
            &context(),
            request(
                "capture:old",
                OwnedDocumentIntent::CaptureRecovery {
                    capture: Box::new(draft),
                },
            ),
        )
        .expect("capture");
    let inspection = inspect_draft(&seeded);
    assert!(!inspection.can_restore);
    assert!(inspection.can_copy);
    let command = request("copy:old", resolve(&inspection, RecoveryChoice::Copy));
    seeded
        .module
        .fail_after_commit
        .store(true, Ordering::SeqCst);
    assert!(seeded.module.apply(&context(), command.clone()).is_err());
    let result = seeded
        .module
        .apply(&context(), command)
        .expect("retry copy");
    let summary = result.committed.value.recovery.unwrap();
    assert_eq!(summary.resolution, Some(RecoveryResolution::Copied));
    assert_ne!(summary.target_document_id.as_deref(), Some(DOCUMENT_ID));
    assert_ne!(summary.target_owner_id.as_deref(), Some(OWNER_BLOCK_ID));
    let after = inspect_draft(&seeded);
    assert_eq!(after.current_head_seq, Some(1));
    seeded
        .kernel
        .readers()
        .read_default(|connection| {
            let count: i64 = connection.query_row(
                "SELECT count(*) FROM pages WHERE document_id = ?1",
                [summary.target_document_id],
                |row| row.get(0),
            )?;
            assert_eq!(count, 1);
            Ok(())
        })
        .expect("one copy");
}

#[test]
fn changes_after_preview_leave_the_draft_pending() {
    let seeded = seeded_module();
    seeded
        .module
        .apply(
            &context(),
            request(
                "capture:preview",
                OwnedDocumentIntent::CaptureRecovery {
                    capture: Box::new(capture(changed_state(&seeded))),
                },
            ),
        )
        .expect("capture");
    let inspection = inspect_draft(&seeded);
    seeded
        .module
        .apply(
            &context(),
            apply_request(
                "canonical:later",
                1,
                title_update(&seeded.full_state, &seeded.state_vector, "Later edit"),
            ),
        )
        .expect("edit");
    assert!(
        seeded
            .module
            .apply(
                &context(),
                request(
                    "restore:stale",
                    resolve(&inspection, RecoveryChoice::Restore)
                )
            )
            .is_err()
    );
    assert!(inspect_draft(&seeded).summary.resolution.is_none());
}

#[test]
fn canvas_draft_restores_only_its_elements_and_preserves_the_other_scene_content() {
    let seeded = canvas_module();
    seeded
        .module
        .apply(
            &context(),
            request(
                "canvas:prepare",
                OwnedDocumentIntent::PrepareOwner {
                    owner_block_id: OWNER_BLOCK_ID.to_owned(),
                },
            ),
        )
        .expect("prepare Canvas");
    let command = canvas_geometry_mutation_request(
        "canvas:initial".to_owned(),
        0,
        vec![
            json!({"id":"existing", "type":"rectangle", "version":1, "versionNonce":1, "index":"a0", "isDeleted":false, "x":10}),
        ],
    );
    seeded
        .module
        .apply(&context(), command)
        .expect("initial Canvas");
    let mutation = json!({ "elementCandidates": [{ "id":"recovered", "type":"rectangle", "version":1, "versionNonce":7, "index":"a1", "isDeleted":false, "x":20 }], "appStateIntents":{}, "fileAdditions":{} });
    let scene = seeded
        .kernel
        .readers()
        .read_default(|connection| {
            let authority = read_document_authority(connection, DOCUMENT_ID)?.unwrap();
            Ok(load_canvas_scene(connection, &authority)?
                .scene
                .canonical_value())
        })
        .expect("scene");
    let mut capture = capture(vec![]);
    capture.schema_key = crate::document::CANVAS_SCHEMA_KEY.to_owned();
    capture.schema_version = crate::document::CANVAS_SCHEMA_VERSION;
    capture.content = RecoveryDraftContent::Canvas {
        scene: Some(scene),
        mutations: vec![mutation],
    };
    seeded
        .module
        .apply(
            &context(),
            request(
                "capture:canvas",
                OwnedDocumentIntent::CaptureRecovery {
                    capture: Box::new(capture),
                },
            ),
        )
        .expect("capture Canvas");
    let inspection = inspect_draft(&seeded);
    assert!(inspection.can_restore);
    assert!(!inspection.already_saved);
    seeded
        .module
        .apply(
            &context(),
            request(
                "restore:canvas",
                resolve(&inspection, RecoveryChoice::Restore),
            ),
        )
        .expect("restore Canvas");
    let after = inspect_draft(&seeded);
    assert_eq!(after.summary.resolution, Some(RecoveryResolution::Restored));
    let Some(RecoveryPreview::Canvas { scene, .. }) = after.current else {
        panic!("Canvas preview");
    };
    assert_eq!(scene["elements"].as_array().unwrap().len(), 2);
}

#[test]
fn missing_source_is_discoverable_only_through_its_library_and_can_be_discarded() {
    let seeded = seeded_module();
    let mut draft = capture(changed_state(&seeded));
    draft.document_id = "document:removed".to_owned();
    let library = library_context_for("recovery:library", AdapterKind::Test);
    seeded
        .module
        .apply(
            &library,
            request(
                "capture:removed",
                OwnedDocumentIntent::CaptureRecovery {
                    capture: Box::new(draft),
                },
            ),
        )
        .expect("retain removed source");
    assert!(
        seeded
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::Recovery {
                        read: RecoveryRead::Inspect {
                            draft_id: "draft:test".to_owned()
                        }
                    }
                }
            )
            .is_err()
    );
    let result = seeded
        .module
        .read(
            &library,
            ModuleReadRequest {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                read: OwnedDocumentRead::Recovery {
                    read: RecoveryRead::Inspect {
                        draft_id: "draft:test".to_owned(),
                    },
                },
            },
        )
        .expect("Library recovery");
    let OwnedDocumentReadValue::Recovery {
        value: RecoveryReadValue::Inspect { inspection },
    } = result.value
    else {
        panic!("inspection");
    };
    assert!(inspection.can_copy);
    assert!(!inspection.can_restore);
    seeded
        .module
        .apply(
            &library,
            request(
                "discard:removed",
                resolve(&inspection, RecoveryChoice::Discard),
            ),
        )
        .expect("discard detached");
}

#[test]
fn pending_count_includes_drafts_beyond_the_summary_page_and_corrupt_bytes_remain_exportable() {
    let seeded = seeded_module();
    let saved = capture(seeded.full_state.clone());
    seeded
        .module
        .apply(
            &context(),
            request(
                "capture:first",
                OwnedDocumentIntent::CaptureRecovery {
                    capture: Box::new(saved),
                },
            ),
        )
        .expect("saved draft");
    let mut corrupt = capture(vec![255, 128]);
    corrupt.draft_id = "draft:zzz".to_owned();
    seeded
        .module
        .apply(
            &context(),
            request(
                "capture:corrupt",
                OwnedDocumentIntent::CaptureRecovery {
                    capture: Box::new(corrupt),
                },
            ),
        )
        .expect("retain undecodable bytes");
    let result = seeded
        .module
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                read: OwnedDocumentRead::Recovery {
                    read: RecoveryRead::List {
                        document_id: Some(DOCUMENT_ID.to_owned()),
                        include_resolved: true,
                        before: None,
                        limit: 1,
                    },
                },
            },
        )
        .expect("bounded list");
    let OwnedDocumentReadValue::Recovery {
        value: RecoveryReadValue::List { page },
    } = result.value
    else {
        panic!("list");
    };
    assert_eq!(page.drafts.len(), 1);
    assert_eq!(page.pending_count, 1);
    assert!(page.next_cursor.is_some());
}

#[test]
fn conflicting_canvas_draft_copies_the_retained_intent_without_overwriting_the_current_element() {
    let seeded = canvas_module();
    seeded
        .module
        .apply(
            &context(),
            request(
                "canvas:prepare",
                OwnedDocumentIntent::PrepareOwner {
                    owner_block_id: OWNER_BLOCK_ID.to_owned(),
                },
            ),
        )
        .expect("prepare Canvas");
    let current = json!({ "id":"element", "type":"rectangle", "version":3, "versionNonce":9, "index":"a0", "isDeleted":false, "x":30 });
    seeded
        .module
        .apply(
            &context(),
            canvas_geometry_mutation_request("canvas:newer".to_owned(), 0, vec![current.clone()]),
        )
        .expect("current scene");
    let retained = json!({ "id":"element", "type":"rectangle", "version":2, "versionNonce":7, "index":"a0", "isDeleted":false, "x":20 });
    let mut draft = capture(vec![]);
    draft.schema_key = crate::document::CANVAS_SCHEMA_KEY.to_owned();
    draft.schema_version = crate::document::CANVAS_SCHEMA_VERSION;
    draft.content = RecoveryDraftContent::Canvas {
        scene: Some({
            let mut scene = crate::document::canvas_scene::CanvasScene::empty().canonical_value();
            scene["elements"] = json!([current]);
            scene
        }),
        mutations: vec![
            json!({ "elementCandidates":[retained], "appStateIntents":{}, "fileAdditions":{} }),
        ],
    };
    seeded
        .module
        .apply(
            &context(),
            request(
                "capture:canvas-conflict",
                OwnedDocumentIntent::CaptureRecovery {
                    capture: Box::new(draft),
                },
            ),
        )
        .expect("capture");
    let inspection = inspect_draft(&seeded);
    assert!(!inspection.can_restore);
    assert!(inspection.can_copy);
    assert!(!inspection.already_saved);
    let Some(RecoveryPreview::Canvas { scene, .. }) = &inspection.retained else {
        panic!("retained scene");
    };
    assert_eq!(scene["elements"][0]["x"], 20);
    let result = seeded
        .module
        .apply(
            &context(),
            request("copy:canvas", resolve(&inspection, RecoveryChoice::Copy)),
        )
        .expect("independent Canvas copy");
    let target = result
        .committed
        .value
        .recovery
        .unwrap()
        .target_document_id
        .unwrap();
    seeded
        .kernel
        .readers()
        .read_default(|connection| {
            let authority = read_document_authority(connection, &target)?.unwrap();
            assert_eq!(
                load_canvas_scene(connection, &authority)?.scene.elements[0].value["x"],
                20
            );
            let original = read_document_authority(connection, DOCUMENT_ID)?.unwrap();
            assert_eq!(
                load_canvas_scene(connection, &original)?.scene.elements[0].value["x"],
                30
            );
            Ok(())
        })
        .expect("both scenes");
}

#[test]
fn handled_retention_releases_only_expired_drafts_and_their_resource_roots() {
    let seeded = seeded_module();
    seeded
        .module
        .apply(
            &context(),
            request(
                "capture:retention",
                OwnedDocumentIntent::CaptureRecovery {
                    capture: Box::new(capture(changed_state(&seeded))),
                },
            ),
        )
        .expect("capture");
    seeded.kernel.writer().call(|connection| {
        let roots: i64 = connection.query_row("SELECT count(*) FROM document_recovery_block_roots WHERE draft_id = 'draft:test'", [], |row| row.get(0))?;
        assert!(roots > 0);
        connection.execute("UPDATE document_recovery_drafts SET created_at = '2000-01-01', received_at = '2000-01-01'", [])?;
        super::super::recovery_drafts::prune_resolved(connection, LIBRARY_ID)?;
        assert_eq!(connection.query_row("SELECT count(*) FROM document_recovery_drafts", [], |row| row.get::<_, i64>(0))?, 1);
        Ok(())
    }).expect("pending retained indefinitely");
    seeded
        .module
        .apply(
            &context(),
            request(
                "discard:retention",
                resolve(&inspect_draft(&seeded), RecoveryChoice::Discard),
            ),
        )
        .expect("discard");
    seeded
        .kernel
        .writer()
        .call(|connection| {
            connection.execute(
                "UPDATE document_recovery_drafts SET resolved_at = '2000-01-01'",
                [],
            )?;
            super::super::recovery_drafts::prune_resolved(connection, LIBRARY_ID)?;
            assert_eq!(
                connection.query_row(
                    "SELECT count(*) FROM document_recovery_drafts",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            assert_eq!(
                connection.query_row(
                    "SELECT count(*) FROM document_recovery_block_roots",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .expect("expired handled drafts release their roots");
}

#[test]
fn recovery_metadata_reaches_live_audiences_without_document_update_resources() {
    let seeded = seeded_module();
    let captured = seeded
        .module
        .apply(
            &context(),
            request(
                "capture:delivery",
                OwnedDocumentIntent::CaptureRecovery {
                    capture: Box::new(capture(changed_state(&seeded))),
                },
            ),
        )
        .expect("capture");
    let restored = seeded
        .module
        .apply(
            &context(),
            request(
                "restore:delivery",
                resolve(&inspect_draft(&seeded), RecoveryChoice::Restore),
            ),
        )
        .expect("restore");
    let log = crate::infrastructure::event_log::CoreEventLog::new(seeded.kernel.readers());
    let host = library_context_for("host:recovery-delivery", AdapterKind::ElectronHost);
    let scopes = [
        nodex_core_contracts::DeliveryAuthorizationScope::Library {
            library_id: LIBRARY_ID.to_owned(),
        },
        nodex_core_contracts::DeliveryAuthorizationScope::Project {
            library_id: LIBRARY_ID.to_owned(),
            project_id: PROJECT_ID.to_owned(),
        },
    ];
    for commit in [captured.committed.commit_seq, restored.committed.commit_seq] {
        let packets = log
            .authorized_projection_live_packets(commit, &host, &scopes)
            .expect("live packets");
        assert_eq!(packets.len(), 2);
        for packet in packets {
            assert!(
                packet.document_effects.is_empty(),
                "live metadata must not duplicate the engine stream"
            );
            assert!(packet.atoms.iter().any(|atom| matches!(&atom.payload,
                nodex_core_contracts::DeliveryAtomPayload::OwnedDocument { event: nodex_core_contracts::AuthorizedOwnedDocumentEvent::RecoveryChanged { document_id, .. }, .. } if document_id == DOCUMENT_ID
            )), "both authorized audiences must observe resolution metadata");
        }
    }
}

#[test]
fn canvas_draft_restores_or_copies_its_captured_file_after_shared_update_and_revocation() {
    use nodex_core_contracts::library::{
        LIBRARY_CONTRACT_VERSION, LibraryFileChange, LibraryFileReadSource, LibraryIntent,
        LibraryProjectAccessChange, LibraryResourceTarget,
    };
    for (choice, trashed) in [
        (RecoveryChoice::Restore, false),
        (RecoveryChoice::Copy, false),
        (RecoveryChoice::Restore, true),
        (RecoveryChoice::Copy, true),
    ] {
        let seeded = canvas_module();
        seeded
            .module
            .apply(
                &context(),
                request(
                    "canvas:prepare",
                    OwnedDocumentIntent::PrepareOwner {
                        owner_block_id: OWNER_BLOCK_ID.to_owned(),
                    },
                ),
            )
            .unwrap();
        create_canvas_file(&seeded, "canvas-image", b"alpha");
        let library = crate::library::LibraryModule::new(PROFILE_ID, LIBRARY_ID, &seeded.kernel);
        let scene = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let authority = read_document_authority(connection, DOCUMENT_ID)?.unwrap();
                Ok(load_canvas_scene(connection, &authority)?
                    .scene
                    .canonical_value())
            })
            .unwrap();
        let mut package = capture(vec![]);
        package.base_head_seq = 0;
        package.schema_key = crate::document::CANVAS_SCHEMA_KEY.to_owned();
        package.schema_version = crate::document::CANVAS_SCHEMA_VERSION;
        package.content = RecoveryDraftContent::Canvas {
            scene: Some(scene),
            mutations: vec![json!({
                "elementCandidates":[{"id":"image-retained", "type":"image", "version":1, "versionNonce":1, "isDeleted":false, "fileId":"slot-retained"}],
                "appStateIntents":{}, "fileAdditions":{"slot-retained":{"id":"slot-retained", "mimeType":"image/png", "source":"nodex://files/canvas-image", "fileVersion":1, "defaultName":"image.png"}}
            })],
        };
        seeded
            .module
            .apply(
                &context(),
                request(
                    "capture:canvas-file",
                    OwnedDocumentIntent::CaptureRecovery {
                        capture: Box::new(package),
                    },
                ),
            )
            .unwrap();
        let mut writer = crate::infrastructure::managed_blobs::BlobWriter::new(
            &seeded._directory.path().join("assets"),
            1024,
        )
        .unwrap();
        writer.write_chunk(b"beta").unwrap();
        let published = writer.finish().unwrap();
        let expiry = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60_000;
        let receipt = library
            .register_prepared_file_blob(
                &context(),
                STORE_EPOCH,
                "canvas:replace",
                "canvas:receipt",
                &published.content_hash,
                &published.physical_asset_name,
                published.byte_length,
                expiry,
            )
            .unwrap();
        library
            .apply(
                &context(),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "canvas:replace".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: LibraryIntent::ApplyFileChange {
                        change: LibraryFileChange::ReplaceContent {
                            file_id: "canvas-image".to_owned(),
                            expected_revision: 1,
                            expected_head_version: 1,
                            mime_type: "image/png".to_owned(),
                            prepared_blob_receipt_id: receipt.receipt_id,
                        },
                        turn_id: None,
                    },
                },
            )
            .unwrap();
        if trashed {
            library
                .apply(
                    &context(),
                    ModuleApplyRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        operation_id: "canvas:trash".to_owned(),
                        store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                        intent: LibraryIntent::ApplyFileChange {
                            change: LibraryFileChange::Trash {
                                file_id: "canvas-image".to_owned(),
                                expected_revision: 2,
                            },
                            turn_id: None,
                        },
                    },
                )
                .unwrap();
        }
        library
            .apply(
                &library_context_for("revoke", AdapterKind::Test),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "canvas:revoke".to_owned(),
                    store_epoch: StoreEpoch(STORE_EPOCH.to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::File {
                            file_id: "canvas-image".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: PROJECT_ID.to_owned(),
                            access: None,
                            expected_revision: Some(1),
                        }],
                    },
                },
            )
            .unwrap();
        let source = LibraryFileReadSource::CanvasRecovery {
            document_id: DOCUMENT_ID.to_owned(),
            draft_id: "draft:test".to_owned(),
            scene_file_id: "slot-retained".to_owned(),
        };
        let blob = library
            .resolve_file_blob(&context(), "canvas-image", &source, None)
            .unwrap();
        assert_eq!(fs::read(blob.physical_path).unwrap(), b"alpha");
        assert!(
            library
                .resolve_file_blob(&context(), "canvas-image", &source, Some(2))
                .is_err()
        );
        let inspection = inspect_draft(&seeded);
        assert!(
            inspection.can_copy && inspection.can_restore,
            "{:?}",
            inspection.explanation
        );
        let command = request("resolve:canvas-file", resolve(&inspection, choice));
        let result = seeded.module.apply(&context(), command.clone()).unwrap();
        let summary = result.committed.value.recovery.unwrap();
        let target = summary.target_owner_id.unwrap();
        let restored_id = seeded.kernel.readers().read_default(|connection| {
            connection.query_row("SELECT reference.target_file_id FROM canvas_scene_file_refs reference WHERE reference.owner_block_id = ?1 AND reference.file_id = 'slot-retained'", [&target], |row| row.get::<_, String>(0)).map_err(StoreError::from)
        }).unwrap();
        assert_eq!(restored_id == "canvas-image", !trashed);
        let bytes = library
            .resolve_file_blob(
                &context(),
                &restored_id,
                &LibraryFileReadSource::Canvas {
                    canvas_id: target.clone(),
                    scene_file_id: "slot-retained".to_owned(),
                },
                None,
            )
            .unwrap();
        assert_eq!(fs::read(bytes.physical_path).unwrap(), b"alpha");
        let replay = seeded.module.apply(&context(), command).unwrap();
        assert_eq!(
            replay.committed.value.recovery.unwrap().target_owner_id,
            Some(target)
        );
        assert!(replay.events.is_empty());
        seeded
            .kernel
            .readers()
            .read_default(move |connection| {
                let count =
                    connection.query_row("SELECT count(*) FROM library_files", [], |row| {
                        row.get::<_, i64>(0)
                    })?;
                assert_eq!(
                    count,
                    if trashed { 2 } else { 1 },
                    "only a trashed fixed target needs a new File"
                );
                Ok(())
            })
            .unwrap();
    }
}

#[test]
fn canvas_recovery_rebuilds_missing_slots_but_never_reuses_a_changed_binding() {
    for changed_binding in [false, true] {
        let seeded = canvas_module();
        seeded
            .module
            .apply(
                &context(),
                request(
                    "prepare",
                    OwnedDocumentIntent::PrepareOwner {
                        owner_block_id: OWNER_BLOCK_ID.to_owned(),
                    },
                ),
            )
            .unwrap();
        create_canvas_file(&seeded, "original-image", b"original");
        create_canvas_file(&seeded, "other-image", b"other");
        let image = |id: &str, version: i64| json!({"id":id,"type":"image","version":version,"versionNonce":1,"isDeleted":false,"fileId":"slot"});
        let binding = |file: &str| json!({"id":"slot","mimeType":"image/png","source":format!("nodex://files/{file}"),"fileVersion":1,"defaultName":"image.png"});
        let apply = |operation: &str, head: i64, elements: Vec<Value>, files: Value| {
            seeded.module.apply(&context(), request(operation, OwnedDocumentIntent::ApplyCanvasMutation {
                document_id: DOCUMENT_ID.to_owned(), generation:1, expected_head_seq:head,
                mutation:json!({"elementCandidates":elements,"appStateIntents":{},"fileAdditions":files}),
            })).unwrap();
        };
        apply(
            "initial",
            0,
            vec![image("existing", 1)],
            json!({"slot":binding("original-image")}),
        );
        let scene = seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let authority = read_document_authority(connection, DOCUMENT_ID)?.unwrap();
                Ok(load_canvas_scene(connection, &authority)?
                    .scene
                    .canonical_value())
            })
            .unwrap();
        let mut package = capture(vec![]);
        package.schema_key = crate::document::CANVAS_SCHEMA_KEY.to_owned();
        package.schema_version = crate::document::CANVAS_SCHEMA_VERSION;
        package.content = RecoveryDraftContent::Canvas {
            scene: Some(scene),
            mutations: vec![
                json!({"elementCandidates":[image("retained",1)],"appStateIntents":{},"fileAdditions":{}}),
            ],
        };
        seeded
            .module
            .apply(
                &context(),
                request(
                    "capture",
                    OwnedDocumentIntent::CaptureRecovery {
                        capture: Box::new(package),
                    },
                ),
            )
            .unwrap();
        let mut deleted = image("existing", 2);
        deleted["isDeleted"] = json!(true);
        apply("remove", 1, vec![deleted], json!({}));
        if changed_binding {
            apply(
                "reuse-slot",
                2,
                vec![image("unrelated", 1)],
                json!({"slot":binding("other-image")}),
            );
        }
        let inspection = inspect_draft(&seeded);
        assert!(inspection.can_copy, "{:?}", inspection.explanation);
        assert_eq!(
            inspection.can_restore, !changed_binding,
            "{:?}",
            inspection.explanation
        );
        let choice = if changed_binding {
            RecoveryChoice::Copy
        } else {
            RecoveryChoice::Restore
        };
        let result = seeded
            .module
            .apply(&context(), request("resolve", resolve(&inspection, choice)))
            .unwrap();
        let document = result
            .committed
            .value
            .recovery
            .unwrap()
            .target_document_id
            .unwrap();
        seeded
            .kernel
            .readers()
            .read_default(|connection| {
                let authority = read_document_authority(connection, &document)?.unwrap();
                let scene = load_canvas_scene(connection, &authority)?.scene;
                assert_eq!(scene.files["slot"].target_file_id, "original-image");
                assert!(
                    scene
                        .elements
                        .iter()
                        .any(|element| element.id == "retained")
                );
                Ok(())
            })
            .unwrap();
    }
}
