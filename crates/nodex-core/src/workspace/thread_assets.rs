//! Thread-owned input bytes survive queue removal and conversation hydration.
//! A thread root retains bytes without creating a user-visible Library File.
use super::mutation::{WorkspaceMutationEffects, run_mutation, workspace_event_anchor};
use crate::infrastructure::{
    prepared_blobs,
    sqlite::{StoreError, StoreErrorCode},
};
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::{Connection, params};
use std::collections::BTreeSet;

pub(super) fn require_access(
    connection: &Connection,
    context: &BoundModuleContext,
    thread_id: &str,
    write: bool,
) -> Result<(), StoreError> {
    let thread = super::thread::read_thread(connection, &context.library_id.0, thread_id)?
        .ok_or_else(|| error(StoreErrorCode::NotFound, "Thread is unavailable"))?;
    let Some(project) = &context.project_id else {
        if matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
        ) {
            return Ok(());
        }
        return Err(error(
            StoreErrorCode::Unauthorized,
            "Thread assets require a Project or trusted Library authority",
        ));
    };
    let accessible: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1 AND library_id = ?2 AND (lifecycle = 'active' OR (?3 = 0 AND lifecycle = 'inactive')))",
        params![project.0,context.library_id.0,i64::from(write)], |row| row.get(0),
    )?;
    if !accessible || thread.project_id.as_deref() != Some(&project.0) {
        return Err(error(
            StoreErrorCode::Unauthorized,
            "Thread assets are unavailable to the bound Project",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn retain(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    receipt_ids: &[String],
) -> Result<super::ProjectWorkspaceApplyOutcome, StoreError> {
    require_access(connection, context, thread_id, true)?;
    if receipt_ids.is_empty() || receipt_ids.len() > 512 {
        return Err(error(
            StoreErrorCode::InvalidInput,
            "Thread input must contain 1 to 512 prepared attachments",
        ));
    }
    let actor = context
        .project_id
        .as_ref()
        .map(|project| Ok(project.0.clone()))
        .unwrap_or_else(|| {
            crate::library::resolve_library_actor_project_id(connection, &context.library_id.0)
        })?;
    let mut seen = BTreeSet::new();
    let mut total = 0u64;
    let prepared = receipt_ids
        .iter()
        .map(|id| {
            if !seen.insert(id) {
                return Err(error(
                    StoreErrorCode::InvalidInput,
                    "Prepared attachment receipts must be unique",
                ));
            }
            let receipt = prepared_blobs::read_receipt(
                connection,
                store_epoch,
                &context.library_id.0,
                &actor,
                operation_id,
                id,
            )?;
            total = total.checked_add(receipt.byte_length).ok_or_else(|| {
                error(
                    StoreErrorCode::ResourceExhausted,
                    "Thread input size is exhausted",
                )
            })?;
            if receipt.byte_length > 256 * 1024 * 1024 || total > 512 * 1024 * 1024 {
                return Err(error(
                    StoreErrorCode::ResourceExhausted,
                    "Thread input exceeds its attachment byte budget",
                ));
            }
            Ok(receipt)
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let now = super::session_mutation::sqlite_now(connection)?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |scope| {
            for receipt in &prepared {
                connection.execute(
                "INSERT INTO codex_thread_asset_refs(thread_id,library_id,blob_hash,retained_at) VALUES (?1,?2,?3,?4) ON CONFLICT(thread_id,library_id,blob_hash) DO NOTHING",
                params![thread_id,context.library_id.0,receipt.content_hash,now],
            )?;
                prepared_blobs::consume(
                    connection,
                    &receipt.receipt_id,
                    scope.evidence().commit_seq(),
                    &now,
                )?;
            }
            Ok(WorkspaceMutationEffects {
                operation_kind: "retain_thread_assets",
                project_catalog_change: None,
                change_project_id: workspace_event_anchor(connection, &context.library_id.0)?,
                project_ids: Vec::new(),
                session_ids: Vec::new(),
                thread_ids: vec![thread_id.to_owned()],
                session_summary_scopes: Vec::new(),
                session_detail_ids: Vec::new(),
                block_ids: Vec::new(),
                document_ids: Vec::new(),
                database_ids: Vec::new(),
                page_ids: Vec::new(),
                data_source_ids: Vec::new(),
                view_ids: Vec::new(),
                document_heads: Vec::new(),
                committed_at: now.clone(),
                queued_follow_up_ledger: None,
            })
        },
    )
}

fn error(code: StoreErrorCode, message: &str) -> StoreError {
    StoreError::new(code, message, false)
}

#[derive(Debug)]
pub struct ThreadAssetBlob {
    pub file: std::fs::File,
    pub byte_length: u64,
    pub content_hash: String,
}

impl super::ProjectWorkspaceModule {
    pub fn resolve_thread_asset_blob(
        &self,
        context: &BoundModuleContext,
        thread_id: &str,
        content_hash: &str,
    ) -> Result<ThreadAssetBlob, nodex_core_contracts::CoreError> {
        self.validate_context(context)?;
        if content_hash.len() != 64
            || !content_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(super::invalid("Thread attachment digest is invalid"));
        }
        let readers = self
            .readers
            .as_ref()
            .ok_or_else(|| super::unavailable("Thread attachments have no durable reader"))?;
        let root = self
            .assets_root
            .clone()
            .ok_or_else(|| super::unavailable("Thread attachments have no Blob storage"))?;
        let _lease = crate::infrastructure::managed_asset_snapshot::acquire_snapshot_lease()
            .map_err(super::core_error)?;
        let context = context.clone();
        let thread_id = thread_id.to_owned();
        let content_hash = content_hash.to_owned();
        readers.read_default(move |connection| {
            use rusqlite::OptionalExtension;
            let transaction = connection.unchecked_transaction()?;
            require_access(&transaction,&context,&thread_id,false)?;
            let (name,length) = transaction.query_row(
                "SELECT blob.physical_asset_name, blob.byte_length FROM managed_blobs blob
                 WHERE blob.content_hash = ?3 AND (
                   EXISTS(SELECT 1 FROM codex_thread_asset_refs reference
                     WHERE reference.thread_id = ?1 AND reference.library_id = ?2 AND reference.blob_hash = ?3)
                   OR EXISTS(SELECT 1 FROM codex_queued_follow_up_entries entry
                     WHERE entry.thread_id = ?1 AND entry.payload_sha256 = ?3)
                   OR EXISTS(SELECT 1 FROM codex_queued_follow_up_entries entry
                     JOIN codex_queued_follow_up_payload_asset_refs reference ON reference.payload_sha256 = entry.payload_sha256
                     WHERE entry.thread_id = ?1 AND reference.sha256 = ?3)
                 )",
                params![thread_id,context.library_id.0,content_hash], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?)),
            ).optional()?.ok_or_else(|| error(StoreErrorCode::NotFound,"Thread attachment is unavailable"))?;
            let byte_length = u64::try_from(length).map_err(|_| error(StoreErrorCode::StoreCorrupt,"Thread attachment length is invalid"))?;
            let file = crate::infrastructure::managed_blobs::open(&root,&name,byte_length)?;
            transaction.commit()?;
            Ok(ThreadAssetBlob { file,byte_length,content_hash })
        }).map_err(super::core_error)
    }
}

#[cfg(test)]
mod tests {
    use crate::workspace::test_support::{
        context, create_session_thread, request, seeded_workspace,
    };
    use nodex_core_contracts::{
        ModuleApplyRequest, StoreEpoch,
        library::{LIBRARY_CONTRACT_VERSION, LibraryFileChange, LibraryIntent},
        workspace::ProjectWorkspaceIntent,
    };
    use std::io::Read;

    #[test]
    fn library_file_and_thread_share_bytes_until_both_release_their_roots() {
        let fixture = seeded_workspace();
        create_session_thread(
            &fixture.module,
            "attachments",
            "session:assets",
            "thread:assets",
            Some("project:default"),
            1,
        );
        let library = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        let root = fixture._directory.path().join("assets");
        let prepare = |operation: &str| {
            let mut writer =
                crate::infrastructure::managed_blobs::BlobWriter::new(&root, 1024).unwrap();
            writer.write_chunk(b"retained input").unwrap();
            let blob = writer.finish().unwrap();
            let expiry = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 60_000;
            library
                .register_prepared_file_blob(
                    &context(),
                    "epoch-1",
                    operation,
                    &format!("receipt:{operation}"),
                    &blob.content_hash,
                    &blob.physical_asset_name,
                    blob.byte_length,
                    expiry,
                )
                .unwrap()
        };
        let file_blob = prepare("create-file");
        let change = |operation: &str, change| {
            library
                .apply(
                    &context(),
                    ModuleApplyRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        operation_id: operation.to_owned(),
                        store_epoch: StoreEpoch("epoch-1".to_owned()),
                        intent: LibraryIntent::ApplyFileChange {
                            change,
                            turn_id: None,
                        },
                    },
                )
                .unwrap()
        };
        change(
            "create-file",
            LibraryFileChange::Create {
                file_id: "file-input".to_owned(),
                default_name: "input.txt".to_owned(),
                mime_type: "text/plain".to_owned(),
                prepared_blob_receipt_id: file_blob.receipt_id,
            },
        );
        let thread_blob = prepare("retain-thread");
        let command = request(
            "retain-thread",
            ProjectWorkspaceIntent::RetainThreadAssets {
                thread_id: "thread:assets".to_owned(),
                prepared_blob_receipt_ids: vec![thread_blob.receipt_id],
            },
        );
        fixture.module.apply(&context(), command.clone()).unwrap();
        let replay = fixture.module.apply(&context(), command).unwrap();
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(replay.event.is_none());
        change(
            "trash-file",
            LibraryFileChange::Trash {
                file_id: "file-input".to_owned(),
                expected_revision: 1,
            },
        );
        change(
            "purge-file",
            LibraryFileChange::Purge {
                file_id: "file-input".to_owned(),
                expected_revision: 2,
            },
        );
        assert_eq!(library.collect_unreachable_file_blobs(100).unwrap(), 0);
        let hash = crate::document::sha256(b"retained input");
        let mut opened = fixture
            .module
            .resolve_thread_asset_blob(&context(), "thread:assets", &hash)
            .unwrap();
        let mut outsider = context();
        outsider.project_id = Some(nodex_core_contracts::ProjectId("other-project".to_owned()));
        assert_eq!(
            fixture
                .module
                .resolve_thread_asset_blob(&outsider, "thread:assets", &hash)
                .unwrap_err()
                .code,
            nodex_core_contracts::CoreErrorCode::Unauthorized
        );
        fixture
            .module
            .apply(
                &context(),
                request(
                    "delete-thread",
                    ProjectWorkspaceIntent::DeleteThread {
                        thread_id: "thread:assets".to_owned(),
                    },
                ),
            )
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while root.join(format!("{hash}.blob")).exists() {
            library.collect_unreachable_file_blobs(100).unwrap();
            assert!(
                std::time::Instant::now() < deadline,
                "released Thread bytes are collected"
            );
            std::thread::yield_now();
        }
        let mut bytes = Vec::new();
        opened.file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"retained input");
        assert!(
            fixture
                .module
                .resolve_thread_asset_blob(&context(), "thread:assets", &hash)
                .is_err()
        );
    }
}
