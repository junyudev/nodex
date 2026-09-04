use std::collections::BTreeMap;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::library::{
    LibraryFileChange, LibraryFileMutationResult, LibraryResourceTarget,
};
use rusqlite::{Connection, params};

use crate::infrastructure::durable_mutation::{self, OperationIdentity};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::ModuleName;

use super::files::{self, FileContent, FileWriteContext};
use super::mutation::{self, MutationEffects};

#[allow(clippy::too_many_arguments)]
pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    change: &LibraryFileChange,
    turn_id: Option<&str>,
) -> Result<super::LibraryApplyOutcome, StoreError> {
    let library_id = &context.library_id.0;
    let authority = mutation::resolve_library_mutation_authority(connection, context, library_id)?;
    if let Some(turn_id) = turn_id {
        crate::domain::files::validate_file_identity(turn_id, "Turn")?;
    }
    let previous = match change {
        LibraryFileChange::ReplaceContent { file_id, .. }
        | LibraryFileChange::Rename { file_id, .. }
        | LibraryFileChange::Trash { file_id, .. }
        | LibraryFileChange::Restore { file_id, .. }
        | LibraryFileChange::Purge { file_id, .. } => {
            super::file_access::require_direct(connection, context, file_id, true)?;
            Some(files::metadata(connection, library_id, file_id)?)
        }
        LibraryFileChange::Fork {
            source_file_id,
            source_version,
            source,
            ..
        } => {
            super::file_queries::presentation(
                connection,
                context,
                source_file_id,
                source,
                Some(*source_version),
            )?;
            None
        }
        LibraryFileChange::Create { .. } => None,
    };
    let prepared = match change {
        LibraryFileChange::Create {
            prepared_blob_receipt_id,
            ..
        }
        | LibraryFileChange::ReplaceContent {
            prepared_blob_receipt_id,
            ..
        } => Some(crate::infrastructure::prepared_blobs::read_receipt(
            connection,
            store_epoch,
            library_id,
            &authority.actor_project_id,
            operation_id,
            prepared_blob_receipt_id,
        )?),
        _ => None,
    };
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
            if let Some(previous) = &previous {
                let changes_presentation = match change {
                    LibraryFileChange::ReplaceContent { .. } => true,
                    LibraryFileChange::Rename { default_name, .. } => {
                        crate::domain::file_path::normalize_file_name(default_name)?
                            != previous.default_name
                    }
                    _ => false,
                };
                if changes_presentation {
                    let actor_context = BoundModuleContext {
                        project_id: Some(nodex_core_contracts::ProjectId(
                            authority.actor_project_id.clone(),
                        )),
                        ..context.clone()
                    };
                    crate::document::prepare_file_content_revisions(
                        connection,
                        &actor_context,
                        &previous.file_id,
                        &now,
                    )?;
                }
            }
            let write = FileWriteContext {
                connection,
                library_id,
                actor_id: &authority.actor_project_id,
                turn_id,
                operation_id,
                now: &now,
            };
            let file = match change {
                LibraryFileChange::Create {
                    file_id,
                    default_name,
                    mime_type,
                    ..
                } => files::create(
                    &write,
                    file_id,
                    default_name,
                    content(prepared.as_ref(), mime_type)?,
                )?,
                LibraryFileChange::ReplaceContent {
                    file_id,
                    expected_revision,
                    expected_head_version,
                    mime_type,
                    ..
                } => {
                    require_compatible_media(connection, file_id, mime_type)?;
                    files::replace_content(
                        &write,
                        file_id,
                        *expected_revision,
                        *expected_head_version,
                        content(prepared.as_ref(), mime_type)?,
                    )?
                }
                LibraryFileChange::Rename {
                    file_id,
                    expected_revision,
                    default_name,
                } => files::rename(&write, file_id, *expected_revision, default_name)?,
                LibraryFileChange::Trash {
                    file_id,
                    expected_revision,
                } => files::set_lifecycle(
                    &write,
                    file_id,
                    *expected_revision,
                    nodex_core_contracts::library::LibraryFileLifecycle::Trashed,
                )?,
                LibraryFileChange::Restore {
                    file_id,
                    expected_revision,
                } => files::set_lifecycle(
                    &write,
                    file_id,
                    *expected_revision,
                    nodex_core_contracts::library::LibraryFileLifecycle::Live,
                )?,
                LibraryFileChange::Purge {
                    file_id,
                    expected_revision,
                } => {
                    let mut file = files::metadata(connection, library_id, file_id)?;
                    file.revision = files::purge(&write, file_id, *expected_revision)?;
                    file
                }
                LibraryFileChange::Fork {
                    source_file_id,
                    source_version,
                    file_id,
                    default_name,
                    ..
                } => files::fork(
                    &write,
                    source_file_id,
                    *source_version,
                    file_id,
                    default_name,
                )?,
            };
            let created = matches!(
                change,
                LibraryFileChange::Create { .. } | LibraryFileChange::Fork { .. }
            );
            if created && let Some(project_id) = &authority.requesting_project_id {
                mutation::grant_created_file(
                    connection,
                    library_id,
                    &file.file_id,
                    project_id,
                    &now,
                )?;
            }
            if let Some(prepared) = &prepared {
                crate::infrastructure::prepared_blobs::consume(
                    connection,
                    &prepared.receipt_id,
                    scope.evidence().commit_seq(),
                    &now,
                )?;
            }
            let did_mutate = previous
                .as_ref()
                .is_none_or(|old| old.revision != file.revision);
            if matches!(change, LibraryFileChange::ReplaceContent { .. }) {
                connection.execute(
                    "UPDATE block_asset_refs SET asset_hash = ?1, updated_at = ?2
                     WHERE library_id = ?3 AND file_id = ?4 AND asset_hash <> ?1",
                    params![file.blob_etag, now, library_id, file.file_id],
                )?;
            }
            let page_ids = current_page_uses(connection, library_id, &file.file_id)?;
            let mut revisions = BTreeMap::from([(format!("file:{}", file.file_id), file.revision)]);
            revisions.extend(page_ids.iter().map(|page_id| {
                (
                    format!("pageFileContent:{page_id}"),
                    scope.evidence().commit_seq(),
                )
            }));
            mutation::seal_mutation(
                scope,
                context,
                operation_id,
                MutationEffects {
                    page_file_entries: Vec::new(),
                    file_revisions: BTreeMap::from([(file.file_id.clone(), file.revision)]),
                    file_mutation: Some(LibraryFileMutationResult {
                        file_id: file.file_id.clone(),
                        revision: file.revision,
                        file: (!matches!(change, LibraryFileChange::Purge { .. }))
                            .then(|| file.clone()),
                    }),
                    project_id: authority.actor_project_id.clone(),
                    operation_kind: "apply_file_change",
                    change_kind: "library.changed",
                    did_mutate,
                    created_target: created.then_some(LibraryResourceTarget::File {
                        file_id: file.file_id,
                    }),
                    affected_parent_keys: Vec::new(),
                    affected_block_ids: Vec::new(),
                    affected_page_ids: page_ids,
                    affected_database_ids: Vec::new(),
                    affected_view_ids: Vec::new(),
                    affected_document_ids: Vec::new(),
                    committed_revisions: revisions,
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
                    committed_at: now.clone(),
                },
            )
        },
    )?;
    mutation::library_commit_result(connection, result)
}

