use nodex_core_contracts::document::EditorHistoryPatch;

use super::*;
use crate::document::editor_history::prepare_editor_history;

#[allow(clippy::too_many_arguments)]
pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    document_id: &str,
    generation: i64,
    patch: &EditorHistoryPatch,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = &structural_actor_project_id(connection, context)?;
    let now = sqlite_now(connection)?;
    let committed = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: "library",
            operation_id,
            intent_hash: request_hash,
            store_epoch,
            committed_at: &now,
            context,
        },
        |scope| {
            let applied = transition(
                StructuralWriteContext {
                    connection,
                    context,
                    operation_id,
                    store_epoch,
                    commit: scope.evidence(),
                },
                document_id,
                generation,
                patch,
            )?;
            let recipe = StructuralHistoryRecipe {
                version: RECIPE_VERSION,
                action: applied.inverse.clone(),
            };
            let (history, recipe_payload) = history_token(operation_id, store_epoch, &recipe)?;
            let snapshots = transition_snapshot_refs(&applied);
            let result = structural_result(
                "restore_editor_history",
                applied.source_root_ids.clone(),
                applied.result_root_ids.clone(),
                BTreeMap::new(),
                BTreeMap::new(),
                &snapshots,
                applied.document_commits.clone(),
                None,
                Some(history.clone()),
                Vec::new(),
                applied.resume.clone(),
            );
            let effects = structural_effects(
                project_id,
                "restore_editor_history",
                &snapshots,
                &result,
                &now,
            );
            seal_mutation_with(
                scope,
                context,
                operation_id,
                effects,
                |_, event_sequence| {
                    persist_structural_mutation_ledger(
                        connection,
                        operation_id,
                        project_id,
                        store_epoch,
                        request_hash,
                        "restore_editor_history",
                        &result,
                        &snapshots,
                        event_sequence,
                        &now,
                    )?;
                    insert_history_recipe(
                        connection,
                        operation_id,
                        library_id,
                        project_id,
                        store_epoch,
                        &history.recipe_hash,
                        &recipe_payload,
                        &snapshots,
                        &now,
                    )
                },
            )
        },
    )?;
    library_commit_result(connection, committed)
}

