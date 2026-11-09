use super::*;
use nodex_core_contracts::ModuleReadRequest;
use nodex_core_contracts::agent::AgentBackendKind;
use nodex_core_contracts::library::{
    LibraryFileChange, LibraryFileReadSource, LibraryPageFileAttachment,
    LibraryPageFileAttachmentActor as Actor, LibraryPageFileCollisionPolicy,
    LibraryPageFileEntryChange as Change, LibraryPageFileInventory, LibraryPageFileItem,
    LibraryPageFileSelector, LibraryRead, LibraryReadValue,
};

fn apply_as(
    module: &crate::library::LibraryModule,
    adapter: AdapterKind,
    operation: &str,
    intent: LibraryIntent,
) -> Result<crate::library::LibraryApplyOutcome, nodex_core_contracts::CoreError> {
    let mut context = bound_context(Some("project-1"));
    context.adapter = adapter;
    module.apply(
        &context,
        ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: operation.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent,
        },
    )
}

fn changes(page: &str, revision: i64, changes: Vec<Change>) -> LibraryIntent {
    LibraryIntent::ApplyPageFileEntries {
        page_id: page.to_owned(),
        expected_manifest_revision: revision,
        changes,
        turn_id: None,
    }
}

fn attach(file: &str, path: &str) -> Change {
    Change::Attach {
        file_id: file.to_owned(),
        logical_path: path.to_owned(),
        source: LibraryFileReadSource::Direct,
        collision_policy: LibraryPageFileCollisionPolicy::Reject,
    }
}

pub(super) fn inventory(
    module: &crate::library::LibraryModule,
    page: &str,
) -> LibraryPageFileInventory {
    let value = module
        .read(
            &bound_context(Some("project-1")),
            ModuleReadRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                read: LibraryRead::PageFileInventory {
                    page_id: page.to_owned(),
                    query: None,
                    cursor: None,
                    limit: None,
                },
            },
        )
        .unwrap()
        .value;
    let LibraryReadValue::PageFileInventory { value } = value else {
        panic!("Page File inventory");
    };
    value
}

fn resolve(
    module: &crate::library::LibraryModule,
    page: &str,
    selector: LibraryPageFileSelector,
) -> LibraryPageFileItem {
    let value = module
        .read(
            &bound_context(Some("project-1")),
            ModuleReadRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                read: LibraryRead::ResolvePageFile {
                    page_id: page.to_owned(),
                    selector,
                },
            },
        )
        .unwrap()
        .value;
    let LibraryReadValue::ResolvedPageFile { value } = value else {
        panic!("Page File selection");
    };
    value
}

#[test]
fn desktop_attach_stamps_commit_time_and_exact_retry_retains_it() {
    let fixture = fixture();
    let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
    create_image(&fixture, &module);
    place_image(&fixture, &module, "page-a");
    let selector = LibraryPageFileSelector::FileId {
        file_id: "file-a".to_owned(),
    };
    let body_only = resolve(&module, "page-a", selector.clone());
    assert!(body_only.logical_path.is_none());
    assert!(body_only.attachment.is_none());
    assert_eq!(inventory(&module, "page-a").files, vec![body_only]);

    let intent = changes("page-a", 0, vec![attach("file-a", "images/output.png")]);
    let attached = apply_as(
        &module,
        AdapterKind::ElectronHost,
        "person-attach",
        intent.clone(),
    )
    .unwrap();
    let selected = resolve(
        &module,
        "page-a",
        LibraryPageFileSelector::Path {
            logical_path: "images/output.png".to_owned(),
        },
    );
    let evidence = selected.attachment.clone().unwrap();
    assert_eq!(evidence.attached_by, member_actor(&fixture));
    assert_eq!(
        evidence.attached_at.as_deref(),
        Some(attached.committed.receipt.committed_at.as_str())
    );
    chrono::DateTime::parse_from_rfc3339(evidence.attached_at.as_ref().unwrap()).unwrap();
    assert_eq!(selected.body_count, 1);
    assert_eq!(inventory(&module, "page-a").files, vec![selected]);
    let replay = apply_as(&module, AdapterKind::ElectronHost, "person-attach", intent).unwrap();
    assert!(replay.committed.receipt.mutation.duplicate);
    assert_eq!(
        replay.committed.receipt.committed_at,
        attached.committed.receipt.committed_at
    );
    assert_eq!(
        resolve(&module, "page-a", selector.clone()).attachment,
        Some(evidence.clone())
    );

    apply_as(
        &module,
        AdapterKind::ElectronHost,
        "remove-entry",
        changes(
            "page-a",
            1,
            vec![Change::Remove {
                file_id: "file-a".to_owned(),
            }],
        ),
    )
    .unwrap();
    assert!(
        resolve(&module, "page-a", selector.clone())
            .attachment
            .is_none()
    );
    let readded = apply_as(
        &module,
        AdapterKind::NativeCli,
        "external-reattach",
        changes("page-a", 2, vec![attach("file-a", "again.png")]),
    )
    .unwrap();
    assert_eq!(
        resolve(&module, "page-a", selector).attachment,
        Some(LibraryPageFileAttachment {
            attached_by: member_actor(&fixture),
            attached_at: Some(readded.committed.receipt.committed_at),
        })
    );
}

