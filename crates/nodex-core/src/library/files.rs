//! Library File persistence. Callers authorize an intent and own its outer
//! transaction; these operations never infer authority from a Page owner.

use std::collections::BTreeMap;

#[cfg(test)]
use nodex_core_contracts::library::LibraryFileUsageFilter;
use nodex_core_contracts::library::{LibraryFile, LibraryFileLifecycle, LibraryFileVersion};
use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::file_path::normalize_file_name;
use crate::domain::files::{
    FileRestoreHead, FileSnapshotManifest, FileSnapshotTarget, normalize_file_mime_type,
    validate_file_identity,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

pub(super) const FILE_COLUMNS: &str = "file.file_id, file.library_id, file.default_name, file.head_version,
    file.revision, file.lifecycle = 'live', version.mime_type, version.byte_length, version.blob_hash,
    file.created_by_actor_id, file.created_by_turn_id, file.created_at, file.updated_at";
pub(super) const FILE_TABLES: &str = "FROM library_files file JOIN file_versions version
    ON version.file_id = file.file_id AND version.version = file.head_version AND version.library_id = file.library_id";

pub(super) fn select_sql() -> String {
    format!("SELECT {FILE_COLUMNS} {FILE_TABLES}")
}

pub(super) struct FileWriteContext<'a> {
    pub(super) connection: &'a Connection,
    pub(super) library_id: &'a str,
    pub(super) actor_id: &'a str,
    pub(super) turn_id: Option<&'a str>,
    pub(super) operation_id: &'a str,
    pub(super) now: &'a str,
}

/// A registered, immutable Blob. Receipt validation happens before construction;
/// persistence also verifies the registered byte length at the SQL boundary.
pub(super) struct FileContent<'a> {
    pub(super) blob_hash: &'a str,
    pub(super) mime_type: &'a str,
}

pub(super) fn metadata(
    connection: &Connection,
    library_id: &str,
    file_id: &str,
) -> Result<LibraryFile, StoreError> {
    validate_file_identity(file_id, "File")?;
    connection
        .query_row(
            &format!(
                "{} WHERE file.file_id = ?1 AND file.library_id = ?2",
                select_sql()
            ),
            params![file_id, library_id],
            file_from_row,
        )
        .optional()?
        .ok_or_else(|| not_found("File is unavailable"))
}

pub(super) fn read_version(
    connection: &Connection,
    library_id: &str,
    file_id: &str,
    version: i64,
) -> Result<LibraryFileVersion, StoreError> {
    validate_file_identity(file_id, "File")?;
    if version < 1 {
        return Err(invalid("File version must be positive"));
    }
    connection
        .query_row(
            "SELECT file_id, version, mime_type, byte_length, blob_hash, actor_id, \
                    turn_id, operation_id, occurred_at FROM file_versions \
             WHERE file_id = ?1 AND version = ?2 AND library_id = ?3",
            params![file_id, version, library_id],
            version_from_row,
        )
        .optional()?
        .ok_or_else(|| not_found("File version is unavailable"))
}

pub(super) fn create(
    context: &FileWriteContext<'_>,
    file_id: &str,
    default_name: &str,
    content: FileContent<'_>,
) -> Result<LibraryFile, StoreError> {
    require_transaction(context)?;
    validate_file_identity(file_id, "File")?;
    let default_name = normalize_file_name(default_name)?;
    let occupied = context.connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM library_files WHERE file_id = ?1) \
           OR EXISTS(SELECT 1 FROM retired_file_ids WHERE file_id = ?1)",
        [file_id],
        |row| row.get::<_, bool>(0),
    )?;
    if occupied {
        return Err(conflict("File identity is already in use or retired"));
    }
    insert_version(context, file_id, 1, content)?;
    context.connection.execute(
        "INSERT INTO library_files(file_id, library_id, default_name, head_version, \
           revision, lifecycle, created_by_actor_id, created_by_turn_id, created_at, updated_at) \
         VALUES (?1, ?2, ?3, 1, 1, 'live', ?4, ?5, ?6, ?6)",
        params![
            file_id,
            context.library_id,
            default_name,
            context.actor_id,
            context.turn_id,
            context.now
        ],
    )?;
    metadata(context.connection, context.library_id, file_id)
}

pub(super) fn replace_content(
    context: &FileWriteContext<'_>,
    file_id: &str,
    expected_revision: i64,
    expected_head_version: i64,
    content: FileContent<'_>,
) -> Result<LibraryFile, StoreError> {
    let current = require_revision(context, file_id, expected_revision)?;
    if current.lifecycle != LibraryFileLifecycle::Live {
        return Err(conflict("Restore the File before updating its content"));
    }
    if current.head_version != expected_head_version {
        return Err(revision_conflict());
    }
    let version = context
        .connection
        .query_row(
            "SELECT max(version) FROM file_versions WHERE file_id = ?1 AND library_id = ?2",
            params![file_id, context.library_id],
            |row| row.get::<_, i64>(0),
        )?
        .checked_add(1)
        .ok_or_else(|| invalid("File version is exhausted"))?;
    insert_version(context, file_id, version, content)?;
    let changed = context.connection.execute(
        "UPDATE library_files SET head_version = ?1, revision = revision + 1, updated_at = ?2 \
         WHERE file_id = ?3 AND library_id = ?4 AND revision = ?5 AND head_version = ?6",
        params![
            version,
            context.now,
            file_id,
            context.library_id,
            expected_revision,
            expected_head_version
        ],
    )?;
    require_changed(changed)?;
    metadata(context.connection, context.library_id, file_id)
}

pub(super) fn rename(
    context: &FileWriteContext<'_>,
    file_id: &str,
    expected_revision: i64,
    default_name: &str,
) -> Result<LibraryFile, StoreError> {
    let default_name = normalize_file_name(default_name)?;
    let current = require_revision(context, file_id, expected_revision)?;
    if current.default_name == default_name {
        return Ok(current);
    }
    let changed = context.connection.execute(
        "UPDATE library_files SET default_name = ?1, revision = revision + 1, updated_at = ?2 \
         WHERE file_id = ?3 AND library_id = ?4 AND revision = ?5",
        params![
            default_name,
            context.now,
            file_id,
            context.library_id,
            expected_revision
        ],
    )?;
    require_changed(changed)?;
    metadata(context.connection, context.library_id, file_id)
}

pub(super) fn set_lifecycle(
    context: &FileWriteContext<'_>,
    file_id: &str,
    expected_revision: i64,
    lifecycle: LibraryFileLifecycle,
) -> Result<LibraryFile, StoreError> {
    let file = require_revision(context, file_id, expected_revision)?;
    if file.lifecycle == lifecycle {
        return Ok(file);
    }
    if lifecycle == LibraryFileLifecycle::Trashed {
        super::file_retention::require_no_current_use(
            context.connection,
            context.library_id,
            file_id,
        )?;
    }
    let state = if lifecycle == LibraryFileLifecycle::Live {
        "live"
    } else {
        "trashed"
    };
    let changed = context.connection.execute(
        "UPDATE library_files SET lifecycle = ?1, revision = revision + 1, updated_at = ?2 WHERE file_id = ?3 AND library_id = ?4 AND revision = ?5",
        params![state, context.now, file_id, context.library_id, expected_revision],
    )?;
    require_changed(changed)?;
    metadata(context.connection, context.library_id, file_id)
}

pub(super) fn purge(
    context: &FileWriteContext<'_>,
    file_id: &str,
    expected_revision: i64,
) -> Result<i64, StoreError> {
    let file = require_revision(context, file_id, expected_revision)?;
    if file.lifecycle != LibraryFileLifecycle::Trashed {
        return Err(conflict(
            "Move the File to Trash before permanently deleting it",
        ));
    }
    super::file_retention::require_unretained(context.connection, context.library_id, file_id)?;
    let revision = expected_revision
        .checked_add(1)
        .ok_or_else(|| invalid("File revision is exhausted"))?;
    context.connection.execute(
        "INSERT INTO retired_file_ids(file_id, library_id, retired_at) VALUES (?1, ?2, ?3)",
        params![file_id, context.library_id, context.now],
    )?;
    context.connection.execute(
        "UPDATE project_resource_grants SET lifecycle = 'revoked', revision = revision + 1, updated_at = ?1
         WHERE library_id = ?2 AND root_kind = 'file' AND root_id = ?3 AND lifecycle = 'active'",
        params![context.now, context.library_id, file_id],
    )?;
    let changed = context.connection.execute(
        "DELETE FROM library_files WHERE library_id = ?1 AND file_id = ?2 AND revision = ?3",
        params![context.library_id, file_id, expected_revision],
    )?;
    require_changed(changed)?;
    Ok(revision)
}

pub(super) fn fork(
    context: &FileWriteContext<'_>,
    source_file_id: &str,
    source_version: i64,
    file_id: &str,
    default_name: &str,
) -> Result<LibraryFile, StoreError> {
    let source = read_version(
        context.connection,
        context.library_id,
        source_file_id,
        source_version,
    )?;
    create(
        context,
        file_id,
        default_name,
        FileContent {
            blob_hash: &source.blob_etag,
            mime_type: &source.mime_type,
        },
    )
}

pub(crate) fn capture_snapshot<'a>(
    connection: &Connection,
    library_id: &str,
    file_ids: impl IntoIterator<Item = &'a str>,
) -> Result<FileSnapshotManifest, StoreError> {
    let mut files = BTreeMap::new();
    for file_id in file_ids {
        if files.contains_key(file_id) {
            continue;
        }
        let file = metadata(connection, library_id, file_id)?;
        files.insert(
            file_id.to_owned(),
            FileSnapshotTarget {
                version: file.head_version,
                default_name: file.default_name,
            },
        );
    }
    Ok(FileSnapshotManifest { files })
}

pub(super) fn restore_heads(
    connection: &Connection,
    library_id: &str,
    snapshot: &FileSnapshotManifest,
) -> Result<BTreeMap<String, FileRestoreHead>, StoreError> {
    snapshot
        .files
        .keys()
        .map(|file_id| {
            let file = metadata(connection, library_id, file_id)?;
            Ok((
                file_id.clone(),
                FileRestoreHead {
                    version: file.head_version,
                    revision: file.revision,
                    default_name: file.default_name,
                    live: file.lifecycle == LibraryFileLifecycle::Live,
                },
            ))
        })
        .collect()
}

fn insert_version(
    context: &FileWriteContext<'_>,
    file_id: &str,
    version: i64,
    content: FileContent<'_>,
) -> Result<(), StoreError> {
    let mime_type = normalize_file_mime_type(content.mime_type)?;
    let byte_length = context
        .connection
        .query_row(
            "SELECT byte_length FROM managed_blobs WHERE content_hash = ?1",
            [content.blob_hash],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Prepared File bytes are unavailable"))?;
    context.connection.execute(
        "INSERT INTO file_versions(file_id, version, library_id, blob_hash, mime_type, byte_length, \
           actor_id, turn_id, operation_id, occurred_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![file_id, version, context.library_id, content.blob_hash, mime_type, byte_length,
            context.actor_id, context.turn_id, context.operation_id, context.now],
    )?;
    Ok(())
}

fn require_revision(
    context: &FileWriteContext<'_>,
    file_id: &str,
    revision: i64,
) -> Result<LibraryFile, StoreError> {
    require_transaction(context)?;
    let file = metadata(context.connection, context.library_id, file_id)?;
    if file.revision != revision {
        return Err(revision_conflict());
    }
    Ok(file)
}

fn require_transaction(context: &FileWriteContext<'_>) -> Result<(), StoreError> {
    if context.connection.is_autocommit() {
        return Err(StoreError::new(
            StoreErrorCode::Internal,
            "File writes require an outer transaction",
            false,
        ));
    }
    Ok(())
}

fn require_changed(count: usize) -> Result<(), StoreError> {
    if count != 1 {
        return Err(revision_conflict());
    }
    Ok(())
}

