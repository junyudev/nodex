use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::document::integrity::validate_restore_documents;
use crate::document::{DocumentAuthorityRow, load_canvas_scene, read_document_authority, sha256};
use crate::domain::derived_records::parse_asset_source;
use crate::infrastructure::document_repository::{
    DocumentAuthority, DocumentReadRepository, DocumentReadiness, DocumentSyncEngine,
};
use crate::infrastructure::migration::validate_profile_clone_source;
use crate::infrastructure::sqlite::{
    StoreError, StoreErrorCode, open_immutable_reader, open_reader, open_writer, validate_store,
    with_immediate_transaction,
};
use crate::infrastructure::store::STORE_FILE_NAME;
use crate::infrastructure::store_replacement::{StoreReplacementJournal, validate_live_store};
use crate::infrastructure::store_validation::validate_codex_thread_timestamp_invariants;

use super::backup;
use crate::infrastructure::store_replacement::{
    NewStoreReplacementJournal, StoreReplacementPhase, advance_store_replacement_journal,
    create_store_replacement_journal, install_staged_store_files, rollback_store_replacement,
};

const ASSETS_DIRECTORY_NAME: &str = "assets";

pub(super) struct RestoreInstallation {
    pub journal: StoreReplacementJournal,
    pub installed_epoch: String,
    pub safety_backup_id: Option<String>,
}

pub(super) struct InstallRestoreRequest<'a> {
    pub profile_home: &'a Path,
    pub profile_id: &'a str,
    pub library_id: &'a str,
    pub operation_id: &'a str,
    pub request_hash: &'a str,
    pub requested_store_epoch: &'a str,
    pub backup_id: &'a str,
    pub create_safety_backup: bool,
    pub existing_journal: Option<StoreReplacementJournal>,
    pub replacement_hook: &'a dyn Fn(&str) -> Result<(), StoreError>,
}

pub(super) fn install_restore(
    request: InstallRestoreRequest<'_>,
) -> Result<RestoreInstallation, StoreError> {
    let database_path = request.profile_home.join(STORE_FILE_NAME);
    let source = open_reader(&database_path)?;
    validate_identity(&source, request.profile_id, request.library_id)?;
    let source_store_epoch = read_store_epoch(&source)?;
    if source_store_epoch != request.requested_store_epoch {
        return Err(StoreError::new(
            StoreErrorCode::StaleStoreEpoch,
            "Store restore targets a stale store epoch",
            true,
        ));
    }
    drop(source);

    let (staging_directory_name, rollback_directory_name) =
        replacement_directory_names(request.profile_id, request.operation_id);
    let (mut journal, candidate_store_epoch) = if let Some(journal) = request.existing_journal {
        validate_journal_identity(
            &journal,
            request.operation_id,
            request.request_hash,
            request.backup_id,
        )?;
        if journal.phase != StoreReplacementPhase::Prepared
            || journal.source_store_epoch != source_store_epoch
            || journal.staging_directory_name != staging_directory_name
            || journal.rollback_directory_name != rollback_directory_name
        {
            return Err(corrupt(
                "Prepared Store restore journal does not match the current source",
            ));
        }
        let candidate_store_epoch = validate_staged_candidate(
            request.profile_home,
            &journal.staging_directory_name,
            request.profile_id,
            request.library_id,
        )?;
        (journal, candidate_store_epoch)
    } else {
        let backup = backup::resolve_backup_for_restore(request.profile_home, request.backup_id)?;
        let staged_epoch = backup::stage_restore_candidate(
            request.profile_home,
            &backup,
            &staging_directory_name,
        )?;
        let validated_epoch = validate_staged_candidate(
            request.profile_home,
            &staging_directory_name,
            request.profile_id,
            request.library_id,
        )?;
        if staged_epoch != validated_epoch {
            return Err(corrupt(
                "Restore candidate epoch changed during semantic validation",
            ));
        }
        let journal = create_store_replacement_journal(
            request.profile_home,
            NewStoreReplacementJournal {
                operation_id: request.operation_id,
                request_hash: request.request_hash,
                backup_id: request.backup_id,
                staging_directory_name: &staging_directory_name,
                rollback_directory_name: &rollback_directory_name,
                source_store_epoch: &source_store_epoch,
                updated_at: &now(),
            },
        )?;
        (journal, validated_epoch)
    };

    if request.create_safety_backup && journal.safety_backup_id.is_none() {
        let source = open_reader(&database_path)?;
        let safety = backup::create_safety_backup(
            &source,
            request.profile_home,
            request.profile_id,
            request.operation_id,
            request.request_hash,
            request.backup_id,
        )?;
        drop(source);
        journal = advance_store_replacement_journal(
            request.profile_home,
            &journal,
            StoreReplacementPhase::Prepared,
            &now(),
            Some(&safety.backup_id),
            None,
        )?;
    }

    let installed_epoch = installed_store_epoch(
        &source_store_epoch,
        request.backup_id,
        request.operation_id,
        request.request_hash,
    );
    if installed_epoch == source_store_epoch {
        return Err(corrupt("Restore did not produce a new Store epoch"));
    }

    let mut attempted_hook = false;
    let installation = (|| {
        journal = advance_store_replacement_journal(
            request.profile_home,
            &journal,
            StoreReplacementPhase::RollbackStarted,
            &now(),
            None,
            None,
        )?;
        journal = advance_store_replacement_journal(
            request.profile_home,
            &journal,
            StoreReplacementPhase::InstallStarted,
            &now(),
            None,
            None,
        )?;
        install_staged_store_files(request.profile_home, &journal)?;
        journal = advance_store_replacement_journal(
            request.profile_home,
            &journal,
            StoreReplacementPhase::EpochRotating,
            &now(),
            None,
            None,
        )?;
        rotate_installed_store_epoch(
            request.profile_home,
            &candidate_store_epoch,
            &installed_epoch,
            request.profile_id,
            request.library_id,
        )?;
        attempted_hook = true;
        (request.replacement_hook)(&installed_epoch)?;
        journal = advance_store_replacement_journal(
            request.profile_home,
            &journal,
            StoreReplacementPhase::Committed,
            &now(),
            None,
            Some(&installed_epoch),
        )?;
        Ok(())
    })();
    if let Err(error) = installation {
        if journal.phase != StoreReplacementPhase::Prepared
            && journal.phase != StoreReplacementPhase::Committed
        {
            rollback_store_replacement(request.profile_home, &journal)?;
            if attempted_hook {
                (request.replacement_hook)(&source_store_epoch)?;
            }
        }
        return Err(error);
    }

    Ok(RestoreInstallation {
        safety_backup_id: journal.safety_backup_id.clone(),
        journal,
        installed_epoch,
    })
}