#[test]
fn verified_agent_attribution_names_the_attaching_session_on_any_adapter() {
    let fixture = fixture();
    let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
    create_image(&fixture, &module);
    let mut context = bound_context(Some("project-1"));
    fixture.kernel.writer().call(|c| { c.execute("INSERT INTO project_sessions(id,project_id,no_thread_fallback_title,created_at,updated_at,activity_at) VALUES('session:cold-start','project-1','Work',?1,?1,CAST(round(unixepoch(?1,'subsec')*1000) AS INTEGER))",[NOW])?; Ok(()) }).unwrap();
    context.adapter = AdapterKind::NativeCli;
    context.agent_attribution = Some(nodex_core_contracts::BoundAgentAttribution {
        run_id: None,
        session_id: "session:cold-start".to_owned(),
        backend: AgentBackendKind::OpenCode,
    });
    let committed = module
        .apply(
            &context,
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: "agent-attach".to_owned(),
                store_epoch: StoreEpoch("epoch-1".to_owned()),
                intent: changes(
                    "page-a",
                    0,
                    vec![attach("file-a", "profile/flamegraph.png")],
                ),
            },
        )
        .unwrap();
    assert_eq!(
        resolve(
            &module,
            "page-a",
            LibraryPageFileSelector::FileId {
                file_id: "file-a".to_owned()
            }
        )
        .attachment,
        Some(LibraryPageFileAttachment {
            attached_by: Actor::Agent {
                session_id: "session:cold-start".to_owned(),
                run_id: None,
                on_behalf_of: member_actor(&fixture).member_id().unwrap().to_owned(),
            },
            attached_at: Some(committed.committed.receipt.committed_at),
        })
    );
}

