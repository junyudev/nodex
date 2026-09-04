use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::library::{
    LibraryFileReadSource, LibraryPageFileCollisionPolicy, LibraryPageFileEntryChange as Change,
    LibraryPageFileEntryReceipt,
};
use nodex_core_contracts::{BoundModuleContext, ModuleName};
use rusqlite::Connection;

use super::files::{self, FileContent, FileWriteContext};
use super::mutation::{self, MutationEffects};
use super::page_file_entries::{self as entries, EntryReplacement, EntryWriteContext};
use crate::domain::file_path::PortablePageFilePath;
use crate::infrastructure::durable_mutation::{self, OperationIdentity};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

// Called only after the durable operation replay check; paths are resolved at commit time.
#[allow(clippy::too_many_arguments)]
pub(super) fn put(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    expected_revision: i64,
    file_id: &str,
    logical_path: &str,
    mime_type: &str,
    prepared_blob_receipt_id: &str,
    replace_entry: bool,
    turn_id: Option<&str>,
) -> Result<super::LibraryApplyOutcome, StoreError> {
    super::page_file_inventory::require_page(connection, context, page_id, true)?;
    let now = mutation::sqlite_now(connection)?;
    entries::require_revision(&EntryWriteContext {
        connection,
        library_id: &context.library_id.0,
        page_id,
        expected_revision,
        now: &now,
    })?;
    let existing = if replace_entry {
        match entries::resolve_path(connection, &context.library_id.0, page_id, logical_path) {
            Ok(entry) => Some(entry),
            Err(error) if error.code == StoreErrorCode::NotFound => None,
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    let change = match existing {
        Some(entry) => Change::Replace {
            file_id: entry.file_id,
            replacement_file_id: file_id.to_owned(),
            mime_type: mime_type.to_owned(),
            prepared_blob_receipt_id: prepared_blob_receipt_id.to_owned(),
        },
        None => Change::Import {
            file_id: file_id.to_owned(),
            logical_path: logical_path.to_owned(),
            mime_type: mime_type.to_owned(),
            prepared_blob_receipt_id: prepared_blob_receipt_id.to_owned(),
            collision_policy: LibraryPageFileCollisionPolicy::Reject,
        },
    };
    apply_with_kind(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        page_id,
        expected_revision,
        &[change],
        turn_id,
        "put_page_file_entry",
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    expected_revision: i64,
    changes: &[Change],
    turn_id: Option<&str>,
) -> Result<super::LibraryApplyOutcome, StoreError> {
    apply_with_kind(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        page_id,
        expected_revision,
        changes,
        turn_id,
        "apply_page_file_entries",
    )
}

#[allow(clippy::too_many_arguments)]
fn apply_with_kind(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    expected_revision: i64,
    changes: &[Change],
    turn_id: Option<&str>,
    operation_kind: &'static str,
) -> Result<super::LibraryApplyOutcome, StoreError> {
    if changes.is_empty() || changes.len() > 100 {
        return Err(error(
            StoreErrorCode::InvalidInput,
            "A Page File batch requires 1 to 100 changes",
        ));
    }
    super::page_file_inventory::require_page(connection, context, page_id, true)?;
    let library_id = &context.library_id.0;
    let authority = mutation::resolve_library_mutation_authority(connection, context, library_id)?;
    if let Some(turn_id) = turn_id {
        crate::domain::files::validate_file_identity(turn_id, "Turn")?;
    }
    let mut originals = BTreeMap::new();
    let mut touched = BTreeSet::new();
    let mut prepared = BTreeMap::new();
    let mut byte_length = 0u64;
    for change in changes {
        let file_id = change_file_id(change);
        if !touched.insert(file_id) {
            return Err(error(
                StoreErrorCode::InvalidInput,
                "A Page File batch changes each File at most once",
            ));
        }
        if matches!(
            change,
            Change::Rename { .. }
                | Change::Remove { .. }
                | Change::Retarget { .. }
                | Change::Replace { .. }
        ) {
            let entry = entries::resolve(connection, library_id, page_id, file_id)?;
            originals.insert(file_id.to_owned(), entry.logical_path);
        }
        match change {
            Change::Attach {
                file_id, source, ..
            } => require_current_source(connection, context, file_id, source)?,
            Change::Retarget {
                replacement_file_id,
                source,
                ..
            } => require_current_source(connection, context, replacement_file_id, source)?,
            Change::Import {
                prepared_blob_receipt_id,
                ..
            }
            | Change::Replace {
                prepared_blob_receipt_id,
                ..
            } => {
                if prepared.contains_key(prepared_blob_receipt_id) {
                    return Err(error(
                        StoreErrorCode::InvalidInput,
                        "A prepared Blob receipt can be consumed only once",
                    ));
                }
                let receipt = crate::infrastructure::prepared_blobs::read_receipt(
                    connection,
                    store_epoch,
                    library_id,
                    &authority.actor_project_id,
                    operation_id,
                    prepared_blob_receipt_id,
                )?;
                byte_length = byte_length
                    .checked_add(receipt.byte_length)
                    .ok_or_else(|| {
                        error(
                            StoreErrorCode::InvalidInput,
                            "Page File upload exceeds the batch limit",
                        )
                    })?;
                if receipt.byte_length > 64 * 1024 * 1024 || byte_length > 256 * 1024 * 1024 {
                    return Err(error(
                        StoreErrorCode::InvalidInput,
                        "Page File uploads allow 64 MiB per File and 256 MiB per batch",
                    ));
                }
                prepared.insert(prepared_blob_receipt_id.clone(), receipt);
            }
            _ => {}
        }
    }
    let removed_ids = originals.keys().cloned().collect::<Vec<_>>();
    let now = mutation::sqlite_now(connection)?;
    let result = durable_mutation::run(
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
            let entry_context = EntryWriteContext {
                connection,
                library_id,
                page_id,
                expected_revision,
                now: &now,
            };
            let write = FileWriteContext {
                connection,
                library_id,
                actor_id: &authority.actor_project_id,
                turn_id,
                operation_id,
                now: &now,
            };
            let mut replacements = Vec::new();
            let mut retargeted = BTreeMap::new();
            let mut created = BTreeMap::new();
            // Reserve explicit paths first. Suffix allocation may use only the remaining namespace.
            let ordered = changes
                .iter()
                .filter(|change| !allows_suffix(change))
                .chain(changes.iter().filter(|change| allows_suffix(change)));
            for change in ordered {
                let (file_id, preferred, policy) = match change {
                    Change::Remove { .. } => continue,
                    Change::Rename {
                        file_id,
                        logical_path,
                    } => (
                        file_id.clone(),
                        logical_path.clone(),
                        LibraryPageFileCollisionPolicy::Reject,
                    ),
                    Change::Attach {
                        file_id,
                        logical_path,
                        collision_policy,
                        ..
                    } => (file_id.clone(), logical_path.clone(), *collision_policy),
                    Change::Retarget {
                        file_id,
                        replacement_file_id,
                        ..
                    } => {
                        retargeted.insert(file_id.clone(), replacement_file_id.clone());
                        (
                            replacement_file_id.clone(),
                            originals[file_id].clone(),
                            LibraryPageFileCollisionPolicy::Reject,
                        )
                    }
                    Change::Import {
                        file_id,
                        logical_path,
                        mime_type,
                        prepared_blob_receipt_id,
                        collision_policy,
                    } => {
                        let path = PortablePageFilePath::parse(logical_path)?;
                        let name = path
                            .display()
                            .rsplit('/')
                            .next()
                            .expect("Portable path has a basename");
                        let file = files::create(
                            &write,
                            file_id,
                            name,
                            FileContent {
                                blob_hash: &prepared[prepared_blob_receipt_id].content_hash,
                                mime_type,
                            },
                        )?;
                        created.insert(file.file_id.clone(), file.revision);
                        (
                            file_id.clone(),
                            path.display().to_owned(),
                            *collision_policy,
                        )
                    }
                    Change::Replace {
                        file_id,
                        replacement_file_id,
                        mime_type,
                        prepared_blob_receipt_id,
                    } => {
                        let old = files::metadata(connection, library_id, file_id)?;
                        let file = files::create(
                            &write,
                            replacement_file_id,
                            &old.default_name,
                            FileContent {
                                blob_hash: &prepared[prepared_blob_receipt_id].content_hash,
                                mime_type,
                            },
                        )?;
                        created.insert(file.file_id.clone(), file.revision);
                        retargeted.insert(file_id.clone(), replacement_file_id.clone());
                        (
                            replacement_file_id.clone(),
                            originals[file_id].clone(),
                            LibraryPageFileCollisionPolicy::Reject,
                        )
                    }
                };
                let logical_path = entries::allocate_path(
                    &entry_context,
                    &preferred,
                    &removed_ids,
                    &replacements,
                    policy,
                )?;
                replacements.push(EntryReplacement {
                    file_id,
                    logical_path,
                });
            }
            let revision = entries::replace_batch(&entry_context, &removed_ids, &replacements)?;
            if let Some(project_id) = &authority.requesting_project_id {
                for file_id in created.keys() {
                    mutation::grant_created_file(
                        connection, library_id, file_id, project_id, &now,
                    )?;
                }
            }
            for receipt in prepared.values() {
                crate::infrastructure::prepared_blobs::consume(
                    connection,
                    &receipt.receipt_id,
                    scope.evidence().commit_seq(),
                    &now,
                )?;
            }
            let did_mutate = revision != expected_revision;
            let changed_ids = if did_mutate {
                removed_ids
                    .iter()
                    .cloned()
                    .chain(replacements.iter().map(|entry| entry.file_id.clone()))
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect()
            } else {
                Vec::new()
            };
            let receipt = LibraryPageFileEntryReceipt {
                page_id: page_id.to_owned(),
                manifest_revision: revision,
                changed_file_ids: changed_ids,
                created_file_ids: created.keys().cloned().collect(),
                replacements: retargeted,
                consumed_blob_receipt_ids: prepared.keys().cloned().collect(),
            };
            mutation::seal_mutation(
                scope,
                context,
                operation_id,
                effects(
                    &authority.actor_project_id,
                    operation_kind,
                    vec![receipt],
                    created,
                    &now,
                ),
            )
        },
    )?;
    mutation::library_commit_result(connection, result)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn transfer(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    file_id: &str,
    source_page_id: &str,
    source_revision: i64,
    target_page_id: &str,
    target_revision: i64,
    logical_path: &str,
    copy: bool,
) -> Result<super::LibraryApplyOutcome, StoreError> {
    super::page_file_inventory::require_page(connection, context, source_page_id, !copy)?;
    super::page_file_inventory::require_page(connection, context, target_page_id, true)?;
    let library_id = &context.library_id.0;
    let authority = mutation::resolve_library_mutation_authority(connection, context, library_id)?;
    let now = mutation::sqlite_now(connection)?;
    let result = durable_mutation::run(
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
            entries::transfer(
                &EntryWriteContext {
                    connection,
                    library_id,
                    page_id: source_page_id,
                    expected_revision: source_revision,
                    now: &now,
                },
                &EntryWriteContext {
                    connection,
                    library_id,
                    page_id: target_page_id,
                    expected_revision: target_revision,
                    now: &now,
                },
                file_id,
                logical_path,
                copy,
            )?;
            let receipt = |page_id: &str, revision, changed| LibraryPageFileEntryReceipt {
                page_id: page_id.to_owned(),
                manifest_revision: revision,
                changed_file_ids: if changed {
                    vec![file_id.to_owned()]
                } else {
                    Vec::new()
                },
                created_file_ids: Vec::new(),
                replacements: BTreeMap::new(),
                consumed_blob_receipt_ids: Vec::new(),
            };
            mutation::seal_mutation(
                scope,
                context,
                operation_id,
                effects(
                    &authority.actor_project_id,
                    "transfer_page_file_entry",
                    vec![
                        receipt(source_page_id, source_revision + i64::from(!copy), !copy),
                        receipt(target_page_id, target_revision + 1, true),
                    ],
                    BTreeMap::new(),
                    &now,
                ),
            )
        },
    )?;
    mutation::library_commit_result(connection, result)
}

fn change_file_id(change: &Change) -> &str {
    match change {
        Change::Import { file_id, .. }
        | Change::Attach { file_id, .. }
        | Change::Rename { file_id, .. }
        | Change::Remove { file_id }
        | Change::Retarget { file_id, .. }
        | Change::Replace { file_id, .. } => file_id,
    }
}

fn allows_suffix(change: &Change) -> bool {
    matches!(
        change,
        Change::Import {
            collision_policy: LibraryPageFileCollisionPolicy::Suffix,
            ..
        } | Change::Attach {
            collision_policy: LibraryPageFileCollisionPolicy::Suffix,
            ..
        }
    )
}

fn require_current_source(
    connection: &Connection,
    context: &BoundModuleContext,
    file_id: &str,
    source: &LibraryFileReadSource,
) -> Result<(), StoreError> {
    if !matches!(
        source,
        LibraryFileReadSource::Direct | LibraryFileReadSource::Page { .. }
    ) {
        return Err(error(
            StoreErrorCode::InvalidInput,
            "Attach requires access to the current File; fork a retained version first",
        ));
    }
    super::file_queries::presentation(connection, context, file_id, source, None)?;
    Ok(())
}

fn effects(
    actor: &str,
    operation_kind: &'static str,
    receipts: Vec<LibraryPageFileEntryReceipt>,
    created: BTreeMap<String, i64>,
    now: &str,
) -> MutationEffects {
    let affected_page_ids = receipts
        .iter()
        .filter(|receipt| !receipt.changed_file_ids.is_empty())
        .map(|receipt| receipt.page_id.clone())
        .collect::<Vec<_>>();
    let committed_revisions = receipts
        .iter()
        .filter(|receipt| !receipt.changed_file_ids.is_empty())
        .map(|receipt| {
            (
                format!("pageFiles:{}", receipt.page_id),
                receipt.manifest_revision,
            )
        })
        .chain(
            created
                .iter()
                .map(|(id, revision)| (format!("file:{id}"), *revision)),
        )
        .collect();
    MutationEffects {
        page_file_entries: receipts,
        file_revisions: created,
        file_mutation: None,
        project_id: actor.to_owned(),
        operation_kind,
        change_kind: "library.changed",
        did_mutate: !affected_page_ids.is_empty(),
        created_target: None,
        affected_parent_keys: Vec::new(),
        affected_block_ids: Vec::new(),
        affected_page_ids,
        affected_database_ids: Vec::new(),
        affected_view_ids: Vec::new(),
        affected_document_ids: Vec::new(),
        committed_revisions,
        page_create: None,
        page_copy: None,
        canvas_mutation: None,
        block_transfer: None,
        block_transfer_undo: None,
        page_relocation_undo: None,
        structural_edit: None,
        page_lifecycle: None,
        block_property_mutation: None,
        agent_page_copy: None,
        agent_create_pages: None,
        agent_move_pages: None,
        change_payload: None,
        committed_at: now.to_owned(),
    }
}

fn error(code: StoreErrorCode, message: &'static str) -> StoreError {
    StoreError::new(code, message, false)
}