pub(super) fn replacement_directory_names(
    profile_id: &str,
    operation_id: &str,
) -> (String, String) {
    let digest = Sha256::digest(format!("store-replacement\0{profile_id}\0{operation_id}"));
    let identity = hex(&digest);
    (
        format!(".restore-{identity}"),
        format!(".rollback-{identity}"),
    )
}

pub(super) fn installed_store_epoch(
    source_store_epoch: &str,
    backup_id: &str,
    operation_id: &str,
    request_hash: &str,
) -> String {
    let digest = Sha256::digest(format!(
        "installed-store-epoch\0{source_store_epoch}\0{backup_id}\0{operation_id}\0{request_hash}"
    ));
    format!("epoch:restore:{}", hex(&digest))
}

pub(super) fn validate_journal_identity(
    journal: &StoreReplacementJournal,
    operation_id: &str,
    request_hash: &str,
    backup_id: &str,
) -> Result<(), StoreError> {
    if journal.operation_id == operation_id
        && journal.request_hash == request_hash
        && journal.backup_id == backup_id
    {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::IdempotencyKeyReused,
        "Store replacement journal belongs to another restore request",
        false,
    ))
}

pub(super) fn validate_staged_candidate(
    profile_home: &Path,
    staging_directory_name: &str,
    profile_id: &str,
    library_id: &str,
) -> Result<String, StoreError> {
    validate_candidate(
        &profile_home
            .join("backups")
            .join(staging_directory_name)
            .join(STORE_FILE_NAME),
        &profile_home
            .join("backups")
            .join(staging_directory_name)
            .join(ASSETS_DIRECTORY_NAME),
        profile_id,
        library_id,
    )
}