pub(super) fn transition(
    write: StructuralWriteContext<'_>,
    document_id: &str,
    generation: i64,
    patch: &EditorHistoryPatch,
) -> Result<AppliedTransition, StoreError> {
    let parent = load_parent_document(write.connection, document_id)?;
    if parent.authority.head.library_id != write.context.library_id.0 {
        return Err(unauthorized("History Document belongs to another Library"));
    }
    authorize_parent_write(write.connection, write.context, &parent)?;
    if parent.authority.head.generation != generation {
        return Err(conflict(
            "Local history belongs to another Document generation",
        ));
    }
    let prepared = prepare_editor_history(&parent.base_materialization.block_tree, patch)?;
    let mut blocks = Vec::new();
    let mut first_registrations = BTreeSet::new();
    for change in &patch.changes {
        let row = write.connection.query_row(
            "SELECT b.type, b.lifecycle, b.metadata_revision, b.placement_revision, i.document_id, t.document_id, t.document_generation \
             FROM blocks b LEFT JOIN document_block_index i ON i.block_id = b.id \
             LEFT JOIN document_block_tombstones t ON t.block_id = b.id \
             WHERE b.id = ?1 AND b.library_id = ?2",
            params![change.block_id, parent.authority.head.library_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<i64>>(6)?)),
        ).optional()?;
        let Some(row) = row else {
            if change.after.is_some() || change.before.is_none() {
                return Err(conflict(
                    "Local history Block identity is no longer retained",
                ));
            }
            // Creation followed by deletion can be batched before Core ever
            // sees an active Block. This is first registration, not tombstone
            // resurrection. The canonical Document writer still enforces fresh
            // UUID-v7 identity, global ownership, retired IDs and typed owners.
            first_registrations.insert(change.block_id.clone());
            continue;
        };
        if row.4.as_deref() != Some(document_id)
            && !(row.4.is_none()
                && row.1 == "deleted"
                && row.5.as_deref() == Some(document_id)
                && row.6 == Some(generation))
        {
            return Err(conflict(
                "Local history Block belongs to another Document placement",
            ));
        }
        blocks.push(BlockAuthoritySnapshot {
            block_id: change.block_id.clone(),
            block_type: row.0,
            lifecycle: row.1,
            metadata_revision: row.2,
            placement_revision: row.3,
            containing_document_id: document_id.to_owned(),
            in_host_document: true,
        });
    }
    let reactivations = prepared
        .restored_ids
        .iter()
        .filter(|id| !first_registrations.contains(*id))
        .cloned()
        .collect::<Vec<_>>();
    let commit = persist_parent_operations_detailed_with_local_commit(
        write.connection,
        ParentDocumentWriteContext {
            actor_project_id: &structural_actor_project_id(write.connection, write.context)?,
            store_epoch: write.store_epoch,
            operation_id: write.operation_id,
            commit: write.commit,
        },
        "editor-history",
        &parent,
        &prepared.operations,
        ParentDocumentPlacement::Restore {
            preapplied: &[],
            tombstone_reactivations: &reactivations,
            source_document_id: document_id,
            source_document_generation: generation,
            exact_moves: &prepared.moved_ids,
        },
    )?;
    for block_id in first_registrations {
        let snapshot = write.connection.query_row(
            "SELECT type, lifecycle, metadata_revision, placement_revision FROM blocks WHERE id = ?1",
            [&block_id],
            |row| Ok(BlockAuthoritySnapshot {
                block_id: block_id.clone(), block_type: row.get(0)?, lifecycle: row.get(1)?,
                metadata_revision: row.get(2)?, placement_revision: row.get(3)?,
                containing_document_id: document_id.to_owned(), in_host_document: true,
            }),
        )?;
        blocks.push(snapshot);
    }
    // Only the local group's identities are retained. Unchanged owning
    // Documents are neither snapshotted nor granted overwrite authority.
    let snapshot = OwnershipClosureSnapshot {
        version: SNAPSHOT_VERSION,
        roots: Vec::new(),
        blocks,
        documents: Vec::new(),
        pages: Vec::new(),
        databases: Vec::new(),
        source: StructuralLocation {
            document_id: document_id.to_owned(),
            document_generation: generation,
            host_page_id: parent.authority.owner_block_id.clone(),
            placements: Vec::new(),
            placeholder_block_id: None,
        },
    };
    Ok(AppliedTransition {
        source_root_ids: patch
            .changes
            .iter()
            .filter(|change| change.after.is_some())
            .map(|change| change.block_id.clone())
            .collect(),
        result_root_ids: prepared
            .inverse
            .changes
            .iter()
            .filter(|change| change.after.is_some())
            .map(|change| change.block_id.clone())
            .collect(),
        document_commits: vec![commit],
        inverse: StructuralRecipeAction::RestoreEditorHistory {
            document_id: document_id.to_owned(),
            generation,
            patch: prepared.inverse,
        },
        snapshot,
        additional_snapshots: Vec::new(),
        resume: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;
    use crate::library::LibraryModule;
    use nodex_core_contracts::document::{EditorHistoryBlockChange, EditorHistoryBlockState};
    use nodex_core_contracts::library::{LibraryIntent, LibraryWriteParent};
    use nodex_core_contracts::{
        AdapterKind, LIBRARY_CONTRACT_VERSION, LibraryId, ModuleApplyRequest, ProfileId, ProjectId,
        StoreEpoch,
    };

    #[test]
    fn first_history_registration_preserves_canonical_identity_and_owner_guards() {
        const PAGE: &str = "018f0000-0000-7000-8000-000000000901";
        const OTHER: &str = "018f0000-0000-7000-8000-000000000902";
        const RETIRED: &str = "018f0000-0000-7000-8000-000000000903";
        const FRESH_OWNER: &str = "018f0000-0000-7000-8000-000000000904";
        let directory = tempfile::tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Store");
        kernel.writer().call(|connection| with_immediate_transaction(connection, |transaction| {
            transaction.execute_batch("INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile', 'now', 'now');
                INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library', 'profile', 'now', 'now');
                INSERT INTO projects(id, library_id, name, created, updated) VALUES ('project', 'library', 'History', 'now', 'now');
                INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) VALUES (1, 'epoch', 'now', 'now');")?;
            // Storage-shape fixture: this identity has already been collected.
            transaction.execute("INSERT INTO retired_block_identities(block_id, library_id, block_type, retention_root_block_id, retired_at) VALUES (?1, 'library', 'paragraph', ?1, 'now')", [RETIRED])?;
            Ok(())
        })).expect("seed authority");
        let context = BoundModuleContext {
            profile_id: ProfileId("profile".into()),
            library_id: LibraryId("library".into()),
            project_id: Some(ProjectId("project".into())),
            connection_id: "history-test".into(),
            adapter: AdapterKind::Test,
            editor_history_owner: None,
        };
        let module = LibraryModule::new("profile", "library", &kernel);
        let apply = |intent| {
            module.apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: crate::domain::identity::random_uuid_v7().expect("operation"),
                    store_epoch: StoreEpoch("epoch".into()),
                    intent,
                },
            )
        };
        for (page_id, document_id) in [(PAGE, "document:history"), (OTHER, "document:other")] {
            apply(LibraryIntent::CreatePage {
                page_id: page_id.into(),
                document_id: document_id.into(),
                title: "History".into(),
                parent: LibraryWriteParent::Library { before: None },
            })
            .expect("Page");
        }
        let head = || {
            kernel
                .readers()
                .read_default(|connection| {
                    connection
                        .query_row(
                            "SELECT head_seq FROM documents WHERE id = 'document:history'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )
                        .map_err(Into::into)
                })
                .expect("head")
        };
        let original_head = head();
        let anchor = kernel.readers().read_default(|connection| connection.query_row(
            "SELECT block_id FROM document_block_index WHERE document_id = 'document:history' ORDER BY ordinal LIMIT 1",
            [], |row| row.get::<_, String>(0),
        ).map_err(Into::into)).expect("host paragraph");
        for (id, block_type, message) in [
            (RETIRED, "paragraph", "Retired Block identity"),
            (OTHER, "paragraph", "another Document placement"),
            ("not-a-fresh-uuid", "paragraph", "typed creation"),
            (FRESH_OWNER, "page", "Owning Block history"),
        ] {
            let result = apply(LibraryIntent::ApplyStructuralEdit {
                command: Box::new(LibraryStructuralEditCommand::RestoreEditorHistory {
                    document_id: "document:history".into(),
                    generation: 1,
                    patch: EditorHistoryPatch {
                        changes: vec![EditorHistoryBlockChange {
                            block_id: id.into(),
                            after: None,
                            before: Some(EditorHistoryBlockState {
                                block_type: block_type.into(),
                                props: BTreeMap::from([
                                    ("backgroundColor".into(), serde_json::json!("default")),
                                    ("textColor".into(), serde_json::json!("default")),
                                    ("textAlignment".into(), serde_json::json!("left")),
                                ]),
                                content: Some(serde_json::json!([])),
                                parent_block_id: None,
                                before_block_id: Some(anchor.clone()),
                            }),
                        }],
                    },
                }),
            })
            .expect_err("identity must be rejected");
            assert!(result.message.contains(message), "{}", result.message);
            assert_eq!(head(), original_head, "rejection must be atomic");
        }
    }
}