#[test]
fn swaps_transfers_and_shared_updates_preserve_captured_agent_binding() {
    let fixture = fixture();
    let original = LibraryPageFileAttachment {
        attached_by: Actor::Agent {
            session_id: "session:product-chat".to_owned(),
            run_id: None,
            on_behalf_of: member_actor(&fixture).member_id().unwrap().to_owned(),
        },
        attached_at: Some(NOW.to_owned()),
    };
    let seed = original.clone();
    write(&fixture, "seed-provenance", move |context| {
        import(context, "file-a")?;
        import(context, "file-b")?;
        entries::add(&entry(context, "page-a", 0), "file-a", "a.txt", &seed)?;
        entries::add(
            &entry(context, "page-a", 1),
            "file-b",
            "b.txt",
            &external_attachment(),
        )?;
        Ok(())
    })
    .unwrap();
    let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
    let before = inventory(&module, "page-a");
    let conflicting = changes(
        "page-a",
        2,
        vec![Change::Rename {
            file_id: "file-a".to_owned(),
            logical_path: "b.txt".to_owned(),
        }],
    );
    assert!(
        apply_as(
            &module,
            AdapterKind::ElectronHost,
            "conflicting-rename",
            conflicting
        )
        .is_err()
    );
    assert_eq!(inventory(&module, "page-a"), before);
    let swapped = changes(
        "page-a",
        2,
        vec![
            Change::Rename {
                file_id: "file-a".to_owned(),
                logical_path: "b.txt".to_owned(),
            },
            Change::Rename {
                file_id: "file-b".to_owned(),
                logical_path: "a.txt".to_owned(),
            },
        ],
    );
    apply_as(
        &module,
        AdapterKind::ElectronHost,
        "swap-provenance",
        swapped,
    )
    .unwrap();
    let after = inventory(&module, "page-a");
    assert_eq!(after.files[0].attachment, Some(external_attachment()));
    assert_eq!(after.files[1].attachment, Some(original.clone()));
    let unchanged = apply_as(
        &module,
        AdapterKind::ElectronHost,
        "same-file-retarget",
        changes(
            "page-a",
            3,
            vec![Change::Retarget {
                file_id: "file-a".to_owned(),
                replacement_file_id: "file-a".to_owned(),
                source: LibraryFileReadSource::Direct,
            }],
        ),
    )
    .unwrap();
    assert!(!unchanged.committed.receipt.did_mutate);
    assert_eq!(inventory(&module, "page-a"), after);
    apply_as(
        &module,
        AdapterKind::NativeCli,
        "copy-provenance",
        LibraryIntent::TransferPageFileEntry {
            file_id: "file-a".to_owned(),
            source_page_id: "page-a".to_owned(),
            source_manifest_revision: 3,
            target_page_id: "page-b".to_owned(),
            target_manifest_revision: 0,
            target_logical_path: "copied.txt".to_owned(),
            copy: true,
        },
    )
    .unwrap();
    assert_eq!(
        inventory(&module, "page-b").files[0].attachment,
        Some(original.clone())
    );
    apply_as(
        &module,
        AdapterKind::ElectronHost,
        "remove-copied-provenance",
        changes(
            "page-b",
            1,
            vec![Change::Remove {
                file_id: "file-a".to_owned(),
            }],
        ),
    )
    .unwrap();
    apply_as(
        &module,
        AdapterKind::ElectronHost,
        "move-provenance",
        LibraryIntent::TransferPageFileEntry {
            file_id: "file-a".to_owned(),
            source_page_id: "page-a".to_owned(),
            source_manifest_revision: 3,
            target_page_id: "page-b".to_owned(),
            target_manifest_revision: 2,
            target_logical_path: "moved.txt".to_owned(),
            copy: false,
        },
    )
    .unwrap();
    assert_eq!(
        inventory(&module, "page-b").files[0].attachment,
        Some(original.clone())
    );
    prepare(
        &fixture,
        "shared-provenance-update",
        "shared-provenance-bytes",
        b"beta",
    );
    apply_intent(
        &module,
        "shared-provenance-update",
        LibraryIntent::ApplyFileChange {
            change: LibraryFileChange::ReplaceContent {
                file_id: "file-a".to_owned(),
                expected_revision: 1,
                expected_head_version: 1,
                mime_type: "text/plain".to_owned(),
                prepared_blob_receipt_id: "shared-provenance-bytes".to_owned(),
            },
            turn_id: None,
        },
    );
    apply_intent(
        &module,
        "shared-provenance-rename",
        LibraryIntent::ApplyFileChange {
            change: LibraryFileChange::Rename {
                file_id: "file-a".to_owned(),
                expected_revision: 2,
                default_name: "renamed.txt".to_owned(),
            },
            turn_id: None,
        },
    );
    assert_eq!(
        inventory(&module, "page-b").files[0].attachment,
        Some(original)
    );
    let retargeted = apply_as(
        &module,
        AdapterKind::ElectronHost,
        "retarget-provenance",
        changes(
            "page-b",
            3,
            vec![Change::Retarget {
                file_id: "file-a".to_owned(),
                replacement_file_id: "file-b".to_owned(),
                source: LibraryFileReadSource::Direct,
            }],
        ),
    )
    .unwrap();
    let replacement = &inventory(&module, "page-b").files[0];
    assert_eq!(
        replacement.attachment,
        Some(LibraryPageFileAttachment {
            attached_by: member_actor(&fixture),
            attached_at: Some(retargeted.committed.receipt.committed_at),
        })
    );
}