pub(super) fn rotate_installed_store_epoch(
    profile_home: &Path,
    expected_candidate_epoch: &str,
    installed_epoch: &str,
    profile_id: &str,
    library_id: &str,
) -> Result<(), StoreError> {
    let database_path = profile_home.join(STORE_FILE_NAME);
    let mut connection = open_writer(&database_path)?;
    let current_epoch = read_store_epoch(&connection)?;
    if current_epoch != installed_epoch {
        if current_epoch != expected_candidate_epoch {
            return Err(corrupt(
                "Installed restore candidate epoch changed before rotation",
            ));
        }
        crate::library::prepare_editor_history_replacement(&mut connection)?;
        with_immediate_transaction(&mut connection, |transaction| {
            let now = transaction.query_row(
                "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
                [],
                |row| row.get::<_, String>(0),
            )?;
            let changed = transaction.execute(
                "UPDATE block_store_metadata SET store_epoch = ?1, updated_at = ?2 \
                 WHERE id = 1 AND store_epoch = ?3",
                params![installed_epoch, now, expected_candidate_epoch],
            )?;
            if changed != 1 {
                return Err(corrupt(
                    "Installed restore candidate epoch changed during rotation",
                ));
            }
            crate::library::discard_replaced_editor_history(transaction)?;
            transaction.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
            transaction.execute_batch("DROP TRIGGER change_log_is_immutable")?;
            transaction.execute(
                "UPDATE change_log SET store_epoch = ?1 WHERE store_epoch != ?1",
                [installed_epoch],
            )?;
            transaction.execute_batch(
                "CREATE TRIGGER change_log_is_immutable \
                   BEFORE UPDATE ON change_log \
                   BEGIN \
                     SELECT RAISE(ABORT, 'change log entries are immutable'); \
                   END;",
            )?;
            crate::infrastructure::local_commit::rebase_store_epoch(transaction, installed_epoch)?;
            // Detached receipts describe delivery evidence that intentionally
            // is no longer present. A Store replacement rotates the authority
            // epoch, so those old-epoch retry identities must not cross it.
            transaction.execute("DELETE FROM detached_module_receipts", [])?;
            transaction.execute(
                "UPDATE core_module_receipts \
                 SET store_epoch = ?1, \
                     result_json = json_set(\
                         json_set(result_json, '$.store_epoch', ?1),\
                         '$.local_commit', json('null')\
                     ) \
                 WHERE store_epoch != ?1",
                [installed_epoch],
            )?;
            Ok(())
        })?;
    }
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    drop(connection);
    validate_live_store(profile_home, Some(installed_epoch))?;
    validate_candidate(
        &database_path,
        &profile_home.join(ASSETS_DIRECTORY_NAME),
        profile_id,
        library_id,
    )?;
    Ok(())
}

pub(super) fn validate_candidate(
    database_path: &Path,
    assets_root: &Path,
    profile_id: &str,
    library_id: &str,
) -> Result<String, StoreError> {
    let connection = open_immutable_reader(database_path)?;
    validate_store(&connection)?;
    Ok(validate_candidate_semantics(
        &connection,
        assets_root,
        profile_id,
        library_id,
        MissingAssetPolicy::Reject,
        true,
    )?
    .store_epoch)
}

pub(super) struct ProfileSnapshotCandidateValidation {
    pub store_epoch: String,
    pub store_schema_version: u32,
    pub missing_managed_asset_count: usize,
}

/// Validates clone-specific semantics after `backup::copy_backup_to_profile`
/// has verified the complete copied byte closure against publication evidence.
pub(super) fn validate_profile_snapshot_candidate(
    database_path: &Path,
    assets_root: &Path,
    profile_id: &str,
    library_id: &str,
) -> Result<ProfileSnapshotCandidateValidation, StoreError> {
    let connection = open_immutable_reader(database_path)?;
    let store_schema_version = validate_profile_clone_source(&connection)?;
    let validation = validate_candidate_semantics(
        &connection,
        assets_root,
        profile_id,
        library_id,
        MissingAssetPolicy::Preserve,
        false,
    )?;
    if i64::from(validation.store_schema_version) != store_schema_version {
        return Err(corrupt(
            "Profile clone validation observed inconsistent Store revisions",
        ));
    }
    Ok(validation)
}

fn validate_candidate_semantics(
    connection: &Connection,
    assets_root: &Path,
    profile_id: &str,
    library_id: &str,
    missing_asset_policy: MissingAssetPolicy,
    validate_documents: bool,
) -> Result<ProfileSnapshotCandidateValidation, StoreError> {
    validate_codex_thread_timestamp_invariants(connection)?;
    if validate_documents {
        validate_restore_documents(connection)?;
    }
    validate_identity(connection, profile_id, library_id)?;
    validate_document_authorities(connection)?;
    let store_schema_version =
        connection.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))?;
    let schema_owner = connection
        .query_row(
            "SELECT schema_owner FROM core_store_metadata WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if schema_owner.as_deref() != Some("rust_core") {
        return Err(corrupt("Restore candidate Store schema owner is invalid"));
    }
    let missing_managed_asset_count =
        validate_assets(connection, assets_root, missing_asset_policy)?;
    Ok(ProfileSnapshotCandidateValidation {
        store_epoch: read_store_epoch(connection)?,
        store_schema_version,
        missing_managed_asset_count,
    })
}