pub(super) fn file_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryFile> {
    Ok(LibraryFile {
        file_id: row.get(0)?,
        library_id: row.get(1)?,
        default_name: row.get(2)?,
        head_version: row.get(3)?,
        revision: row.get(4)?,
        lifecycle: if row.get(5)? {
            LibraryFileLifecycle::Live
        } else {
            LibraryFileLifecycle::Trashed
        },
        mime_type: row.get(6)?,
        byte_length: byte_length_from_row(row, 7)?,
        blob_etag: row.get(8)?,
        created_by_actor_id: row.get(9)?,
        created_by_turn_id: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

pub(super) fn version_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryFileVersion> {
    Ok(LibraryFileVersion {
        file_id: row.get(0)?,
        version: row.get(1)?,
        mime_type: row.get(2)?,
        byte_length: byte_length_from_row(row, 3)?,
        blob_etag: row.get(4)?,
        actor_id: row.get(5)?,
        turn_id: row.get(6)?,
        operation_id: row.get(7)?,
        occurred_at: row.get(8)?,
    })
}

fn invalid(message: &'static str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn byte_length_from_row(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value = row.get::<_, i64>(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}

fn not_found(message: &'static str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn conflict(message: &'static str) -> StoreError {
    StoreError::new(StoreErrorCode::Conflict, message, false)
}

fn revision_conflict() -> StoreError {
    StoreError::new(
        StoreErrorCode::RevisionConflict,
        "File revision changed",
        true,
    )
}

#[cfg(test)]
mod tests {
    use std::fs;

    use nodex_core_contracts::library::{
        LIBRARY_CONTRACT_VERSION, LibraryIntent, LibraryWriteParent,
    };
    use nodex_core_contracts::{
        AdapterKind, BoundModuleContext, LibraryId, ModuleApplyRequest, ProfileId, ProjectId,
        StoreEpoch,
    };

    use super::*;
    use crate::domain::files::FileRestoreAction;
    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;
    use crate::library::page_file_entries::{self as entries, EntryWriteContext};

    const NOW: &str = "2026-09-04T00:00:00.000Z";

    struct Fixture {
        home: tempfile::TempDir,
        kernel: SqliteStoreKernel,
    }

    fn fixture() -> Fixture {
        let home = tempfile::tempdir().unwrap();
        let kernel = SqliteStoreKernel::open_test(&home.path().canonicalize().unwrap()).unwrap();
        kernel.writer().call(|connection| {
            with_immediate_transaction(connection, |transaction| {
                transaction.execute("INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)", [NOW])?;
                transaction.execute("INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library-1', 'profile-1', ?1, ?1)", [NOW])?;
                transaction.execute("INSERT INTO projects(id, library_id, name, created, updated) VALUES ('project-1', 'library-1', 'Files', ?1, ?1)", [NOW])?;
                transaction.execute("INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) VALUES (1, 'epoch-1', ?1, ?1)", [NOW])?;
                Ok(())
            })
        }).unwrap();
        let module = super::super::LibraryModule::new("profile-1", "library-1", &kernel);
        for page_id in ["page-a", "page-b"] {
            module
                .apply(
                    &BoundModuleContext {
                        editor_history_owner: None,
                        profile_id: ProfileId("profile-1".to_owned()),
                        library_id: LibraryId("library-1".to_owned()),
                        project_id: Some(ProjectId("project-1".to_owned())),
                        connection_id: "connection:library-files".to_owned(),
                        adapter: AdapterKind::Test,
                    },
                    ModuleApplyRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        operation_id: format!("create:{page_id}"),
                        store_epoch: StoreEpoch("epoch-1".to_owned()),
                        intent: LibraryIntent::CreatePage {
                            page_id: page_id.to_owned(),
                            document_id: format!("document:{page_id}"),
                            title: page_id.to_owned(),
                            parent: LibraryWriteParent::Library { before: None },
                        },
                    },
                )
                .unwrap();
        }
        let assets = home.path().join("assets");
        fs::create_dir_all(&assets).unwrap();
        for bytes in [b"alpha".as_slice(), b"beta".as_slice()] {
            let hash = crate::document::sha256(bytes);
            fs::write(assets.join(format!("{hash}.blob")), bytes).unwrap();
            let length = bytes.len() as i64;
            kernel.writer().call(move |connection| {
                connection.execute("INSERT INTO managed_blobs(content_hash, physical_asset_name, byte_length, created_at) VALUES (?1, ?2, ?3, ?4)", params![hash, format!("{hash}.blob"), length, NOW])?;
                Ok(())
            }).unwrap();
        }
        Fixture { home, kernel }
    }

    fn write<T: Send + 'static>(
        fixture: &Fixture,
        operation: &'static str,
        action: impl FnOnce(&FileWriteContext<'_>) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        fixture.kernel.writer().call(move |connection| {
            with_immediate_transaction(connection, |transaction| {
                action(&FileWriteContext {
                    connection: transaction,
                    library_id: "library-1",
                    actor_id: "project-1",
                    turn_id: None,
                    operation_id: operation,
                    now: NOW,
                })
            })
        })
    }

    fn entry<'a>(
        context: &'a FileWriteContext<'_>,
        page: &'a str,
        revision: i64,
    ) -> EntryWriteContext<'a> {
        EntryWriteContext {
            connection: context.connection,
            library_id: context.library_id,
            page_id: page,
            expected_revision: revision,
            now: context.now,
        }
    }

    fn import(context: &FileWriteContext<'_>, file_id: &str) -> Result<LibraryFile, StoreError> {
        create(
            context,
            file_id,
            "notes.txt",
            FileContent {
                blob_hash: &crate::document::sha256(b"alpha"),
                mime_type: "text/plain",
            },
        )
    }

    fn bound_context(project_id: Option<&str>) -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: project_id.map(|id| ProjectId(id.to_owned())),
            connection_id: "files-api-test".to_owned(),
            adapter: AdapterKind::Test,
        }
    }

    fn prepare(fixture: &Fixture, operation_id: &str, receipt_id: &str, bytes: &[u8]) {
        let hash = crate::document::sha256(bytes);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel)
            .register_prepared_file_blob(
                &bound_context(Some("project-1")),
                "epoch-1",
                operation_id,
                receipt_id,
                &hash,
                &format!("{hash}.blob"),
                bytes.len() as u64,
                now + 60_000,
            )
            .unwrap();
    }

    fn apply_intent(
        module: &crate::library::LibraryModule,
        operation_id: &str,
        intent: LibraryIntent,
    ) -> super::super::LibraryApplyOutcome {
        module
            .apply(
                &bound_context(Some("project-1")),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: operation_id.to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent,
                },
            )
            .unwrap()
    }

    fn page_content(
        module: &crate::library::LibraryModule,
        page_id: &str,
    ) -> nodex_core_contracts::library::LibraryPageContent {
        page_content_with_context(module, page_id, &bound_context(Some("project-1")))
    }

    fn page_content_with_context(
        module: &crate::library::LibraryModule,
        page_id: &str,
        context: &BoundModuleContext,
    ) -> nodex_core_contracts::library::LibraryPageContent {
        use nodex_core_contracts::{
            ModuleReadRequest,
            library::{LibraryRead, LibraryReadValue},
        };
        let value = module
            .read(
                context,
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageContent {
                        page_id: page_id.to_owned(),
                    },
                },
            )
            .unwrap()
            .value;
        let LibraryReadValue::PageContent { value } = value else {
            panic!("Page content");
        };
        *value
    }

    fn place_image(
        fixture: &Fixture,
        module: &crate::library::LibraryModule,
        page_id: &str,
    ) -> String {
        use nodex_core_contracts::library::{
            LibraryDocumentHead, LibraryStructuralEditCommand, LibraryStructuralReplacement,
            LibraryStructuralReplacementBlock, LibraryStructuralSelection,
        };
        let content = page_content(module, page_id);
        let document_id = content.document_id.clone();
        let placeholder = fixture.kernel.readers().read_default(move |connection| {
            Ok(connection.query_row("SELECT block_id FROM document_block_index WHERE document_id = ?1 ORDER BY ordinal LIMIT 1", [&document_id], |row| row.get::<_, String>(0))?)
        }).unwrap();
        apply_intent(
            module,
            &format!("place-image:{page_id}"),
            LibraryIntent::ApplyStructuralEdit {
                command: Box::new(LibraryStructuralEditCommand::ReplaceSelection {
                    selection: LibraryStructuralSelection {
                        source_document_id: content.document_id.clone(),
                        root_block_ids: vec![placeholder],
                        source_head: LibraryDocumentHead {
                            document_id: content.document_id,
                            generation: content.document_generation,
                            head_seq: content.document_head_seq,
                        },
                    },
                    replacement: LibraryStructuralReplacement::Blocks {
                        blocks: vec![
                            LibraryStructuralReplacementBlock {
                                block_type: "image".to_owned(),
                                props: BTreeMap::from([
                                    ("url".to_owned(), serde_json::json!("nodex://files/file-a")),
                                    ("name".to_owned(), serde_json::json!("shared.png")),
                                ]),
                                content: None,
                                children: Vec::new(),
                            },
                            LibraryStructuralReplacementBlock {
                                block_type: "paragraph".to_owned(),
                                props: BTreeMap::new(),
                                content: Some(serde_json::json!([])),
                                children: Vec::new(),
                            },
                        ],
                    },
                }),
            },
        )
        .committed
        .value
        .structural_edit
        .unwrap()
        .result_root_block_ids[0]
            .clone()
    }

    fn create_image(fixture: &Fixture, module: &crate::library::LibraryModule) {
        use nodex_core_contracts::library::LibraryFileChange;
        prepare(fixture, "create-image", "image-receipt", b"alpha");
        apply_intent(
            module,
            "create-image",
            LibraryIntent::ApplyFileChange {
                change: LibraryFileChange::Create {
                    file_id: "file-a".to_owned(),
                    default_name: "shared.png".to_owned(),
                    mime_type: "image/png".to_owned(),
                    prepared_blob_receipt_id: "image-receipt".to_owned(),
                },
                turn_id: None,
            },
        );
    }

    #[test]
    fn library_file_lifecycle_requires_detachment_and_retires_purged_identity() {
        use nodex_core_contracts::library::{
            LibraryFileChange, LibraryFileReadSource, LibraryPageFileCollisionPolicy,
            LibraryPageFileEntryChange,
        };
        let fixture = fixture();
        let library = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        create_image(&fixture, &library);
        let request = |operation: &str, change| ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: operation.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::ApplyFileChange {
                change,
                turn_id: None,
            },
        };
        let trash = |revision| LibraryFileChange::Trash {
            file_id: "file-a".to_owned(),
            expected_revision: revision,
        };
        let restore = |revision| LibraryFileChange::Restore {
            file_id: "file-a".to_owned(),
            expected_revision: revision,
        };
        let purge = |revision| LibraryFileChange::Purge {
            file_id: "file-a".to_owned(),
            expected_revision: revision,
        };
        let context = bound_context(Some("project-1"));
        assert_eq!(
            library
                .apply(&context, request("purge-live", purge(1)))
                .unwrap_err()
                .code,
            nodex_core_contracts::CoreErrorCode::Conflict
        );
        apply_intent(
            &library,
            "attach",
            LibraryIntent::ApplyPageFileEntries {
                page_id: "page-a".to_owned(),
                expected_manifest_revision: 0,
                changes: vec![LibraryPageFileEntryChange::Attach {
                    file_id: "file-a".to_owned(),
                    logical_path: "image.png".to_owned(),
                    source: LibraryFileReadSource::Direct,
                    collision_policy: LibraryPageFileCollisionPolicy::Reject,
                }],
                turn_id: None,
            },
        );
        assert_eq!(
            library
                .apply(&context, request("trash-attached", trash(1)))
                .unwrap_err()
                .code,
            nodex_core_contracts::CoreErrorCode::Conflict
        );
        apply_intent(
            &library,
            "detach",
            LibraryIntent::ApplyPageFileEntries {
                page_id: "page-a".to_owned(),
                expected_manifest_revision: 1,
                changes: vec![LibraryPageFileEntryChange::Remove {
                    file_id: "file-a".to_owned(),
                }],
                turn_id: None,
            },
        );
        let trashed = library.apply(&context, request("trash", trash(1))).unwrap();
        assert_eq!(
            trashed
                .committed
                .value
                .file_mutation
                .unwrap()
                .file
                .unwrap()
                .lifecycle,
            LibraryFileLifecycle::Trashed
        );
        assert!(
            library
                .apply(&context, request("stale-restore", restore(1)))
                .is_err()
        );
        library
            .apply(&context, request("restore", restore(2)))
            .unwrap();
        library
            .apply(&context, request("trash-again", trash(3)))
            .unwrap();
        library
            .apply(
                &context,
                request(
                    "share-bytes",
                    LibraryFileChange::Fork {
                        source_file_id: "file-a".to_owned(),
                        source_version: 1,
                        source: LibraryFileReadSource::Direct,
                        file_id: "file-shared-bytes".to_owned(),
                        default_name: "second.png".to_owned(),
                    },
                ),
            )
            .unwrap();
        let command = request("purge", purge(4));
        let purged = library.apply(&context, command.clone()).unwrap();
        assert!(purged.committed.value.file_mutation.unwrap().file.is_none());
        let replay = library.apply(&context, command).unwrap();
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(replay.event.is_none());
        write(&fixture,"verify-retirement",|write| {
            assert_eq!(write.connection.query_row("SELECT count(*) FROM file_versions WHERE file_id = 'file-a'",[],|row| row.get::<_,i64>(0))?,0);
            assert_eq!(write.connection.query_row("SELECT count(*) FROM retired_file_ids WHERE file_id = 'file-a'",[],|row| row.get::<_,i64>(0))?,1);
            assert_eq!(import(write,"file-a").unwrap_err().code,StoreErrorCode::Conflict);
            assert!(write.connection.query_row("SELECT NOT EXISTS(SELECT 1 FROM project_resource_grants WHERE root_kind = 'file' AND root_id = 'file-a' AND lifecycle = 'active')",[],|row| row.get::<_,bool>(0))?);
            Ok(())
        }).unwrap();
        assert_eq!(
            library.collect_unreachable_file_blobs(100).unwrap(),
            1,
            "only unrelated beta bytes can be collected"
        );
        assert!(
            fixture
                .home
                .path()
                .join("assets")
                .join(format!("{}.blob", crate::document::sha256(b"alpha")))
                .exists()
        );
        for (operation, change) in [
            (
                "trash-shared-bytes",
                LibraryFileChange::Trash {
                    file_id: "file-shared-bytes".to_owned(),
                    expected_revision: 1,
                },
            ),
            (
                "purge-shared-bytes",
                LibraryFileChange::Purge {
                    file_id: "file-shared-bytes".to_owned(),
                    expected_revision: 2,
                },
            ),
        ] {
            library.apply(&context, request(operation, change)).unwrap();
        }
        assert_eq!(library.collect_unreachable_file_blobs(100).unwrap(), 1);
        assert!(
            !fixture
                .home
                .path()
                .join("assets")
                .join(format!("{}.blob", crate::document::sha256(b"alpha")))
                .exists()
        );
        let replay = library.apply(&context, request("purge", purge(4))).unwrap();
        assert!(replay.committed.receipt.mutation.duplicate);
    }

    #[test]
    fn page_file_inventory_reports_read_only_authority() {
        use nodex_core_contracts::{
            ModuleReadRequest,
            library::{
                LibraryAccess, LibraryProjectAccessChange, LibraryRead, LibraryReadValue,
                LibraryResourceTarget,
            },
        };
        let fixture = fixture();
        let library = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        library
            .apply(
                &bound_context(None),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "read-only-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page-a".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: Some(LibraryAccess::Read),
                            expected_revision: Some(1),
                        }],
                    },
                },
            )
            .unwrap();
        let read = |context| {
            library
                .read(
                    &context,
                    ModuleReadRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        read: LibraryRead::PageFileInventory {
                            page_id: "page-a".to_owned(),
                            query: None,
                            cursor: None,
                            limit: Some(50),
                        },
                    },
                )
                .unwrap()
        };
        let LibraryReadValue::PageFileInventory { value } =
            read(bound_context(Some("project-1"))).value
        else {
            panic!("inventory")
        };
        assert!(!value.can_write);
        let LibraryReadValue::PageFileInventory { value } = read(bound_context(None)).value else {
            panic!("inventory")
        };
        assert!(value.can_write);
    }

    #[test]
    fn library_file_usages_paginate_only_authorized_owners_and_revoke_cached_dependencies() {
        use nodex_core_contracts::ModuleReadRequest;
        use nodex_core_contracts::library::{
            LibraryProjectAccessChange, LibraryRead, LibraryReadValue, LibraryResourceTarget,
        };
        let fixture = fixture();
        let library = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        create_image(&fixture, &library);
        place_image(&fixture, &library, "page-a");
        place_image(&fixture, &library, "page-b");
        let read = |cursor| {
            library.read(
                &bound_context(Some("project-1")),
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::FileUsages {
                        file_id: "file-a".to_owned(),
                        cursor,
                        limit: Some(1),
                    },
                },
            )
        };
        let first = read(None).unwrap();
        let LibraryReadValue::FileUsages { value: first_page } = first.value else {
            panic!("usages")
        };
        assert_eq!(first_page.items.len(), 1);
        assert_eq!(
            first_page.items[0].target,
            nodex_core_contracts::library::LibraryPlacedResourceTarget::Page {
                page_id: "page-a".to_owned()
            }
        );
        assert_eq!(first_page.items[0].occurrence_count, 1);
        assert_eq!(first_page.items[0].title, "page-a");
        assert_eq!(
            first_page.items[0].lifecycle,
            nodex_core_contracts::library::LibraryPageLifecycleState::Active
        );
        assert!(first_page.has_more);
        assert!(first_page.can_write);
        assert!(!first_page.can_trash);
        let cursor = first_page.next_cursor.unwrap();
        library
            .apply(
                &bound_context(None),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "hide-page-b".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::Page {
                            page_id: "page-b".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: None,
                            expected_revision: Some(1),
                        }],
                    },
                },
            )
            .unwrap();
        let LibraryReadValue::FileUsages { value: remaining } =
            read(Some(cursor.clone())).unwrap().value
        else {
            panic!("usages")
        };
        assert!(remaining.items.is_empty());
        assert!(!remaining.has_more);
        assert!(remaining.next_cursor.is_none());
        library
            .apply(
                &bound_context(None),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "hide-file".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::File {
                            file_id: "file-a".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: None,
                            expected_revision: Some(1),
                        }],
                    },
                },
            )
            .unwrap();
        assert_eq!(
            read(Some(cursor)).unwrap_err().code,
            nodex_core_contracts::CoreErrorCode::Unauthorized
        );
    }

    #[test]
    fn canvas_slots_and_history_keep_two_versions_of_one_shared_file() {
        use nodex_core_contracts::OWNED_DOCUMENT_CONTRACT_VERSION;
        use nodex_core_contracts::document::{DocumentRevisionKind, OwnedDocumentIntent};
        use nodex_core_contracts::library::{
            LibraryCanvasDestination, LibraryFileChange, LibraryFileReadSource,
            LibraryProjectAccessChange, LibraryResourceTarget,
        };
        for trashed in [false, true] {
            let fixture = fixture();
            let library =
                crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
            let documents = crate::document::OwnedDocumentModule::new(
                "profile-1",
                "library-1",
                &fixture.kernel,
            );
            let context = bound_context(Some("project-1"));
            create_image(&fixture, &library);
            prepare(&fixture, "canvas-beta", "canvas-beta-receipt", b"beta");
            apply_intent(
                &library,
                "canvas-beta",
                LibraryIntent::ApplyFileChange {
                    change: LibraryFileChange::ReplaceContent {
                        file_id: "file-a".to_owned(),
                        expected_revision: 1,
                        expected_head_version: 1,
                        mime_type: "image/png".to_owned(),
                        prepared_blob_receipt_id: "canvas-beta-receipt".to_owned(),
                    },
                    turn_id: None,
                },
            );
            apply_intent(
                &library,
                "create-file-canvas",
                LibraryIntent::CreateCanvas {
                    canvas_id: "01990000-0000-7000-8000-000000000001".to_owned(),
                    document_id: "01990000-0000-7000-8000-000000000002".to_owned(),
                    display_name: "Versions".to_owned(),
                    destination: LibraryCanvasDestination::Library { before: None },
                },
            );
            let apply = |operation: &str, intent| {
                documents
                    .apply(
                        &context,
                        ModuleApplyRequest {
                            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                            operation_id: operation.to_owned(),
                            store_epoch: StoreEpoch("epoch-1".to_owned()),
                            intent,
                        },
                    )
                    .unwrap()
            };
            let elements = |deleted: bool, version: i64| {
                serde_json::json!([
                    { "id": "image-alpha", "type": "image", "version": version, "versionNonce": 1,
                        "isDeleted": deleted, "fileId": "slot-alpha" },
                    { "id": "image-beta", "type": "image", "version": version, "versionNonce": 1,
                        "isDeleted": deleted, "fileId": "slot-beta" },
                ])
            };
            apply(
                "add-canvas-file-versions",
                OwnedDocumentIntent::ApplyCanvasMutation {
                    document_id: "01990000-0000-7000-8000-000000000002".to_owned(),
                    generation: 1,
                    expected_head_seq: 0,
                    mutation: serde_json::json!({ "elementCandidates": elements(false, 1), "appStateIntents": {},
                        "fileAdditions": {
                            "slot-alpha": {"id":"slot-alpha", "mimeType":"image/png", "source":"nodex://files/file-a", "fileVersion":1, "defaultName":"shared.png"},
                            "slot-beta": {"id":"slot-beta", "mimeType":"image/png", "source":"nodex://files/file-a", "fileVersion":2, "defaultName":"shared.png"}
                        }
                    }),
                },
            );
            let checkpoint = apply(
                "checkpoint-canvas-files",
                OwnedDocumentIntent::CreateCheckpoint {
                    document_id: "01990000-0000-7000-8000-000000000002".to_owned(),
                    generation: 1,
                    expected_head_seq: 1,
                    cause: "manual".to_owned(),
                    label: None,
                    actor: serde_json::json!({"kind":"user"}),
                    revision_kind: Some(DocumentRevisionKind::Manual),
                    source_mutation_id: None,
                    source_change_seq: None,
                },
            )
            .committed
            .value
            .checkpoint_effect
            .unwrap()
            .checkpoint;
            assert_eq!(checkpoint["fileSnapshotStatus"], "exact");
            let revision_id = checkpoint["versionId"].as_str().unwrap().to_owned();
            prepare(&fixture, "canvas-new-head", "canvas-head-receipt", b"alpha");
            apply_intent(
                &library,
                "canvas-new-head",
                LibraryIntent::ApplyFileChange {
                    change: LibraryFileChange::ReplaceContent {
                        file_id: "file-a".to_owned(),
                        expected_revision: 2,
                        expected_head_version: 2,
                        mime_type: "image/png".to_owned(),
                        prepared_blob_receipt_id: "canvas-head-receipt".to_owned(),
                    },
                    turn_id: None,
                },
            );
            library
                .apply(
                    &bound_context(None),
                    ModuleApplyRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        operation_id: "revoke-canvas-file".to_owned(),
                        store_epoch: StoreEpoch("epoch-1".to_owned()),
                        intent: LibraryIntent::SetProjectAccess {
                            target: LibraryResourceTarget::File {
                                file_id: "file-a".to_owned(),
                            },
                            changes: vec![LibraryProjectAccessChange {
                                project_id: "project-1".to_owned(),
                                access: None,
                                expected_revision: Some(1),
                            }],
                        },
                    },
                )
                .unwrap();
            for (slot, version, bytes) in [
                ("slot-alpha", 1, b"alpha".as_slice()),
                ("slot-beta", 2, b"beta".as_slice()),
            ] {
                for source in [
                    LibraryFileReadSource::Canvas {
                        canvas_id: "01990000-0000-7000-8000-000000000001".to_owned(),
                        scene_file_id: slot.to_owned(),
                    },
                    LibraryFileReadSource::CanvasRevision {
                        document_id: "01990000-0000-7000-8000-000000000002".to_owned(),
                        revision_id: revision_id.clone(),
                        scene_file_id: slot.to_owned(),
                    },
                ] {
                    let blob = library
                        .resolve_file_blob(&context, "file-a", &source, Some(version))
                        .unwrap();
                    assert_eq!(fs::read(blob.physical_path).unwrap(), bytes);
                    assert!(
                        library
                            .resolve_file_blob(&context, "file-a", &source, Some(3))
                            .is_err()
                    );
                }
            }
            assert!(
                library
                    .resolve_file_blob(&context, "file-a", &LibraryFileReadSource::Direct, None)
                    .is_err()
            );
            apply(
                "remove-canvas-images",
                OwnedDocumentIntent::ApplyCanvasMutation {
                    document_id: "01990000-0000-7000-8000-000000000002".to_owned(),
                    generation: 1,
                    expected_head_seq: 1,
                    mutation: serde_json::json!({"elementCandidates":elements(true, 2), "appStateIntents":{}, "fileAdditions":{}}),
                },
            );
            let unproven = documents.apply(&context, ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION, operation_id: "unproven-canvas-file".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()), intent: OwnedDocumentIntent::ApplyCanvasMutation {
                document_id: "01990000-0000-7000-8000-000000000002".to_owned(), generation: 1, expected_head_seq: 2,
                mutation: serde_json::json!({ "elementCandidates": [{"id":"unproven-image", "type":"image", "version":1, "versionNonce":1, "isDeleted":false, "fileId":"unproven-slot"}],
                    "appStateIntents":{}, "fileAdditions":{"unproven-slot":{"id":"unproven-slot", "mimeType":"image/png", "source":"nodex://files/file-a", "fileVersion":1, "defaultName":"shared.png"}} }),
            },
        }).unwrap_err();
            assert_eq!(
                unproven.code,
                nodex_core_contracts::CoreErrorCode::Unauthorized
            );
            if trashed {
                library
                    .apply(
                        &bound_context(None),
                        ModuleApplyRequest {
                            contract_version: LIBRARY_CONTRACT_VERSION,
                            operation_id: "trash-canvas-file".to_owned(),
                            store_epoch: StoreEpoch("epoch-1".to_owned()),
                            intent: LibraryIntent::ApplyFileChange {
                                change: LibraryFileChange::Trash {
                                    file_id: "file-a".to_owned(),
                                    expected_revision: 3,
                                },
                                turn_id: None,
                            },
                        },
                    )
                    .unwrap();
                assert_eq!(
                    library
                        .apply(
                            &bound_context(None),
                            ModuleApplyRequest {
                                contract_version: LIBRARY_CONTRACT_VERSION,
                                operation_id: "purge-retained-canvas-file".to_owned(),
                                store_epoch: StoreEpoch("epoch-1".to_owned()),
                                intent: LibraryIntent::ApplyFileChange {
                                    change: LibraryFileChange::Purge {
                                        file_id: "file-a".to_owned(),
                                        expected_revision: 4
                                    },
                                    turn_id: None
                                },
                            }
                        )
                        .unwrap_err()
                        .code,
                    nodex_core_contracts::CoreErrorCode::Conflict
                );
            }
            let restored = apply(
                "restore-canvas-versions",
                OwnedDocumentIntent::RestoreVersion {
                    document_id: "01990000-0000-7000-8000-000000000002".to_owned(),
                    version_id: revision_id.clone(),
                    generation: 1,
                    expected_head_seq: 2,
                    actor: serde_json::json!({"kind":"user"}),
                },
            );
            assert_eq!(restored.committed.value.head_seq, 3);
            let checked_revision = revision_id.clone();
            write(&fixture, "assert-canvas-version-index", move |context| {
            let versions = context.connection.prepare("SELECT file_version FROM document_version_file_refs WHERE version_id = ?1 ORDER BY binding_id")?
                .query_map([checked_revision], |row| row.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(versions, vec![1, 2]);
            let original = metadata(context.connection, context.library_id, "file-a")?;
            assert_eq!(original.head_version, 3);
            assert_eq!(original.lifecycle, if trashed { LibraryFileLifecycle::Trashed } else { LibraryFileLifecycle::Live });
            assert_eq!(context.connection.query_row("SELECT count(*) FROM library_files", [], |row| row.get::<_, i64>(0))?, if trashed { 3 } else { 1 });
            Ok(())
        }).unwrap();
            for (slot, bytes) in [
                ("slot-alpha", b"alpha".as_slice()),
                ("slot-beta", b"beta".as_slice()),
            ] {
                let source = LibraryFileReadSource::Canvas {
                    canvas_id: "01990000-0000-7000-8000-000000000001".to_owned(),
                    scene_file_id: slot.to_owned(),
                };
                let file_id = fixture.kernel.readers().read_default(|connection| {
                connection.query_row("SELECT target_file_id FROM canvas_scene_file_refs WHERE document_id = '01990000-0000-7000-8000-000000000002' AND file_id = ?1", [slot], |row| row.get::<_,String>(0)).map_err(StoreError::from)
            }).unwrap();
                assert_eq!(file_id == "file-a", !trashed);
                assert_eq!(
                    fs::read(
                        library
                            .resolve_file_blob(&context, &file_id, &source, None)
                            .unwrap()
                            .physical_path
                    )
                    .unwrap(),
                    bytes
                );
            }
        }
    }

    #[test]
    fn exact_history_restores_forward_without_rewinding_a_shared_file() {
        use nodex_core_contracts::document::{DocumentRevisionKind, OwnedDocumentIntent};
        use nodex_core_contracts::library::{
            LibraryFileChange, LibraryFileReadSource, LibraryRead, LibraryReadValue,
        };
        use nodex_core_contracts::{ModuleReadRequest, OWNED_DOCUMENT_CONTRACT_VERSION};
        let fixture = fixture();
        let library = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        let documents =
            crate::document::OwnedDocumentModule::new("profile-1", "library-1", &fixture.kernel);
        let context = bound_context(Some("project-1"));
        create_image(&fixture, &library);
        place_image(&fixture, &library, "page-a");
        place_image(&fixture, &library, "page-b");
        let page = page_content(&library, "page-a");
        let checkpoint = documents
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "exact-checkpoint".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: OwnedDocumentIntent::CreateCheckpoint {
                        document_id: page.document_id.clone(),
                        generation: page.document_generation,
                        expected_head_seq: page.document_head_seq,
                        cause: "manual".to_owned(),
                        label: None,
                        actor: serde_json::json!({"kind":"user"}),
                        revision_kind: Some(DocumentRevisionKind::Manual),
                        source_mutation_id: None,
                        source_change_seq: None,
                    },
                },
            )
            .unwrap()
            .committed
            .value
            .checkpoint_effect
            .unwrap()
            .checkpoint;
        let version_id = checkpoint["versionId"].as_str().unwrap().to_owned();
        assert_eq!(checkpoint["fileSnapshotStatus"], "exact");
        prepare(&fixture, "shared-beta", "beta-receipt", b"beta");
        apply_intent(
            &library,
            "shared-beta",
            LibraryIntent::ApplyFileChange {
                change: LibraryFileChange::ReplaceContent {
                    file_id: "file-a".to_owned(),
                    expected_revision: 1,
                    expected_head_version: 1,
                    mime_type: "image/png".to_owned(),
                    prepared_blob_receipt_id: "beta-receipt".to_owned(),
                },
                turn_id: None,
            },
        );
        apply_intent(
            &library,
            "rename-shared",
            LibraryIntent::ApplyFileChange {
                change: LibraryFileChange::Rename {
                    file_id: "file-a".to_owned(),
                    expected_revision: 2,
                    default_name: "current.png".to_owned(),
                },
                turn_id: None,
            },
        );
        let original_hash = checkpoint["checkpointHash"].as_str().unwrap().to_owned();
        let original_head = page.document_head_seq;
        fixture.kernel.writer().call(move |connection| {
            connection.execute("UPDATE document_revision_sessions SET last_edit_at = '2026-01-01T00:00:00.000Z'", [])?;
            assert_eq!(crate::document::finalize_idle_document_revisions(connection, &bound_context(Some("project-1")))?, 2);
            let (head, hash, target_version, name) = connection.query_row(
                "SELECT version.base_head_seq, version.checkpoint_hash, reference.file_version, reference.default_name FROM document_versions version JOIN document_version_file_refs reference ON reference.version_id = version.version_id WHERE version.document_id = 'document:page-a' AND version.cause = 'idle_edit' AND reference.file_id = 'file-a'",
                [], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?)),
            )?;
            assert_eq!(head, original_head);
            assert_ne!(hash, original_hash);
            assert_eq!((target_version, name.as_str()), (2, "current.png"));
            Ok(())
        }).unwrap();
        // Exact historical use is authorized by the Page, independently of a
        // direct File grant; restoration only grants the newly created File.
        fixture.kernel.writer().call(|connection| {
            connection.execute("UPDATE project_resource_grants SET lifecycle = 'revoked' WHERE root_kind = 'file' AND root_id = 'file-a'", [])?;
            Ok(())
        }).unwrap();
        let source = LibraryFileReadSource::DocumentRevision {
            document_id: page.document_id.clone(),
            revision_id: version_id.clone(),
        };
        let historical = library
            .read(
                &context,
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::FilePresentation {
                        file_id: "file-a".to_owned(),
                        source: source.clone(),
                        version: None,
                    },
                },
            )
            .unwrap()
            .value;
        let LibraryReadValue::FilePresentation { value } = historical else {
            panic!("File presentation");
        };
        assert_eq!(
            (value.version, value.default_name.as_str()),
            (1, "shared.png")
        );
        let old_blob = library
            .resolve_file_blob(&context, "file-a", &source, None)
            .unwrap();
        assert_eq!(fs::read(old_blob.physical_path).unwrap(), b"alpha");
        let request = ModuleApplyRequest {
            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
            operation_id: "restore-exact".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: OwnedDocumentIntent::RestoreVersion {
                document_id: page.document_id.clone(),
                version_id,
                generation: page.document_generation,
                expected_head_seq: page.document_head_seq,
                actor: serde_json::json!({"kind":"user"}),
            },
        };
        let restored = documents.apply(&context, request.clone()).unwrap();
        assert_eq!(restored.events.len(), 2);
        assert!(
            restored
                .events
                .iter()
                .all(|event| event.operation_id.as_deref() == Some("restore-exact"))
        );
        let replay = documents.apply(&context, request).unwrap();
        assert!(replay.committed.receipt.mutation.duplicate);
        assert!(replay.events.is_empty());
        let restored_id = fixture
            .kernel
            .readers()
            .read_default(|connection| {
                let id = connection.query_row(
                    "SELECT file_id FROM block_asset_refs WHERE owner_block_id = 'page-a'",
                    [],
                    |row| row.get::<_, String>(0),
                )?;
                assert_ne!(id, "file-a");
                let source = metadata(connection, "library-1", "file-a")?;
                assert_eq!(
                    (
                        source.head_version,
                        source.revision,
                        source.default_name.as_str()
                    ),
                    (2, 3, "current.png")
                );
                assert_eq!(
                    connection.query_row("SELECT count(*) FROM library_files", [], |row| row
                        .get::<_, i64>(0))?,
                    2
                );
                assert_eq!(
                    connection
                        .query_row("SELECT count(*) FROM page_file_entries", [], |row| row
                            .get::<_, i64>(0))?,
                    0
                );
                Ok(id)
            })
            .unwrap();
        let restored_file = library
            .resolve_file_blob(&context, &restored_id, &LibraryFileReadSource::Direct, None)
            .unwrap();
        assert_eq!(
            (restored_file.version, restored_file.default_name.as_str()),
            (1, "shared.png")
        );
        assert_eq!(fs::read(restored_file.physical_path).unwrap(), b"alpha");
        let current_blob = library
            .resolve_file_blob(
                &context,
                "file-a",
                &LibraryFileReadSource::Page {
                    page_id: "page-b".to_owned(),
                },
                None,
            )
            .unwrap();
        assert_eq!(fs::read(current_blob.physical_path).unwrap(), b"beta");
    }

    #[test]
    fn historical_file_index_corruption_and_unknown_legacy_targets_fail_closed() {
        use nodex_core_contracts::document::{
            OwnedDocumentIntent, OwnedDocumentRead, OwnedDocumentReadValue,
        };
        use nodex_core_contracts::{ModuleReadRequest, OWNED_DOCUMENT_CONTRACT_VERSION};
        let fixture = fixture();
        let library = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        let documents =
            crate::document::OwnedDocumentModule::new("profile-1", "library-1", &fixture.kernel);
        let context = bound_context(Some("project-1"));
        create_image(&fixture, &library);
        place_image(&fixture, &library, "page-a");
        let page = page_content(&library, "page-a");
        let checkpoint = documents
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: "checkpoint-index".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: OwnedDocumentIntent::CreateCheckpoint {
                        document_id: page.document_id.clone(),
                        generation: page.document_generation,
                        expected_head_seq: page.document_head_seq,
                        cause: "manual".to_owned(),
                        label: None,
                        actor: serde_json::json!({"kind":"user"}),
                        revision_kind: None,
                        source_mutation_id: None,
                        source_change_seq: None,
                    },
                },
            )
            .unwrap()
            .committed
            .value
            .checkpoint_effect
            .unwrap()
            .checkpoint;
        let version_id = checkpoint["versionId"].as_str().unwrap().to_owned();
        let checkpoint_id = version_id.clone();
        fixture.kernel.writer().call(move |connection| {
            with_immediate_transaction(connection, |connection| {
                let bytes = connection.query_row("SELECT full_update_blob FROM document_versions WHERE version_id = ?1", [&checkpoint_id], |row| row.get::<_, Vec<u8>>(0))?;
                let mut legacy: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                legacy.as_object_mut().unwrap().remove("fileSnapshot");
                legacy["formatVersion"] = serde_json::json!(2);
                let legacy = serde_json::to_vec(&legacy).unwrap();
                connection.execute("INSERT INTO document_versions(version_id, document_id, project_id, generation, base_head_seq, schema_key, schema_version, cause, label, actor_json, revision_kind, source_mutation_id, source_change_seq, pinned, checkpoint_format, full_update_blob, state_vector, checkpoint_hash, byte_length, created_at)
                    SELECT 'legacy-file-history', document_id, project_id, generation, base_head_seq, schema_key, schema_version, cause, label, actor_json, revision_kind, source_mutation_id, source_change_seq, pinned, 'block_tree_snapshot_v2', ?1, state_vector, ?2, ?3, created_at FROM document_versions WHERE version_id = ?4",
                    params![legacy, crate::document::sha256(&legacy), legacy.len() as i64, checkpoint_id])?;
                // The canonical bytes remain intact; only their derived index is corrupt.
                connection.execute("DELETE FROM document_version_file_refs WHERE version_id = ?1", [&checkpoint_id])?;
                Ok(())
            })
        }).unwrap();
        let restore = |version_id: String, operation: &str| {
            documents.apply(
                &context,
                ModuleApplyRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    operation_id: operation.to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: OwnedDocumentIntent::RestoreVersion {
                        document_id: page.document_id.clone(),
                        version_id,
                        generation: page.document_generation,
                        expected_head_seq: page.document_head_seq,
                        actor: serde_json::json!({"kind":"user"}),
                    },
                },
            )
        };
        assert_eq!(
            restore(version_id, "restore-corrupt-index")
                .unwrap_err()
                .code,
            nodex_core_contracts::CoreErrorCode::StoreCorrupt
        );
        let legacy = documents
            .read(
                &context,
                ModuleReadRequest {
                    contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                    read: OwnedDocumentRead::GetVersion {
                        document_id: page.document_id.clone(),
                        version_id: "legacy-file-history".to_owned(),
                    },
                },
            )
            .unwrap()
            .value;
        let OwnedDocumentReadValue::Version { value: version } = legacy else {
            panic!("historical preview");
        };
        assert_eq!(
            version["summary"]["fileSnapshotStatus"],
            "unresolved_legacy"
        );
        assert_eq!(
            restore("legacy-file-history".to_owned(), "restore-unknown-legacy")
                .unwrap_err()
                .code,
            nodex_core_contracts::CoreErrorCode::Conflict
        );
        assert_eq!(
            page_content(&library, "page-a").document_head_seq,
            page.document_head_seq
        );
        fixture
            .kernel
            .readers()
            .read_default(|connection| {
                assert_eq!(
                    connection.query_row("SELECT count(*) FROM library_files", [], |row| row
                        .get::<_, i64>(0))?,
                    1
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn recovery_restore_and_copy_keep_captured_file_bytes_after_shared_updates() {
        use nodex_core_contracts::document::*;
        use nodex_core_contracts::library::{LibraryFileChange, LibraryFileReadSource};
        use nodex_core_contracts::{ModuleReadRequest, OWNED_DOCUMENT_CONTRACT_VERSION};
        for choice in [RecoveryChoice::Restore, RecoveryChoice::Copy] {
            let fixture = fixture();
            let library =
                crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
            let documents = crate::document::OwnedDocumentModule::new(
                "profile-1",
                "library-1",
                &fixture.kernel,
            );
            let context = bound_context(if matches!(&choice, RecoveryChoice::Copy) {
                None
            } else {
                Some("project-1")
            });
            create_image(&fixture, &library);
            place_image(&fixture, &library, "page-a");
            place_image(&fixture, &library, "page-b");
            let page = page_content(&library, "page-a");
            let state = fixture
                .kernel
                .readers()
                .read_default(|connection| {
                    let authority =
                        crate::document::read_document_authority(connection, "document:page-a")?
                            .unwrap();
                    let mut engine =
                        crate::document::reconstruct_yjs_engine(connection, &authority.head)?;
                    let update = crate::document::prepare_document_operation_update(
                        "document:page-a",
                        crate::document::BlockDocumentSchema::PageV3,
                        &engine.full_state_v1(),
                        &engine.state_vector_v1(),
                        &[crate::document::DocumentBlockOperation::SetTitle {
                            title: "Unsaved title".to_owned(),
                        }],
                        false,
                    )
                    .unwrap();
                    let candidate = engine.prepare_update_v1(&update.update_v1).unwrap();
                    engine.commit_candidate(candidate).unwrap();
                    Ok(engine.full_state_v1())
                })
                .unwrap();
            documents
                .apply(
                    &context,
                    ModuleApplyRequest {
                        contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                        operation_id: "capture-files".to_owned(),
                        store_epoch: StoreEpoch("epoch-1".to_owned()),
                        intent: OwnedDocumentIntent::CaptureRecovery {
                            capture: Box::new(RecoveryDraftCapture {
                                draft_id: "draft-files".to_owned(),
                                document_id: page.document_id.clone(),
                                source_store_epoch: "epoch-1".to_owned(),
                                generation: page.document_generation,
                                base_head_seq: page.document_head_seq,
                                created_at: NOW.to_owned(),
                                schema_key: crate::document::PAGE_SCHEMA_KEY.to_owned(),
                                schema_version: crate::document::PAGE_SCHEMA_VERSION.into(),
                                content: RecoveryDraftContent::Yjs {
                                    state,
                                    unintegrated_updates: Vec::new(),
                                },
                                source: serde_json::json!({"kind":"test"}),
                            }),
                        },
                    },
                )
                .unwrap();
            prepare(&fixture, "shared-beta", "beta-receipt", b"beta");
            apply_intent(
                &library,
                "shared-beta",
                LibraryIntent::ApplyFileChange {
                    change: LibraryFileChange::ReplaceContent {
                        file_id: "file-a".to_owned(),
                        expected_revision: 1,
                        expected_head_version: 1,
                        mime_type: "image/png".to_owned(),
                        prepared_blob_receipt_id: "beta-receipt".to_owned(),
                    },
                    turn_id: None,
                },
            );
            fixture.kernel.writer().call(|connection| {
                connection.execute("UPDATE project_resource_grants SET lifecycle = 'revoked' WHERE root_kind = 'file' AND root_id = 'file-a'", [])?;
                Ok(())
            }).unwrap();
            let source = LibraryFileReadSource::RecoveryDraft {
                document_id: page.document_id.clone(),
                draft_id: "draft-files".to_owned(),
            };
            let bytes = library
                .resolve_file_blob(&context, "file-a", &source, None)
                .unwrap();
            assert_eq!(fs::read(bytes.physical_path).unwrap(), b"alpha");
            assert!(
                library
                    .resolve_file_blob(&context, "file-a", &source, Some(2))
                    .is_err()
            );
            let inspect = || {
                let value = documents
                    .read(
                        &context,
                        ModuleReadRequest {
                            contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                            read: OwnedDocumentRead::Recovery {
                                read: RecoveryRead::Inspect {
                                    draft_id: "draft-files".to_owned(),
                                },
                            },
                        },
                    )
                    .unwrap()
                    .value;
                let OwnedDocumentReadValue::Recovery {
                    value: RecoveryReadValue::Inspect { inspection },
                } = value
                else {
                    panic!("Recovery inspection");
                };
                *inspection
            };
            let inspection = inspect();
            assert!(inspection.can_restore && inspection.can_copy && !inspection.already_saved);
            for (preview, expected_version, expected_bytes) in [
                (&inspection.current, 2, b"beta".as_slice()),
                (&inspection.retained, 1, b"alpha".as_slice()),
                (&inspection.restored, 1, b"alpha".as_slice()),
            ] {
                let Some(RecoveryPreview::Document { files, .. }) = preview else {
                    panic!("body preview");
                };
                let binding = files.get("file-a").expect("explicit preview binding");
                assert_eq!(binding.version, expected_version);
                assert_eq!(
                    binding.source,
                    if expected_version == 2 {
                        LibraryFileReadSource::Page {
                            page_id: "page-a".to_owned(),
                        }
                    } else {
                        source.clone()
                    }
                );
                let read = library
                    .resolve_file_blob(
                        &context,
                        &binding.file_id,
                        &binding.source,
                        Some(binding.version),
                    )
                    .unwrap();
                assert_eq!(fs::read(read.physical_path).unwrap(), expected_bytes);
            }
            let request = ModuleApplyRequest {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                operation_id: "resolve-files".to_owned(),
                store_epoch: StoreEpoch("epoch-1".to_owned()),
                intent: OwnedDocumentIntent::ResolveRecovery {
                    resolve: RecoveryDraftResolve {
                        draft_id: "draft-files".to_owned(),
                        revision: inspection.summary.revision,
                        expected_generation: inspection.current_generation,
                        expected_head_seq: inspection.current_head_seq,
                        choice,
                    },
                },
            };
            let resolved = documents.apply(&context, request.clone()).unwrap();
            assert!(resolved.events.len() >= 2);
            let retried = documents.apply(&context, request).unwrap();
            assert!(retried.committed.receipt.mutation.duplicate);
            assert!(retried.events.is_empty());
            let target = inspect()
                .summary
                .target_owner_id
                .unwrap_or_else(|| "page-a".to_owned());
            let target_content = page_content_with_context(&library, &target, &context);
            assert_eq!(target_content.title, "Unsaved title");
            let target_for_query = target.clone();
            let file_id = fixture
                .kernel
                .readers()
                .read_default(move |connection| {
                    assert_eq!(
                        connection
                            .query_row("SELECT count(*) FROM library_files", [], |row| row
                                .get::<_, i64>(0))?,
                        2
                    );
                    Ok(connection.query_row(
                        "SELECT file_id FROM block_asset_refs WHERE owner_block_id = ?1",
                        [&target_for_query],
                        |row| row.get::<_, String>(0),
                    )?)
                })
                .unwrap();
            assert_ne!(file_id, "file-a");
            let recovered = library
                .resolve_file_blob(
                    &context,
                    &file_id,
                    &LibraryFileReadSource::Page { page_id: target },
                    None,
                )
                .unwrap();
            assert_eq!(fs::read(recovered.physical_path).unwrap(), b"alpha");
            let shared = library
                .resolve_file_blob(
                    &context,
                    "file-a",
                    &LibraryFileReadSource::Page {
                        page_id: "page-b".to_owned(),
                    },
                    None,
                )
                .unwrap();
            assert_eq!(fs::read(shared.physical_path).unwrap(), b"beta");
        }
    }

    #[test]
    fn promotion_undo_preserves_a_shared_file_update_and_body_only_relationships() {
        use nodex_core_contracts::library::{
            LibraryBlockTransferDocumentHead, LibraryBlockTransferLogicalIntent,
            LibraryBlockTransferMode, LibraryBlockTransferSource, LibraryBlockTransferTarget,
            LibraryFileChange, LibraryFileReadSource, LibraryPagePromotionPolicy,
        };
        let fixture = fixture();
        let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        create_image(&fixture, &module);
        let image_id = place_image(&fixture, &module, "page-a");
        let source = page_content(&module, "page-a");
        let promoted = apply_intent(
            &module,
            "promote-image",
            LibraryIntent::TransferBlocks {
                intent: LibraryBlockTransferLogicalIntent {
                    actor: serde_json::json!({"kind":"test"}),
                    mode: LibraryBlockTransferMode::Move,
                    root_block_ids: vec![image_id],
                    causal_dependencies: vec![LibraryBlockTransferDocumentHead {
                        document_id: source.document_id.clone(),
                        generation: source.document_generation,
                        expected_head_seq: source.document_head_seq,
                    }],
                    source: LibraryBlockTransferSource::Document {
                        document_id: source.document_id,
                    },
                    target: LibraryBlockTransferTarget::Library {
                        library_id: "library-1".to_owned(),
                        before_block_id: None,
                    },
                    promotion_policy: LibraryPagePromotionPolicy::Literal,
                },
            },
        )
        .committed
        .value
        .block_transfer
        .unwrap();
        let promoted_page_id = &promoted.result_root_block_ids[0];
        assert!(page_content(&module, "page-a").asset_refs.is_empty());
        assert_eq!(
            page_content(&module, promoted_page_id).asset_refs[0]
                .file_id
                .as_deref(),
            Some("file-a")
        );
        prepare(
            &fixture,
            "replace-promoted-image",
            "promoted-receipt",
            b"beta",
        );
        apply_intent(
            &module,
            "replace-promoted-image",
            LibraryIntent::ApplyFileChange {
                change: LibraryFileChange::ReplaceContent {
                    file_id: "file-a".to_owned(),
                    expected_revision: 1,
                    expected_head_version: 1,
                    mime_type: "image/png".to_owned(),
                    prepared_blob_receipt_id: "promoted-receipt".to_owned(),
                },
                turn_id: None,
            },
        );
        apply_intent(
            &module,
            "undo-image-promotion",
            LibraryIntent::UndoBlockTransfer {
                token: promoted.undo_token.unwrap(),
            },
        );
        assert_eq!(
            page_content(&module, "page-a").asset_refs[0]
                .file_id
                .as_deref(),
            Some("file-a")
        );
        let blob = module
            .resolve_file_blob(
                &bound_context(Some("project-1")),
                "file-a",
                &LibraryFileReadSource::Page {
                    page_id: "page-a".to_owned(),
                },
                None,
            )
            .unwrap();
        assert_eq!(fs::read(blob.physical_path).unwrap(), b"beta");
        write(&fixture, "assert-promotion-file", |context| {
            let file = metadata(context.connection, context.library_id, "file-a")?;
            assert_eq!((file.revision, file.head_version), (2, 2));
            let entries: i64 = context.connection.query_row(
                "SELECT count(*) FROM page_file_entries",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(entries, 0, "body occurrences do not manufacture paths");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn body_only_cut_paste_uses_exact_clipboard_authority_after_source_detachment() {
        use nodex_core_contracts::library::{
            LibraryDocumentHead, LibraryFileReadSource, LibraryProjectAccessChange,
            LibraryResourceTarget, LibraryStructuralDeleteDirection, LibraryStructuralDeleteReason,
            LibraryStructuralEditCommand as Command, LibraryStructuralSelection,
            LibraryStructuralTarget,
        };
        let fixture = fixture();
        let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        create_image(&fixture, &module);
        let image_id = place_image(&fixture, &module, "page-a");
        module
            .apply(
                &bound_context(None),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "revoke-cut-file".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::File {
                            file_id: "file-a".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: None,
                            expected_revision: Some(1),
                        }],
                    },
                },
            )
            .unwrap();
        let selection = || {
            let source = page_content(&module, "page-a");
            LibraryStructuralSelection {
                source_document_id: source.document_id.clone(),
                root_block_ids: vec![image_id.clone()],
                source_head: LibraryDocumentHead {
                    document_id: source.document_id,
                    generation: source.document_generation,
                    head_seq: source.document_head_seq,
                },
            }
        };
        let captured = apply_intent(
            &module,
            "capture-body-file",
            LibraryIntent::ApplyStructuralEdit {
                command: Box::new(Command::CaptureClipboard {
                    selection: selection(),
                }),
            },
        )
        .committed
        .value
        .structural_edit
        .unwrap()
        .clipboard
        .unwrap();
        apply_intent(
            &module,
            "cut-body-file",
            LibraryIntent::ApplyStructuralEdit {
                command: Box::new(Command::DeleteSelection {
                    selection: selection(),
                    reason: LibraryStructuralDeleteReason::Cut {
                        bundle: captured.clone(),
                    },
                    direction: LibraryStructuralDeleteDirection::Backward,
                }),
            },
        );
        assert!(
            module
                .resolve_file_blob(
                    &bound_context(Some("project-1")),
                    "file-a",
                    &LibraryFileReadSource::Page {
                        page_id: "page-a".to_owned()
                    },
                    None
                )
                .is_err()
        );
        assert!(
            module
                .resolve_file_blob(
                    &bound_context(Some("project-1")),
                    "file-a",
                    &LibraryFileReadSource::Direct,
                    None
                )
                .is_err()
        );
        write(&fixture, "assert-cut-retention", |context| {
            let retained: bool = context.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM structural_retention_members WHERE library_id = ?1 AND member_kind = 'file' AND member_id = 'file-a')",
                [context.library_id], |row| row.get(0))?;
            assert!(retained, "detached clipboard bodies retain their File identity");
            Ok(())
        }).unwrap();
        let target = page_content(&module, "page-b");
        let pasted = apply_intent(
            &module,
            "paste-body-file",
            LibraryIntent::ApplyStructuralEdit {
                command: Box::new(Command::PasteClipboard {
                    bundle: captured,
                    target: LibraryStructuralTarget {
                        target_document_id: target.document_id.clone(),
                        parent_block_id: None,
                        before_block_id: None,
                        target_head: LibraryDocumentHead {
                            document_id: target.document_id,
                            generation: target.document_generation,
                            head_seq: target.document_head_seq,
                        },
                    },
                }),
            },
        )
        .committed
        .value
        .structural_edit
        .unwrap();
        assert_eq!(pasted.result_root_block_ids, vec![image_id]);
        assert_eq!(
            page_content(&module, "page-b").asset_refs[0]
                .file_id
                .as_deref(),
            Some("file-a")
        );
        let blob = module
            .resolve_file_blob(
                &bound_context(Some("project-1")),
                "file-a",
                &LibraryFileReadSource::Page {
                    page_id: "page-b".to_owned(),
                },
                None,
            )
            .unwrap();
        assert_eq!(fs::read(blob.physical_path).unwrap(), b"alpha");
        write(&fixture, "assert-cut-file", |context| {
            let file = metadata(context.connection, context.library_id, "file-a")?;
            assert_eq!((file.revision, file.head_version), (1, 1));
            assert!(
                super::super::file_access::require_direct(
                    context.connection,
                    &bound_context(Some("project-1")),
                    "file-a",
                    false
                )
                .is_err()
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn clipboard_page_copy_keeps_captured_paths_and_shared_files_without_direct_grants() {
        use nodex_core_contracts::library::{
            LibraryDocumentHead, LibraryFileChange, LibraryFileReadSource,
            LibraryPageFileCollisionPolicy, LibraryPageFileEntryChange, LibraryProjectAccessChange,
            LibraryResourceTarget, LibraryStructuralEditCommand as Command,
            LibraryStructuralSelection, LibraryStructuralTarget,
        };
        let fixture = fixture();
        let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        create_image(&fixture, &module);
        let host = page_content(&module, "page-a");
        apply_intent(
            &module,
            "create-nested-file-page",
            LibraryIntent::CreatePage {
                page_id: "page-nested".to_owned(),
                document_id: "document:page-nested".to_owned(),
                title: "Nested".to_owned(),
                parent: LibraryWriteParent::Page {
                    page_id: "page-a".to_owned(),
                    expected_document_generation: host.document_generation,
                    expected_document_head_seq: host.document_head_seq,
                    before: None,
                    insertion: None,
                },
            },
        );
        place_image(&fixture, &module, "page-nested");
        apply_intent(
            &module,
            "attach-nested-image",
            LibraryIntent::ApplyPageFileEntries {
                page_id: "page-nested".to_owned(),
                expected_manifest_revision: 0,
                turn_id: None,
                changes: vec![LibraryPageFileEntryChange::Attach {
                    file_id: "file-a".to_owned(),
                    logical_path: "captured/image.png".to_owned(),
                    source: LibraryFileReadSource::Direct,
                    collision_policy: LibraryPageFileCollisionPolicy::Reject,
                }],
            },
        );
        let host = page_content(&module, "page-a");
        let clipboard = apply_intent(
            &module,
            "capture-nested-files",
            LibraryIntent::ApplyStructuralEdit {
                command: Box::new(Command::CaptureClipboard {
                    selection: LibraryStructuralSelection {
                        source_document_id: host.document_id.clone(),
                        root_block_ids: vec!["page-nested".to_owned()],
                        source_head: LibraryDocumentHead {
                            document_id: host.document_id,
                            generation: host.document_generation,
                            head_seq: host.document_head_seq,
                        },
                    },
                }),
            },
        )
        .committed
        .value
        .structural_edit
        .unwrap()
        .clipboard
        .unwrap();
        apply_intent(
            &module,
            "remove-captured-entry",
            LibraryIntent::ApplyPageFileEntries {
                page_id: "page-nested".to_owned(),
                expected_manifest_revision: 1,
                turn_id: None,
                changes: vec![LibraryPageFileEntryChange::Remove {
                    file_id: "file-a".to_owned(),
                }],
            },
        );
        prepare(
            &fixture,
            "update-captured-image",
            "captured-receipt",
            b"beta",
        );
        apply_intent(
            &module,
            "update-captured-image",
            LibraryIntent::ApplyFileChange {
                change: LibraryFileChange::ReplaceContent {
                    file_id: "file-a".to_owned(),
                    expected_revision: 1,
                    expected_head_version: 1,
                    mime_type: "image/png".to_owned(),
                    prepared_blob_receipt_id: "captured-receipt".to_owned(),
                },
                turn_id: None,
            },
        );
        module
            .apply(
                &bound_context(None),
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "revoke-captured-file".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target: LibraryResourceTarget::File {
                            file_id: "file-a".to_owned(),
                        },
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: None,
                            expected_revision: Some(1),
                        }],
                    },
                },
            )
            .unwrap();
        let target = page_content(&module, "page-b");
        let copied = apply_intent(
            &module,
            "paste-nested-files",
            LibraryIntent::ApplyStructuralEdit {
                command: Box::new(Command::PasteClipboard {
                    bundle: clipboard,
                    target: LibraryStructuralTarget {
                        target_document_id: target.document_id.clone(),
                        parent_block_id: None,
                        before_block_id: None,
                        target_head: LibraryDocumentHead {
                            document_id: target.document_id,
                            generation: target.document_generation,
                            head_seq: target.document_head_seq,
                        },
                    },
                }),
            },
        )
        .committed
        .value
        .structural_edit
        .unwrap();
        let copied_page = copied.copied_block_ids["page-nested"].clone();
        let body = page_content(&module, &copied_page);
        assert_eq!(body.asset_refs[0].file_id.as_deref(), Some("file-a"));
        let blob = module
            .resolve_file_blob(
                &bound_context(Some("project-1")),
                "file-a",
                &LibraryFileReadSource::Page {
                    page_id: copied_page.clone(),
                },
                None,
            )
            .unwrap();
        assert_eq!(
            fs::read(blob.physical_path).unwrap(),
            b"beta",
            "ordinary copies follow the shared head"
        );
        write(&fixture, "assert-captured-files", move |context| {
            let captured = entries::resolve(
                context.connection,
                context.library_id,
                &copied_page,
                "file-a",
            )?;
            assert_eq!(captured.logical_path, "captured/image.png");
            assert!(
                entries::resolve(
                    context.connection,
                    context.library_id,
                    "page-nested",
                    "file-a"
                )
                .is_err()
            );
            assert_eq!(
                metadata(context.connection, context.library_id, "file-a")?.head_version,
                2
            );
            let count: i64 =
                context
                    .connection
                    .query_row("SELECT count(*) FROM library_files", [], |row| row.get(0))?;
            assert_eq!(count, 1);
            assert!(
                super::super::file_access::require_direct(
                    context.connection,
                    &bound_context(Some("project-1")),
                    "file-a",
                    false
                )
                .is_err()
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn page_copy_shares_file_identity_and_global_content_without_rewriting_documents() {
        use nodex_core_contracts::library::{
            LibraryFileChange, LibraryFileReadSource, LibraryPageFileCollisionPolicy,
            LibraryPageFileEntryChange, LibraryPageWriteDestination,
        };
        let fixture = fixture();
        let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        create_image(&fixture, &module);
        apply_intent(
            &module,
            "attach-image",
            LibraryIntent::ApplyPageFileEntries {
                page_id: "page-a".to_owned(),
                expected_manifest_revision: 0,
                turn_id: None,
                changes: vec![LibraryPageFileEntryChange::Attach {
                    file_id: "file-a".to_owned(),
                    logical_path: "assets/image.png".to_owned(),
                    source: LibraryFileReadSource::Direct,
                    collision_policy: LibraryPageFileCollisionPolicy::Reject,
                }],
            },
        );
        place_image(&fixture, &module, "page-a");
        let copied = apply_intent(
            &module,
            "duplicate-image-page",
            LibraryIntent::DuplicatePage {
                source_page_id: "page-a".to_owned(),
                destination: LibraryPageWriteDestination::Library { at: None },
            },
        )
        .committed
        .value
        .page_copy
        .unwrap();
        let target_id = copied.page_id;
        let before = page_content(&module, "page-a");
        let target_before = page_content(&module, &target_id);
        assert_eq!(before.asset_refs[0].file_id.as_deref(), Some("file-a"));
        assert_eq!(
            target_before.asset_refs[0].file_id.as_deref(),
            Some("file-a")
        );
        prepare(&fixture, "update-shared-image", "shared-receipt", b"beta");
        apply_intent(
            &module,
            "update-shared-image",
            LibraryIntent::ApplyFileChange {
                change: LibraryFileChange::ReplaceContent {
                    file_id: "file-a".to_owned(),
                    expected_revision: 1,
                    expected_head_version: 1,
                    mime_type: "image/png".to_owned(),
                    prepared_blob_receipt_id: "shared-receipt".to_owned(),
                },
                turn_id: None,
            },
        );
        for page_id in ["page-a", target_id.as_str()] {
            let blob = module
                .resolve_file_blob(
                    &bound_context(Some("project-1")),
                    "file-a",
                    &LibraryFileReadSource::Page {
                        page_id: page_id.to_owned(),
                    },
                    None,
                )
                .unwrap();
            assert_eq!(fs::read(blob.physical_path).unwrap(), b"beta");
        }
        assert_eq!(
            page_content(&module, "page-a").document_head_seq,
            before.document_head_seq
        );
        assert_eq!(
            page_content(&module, &target_id).document_head_seq,
            target_before.document_head_seq
        );
        write(&fixture, "assert-copied-image", move |context| {
            let source_entry = entries::resolve(context.connection, context.library_id, "page-a", "file-a")?;
            let target_entry = entries::resolve(context.connection, context.library_id, &target_id, "file-a")?;
            assert_eq!(source_entry.logical_path, target_entry.logical_path);
            let count: i64 = context.connection.query_row("SELECT count(*) FROM library_files", [], |row| row.get(0))?;
            assert_eq!(count, 1);
            let hashes = context.connection.prepare("SELECT asset_hash FROM block_asset_refs WHERE file_id = 'file-a' ORDER BY document_id")?
                .query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(hashes, vec![crate::document::sha256(b"beta"); 2]);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn page_file_entries_swap_paths_and_copy_without_changing_shared_files() {
        use nodex_core_contracts::ModuleReadRequest;
        use nodex_core_contracts::library::{
            LibraryPageFileEntryChange as Change, LibraryRead, LibraryReadValue,
        };
        let fixture = fixture();
        write(&fixture, "seed-entries", |context| {
            import(context, "file-a")?;
            import(context, "file-b")?;
            entries::add(&entry(context, "page-a", 0), "file-a", "a.txt")?;
            entries::add(&entry(context, "page-a", 1), "file-b", "b.txt")?;
            Ok(())
        })
        .unwrap();
        let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        let actor = bound_context(Some("project-1"));
        let apply = |operation: &str, intent| {
            module.apply(
                &actor,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: operation.to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent,
                },
            )
        };
        let swapped = apply(
            "swap-paths",
            LibraryIntent::ApplyPageFileEntries {
                page_id: "page-a".to_owned(),
                expected_manifest_revision: 2,
                turn_id: None,
                changes: vec![
                    Change::Rename {
                        file_id: "file-a".to_owned(),
                        logical_path: "b.txt".to_owned(),
                    },
                    Change::Rename {
                        file_id: "file-b".to_owned(),
                        logical_path: "a.txt".to_owned(),
                    },
                ],
            },
        )
        .unwrap();
        assert_eq!(
            swapped.committed.value.page_file_entries[0].manifest_revision,
            3
        );
        let copy = LibraryIntent::TransferPageFileEntry {
            file_id: "file-a".to_owned(),
            source_page_id: "page-a".to_owned(),
            source_manifest_revision: 3,
            target_page_id: "page-b".to_owned(),
            target_manifest_revision: 0,
            target_logical_path: "shared/source.txt".to_owned(),
            copy: true,
        };
        let copied = apply("copy-entry", copy.clone()).unwrap();
        assert!(
            !copied
                .committed
                .receipt
                .committed_revisions
                .contains_key("pageFiles:page-a")
        );
        assert_eq!(
            copied.committed.receipt.committed_revisions["pageFiles:page-b"],
            1
        );
        assert_eq!(
            copied.committed.value.page_file_entries[0].manifest_revision,
            3
        );
        assert_eq!(
            copied.committed.value.page_file_entries[1].manifest_revision,
            1
        );
        assert!(apply("stale-copy", copy).is_err());
        let collision = LibraryIntent::TransferPageFileEntry {
            file_id: "file-a".to_owned(),
            source_page_id: "page-a".to_owned(),
            source_manifest_revision: 3,
            target_page_id: "page-b".to_owned(),
            target_manifest_revision: 1,
            target_logical_path: "another.txt".to_owned(),
            copy: false,
        };
        assert!(apply("conflicting-move", collision).is_err());
        let inventory = module
            .read(
                &actor,
                ModuleReadRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    read: LibraryRead::PageFileInventory {
                        page_id: "page-a".to_owned(),
                        query: None,
                        cursor: None,
                        limit: None,
                    },
                },
            )
            .unwrap();
        let LibraryReadValue::PageFileInventory { value } = inventory.value else {
            panic!("Page File inventory");
        };
        assert_eq!(
            (value.revision, value.total, value.unplaced_total),
            (3, 2, 2)
        );
        assert_eq!(value.files[0].file.file_id, "file-b");
        assert_eq!(value.files[0].logical_path.as_deref(), Some("a.txt"));
        assert_eq!(value.files[1].logical_path.as_deref(), Some("b.txt"));
        assert!(value.files.iter().all(|item| item.file.head_version == 1
            && item.file.revision == 1
            && item.file.default_name == "notes.txt"));
        write(&fixture, "assert-relation-copy", |context| {
            assert_eq!(
                entries::resolve(context.connection, context.library_id, "page-b", "file-a")?
                    .logical_path,
                "shared/source.txt"
            );
            assert_eq!(
                metadata(context.connection, context.library_id, "file-a")?.revision,
                1
            );
            assert!(
                super::super::file_access::require_direct(
                    context.connection,
                    &bound_context(Some("project-1")),
                    "file-a",
                    false
                )
                .is_err()
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn page_path_put_replays_original_local_replacement_after_namespace_changes() {
        let fixture = fixture();
        write(&fixture, "seed-path-put", |context| {
            import(context, "file-a")?;
            entries::add(&entry(context, "page-a", 0), "file-a", "source.txt")?;
            entries::add(&entry(context, "page-b", 0), "file-a", "also.txt")?;
            Ok(())
        })
        .unwrap();
        let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        let actor = bound_context(Some("project-1"));
        let put = |operation: &str, revision, replace_entry| ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: operation.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::PutPageFileEntry {
                page_id: "page-a".to_owned(),
                expected_manifest_revision: revision,
                file_id: format!("file:{operation}"),
                logical_path: "SOURCE.txt".to_owned(),
                mime_type: "text/plain".to_owned(),
                prepared_blob_receipt_id: format!("receipt:{operation}"),
                replace_entry,
                turn_id: None,
            },
        };
        prepare(&fixture, "collision", "receipt:collision", b"beta");
        assert!(module.apply(&actor, put("collision", 1, false)).is_err());
        prepare(&fixture, "stale", "receipt:stale", b"beta");
        assert!(module.apply(&actor, put("stale", 0, true)).is_err());
        prepare(&fixture, "replace-path", "receipt:replace-path", b"beta");
        let request = put("replace-path", 1, true);
        let applied = module.apply(&actor, request.clone()).unwrap();
        assert_eq!(
            applied.committed.value.page_file_entries[0].manifest_revision,
            2
        );
        assert_eq!(
            applied.committed.value.page_file_entries[0].replacements["file-a"],
            "file:replace-path"
        );
        write(&fixture, "change-path-after-put", |context| {
            assert_eq!(
                metadata(context.connection, context.library_id, "file-a")?.head_version,
                1
            );
            assert_eq!(
                entries::resolve(context.connection, context.library_id, "page-b", "file-a")?
                    .logical_path,
                "also.txt"
            );
            assert!(metadata(context.connection, context.library_id, "file:collision").is_err());
            assert!(metadata(context.connection, context.library_id, "file:stale").is_err());
            entries::rename(
                &entry(context, "page-a", 2),
                "file:replace-path",
                "renamed.txt",
            )?;
            Ok(())
        })
        .unwrap();
        let replay = module.apply(&actor, request).unwrap();
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(
            replay.committed.value.page_file_entries,
            applied.committed.value.page_file_entries
        );
        write(&fixture, "assert-path-replay", |context| {
            assert_eq!(
                entries::resolve(
                    context.connection,
                    context.library_id,
                    "page-a",
                    "file:replace-path"
                )?
                .logical_path,
                "renamed.txt"
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn page_file_import_rolls_back_identity_grant_and_receipt_then_local_replace_forks() {
        use nodex_core_contracts::library::{
            LibraryPageFileCollisionPolicy, LibraryPageFileEntryChange as Change,
        };
        let fixture = fixture();
        write(&fixture, "seed-local-replace", |context| {
            import(context, "file-a")?;
            entries::add(&entry(context, "page-a", 0), "file-a", "source.txt")?;
            entries::add(&entry(context, "page-b", 0), "file-a", "also.txt")?;
            Ok(())
        })
        .unwrap();
        let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        let actor = bound_context(Some("project-1"));
        let apply = |operation: &str, changes| {
            module.apply(
                &actor,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: operation.to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyPageFileEntries {
                        page_id: "page-a".to_owned(),
                        expected_manifest_revision: 1,
                        changes,
                        turn_id: None,
                    },
                },
            )
        };
        prepare(&fixture, "failed-import", "failed-receipt", b"beta");
        assert!(
            apply(
                "failed-import",
                vec![Change::Import {
                    file_id: "file-failed".to_owned(),
                    logical_path: "SOURCE.txt".to_owned(),
                    mime_type: "text/plain".to_owned(),
                    prepared_blob_receipt_id: "failed-receipt".to_owned(),
                    collision_policy: LibraryPageFileCollisionPolicy::Reject
                }]
            )
            .is_err()
        );
        write(&fixture, "assert-import-rollback", |context| {
            assert!(metadata(context.connection, context.library_id, "file-failed").is_err());
            let grants: i64 = context.connection.query_row("SELECT count(*) FROM project_resource_grants WHERE root_kind = 'file' AND root_id = 'file-failed'", [], |row| row.get(0))?;
            assert_eq!(grants, 0);
            let state: String = context.connection.query_row("SELECT state FROM prepared_blob_receipts WHERE receipt_id = 'failed-receipt'", [], |row| row.get(0))?;
            assert_eq!(state, "prepared");
            Ok(())
        }).unwrap();
        prepare(&fixture, "local-replace", "local-receipt", b"beta");
        let replaced = apply(
            "local-replace",
            vec![Change::Replace {
                file_id: "file-a".to_owned(),
                replacement_file_id: "file-local".to_owned(),
                mime_type: "text/plain".to_owned(),
                prepared_blob_receipt_id: "local-receipt".to_owned(),
            }],
        )
        .unwrap();
        assert_eq!(
            replaced.committed.value.page_file_entries[0].replacements["file-a"],
            "file-local"
        );
        write(&fixture, "assert-local-replace", |context| {
            let original = metadata(context.connection, context.library_id, "file-a")?;
            assert_eq!((original.revision, original.head_version), (1, 1));
            assert_eq!(original.blob_etag, crate::document::sha256(b"alpha"));
            let replacement = metadata(context.connection, context.library_id, "file-local")?;
            assert_eq!(replacement.blob_etag, crate::document::sha256(b"beta"));
            assert_eq!(replacement.default_name, original.default_name);
            assert_eq!(
                entries::resolve(
                    context.connection,
                    context.library_id,
                    "page-a",
                    "file-local"
                )?
                .logical_path,
                "source.txt"
            );
            assert_eq!(
                entries::resolve(context.connection, context.library_id, "page-b", "file-a")?
                    .logical_path,
                "also.txt"
            );
            super::super::file_access::require_direct(
                context.connection,
                &bound_context(Some("project-1")),
                "file-local",
                true,
            )?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn library_file_public_commands_consume_once_grant_creator_and_preserve_versions() {
        use nodex_core_contracts::ModuleReadRequest;
        use nodex_core_contracts::library::{
            LibraryFileChange, LibraryFileReadSource, LibraryPageFileCollisionPolicy,
            LibraryPageFileEntryChange, LibraryRead, LibraryReadValue,
        };
        let fixture = fixture();
        let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        let actor = bound_context(Some("project-1"));
        prepare(&fixture, "create-file", "create-receipt", b"alpha");
        let request = ModuleApplyRequest {
            contract_version: LIBRARY_CONTRACT_VERSION,
            operation_id: "create-file".to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: LibraryIntent::ApplyFileChange {
                change: LibraryFileChange::Create {
                    file_id: "file-a".to_owned(),
                    default_name: "source.txt".to_owned(),
                    mime_type: "text/plain".to_owned(),
                    prepared_blob_receipt_id: "create-receipt".to_owned(),
                },
                turn_id: None,
            },
        };
        let created = module.apply(&actor, request.clone()).unwrap();
        let repeated = module.apply(&actor, request).unwrap();
        assert!(repeated.committed.receipt.mutation.duplicate);
        assert_eq!(created.committed.commit_seq, repeated.committed.commit_seq);
        assert_eq!(
            created.committed.value.file_mutation,
            repeated.committed.value.file_mutation
        );
        let read = |read| {
            module
                .read(
                    &actor,
                    ModuleReadRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        read,
                    },
                )
                .unwrap()
        };
        let catalog = read(LibraryRead::Files {
            query: None,
            lifecycle: LibraryFileLifecycle::Live,
            usage: LibraryFileUsageFilter::All,
            cursor: None,
            limit: Some(1),
        });
        assert!(catalog.authorization.is_some());
        let LibraryReadValue::Files { value } = catalog.value else {
            panic!("Files catalog");
        };
        assert_eq!(value.total, 1);
        assert_eq!(value.items[0].file_id, "file-a");
        let LibraryReadValue::Files { value: unused } = read(LibraryRead::Files {
            query: None,
            lifecycle: LibraryFileLifecycle::Live,
            usage: LibraryFileUsageFilter::Unused,
            cursor: None,
            limit: Some(1),
        })
        .value
        else {
            panic!("unused Files catalog");
        };
        assert_eq!(unused.total, 1);
        apply_intent(
            &module,
            "attach-file",
            LibraryIntent::ApplyPageFileEntries {
                page_id: "page-a".to_owned(),
                expected_manifest_revision: 0,
                changes: vec![LibraryPageFileEntryChange::Attach {
                    file_id: "file-a".to_owned(),
                    logical_path: "source.txt".to_owned(),
                    source: LibraryFileReadSource::Direct,
                    collision_policy: LibraryPageFileCollisionPolicy::Reject,
                }],
                turn_id: None,
            },
        );
        let LibraryReadValue::Files { value: unused } = read(LibraryRead::Files {
            query: None,
            lifecycle: LibraryFileLifecycle::Live,
            usage: LibraryFileUsageFilter::Unused,
            cursor: None,
            limit: Some(1),
        })
        .value
        else {
            panic!("unused Files catalog after use");
        };
        assert_eq!(unused.total, 0);
        apply_intent(
            &module,
            "detach-file",
            LibraryIntent::ApplyPageFileEntries {
                page_id: "page-a".to_owned(),
                expected_manifest_revision: 1,
                changes: vec![LibraryPageFileEntryChange::Remove {
                    file_id: "file-a".to_owned(),
                }],
                turn_id: None,
            },
        );
        prepare(&fixture, "replace-file", "replace-receipt", b"beta");
        let replace = LibraryIntent::ApplyFileChange {
            change: LibraryFileChange::ReplaceContent {
                file_id: "file-a".to_owned(),
                expected_revision: 1,
                expected_head_version: 1,
                mime_type: "text/plain".to_owned(),
                prepared_blob_receipt_id: "replace-receipt".to_owned(),
            },
            turn_id: None,
        };
        let replaced = module
            .apply(
                &actor,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "replace-file".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: replace,
                },
            )
            .unwrap();
        let changed = replaced
            .committed
            .value
            .file_mutation
            .unwrap()
            .file
            .unwrap();
        assert_eq!((changed.revision, changed.head_version), (2, 2));
        assert_eq!(changed.blob_etag, crate::document::sha256(b"beta"));
        let first = read(LibraryRead::FileVersions {
            file_id: "file-a".to_owned(),
            cursor: None,
            limit: Some(1),
        });
        let LibraryReadValue::FileVersions { value } = first.value else {
            panic!("File versions");
        };
        assert_eq!(value.items[0].version, 2);
        assert!(value.has_more);
        let second = read(LibraryRead::FileVersions {
            file_id: "file-a".to_owned(),
            cursor: value.next_cursor,
            limit: Some(1),
        });
        let LibraryReadValue::FileVersions { value } = second.value else {
            panic!("File versions");
        };
        assert_eq!(value.items[0].blob_etag, crate::document::sha256(b"alpha"));
        assert!(!value.has_more);
        let current_bytes = module
            .resolve_file_blob(
                &actor,
                "file-a",
                &nodex_core_contracts::library::LibraryFileReadSource::Direct,
                None,
            )
            .unwrap();
        let old_bytes = module
            .resolve_file_blob(
                &actor,
                "file-a",
                &nodex_core_contracts::library::LibraryFileReadSource::Direct,
                Some(1),
            )
            .unwrap();
        assert_eq!(fs::read(current_bytes.physical_path).unwrap(), b"beta");
        assert_eq!(fs::read(old_bytes.physical_path).unwrap(), b"alpha");
        write(&fixture, "assert-created-grant", |context| {
            super::super::file_access::require_direct(
                context.connection,
                &bound_context(Some("project-1")),
                "file-a",
                true,
            )?;
            let consumed: i64 = context.connection.query_row(
                "SELECT count(*) FROM prepared_blob_receipts WHERE state = 'consumed'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(consumed, 2);
            let entries: i64 = context.connection.query_row(
                "SELECT count(*) FROM page_file_entries",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(entries, 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn library_file_page_use_does_not_grant_global_access_and_direct_grants_revoke() {
        use nodex_core_contracts::library::{
            LibraryAccess, LibraryProjectAccessChange, LibraryResourceTarget,
        };
        let fixture = fixture();
        write(&fixture, "seed-file", |context| {
            import(context, "file-a")?;
            entries::add(&entry(context, "page-a", 0), "file-a", "source.txt")?;
            Ok(())
        })
        .unwrap();
        let project = BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project-1".to_owned())),
            connection_id: "file-access-test".to_owned(),
            adapter: AdapterKind::Test,
        };
        let mut trusted = project.clone();
        trusted.project_id = None;
        let module = crate::library::LibraryModule::new("profile-1", "library-1", &fixture.kernel);
        let target = LibraryResourceTarget::File {
            file_id: "file-a".to_owned(),
        };
        let before = project.clone();
        write(&fixture, "assert-page-only", move |context| {
            super::super::file_access::require_page_use(
                context.connection,
                &before,
                "page-a",
                "file-a",
            )?;
            assert!(
                super::super::file_access::require_page_use(
                    context.connection,
                    &before,
                    "page-b",
                    "file-a"
                )
                .is_err()
            );
            assert!(
                super::super::file_access::require_direct(
                    context.connection,
                    &before,
                    "file-a",
                    false
                )
                .is_err()
            );
            assert!(
                super::super::file_access::require_direct(
                    context.connection,
                    &before,
                    "file-a",
                    true
                )
                .is_err()
            );
            Ok(())
        })
        .unwrap();
        let grant = LibraryIntent::GrantProjectAccess {
            project_id: "project-1".to_owned(),
            target: target.clone(),
            access: LibraryAccess::Read,
        };
        assert!(
            module
                .apply(
                    &project,
                    ModuleApplyRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        operation_id: "unauthorized-file-grant".to_owned(),
                        store_epoch: StoreEpoch("epoch-1".to_owned()),
                        intent: grant.clone(),
                    }
                )
                .is_err()
        );
        module
            .apply(
                &trusted,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "file-grant".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: grant,
                },
            )
            .unwrap();
        let reader = project.clone();
        write(&fixture, "assert-read-grant", move |context| {
            super::super::file_access::require_direct(context.connection, &reader, "file-a", false)?;
            assert!(super::super::file_access::require_direct(context.connection, &reader, "file-a", true).is_err());
            let recursive: i64 = context.connection.query_row(
                "SELECT recursive FROM project_resource_grants WHERE root_kind = 'file' AND root_id = 'file-a'", [], |row| row.get(0),
            )?;
            assert_eq!(recursive, 0);
            Ok(())
        }).unwrap();
        let revoked = module
            .apply(
                &trusted,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "file-revoke".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::SetProjectAccess {
                        target,
                        changes: vec![LibraryProjectAccessChange {
                            project_id: "project-1".to_owned(),
                            access: None,
                            expected_revision: Some(1),
                        }],
                    },
                },
            )
            .unwrap();
        let commit_seq = revoked.committed.commit_seq;
        write(&fixture, "assert-revoked", move |context| {
            assert!(super::super::file_access::require_direct(context.connection, &project, "file-a", false).is_err());
            super::super::file_access::require_page_use(context.connection, &project, "page-a", "file-a")?;
            let revocations: i64 = context.connection.query_row(
                "SELECT count(*) FROM local_commit_revocations WHERE commit_seq = ?1 AND resource_kind = 'file' AND resource_id = 'file-a'",
                [commit_seq], |row| row.get(0),
            )?;
            assert!(revocations > 0, "direct File grant revocation must invalidate prior authorized reads");
            Ok(())
        }).unwrap();
    }

    #[test]
    fn library_file_catalog_pages_duplicate_names_and_rejects_cross_scope_cursors() {
        let fixture = fixture();
        write(&fixture, "catalog-files", |context| {
            import(context, "file-a")?;
            import(context, "file-b")?;
            let trusted = bound_context(None);
            let reader = bound_context(Some("project-1"));
            let first = super::super::file_queries::catalog(
                context.connection,
                &trusted,
                None,
                LibraryFileLifecycle::Live,
                LibraryFileUsageFilter::All,
                None,
                Some(1),
            )?;
            assert_eq!(first.total, 2);
            assert_eq!(first.items[0].file_id, "file-a");
            assert!(first.has_more);
            let second = super::super::file_queries::catalog(
                context.connection,
                &trusted,
                None,
                LibraryFileLifecycle::Live,
                LibraryFileUsageFilter::All,
                first.next_cursor.as_deref(),
                Some(1),
            )?;
            assert_eq!(second.items[0].file_id, "file-b");
            assert!(!second.has_more);
            let private = super::super::file_queries::catalog(
                context.connection,
                &reader,
                None,
                LibraryFileLifecycle::Live,
                LibraryFileUsageFilter::All,
                None,
                Some(1),
            )?;
            assert_eq!(
                private.total, 0,
                "creation provenance does not imply a File grant"
            );
            assert!(private.items.is_empty());
            assert!(
                super::super::file_queries::catalog(
                    context.connection,
                    &reader,
                    None,
                    LibraryFileLifecycle::Live,
                    LibraryFileUsageFilter::All,
                    first.next_cursor.as_deref(),
                    Some(1)
                )
                .is_err()
            );
            assert!(
                super::super::file_queries::catalog(
                    context.connection,
                    &trusted,
                    Some("changed query"),
                    LibraryFileLifecycle::Live,
                    LibraryFileUsageFilter::All,
                    first.next_cursor.as_deref(),
                    Some(1)
                )
                .is_err()
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn library_file_identity_exists_without_page_paths_and_shared_bytes_do_not_merge_files() {
        let fixture = fixture();
        let (first, second) = write(&fixture, "import", |context| {
            Ok((import(context, "file-a")?, import(context, "file-b")?))
        })
        .unwrap();
        assert_ne!(first.file_id, second.file_id);
        assert_eq!(first.blob_etag, second.blob_etag);
        assert_eq!(first.default_name, second.default_name);
        let entries = write(&fixture, "inspect", |context| {
            Ok(context.connection.query_row(
                "SELECT count(*) FROM page_file_entries",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .unwrap();
        assert_eq!(entries, 0);
    }

    #[test]
    fn library_file_paths_are_local_and_do_not_create_content_versions() {
        let fixture = fixture();
        write(&fixture, "paths", |context| {
            let file = import(context, "file-a")?;
            entries::add(
                &entry(context, "page-a", 0),
                "file-a",
                "research/source.txt",
            )?;
            entries::add(
                &entry(context, "page-b", 0),
                "file-a",
                "reference/paper.txt",
            )?;
            entries::rename(&entry(context, "page-a", 1), "file-a", "docs/source.txt")?;
            assert_eq!(
                metadata(context.connection, context.library_id, "file-a")?,
                file
            );
            let renamed = rename(context, "file-a", 1, "shared.txt")?;
            assert_eq!(renamed.head_version, 1);
            assert_eq!(renamed.revision, 2);
            assert_eq!(
                entries::resolve_path(
                    context.connection,
                    context.library_id,
                    "page-a",
                    "DOCS/source.txt"
                )?
                .file_id,
                "file-a"
            );
            assert_eq!(
                entries::resolve(context.connection, context.library_id, "page-b", "file-a")?
                    .logical_path,
                "reference/paper.txt"
            );
            entries::remove(&entry(context, "page-a", 2), "file-a")?;
            entries::remove(&entry(context, "page-b", 1), "file-a")?;
            assert_eq!(
                metadata(context.connection, context.library_id, "file-a")?.lifecycle,
                LibraryFileLifecycle::Live
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn library_file_snapshot_keeps_exact_bytes_and_restore_forks_once() {
        let fixture = fixture();
        let (old, current, restored) = write(&fixture, "history", |context| {
            import(context, "file-a")?;
            let snapshot =
                capture_snapshot(context.connection, context.library_id, ["file-a", "file-a"])?;
            assert_eq!(snapshot.files.len(), 1);
            replace_content(
                context,
                "file-a",
                1,
                1,
                FileContent {
                    blob_hash: &crate::document::sha256(b"beta"),
                    mime_type: "text/plain",
                },
            )?;
            let old = read_version(
                context.connection,
                context.library_id,
                "file-a",
                snapshot.files["file-a"].version,
            )?;
            let current = metadata(context.connection, context.library_id, "file-a")?;
            let heads = restore_heads(context.connection, context.library_id, &snapshot)?;
            let actions = snapshot.plan_restore(&heads)?;
            assert_eq!(actions.len(), 1);
            let FileRestoreAction::Fork {
                source_file_id,
                source_version,
                default_name,
                ..
            } = &actions[0]
            else {
                panic!("changed shared content must fork");
            };
            let restored = fork(
                context,
                source_file_id,
                *source_version,
                "file-restored",
                default_name,
            )?;
            assert_eq!(
                metadata(context.connection, context.library_id, "file-a")?,
                current
            );
            Ok((old, current, restored))
        })
        .unwrap();
        let read = |hash: &str| {
            fs::read(
                fixture
                    .home
                    .path()
                    .join("assets")
                    .join(format!("{hash}.blob")),
            )
            .unwrap()
        };
        assert_eq!(read(&old.blob_etag), b"alpha");
        assert_eq!(read(&current.blob_etag), b"beta");
        assert_eq!(read(&restored.blob_etag), b"alpha");
        assert_eq!(current.head_version, 2);
        assert_eq!(restored.head_version, 1);
    }

    #[test]
    fn library_file_entry_transfer_checks_both_manifests_and_rolls_back_conflicts() {
        let fixture = fixture();
        write(&fixture, "seed", |context| {
            import(context, "file-a")?;
            import(context, "file-b")?;
            entries::add(&entry(context, "page-a", 0), "file-a", "source.txt")?;
            entries::add(&entry(context, "page-b", 0), "file-b", "occupied.txt")?;
            Ok(())
        })
        .unwrap();
        let collision = write(&fixture, "move-conflict", |context| {
            entries::transfer(
                &entry(context, "page-a", 1),
                &entry(context, "page-b", 1),
                "file-a",
                "OCCUPIED.txt",
                false,
            )
        })
        .unwrap_err();
        assert_eq!(collision.code, StoreErrorCode::Conflict);
        let stale = write(&fixture, "move-stale", |context| {
            entries::transfer(
                &entry(context, "page-a", 0),
                &entry(context, "page-b", 1),
                "file-a",
                "moved.txt",
                false,
            )
        })
        .unwrap_err();
        assert_eq!(stale.code, StoreErrorCode::RevisionConflict);
        write(&fixture, "move", |context| {
            assert_eq!(entries::resolve(context.connection, context.library_id, "page-a", "file-a")?.logical_path, "source.txt");
            entries::transfer(&entry(context, "page-a", 1), &entry(context, "page-b", 1), "file-a", "moved.txt", false)?;
            assert!(entries::resolve(context.connection, context.library_id, "page-a", "file-a").is_err());
            assert_eq!(metadata(context.connection, context.library_id, "file-a")?.revision, 1);
            let revisions: (i64, i64) = context.connection.query_row("SELECT (SELECT revision FROM page_file_manifests WHERE page_id = 'page-a'), (SELECT revision FROM page_file_manifests WHERE page_id = 'page-b')", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
            assert_eq!(revisions, (2, 2));
            Ok(())
        }).unwrap();
    }

    #[test]
    fn library_file_entry_paths_reject_ancestors_descendants_and_duplicate_targets() {
        let fixture = fixture();
        write(&fixture, "seed", |context| {
            import(context, "file-a")?;
            import(context, "file-b")?;
            entries::add(&entry(context, "page-a", 0), "file-a", "folder/source.txt")?;
            Ok(())
        })
        .unwrap();
        for path in [
            "FOLDER",
            "folder/source.txt/nested.txt",
            "folder/SOURCE.txt",
        ] {
            assert_eq!(
                write(&fixture, "conflict", move |context| {
                    entries::add(&entry(context, "page-a", 1), "file-b", path)
                })
                .unwrap_err()
                .code,
                StoreErrorCode::Conflict
            );
        }
        write(&fixture, "retarget", |context| {
            entries::retarget(&entry(context, "page-a", 1), "file-a", "file-b")?;
            assert_eq!(
                entries::resolve_path(
                    context.connection,
                    context.library_id,
                    "page-a",
                    "folder/source.txt"
                )?
                .file_id,
                "file-b"
            );
            assert_eq!(
                metadata(context.connection, context.library_id, "file-a")?.revision,
                1
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn library_file_content_transaction_failure_does_not_publish_a_partial_head() {
        let fixture = fixture();
        write(&fixture, "seed", |context| import(context, "file-a")).unwrap();
        let error = write::<()>(&fixture, "failed-update", |context| {
            replace_content(
                context,
                "file-a",
                1,
                1,
                FileContent {
                    blob_hash: &crate::document::sha256(b"beta"),
                    mime_type: "text/plain",
                },
            )?;
            Err(conflict("injected downstream failure"))
        })
        .unwrap_err();
        assert_eq!(error.code, StoreErrorCode::Conflict);
        write(&fixture, "inspect", |context| {
            assert_eq!(
                metadata(context.connection, context.library_id, "file-a")?.head_version,
                1
            );
            assert!(read_version(context.connection, context.library_id, "file-a", 2).is_err());
            assert!(
                context
                    .connection
                    .execute(
                        "UPDATE file_versions SET blob_hash = ?1 WHERE file_id = 'file-a'",
                        [crate::document::sha256(b"beta")]
                    )
                    .is_err()
            );
            Ok(())
        })
        .unwrap();
    }
}