#[test]
fn structural_delete_undo_and_redo_preserve_entry_attachment_evidence() {
    use nodex_core_contracts::library::{
        LibraryDocumentHead, LibraryStructuralDeleteDirection, LibraryStructuralDeleteReason,
        LibraryStructuralEditCommand, LibraryStructuralSelection,
    };
    let fixture = fixture();
    let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
    create_image(&fixture, &module);
    let parent = page_content(&module, "page-a");
    apply_intent(
        &module,
        "create-provenance-child",
        LibraryIntent::CreatePage {
            page_id: "page-child".to_owned(),
            document_id: "document:child".to_owned(),
            title: "Child".to_owned(),
            parent: LibraryWriteParent::Page {
                page_id: "page-a".to_owned(),
                expected_document_generation: parent.document_generation,
                expected_document_head_seq: parent.document_head_seq,
                before: None,
                insertion: None,
            },
        },
    );
    apply_as(
        &module,
        AdapterKind::ElectronHost,
        "attach-child-provenance",
        changes("page-child", 0, vec![attach("file-a", "child.png")]),
    )
    .unwrap();
    let original = inventory(&module, "page-child").files[0].attachment.clone();
    let parent = page_content(&module, "page-a");
    let deleted = apply_intent(
        &module,
        "delete-provenance-child",
        LibraryIntent::ApplyStructuralEdit {
            command: Box::new(LibraryStructuralEditCommand::DeleteSelection {
                selection: LibraryStructuralSelection {
                    source_document_id: parent.document_id.clone(),
                    root_block_ids: vec!["page-child".to_owned()],
                    source_head: LibraryDocumentHead {
                        document_id: parent.document_id,
                        generation: parent.document_generation,
                        head_seq: parent.document_head_seq,
                    },
                },
                reason: LibraryStructuralDeleteReason::Delete,
                direction: LibraryStructuralDeleteDirection::Backward,
            }),
        },
    )
    .committed
    .value
    .structural_edit
    .unwrap();
    let restored = apply_intent(
        &module,
        "undo-provenance-child",
        LibraryIntent::ReverseStructuralEdit {
            token: deleted.history.unwrap(),
        },
    )
    .committed
    .value
    .structural_edit
    .unwrap();
    assert_eq!(
        inventory(&module, "page-child").files[0].attachment,
        original
    );
    let redone = apply_intent(
        &module,
        "redo-provenance-child",
        LibraryIntent::ReverseStructuralEdit {
            token: restored.history.unwrap(),
        },
    )
    .committed
    .value
    .structural_edit
    .unwrap();
    apply_intent(
        &module,
        "undo-again-provenance-child",
        LibraryIntent::ReverseStructuralEdit {
            token: redone.history.unwrap(),
        },
    );
    assert_eq!(
        inventory(&module, "page-child").files[0].attachment,
        original
    );
}

#[test]
fn retained_entry_evidence_without_provenance_decodes_as_unknown_without_time() {
    let entry: crate::library::page_file_entries::EntryReplacement =
        serde_json::from_value(serde_json::json!({
            "fileId": "historical-file", "logicalPath": "historical.txt",
        }))
        .unwrap();
    assert_eq!(
        entry.attachment,
        LibraryPageFileAttachment {
            attached_by: Actor::Service {
                kind: nodex_core_contracts::ServiceKind::Maintenance
            },
            attached_at: None
        }
    );
}