fn validate_identity(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
) -> Result<(), StoreError> {
    let valid = connection
        .query_row(
            "SELECT 1 FROM libraries WHERE id = ?1 AND profile_id = ?2",
            params![library_id, profile_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if valid {
        return Ok(());
    }
    Err(corrupt(
        "Restore candidate does not contain the bound Profile and Library identity",
    ))
}

fn validate_document_authorities(connection: &Connection) -> Result<(), StoreError> {
    let heads = DocumentReadRepository::new(connection).document_heads()?;
    for head in heads {
        if head.authority != DocumentAuthority::YdocPrimary
            || head.readiness != DocumentReadiness::Ready
        {
            return Err(corrupt(format!(
                "Restore candidate Document {} is not ready primary authority",
                head.id
            )));
        }
        let authority = match read_document_authority(connection, &head.id) {
            Ok(Some(authority)) => authority,
            Ok(None) => {
                return Err(corrupt(
                    "Restore candidate Document has no durable authority",
                ));
            }
            Err(_) if is_known_unowned_document(connection, &head)? => continue,
            Err(error) => return Err(error),
        };
        match head.sync_engine {
            DocumentSyncEngine::Yjs => {}
            DocumentSyncEngine::CanvasScene => validate_canvas_projection(connection, &authority)?,
        }
    }
    Ok(())
}

/// Unowned content may be retained by a durable authority or waiting for bounded
/// collection with exact dormant provenance. Neither permits ordinary editing.
fn is_known_unowned_document(
    connection: &Connection,
    head: &crate::infrastructure::document_repository::DocumentHeadRow,
) -> Result<bool, StoreError> {
    // Candidate validation also runs before older snapshots are migrated.
    let has_dormant_sources: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'structural_dormant_document_sources')",
        [],
        |row| row.get(0),
    )?;
    if has_dormant_sources
        && crate::document::is_known_dormant_document(connection, &head.library_id, &head.id)?
    {
        return Ok(true);
    }
    connection
        .query_row(
            "SELECT \
               EXISTS(\
                 SELECT 1 FROM document_block_tombstones tombstone \
                 JOIN blocks block ON block.id = tombstone.block_id \
                   AND block.library_id = tombstone.library_id \
                 WHERE tombstone.document_id = ?1 \
                   AND tombstone.library_id = ?2 \
                   AND tombstone.document_generation = ?3 \
                   AND tombstone.deletion_head_seq <= ?4 \
                   AND block.lifecycle = 'deleted' \
                   AND block.placement_revision = tombstone.placement_revision \
                   AND NOT EXISTS (\
                     SELECT 1 FROM block_documents ownership \
                     WHERE ownership.document_id = tombstone.document_id\
                   )\
               ) \
               OR EXISTS(\
                 SELECT 1 FROM structural_retention_members member \
                 WHERE member.library_id = ?2 \
                   AND member.member_kind = 'document' \
                   AND member.member_id = ?1 \
                   AND NOT EXISTS (\
                     SELECT 1 FROM block_documents ownership \
                     WHERE ownership.document_id = member.member_id\
                   ) \
                   AND (\
                     (member.authority_kind = 'clipboard_bundle' AND EXISTS (\
                       SELECT 1 FROM structural_clipboard_leases lease \
                       WHERE lease.bundle_id = member.authority_id \
                         AND lease.state = 'active'\
                     )) \
                     OR (member.authority_kind = 'history_recipe' AND EXISTS (\
                       SELECT 1 FROM structural_history_recipes recipe \
                       WHERE recipe.recipe_operation_id = member.authority_id \
                         AND recipe.library_id = member.library_id\
                     ))\
                   )\
               )",
            params![head.id, head.library_id, head.generation, head.head_seq],
            |row| row.get::<_, bool>(0),
        )
        .map_err(StoreError::from)
}