fn content<'a>(
    prepared: Option<&'a crate::infrastructure::prepared_blobs::PreparedBlob>,
    mime_type: &'a str,
) -> Result<FileContent<'a>, StoreError> {
    let prepared = prepared.ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::Internal,
            "File content has no prepared receipt",
            false,
        )
    })?;
    if prepared.byte_length > 64 * 1024 * 1024 {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "File content exceeds 64 MiB",
            false,
        ));
    }
    Ok(FileContent {
        blob_hash: &prepared.content_hash,
        mime_type,
    })
}

fn current_page_uses(
    connection: &Connection,
    library_id: &str,
    file_id: &str,
) -> Result<Vec<String>, StoreError> {
    connection.prepare("SELECT DISTINCT page.id FROM blocks page JOIN (
        SELECT page_id FROM page_file_entries WHERE file_id = ?1
        UNION SELECT owner_block_id FROM block_asset_refs WHERE file_id = ?1
      ) uses ON uses.page_id = page.id
      WHERE page.library_id = ?2 AND page.type = 'page' AND page.lifecycle = 'active' ORDER BY page.id")?
        .query_map(params![file_id, library_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

fn require_compatible_media(
    connection: &Connection,
    file_id: &str,
    mime_type: &str,
) -> Result<(), StoreError> {
    let mime_type = crate::domain::files::normalize_file_mime_type(mime_type)?;
    let incompatible = connection.query_row(
        "SELECT EXISTS(
        SELECT 1 FROM block_asset_refs reference JOIN blocks block ON block.id = reference.block_id
        WHERE reference.file_id = ?1 AND (
          (block.type = 'image' AND ?2 NOT LIKE 'image/%') OR
          (block.type = 'video' AND ?2 NOT LIKE 'video/%') OR
          (block.type = 'audio' AND ?2 NOT LIKE 'audio/%')
        ))",
        params![file_id, mime_type],
        |row| row.get::<_, bool>(0),
    )?;
    if incompatible {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "File content is incompatible with an existing media use",
            false,
        ));
    }
    Ok(())
}