fn validate_canvas_projection(
    connection: &Connection,
    authority: &DocumentAuthorityRow,
) -> Result<(), StoreError> {
    let loaded = load_canvas_scene(connection, authority)?;
    let projected_files = connection
        .prepare(
            "SELECT file_id, mime_type, asset_uri, target_file_id, file_version, default_name, asset_hash, byte_length \
             FROM canvas_scene_file_refs WHERE document_id = ?1 AND library_id = ?2 \
               AND document_generation = ?3 ORDER BY file_id",
        )?
        .query_map(
            params![
                authority.head.id,
                authority.head.library_id,
                authority.head.generation
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if projected_files.len() != loaded.scene.files.len() {
        return Err(corrupt("Restore candidate Canvas file projection is stale"));
    }
    for (
        file_id,
        mime_type,
        asset_uri,
        target_file_id,
        file_version,
        default_name,
        asset_hash,
        byte_length,
    ) in projected_files
    {
        let Some(file) = loaded.scene.files.get(&file_id) else {
            return Err(corrupt("Restore candidate Canvas file projection is stale"));
        };
        let evidence =
            crate::document::canvas_file_content_evidence(connection, &authority.head.id, file)?;
        if asset_hash != evidence.0
            || byte_length != evidence.1
            || file.mime_type != mime_type
            || file.source != asset_uri
            || file.target_file_id != target_file_id
            || file.file_version != file_version
            || file.default_name != default_name
        {
            return Err(corrupt("Restore candidate Canvas file projection is stale"));
        }
    }

    let projected_references = connection
        .prepare(
            "SELECT source_element_id, target_block_id FROM canvas_page_references \
             WHERE document_id = ?1 AND library_id = ?2 AND document_generation = ?3 \
             ORDER BY source_element_id",
        )?
        .query_map(
            params![
                authority.head.id,
                authority.head.library_id,
                authority.head.generation
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut expected_references = loaded
        .scene
        .page_references
        .iter()
        .map(|reference| {
            (
                reference.source_element_id.clone(),
                reference.target_block_id.clone(),
            )
        })
        .collect::<Vec<_>>();
    expected_references.sort();
    if projected_references != expected_references {
        return Err(corrupt(
            "Restore candidate Canvas Page reference projection is stale",
        ));
    }

    let marker = connection
        .query_row(
            "SELECT text, text_hash FROM block_search_units \
             WHERE document_id = ?1 AND owner_block_id = ?2 AND block_id = ?2 \
               AND document_generation = ?3 \
               AND source_kind = 'document_marker' AND field_key = 'marker'",
            params![
                authority.head.id,
                authority.owner_block_id,
                authority.head.generation
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if marker
        != Some((
            loaded.scene.plain_text.clone(),
            sha256(loaded.scene.plain_text.as_bytes()),
        ))
    {
        return Err(corrupt(
            "Restore candidate Canvas search projection is stale",
        ));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum MissingAssetPolicy {
    Reject,
    Preserve,
}

fn validate_assets(
    connection: &Connection,
    assets_root: &Path,
    missing_asset_policy: MissingAssetPolicy,
) -> Result<usize, StoreError> {
    let metadata = fs::symlink_metadata(assets_root).map_err(io_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(corrupt(
            "Restore candidate managed assets root is not a real directory",
        ));
    }
    for entry in fs::read_dir(assets_root).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let Some(file_name) = entry.file_name().to_str().map(str::to_owned) else {
            return Err(corrupt("Restore candidate managed asset name is not UTF-8"));
        };
        let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
        if !safe_asset_file_name(&file_name)
            || metadata.file_type().is_symlink()
            || !metadata.is_file()
        {
            return Err(corrupt(
                "Restore candidate managed assets must be flat safe regular files",
            ));
        }
    }

    let mut missing_assets = BTreeSet::new();
    let block_assets = connection
        .prepare(
            "SELECT DISTINCT asset.asset_uri, asset.asset_hash FROM block_asset_refs asset \
             JOIN documents document ON document.id = asset.document_id \
               AND document.library_id = asset.library_id \
             WHERE asset.document_generation = document.generation \
               AND asset.projected_seq = document.head_seq \
               AND asset.asset_uri LIKE 'nodex://assets/%' ORDER BY asset.asset_uri",
        )?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (asset_uri, expected_hash) in block_assets {
        let file_name = parse_asset_source(&asset_uri)
            .ok_or_else(|| corrupt("Restore candidate contains an invalid managed asset URI"))?;
        let Some(bytes) = read_asset(
            assets_root,
            &file_name,
            None,
            missing_asset_policy,
            &mut missing_assets,
        )?
        else {
            continue;
        };
        if expected_hash.is_some_and(|expected| sha256(&bytes) != expected) {
            return Err(corrupt(
                "Restore candidate managed asset hash evidence does not match",
            ));
        }
    }

    let managed_blobs = connection
        .prepare(
            "SELECT physical_asset_name, content_hash, byte_length \
             FROM managed_blobs ORDER BY content_hash",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (managed_file_name, expected_hash, expected_length) in managed_blobs {
        if expected_length < 0 {
            return Err(corrupt("Restore candidate Blob length is invalid"));
        }
        let Some(bytes) = read_asset(
            assets_root,
            &managed_file_name,
            Some(nodex_core_contracts::MAX_MANAGED_BLOB_BYTES),
            missing_asset_policy,
            &mut missing_assets,
        )?
        else {
            continue;
        };
        if i64::try_from(bytes.len()).ok() != Some(expected_length)
            || sha256(&bytes) != expected_hash
        {
            return Err(corrupt(
                "Restore candidate Blob evidence does not match its file",
            ));
        }
    }

    let invalid_file_relationships = connection.query_row(
        "SELECT EXISTS( \
           SELECT 1 FROM library_files file \
           LEFT JOIN file_versions version \
             ON version.file_id = file.file_id AND version.version = file.head_version \
              AND version.library_id = file.library_id \
           LEFT JOIN managed_blobs blob ON blob.content_hash = version.blob_hash \
           WHERE version.file_id IS NULL OR blob.content_hash IS NULL \
             OR blob.byte_length <> version.byte_length \
         ) OR EXISTS( \
           SELECT 1 FROM page_file_entries entry \
           LEFT JOIN pages page ON page.block_id = entry.page_id \
             AND page.library_id = entry.library_id \
           LEFT JOIN library_files file ON file.file_id = entry.file_id \
             AND file.library_id = entry.library_id \
           WHERE page.block_id IS NULL OR file.file_id IS NULL OR file.lifecycle <> 'live' \
         )",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if invalid_file_relationships {
        return Err(corrupt(
            "Restore candidate File heads or Page relationships are invalid",
        ));
    }

    let queue_evidence_mode = match missing_asset_policy {
        MissingAssetPolicy::Reject => {
            crate::workspace::queued_follow_up::QueuedAssetEvidenceMode::RequireFiles(assets_root)
        }
        MissingAssetPolicy::Preserve => {
            crate::workspace::queued_follow_up::QueuedAssetEvidenceMode::AllowMissing(assets_root)
        }
    };
    missing_assets.extend(
        crate::workspace::queued_follow_up::validate_all_stored_ledgers(
            connection,
            queue_evidence_mode,
        )?,
    );
    Ok(missing_assets.len())
}

fn read_asset(
    assets_root: &Path,
    file_name: &str,
    maximum_bytes: Option<u64>,
    missing_asset_policy: MissingAssetPolicy,
    missing_assets: &mut BTreeSet<String>,
) -> Result<Option<Vec<u8>>, StoreError> {
    if !safe_asset_file_name(file_name) {
        return Err(corrupt("Restore candidate managed asset name is unsafe"));
    }
    let path = assets_root.join(file_name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if matches!(missing_asset_policy, MissingAssetPolicy::Preserve) {
                missing_assets.insert(file_name.to_owned());
                return Ok(None);
            }
            return Err(corrupt(format!(
                "Restore candidate is missing managed asset {file_name}"
            )));
        }
        Err(error) => return Err(io_error(error)),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || maximum_bytes.is_some_and(|maximum| metadata.len() > maximum)
    {
        return Err(corrupt(format!(
            "Restore candidate managed asset {file_name} is invalid"
        )));
    }
    fs::read(path).map(Some).map_err(io_error)
}

fn safe_asset_file_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 512
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(super) fn read_store_epoch(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .filter(|epoch| !epoch.is_empty() && epoch.len() <= 512)
        .ok_or_else(|| corrupt("Restore candidate Store epoch is unavailable"))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::Internal,
        format!("Store restore filesystem operation failed: {error}"),
        false,
    )
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use crate::infrastructure::store::SqliteStoreKernel;

    use super::*;

    #[test]
    fn dormant_documents_waiting_for_collection_remain_valid_restore_content() {
        let home = tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(home.path()).expect("current Store");
        kernel.writer().call(|connection| {
            connection.execute_batch(
                "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile:restore', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z');
                 INSERT INTO libraries(id, profile_id, created_at, updated_at)
                   VALUES ('library:restore', 'profile:restore', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z');
                 INSERT INTO blocks(id, library_id, type, lifecycle, placement_revision,
                   metadata_revision, created_at, updated_at)
                   VALUES ('placeholder', 'library:restore', 'paragraph', 'active', 1, 1, '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z');
                 INSERT INTO documents(id, library_id, generation, head_seq, schema_key, schema_version,
                   state_vector, state_hash, readiness, authority, created_at, updated_at, sync_engine)
                   VALUES ('document:dormant', 'library:restore', 1, 1, 'nodex.page', 3,
                     X'', '', 'ready', 'ydoc_primary', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z', 'yjs');
                 INSERT INTO document_block_index(document_id, block_id, ordinal, block_type, text, projected_seq)
                   VALUES ('document:dormant', 'placeholder', 0, 'paragraph', '', 1);",
            )?;
            assert!(validate_document_authorities(connection).is_err(), "unexplained orphan");
            connection.execute_batch(
                "INSERT INTO structural_dormant_document_sources(library_id, document_id, page_id, placeholder_block_id)
                   VALUES ('library:restore', 'document:dormant', 'former-page', 'placeholder');",
            )?;
            validate_document_authorities(connection)?;
            connection.execute("UPDATE structural_dormant_document_sources SET placeholder_block_id = 'wrong'", [])?;
            assert!(validate_document_authorities(connection).is_err(), "wrong placeholder provenance");
            connection.execute("UPDATE structural_dormant_document_sources SET placeholder_block_id = 'placeholder'", [])?;
            connection.execute("UPDATE blocks SET type = 'heading' WHERE id = 'placeholder'", [])?;
            assert!(validate_document_authorities(connection).is_err(), "non-placeholder content");
            Ok(())
        }).expect("dormant restore closure");
    }

    #[test]
    fn retained_tombstoned_documents_are_part_of_the_restore_closure() {
        let home = tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(home.path()).expect("current Store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "INSERT INTO profiles(id, created_at, updated_at) \
                       VALUES ('profile:restore', '2026-08-26T00:00:00.000Z', \
                         '2026-08-26T00:00:00.000Z'); \
                     INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                       VALUES ('library:restore', 'profile:restore', \
                         '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z'); \
                     INSERT INTO blocks(\
                       id, library_id, type, lifecycle, placement_revision, \
                       metadata_revision, created_at, updated_at\
                     ) VALUES (\
                       'block:deleted-owner', 'library:restore', 'paragraph', 'deleted', 2, 1, \
                       '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z'\
                     ); \
                     INSERT INTO documents(\
                       id, library_id, generation, head_seq, schema_key, schema_version, \
                       state_vector, state_hash, readiness, authority, created_at, updated_at, \
                       sync_engine\
                     ) VALUES (\
                       'document:retained', 'library:restore', 1, 4, 'nodex.page', 3, X'', '', \
                       'ready', 'ydoc_primary', '2026-08-26T00:00:00.000Z', \
                       '2026-08-26T00:00:00.000Z', 'yjs'\
                     ); \
                     INSERT INTO document_block_tombstones(\
                       block_id, library_id, document_id, document_generation, \
                       deletion_head_seq, placement_revision, deleted_at\
                     ) VALUES (\
                       'block:deleted-owner', 'library:restore', 'document:retained', 1, 5, 2, \
                       '2026-08-26T00:00:00.000Z'\
                     ); \
                     UPDATE documents SET head_seq = 5 WHERE id = 'document:retained';",
                )?;
                validate_document_authorities(connection)
            })
            .expect("retained tombstone authority");
    }

    #[test]
    fn snapshot_asset_validation_preserves_missing_evidence_that_restore_rejects() {
        let connection = Connection::open_in_memory().expect("asset fixture");
        connection
            .execute_batch(
                "CREATE TABLE documents( \
                   id TEXT NOT NULL, library_id TEXT NOT NULL, generation INTEGER NOT NULL, \
                   head_seq INTEGER NOT NULL \
                 ); \
                 CREATE TABLE block_asset_refs( \
                   document_id TEXT NOT NULL, library_id TEXT NOT NULL, \
                   document_generation INTEGER NOT NULL, projected_seq INTEGER NOT NULL, \
                   asset_uri TEXT NOT NULL, asset_hash TEXT \
                 ); \
                 CREATE TABLE canvas_scene_file_refs( \
                   document_id TEXT NOT NULL, library_id TEXT NOT NULL, \
                   document_generation INTEGER NOT NULL, file_id TEXT NOT NULL, \
                   asset_uri TEXT NOT NULL, managed_file_name TEXT NOT NULL, \
                   asset_hash TEXT NOT NULL, byte_length INTEGER NOT NULL \
                 ); \
                 CREATE TABLE managed_blobs( \
                   content_hash TEXT NOT NULL, physical_asset_name TEXT NOT NULL, \
                   byte_length INTEGER NOT NULL \
                 ); \
                 CREATE TABLE pages(block_id TEXT NOT NULL, library_id TEXT NOT NULL); \
                 CREATE TABLE library_files( \
                   file_id TEXT NOT NULL, library_id TEXT NOT NULL, head_version INTEGER NOT NULL, \
                   lifecycle TEXT NOT NULL \
                 ); \
                 CREATE TABLE file_versions( \
                   file_id TEXT NOT NULL, version INTEGER NOT NULL, library_id TEXT NOT NULL, \
                   blob_hash TEXT NOT NULL, byte_length INTEGER NOT NULL \
                 ); \
                 CREATE TABLE page_file_entries( \
                   page_id TEXT NOT NULL, library_id TEXT NOT NULL, file_id TEXT NOT NULL \
                 ); \
                 INSERT INTO documents(id, library_id, generation, head_seq) \
                 VALUES ('document:1', 'library:1', 1, 4); \
                 INSERT INTO block_asset_refs( \
                   document_id, library_id, document_generation, projected_seq, \
                   asset_uri, asset_hash \
                 ) VALUES ( \
                   'document:1', 'library:1', 1, 4, \
                   'nodex://assets/missing.png', NULL \
                 );",
            )
            .expect("asset projection fixture");
        let assets = tempdir().expect("assets");

        let restore_error = validate_assets(&connection, assets.path(), MissingAssetPolicy::Reject)
            .expect_err("restore must reject incomplete closure");
        assert_eq!(restore_error.code, StoreErrorCode::StoreCorrupt);

        assert_eq!(
            validate_assets(&connection, assets.path(), MissingAssetPolicy::Preserve,)
                .expect("snapshot preserves missing evidence"),
            1
        );
        fs::write(assets.path().join("missing.png"), b"available").expect("managed asset");
        assert_eq!(
            validate_assets(&connection, assets.path(), MissingAssetPolicy::Reject,)
                .expect("complete restore closure"),
            0
        );
    }

    #[test]
    fn restore_rejects_tampered_file_blob_bytes() {
        let connection = Connection::open_in_memory().expect("File restore fixture");
        connection
            .execute_batch(
                "CREATE TABLE documents( \
                   id TEXT NOT NULL, library_id TEXT NOT NULL, generation INTEGER NOT NULL, \
                   head_seq INTEGER NOT NULL \
                 ); \
                 CREATE TABLE block_asset_refs( \
                   document_id TEXT NOT NULL, library_id TEXT NOT NULL, \
                   document_generation INTEGER NOT NULL, projected_seq INTEGER NOT NULL, \
                   asset_uri TEXT NOT NULL, asset_hash TEXT \
                 ); \
                 CREATE TABLE canvas_scene_file_refs( \
                   document_id TEXT NOT NULL, library_id TEXT NOT NULL, \
                   document_generation INTEGER NOT NULL, file_id TEXT NOT NULL, \
                   asset_uri TEXT NOT NULL, managed_file_name TEXT NOT NULL, \
                   asset_hash TEXT NOT NULL, byte_length INTEGER NOT NULL \
                 ); \
                 CREATE TABLE managed_blobs( \
                   content_hash TEXT NOT NULL, physical_asset_name TEXT NOT NULL, \
                   byte_length INTEGER NOT NULL \
                 ); \
                 CREATE TABLE pages(block_id TEXT NOT NULL, library_id TEXT NOT NULL); \
                 CREATE TABLE library_files( \
                   file_id TEXT NOT NULL, library_id TEXT NOT NULL, head_version INTEGER NOT NULL, \
                   lifecycle TEXT NOT NULL \
                 ); \
                 CREATE TABLE file_versions( \
                   file_id TEXT NOT NULL, version INTEGER NOT NULL, library_id TEXT NOT NULL, \
                   blob_hash TEXT NOT NULL, byte_length INTEGER NOT NULL \
                 ); \
                 CREATE TABLE page_file_entries( \
                   page_id TEXT NOT NULL, library_id TEXT NOT NULL, file_id TEXT NOT NULL \
                 );",
            )
            .expect("File restore schema");
        let expected = b"trusted bytes";
        let content_hash = sha256(expected);
        connection
            .execute(
                "INSERT INTO managed_blobs(content_hash, physical_asset_name, byte_length) \
                 VALUES (?1, 'file-test.blob', ?2)",
                params![content_hash, expected.len() as i64],
            )
            .expect("managed Blob evidence");
        let assets = tempdir().expect("assets");
        fs::write(assets.path().join("file-test.blob"), b"forged-bytes!").expect("tampered Blob");

        let error = validate_assets(&connection, assets.path(), MissingAssetPolicy::Reject)
            .expect_err("restore must reject a tampered File Blob");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
    }
}
