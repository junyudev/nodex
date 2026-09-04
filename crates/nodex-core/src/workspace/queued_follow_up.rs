use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::workspace::{
    ProjectWorkspaceQueuedFollowUpEntry, ProjectWorkspaceQueuedFollowUpLedger,
    ProjectWorkspaceQueuedFollowUpLedgerCommit, ProjectWorkspaceQueuedFollowUpPause,
    ProjectWorkspaceQueuedFollowUpPayloadRef,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::document::sha256;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::{
    WorkspaceMutationEffects, finish_no_op_with_queued_follow_up, run_mutation,
    workspace_event_anchor,
};
use super::session_mutation::sqlite_now;
use super::thread::read_thread;

pub(super) const MAX_QUEUED_FOLLOW_UP_ENTRIES: usize = 512;
pub(super) const MAX_QUEUED_FOLLOW_UP_LEDGER_METADATA_BYTES: usize = 768 * 1024;
const MAX_ID_BYTES: usize = 512;
const MAX_PAUSE_REASON_BYTES: usize = 4_096;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MANIFEST_ASSET_REFERENCES: usize = 512;
const MAX_REFERENCED_ASSET_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_ASSET_EVIDENCE_BYTES: u64 = 512 * 1024 * 1024;
const MANIFEST_SCHEMA_VERSION: u32 = 2;
const ASSET_URI_PREFIX: &str = "nodex://assets/";
const INTERRUPTED_REASON: &str = "Interrupted before the steer was accepted.";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PayloadManifest {
    schema_version: u32,
    payload: Value,
    #[serde(default)]
    asset_references: Vec<PayloadAssetReference>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct PayloadAssetReference {
    asset_uri: String,
    sha256: String,
    byte_length: u64,
    mime_type: String,
}

#[derive(Clone, Copy)]
pub(crate) enum QueuedAssetEvidenceMode<'a> {
    DatabaseOnly,
    RequireFiles(&'a Path),
    AllowMissing(&'a Path),
}

#[derive(Default)]
struct AssetEvidenceBudget {
    consumed_bytes: u64,
}

impl AssetEvidenceBudget {
    fn reserve(&mut self, bytes: u64) -> Result<(), StoreError> {
        self.consumed_bytes = self
            .consumed_bytes
            .checked_add(bytes)
            .ok_or_else(|| resource_exhausted("Queued follow-up asset evidence is too large"))?;
        if self.consumed_bytes > MAX_TOTAL_ASSET_EVIDENCE_BYTES {
            return Err(resource_exhausted(
                "Queued follow-up asset evidence exceeds its total byte budget",
            ));
        }
        Ok(())
    }
}

pub(super) fn read_ledger(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
    assets_root: &Path,
) -> Result<ProjectWorkspaceQueuedFollowUpLedger, StoreError> {
    require_thread(connection, library_id, thread_id)?;
    let mut budget = AssetEvidenceBudget::default();
    let mut missing = BTreeSet::new();
    let mut validated_payloads = BTreeSet::new();
    read_stored_ledger(
        connection,
        thread_id,
        QueuedAssetEvidenceMode::RequireFiles(assets_root),
        &mut budget,
        &mut missing,
        &mut validated_payloads,
    )
}

fn read_stored_ledger(
    connection: &Connection,
    thread_id: &str,
    evidence_mode: QueuedAssetEvidenceMode<'_>,
    budget: &mut AssetEvidenceBudget,
    missing: &mut BTreeSet<String>,
    validated_payloads: &mut BTreeSet<String>,
) -> Result<ProjectWorkspaceQueuedFollowUpLedger, StoreError> {
    let envelope = connection
        .query_row(
            "SELECT revision, ledger_hash FROM codex_queued_follow_up_ledgers \
             WHERE thread_id = ?1",
            [thread_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((revision, ledger_hash)) = envelope else {
        return Ok(ProjectWorkspaceQueuedFollowUpLedger {
            thread_id: thread_id.to_owned(),
            revision: 0,
            ledger_hash: sha256(b"[]"),
            entries: Vec::new(),
        });
    };
    let entries = connection
        .prepare(
            "SELECT entry.position, entry.follow_up_id, entry.client_user_message_id, entry.created_at_ms, \
                    entry.pause_kind, entry.pause_reason, manifest.schema_version, \
                    manifest.asset_uri, manifest.payload_sha256, manifest.byte_length \
             FROM codex_queued_follow_up_entries entry \
             JOIN codex_queued_follow_up_payload_manifests manifest \
               ON manifest.payload_sha256 = entry.payload_sha256 \
             WHERE entry.thread_id = ?1 ORDER BY entry.position",
        )?
        .query_map([thread_id], |row| {
            let position = row.get::<_, i64>(0)?;
            let pause_kind = row.get::<_, Option<String>>(4)?;
            let pause_reason = row.get::<_, Option<String>>(5)?;
            let pause = match (pause_kind.as_deref(), pause_reason) {
                (None, None) => None,
                (Some("interrupted"), Some(reason)) => {
                    Some(ProjectWorkspaceQueuedFollowUpPause::Interrupted { reason })
                }
                (Some("failed"), Some(reason)) => {
                    Some(ProjectWorkspaceQueuedFollowUpPause::Failed { reason })
                }
                _ => return Err(rusqlite::Error::InvalidQuery),
            };
            let byte_length = row.get::<_, i64>(9)?;
            Ok((position, ProjectWorkspaceQueuedFollowUpEntry {
                follow_up_id: row.get(1)?,
                client_user_message_id: row.get(2)?,
                created_at_ms: row.get(3)?,
                pause,
                payload: ProjectWorkspaceQueuedFollowUpPayloadRef {
                    schema_version: u32::try_from(row.get::<_, i64>(6)?).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            6,
                            rusqlite::types::Type::Integer,
                            Box::new(error),
                        )
                    })?,
                    asset_uri: row.get(7)?,
                    sha256: row.get(8)?,
                    byte_length: u64::try_from(byte_length).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            9,
                            rusqlite::types::Type::Integer,
                            Box::new(error),
                        )
                    })?,
                },
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (expected, (actual, _)) in entries.iter().enumerate() {
        if i64::try_from(expected).ok() != Some(*actual) {
            return Err(corrupt(
                "Stored queued follow-up positions are not contiguous",
            ));
        }
    }
    let entries = entries.into_iter().map(|(_, entry)| entry).collect();
    let ledger = ProjectWorkspaceQueuedFollowUpLedger {
        thread_id: thread_id.to_owned(),
        revision,
        ledger_hash,
        entries,
    };
    validate_stored_ledger(&ledger)?;
    let mut unique_payloads = BTreeMap::new();
    for entry in &ledger.entries {
        unique_payloads
            .entry(entry.payload.sha256.clone())
            .or_insert_with(|| entry.payload.clone());
    }
    for payload in unique_payloads.values() {
        if !validated_payloads.insert(payload.sha256.clone()) {
            continue;
        }
        let stored_refs = read_stored_asset_references(connection, &payload.sha256)?;
        validate_manifest(payload, evidence_mode, budget, missing, Some(&stored_refs))
            .map_err(as_stored_corruption)?;
    }
    Ok(ledger)
}

pub(crate) fn validate_all_stored_ledgers(
    connection: &Connection,
    evidence_mode: QueuedAssetEvidenceMode<'_>,
) -> Result<BTreeSet<String>, StoreError> {
    let table_exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' \
             AND name = 'codex_queued_follow_up_ledgers'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !table_exists {
        return Ok(BTreeSet::new());
    }
    let inconsistent_blob: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM codex_queued_follow_up_payload_manifests payload
           LEFT JOIN managed_blobs blob ON blob.content_hash = payload.payload_sha256
           WHERE blob.content_hash IS NULL OR blob.byte_length != payload.byte_length)
         OR EXISTS(SELECT 1 FROM codex_queued_follow_up_payload_asset_refs reference
           LEFT JOIN managed_blobs blob ON blob.content_hash = reference.sha256
           WHERE blob.content_hash IS NULL OR blob.byte_length != reference.byte_length)",
        [],
        |row| row.get(0),
    )?;
    if inconsistent_blob {
        return Err(corrupt(
            "Queued follow-up Blob metadata disagrees with its retained bytes",
        ));
    }
    let thread_ids = connection
        .prepare("SELECT thread_id FROM codex_queued_follow_up_ledgers ORDER BY thread_id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut budget = AssetEvidenceBudget::default();
    let mut missing = BTreeSet::new();
    let mut validated_payloads = BTreeSet::new();
    for thread_id in thread_ids {
        read_stored_ledger(
            connection,
            &thread_id,
            evidence_mode,
            &mut budget,
            &mut missing,
            &mut validated_payloads,
        )?;
    }
    let orphaned_manifest = connection
        .query_row(
            "SELECT payload.payload_sha256 \
             FROM codex_queued_follow_up_payload_manifests payload \
             WHERE NOT EXISTS ( \
               SELECT 1 FROM codex_queued_follow_up_entries entry \
               WHERE entry.payload_sha256 = payload.payload_sha256 \
             ) LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if orphaned_manifest.is_some() {
        return Err(corrupt(
            "Stored queued follow-up payload manifest is not owned by a ledger entry",
        ));
    }
    Ok(missing)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn commit_ledger(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    thread_id: &str,
    expected_revision: i64,
    entries: &[ProjectWorkspaceQueuedFollowUpEntry],
    receipt_ids: &[String],
    assets_root: &Path,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    super::thread_assets::require_access(connection, context, thread_id, true)?;
    if expected_revision < 0 {
        return Err(invalid(
            "Queued follow-up expected_revision cannot be negative",
        ));
    }
    let current = read_ledger(connection, library_id, thread_id, assets_root)?;
    if current.revision != expected_revision {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            format!(
                "Queued follow-up ledger revision changed (expected {expected_revision}, actual {})",
                current.revision
            ),
            true,
        ));
    }
    let validated = validate_entries(entries, assets_root)?;
    let ledger_hash = ledger_hash(entries)?;
    let now = sqlite_now(connection)?;
    if current.entries == entries {
        return finish_no_op_with_queued_follow_up(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "commit_queued_follow_up_ledger",
            Vec::new(),
            Vec::new(),
            &now,
            Some(ProjectWorkspaceQueuedFollowUpLedgerCommit {
                thread_id: thread_id.to_owned(),
                revision: current.revision,
                ledger_hash,
                changed: false,
            }),
        );
    }

    let prepared = authorize_publication(
        connection,
        context,
        store_epoch,
        operation_id,
        thread_id,
        &validated,
        receipt_ids,
    )?;
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |scope| {
            for receipt in &prepared {
                crate::infrastructure::prepared_blobs::consume(
                    connection,
                    &receipt.receipt_id,
                    scope.evidence().commit_seq(),
                    &now,
                )?;
            }
            let prior_payloads = connection
                .prepare(
                    "SELECT DISTINCT payload_sha256 FROM codex_queued_follow_up_entries \
             WHERE thread_id = ?1",
                )?
                .query_map([thread_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<BTreeSet<_>>>()?;
            let next_revision = current.revision.checked_add(1).ok_or_else(|| {
                resource_exhausted("Queued follow-up ledger revision is exhausted")
            })?;
            connection.execute(
        "INSERT INTO codex_queued_follow_up_ledgers(thread_id, revision, ledger_hash, updated_at) \
         VALUES (?1, ?2, ?3, ?4) ON CONFLICT(thread_id) DO UPDATE SET \
           revision = excluded.revision, ledger_hash = excluded.ledger_hash, \
           updated_at = excluded.updated_at",
        params![thread_id, next_revision, ledger_hash, now],
    )?;
            connection.execute(
                "DELETE FROM codex_queued_follow_up_entries WHERE thread_id = ?1",
                [thread_id],
            )?;
            for (position, entry) in entries.iter().enumerate() {
                let (_, manifest) = validated
                    .get(&entry.payload.sha256)
                    .expect("validated manifest is keyed by payload hash");
                insert_manifest(connection, &entry.payload, manifest)?;
                let (pause_kind, pause_reason) = pause_storage(entry.pause.as_ref());
                connection.execute(
                    "INSERT INTO codex_queued_follow_up_entries( \
               thread_id, follow_up_id, position, client_user_message_id, created_at_ms, \
               pause_kind, pause_reason, payload_sha256 \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        thread_id,
                        entry.follow_up_id,
                        i64::try_from(position).expect("queue bound fits SQLite integer"),
                        entry.client_user_message_id,
                        entry.created_at_ms,
                        pause_kind,
                        pause_reason,
                        entry.payload.sha256,
                    ],
                )?;
            }
            release_orphaned_manifests(connection, &prior_payloads)?;
            let change_project_id = workspace_event_anchor(connection, library_id)?;
            Ok(WorkspaceMutationEffects {
                operation_kind: "commit_queued_follow_up_ledger",
                project_catalog_change: None,
                change_project_id,
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
                queued_follow_up_ledger: Some(ProjectWorkspaceQueuedFollowUpLedgerCommit {
                    thread_id: thread_id.to_owned(),
                    revision: next_revision,
                    ledger_hash,
                    changed: true,
                }),
            })
        },
    )
}

/// New bytes require receipts for this exact commit; existing bytes may be reused
/// only from this Thread's retained queue, never from an arbitrary known hash.
#[allow(clippy::too_many_arguments)]
fn authorize_publication(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    thread_id: &str,
    manifests: &BTreeMap<String, (ProjectWorkspaceQueuedFollowUpPayloadRef, PayloadManifest)>,
    receipt_ids: &[String],
) -> Result<Vec<crate::infrastructure::prepared_blobs::PreparedBlob>, StoreError> {
    if receipt_ids.len() > 1024 {
        return Err(resource_exhausted(
            "Queue publication exceeds 1024 prepared Blobs",
        ));
    }
    let actor = context
        .project_id
        .as_ref()
        .map(|project| Ok(project.0.clone()))
        .unwrap_or_else(|| {
            crate::library::resolve_library_actor_project_id(connection, &context.library_id.0)
        })?;
    let mut needed = BTreeMap::new();
    for (payload, manifest) in manifests.values() {
        needed.insert(payload.sha256.clone(), payload.byte_length);
        for reference in &manifest.asset_references {
            if needed
                .insert(reference.sha256.clone(), reference.byte_length)
                .is_some_and(|length| length != reference.byte_length)
            {
                return Err(invalid("Queue Blob metadata is inconsistent"));
            }
        }
    }
    let mut seen = BTreeSet::new();
    let mut prepared_hashes = BTreeSet::new();
    let mut prepared = Vec::new();
    for id in receipt_ids {
        if !seen.insert(id) {
            return Err(invalid("Queue publication receipts must be unique"));
        }
        let receipt = crate::infrastructure::prepared_blobs::read_receipt(
            connection,
            store_epoch,
            &context.library_id.0,
            &actor,
            operation_id,
            id,
        )?;
        if needed.get(&receipt.content_hash) != Some(&receipt.byte_length)
            || !prepared_hashes.insert(receipt.content_hash.clone())
        {
            return Err(invalid(
                "Queue publication receipt does not match its payload closure",
            ));
        }
        prepared.push(receipt);
    }
    let retained = connection.prepare(
        "SELECT payload_sha256 FROM codex_queued_follow_up_entries WHERE thread_id = ?1
         UNION SELECT reference.sha256 FROM codex_queued_follow_up_payload_asset_refs reference
         JOIN codex_queued_follow_up_entries entry ON entry.payload_sha256 = reference.payload_sha256
         WHERE entry.thread_id = ?1",
    )?.query_map([thread_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    if needed
        .keys()
        .any(|hash| !prepared_hashes.contains(hash) && !retained.contains(hash))
    {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Queue bytes require prepared publication or an existing Thread queue reference",
            false,
        ));
    }
    Ok(prepared)
}

pub(super) fn thread_payloads(
    connection: &Connection,
    thread_id: &str,
) -> Result<BTreeSet<String>, StoreError> {
    connection
        .prepare(
            "SELECT DISTINCT payload_sha256 FROM codex_queued_follow_up_entries \
             WHERE thread_id = ?1",
        )?
        .query_map([thread_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()
        .map_err(Into::into)
}

pub(super) fn release_thread_payloads(
    connection: &Connection,
    payloads: &BTreeSet<String>,
    _now: &str,
) -> Result<(), StoreError> {
    release_orphaned_manifests(connection, payloads)
}

fn require_thread(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
) -> Result<(), StoreError> {
    validate_id("thread_id", thread_id)?;
    read_thread(connection, library_id, thread_id)?
        .ok_or_else(|| not_found("Codex Thread is unavailable in this Library"))?;
    Ok(())
}

fn validate_entries(
    entries: &[ProjectWorkspaceQueuedFollowUpEntry],
    assets_root: &Path,
) -> Result<BTreeMap<String, (ProjectWorkspaceQueuedFollowUpPayloadRef, PayloadManifest)>, StoreError>
{
    if entries.len() > MAX_QUEUED_FOLLOW_UP_ENTRIES {
        return Err(resource_exhausted(
            "Queued follow-up ledger exceeds 512 entries",
        ));
    }
    let encoded = serde_json::to_vec(entries)
        .map_err(|_| invalid("Queued follow-up ledger metadata is not encodable"))?;
    if encoded.len() > MAX_QUEUED_FOLLOW_UP_LEDGER_METADATA_BYTES {
        return Err(resource_exhausted(
            "Queued follow-up ledger metadata exceeds 768 KiB",
        ));
    }
    let mut follow_up_ids = BTreeSet::new();
    let mut client_message_ids = BTreeSet::new();
    let mut manifests = BTreeMap::new();
    let mut budget = AssetEvidenceBudget::default();
    let mut missing = BTreeSet::new();
    for entry in entries {
        validate_id("follow_up_id", &entry.follow_up_id)?;
        validate_id("client_user_message_id", &entry.client_user_message_id)?;
        if entry.created_at_ms < 0 {
            return Err(invalid("Queued follow-up created_at_ms cannot be negative"));
        }
        if !follow_up_ids.insert(entry.follow_up_id.as_str()) {
            return Err(invalid("Queued follow-up IDs must be unique"));
        }
        if !client_message_ids.insert(entry.client_user_message_id.as_str()) {
            return Err(invalid(
                "Queued follow-up client user message IDs must be unique",
            ));
        }
        validate_pause(entry.pause.as_ref())?;
        if let Some((existing, _)) = manifests.get(&entry.payload.sha256) {
            if existing != &entry.payload {
                return Err(invalid(
                    "The same queued follow-up payload hash has conflicting metadata",
                ));
            }
            continue;
        }
        let manifest = validate_manifest(
            &entry.payload,
            QueuedAssetEvidenceMode::RequireFiles(assets_root),
            &mut budget,
            &mut missing,
            None,
        )?;
        manifests.insert(
            entry.payload.sha256.clone(),
            (entry.payload.clone(), manifest),
        );
    }
    Ok(manifests)
}

fn validate_stored_ledger(ledger: &ProjectWorkspaceQueuedFollowUpLedger) -> Result<(), StoreError> {
    if ledger.revision < 0 || ledger.entries.len() > MAX_QUEUED_FOLLOW_UP_ENTRIES {
        return Err(corrupt(
            "Stored queued follow-up ledger violates its bounds",
        ));
    }
    if ledger_hash(&ledger.entries)? != ledger.ledger_hash {
        return Err(corrupt("Stored queued follow-up ledger hash is invalid"));
    }
    let encoded = serde_json::to_vec(&ledger.entries)
        .map_err(|_| corrupt("Stored queued follow-up ledger cannot be encoded"))?;
    if encoded.len() > MAX_QUEUED_FOLLOW_UP_LEDGER_METADATA_BYTES {
        return Err(corrupt(
            "Stored queued follow-up ledger metadata is too large",
        ));
    }
    let mut follow_up_ids = BTreeSet::new();
    let mut client_message_ids = BTreeSet::new();
    for entry in &ledger.entries {
        validate_id("follow_up_id", &entry.follow_up_id)
            .map_err(|_| corrupt("Stored queued follow-up ID is invalid"))?;
        validate_id("client_user_message_id", &entry.client_user_message_id)
            .map_err(|_| corrupt("Stored queued follow-up wire ID is invalid"))?;
        if entry.created_at_ms < 0
            || !follow_up_ids.insert(entry.follow_up_id.as_str())
            || !client_message_ids.insert(entry.client_user_message_id.as_str())
            || validate_pause(entry.pause.as_ref()).is_err()
        {
            return Err(corrupt(
                "Stored queued follow-up ledger metadata is invalid",
            ));
        }
    }
    Ok(())
}

fn validate_pause(pause: Option<&ProjectWorkspaceQueuedFollowUpPause>) -> Result<(), StoreError> {
    let Some(pause) = pause else {
        return Ok(());
    };
    let reason = match pause {
        ProjectWorkspaceQueuedFollowUpPause::Interrupted { reason } => {
            if reason != INTERRUPTED_REASON {
                return Err(invalid(
                    "Interrupted queued follow-up pause has a non-canonical reason",
                ));
            }
            reason
        }
        ProjectWorkspaceQueuedFollowUpPause::Failed { reason } => reason,
    };
    if reason.trim().is_empty() || reason.len() > MAX_PAUSE_REASON_BYTES {
        return Err(invalid("Queued follow-up pause reason is invalid"));
    }
    Ok(())
}

fn validate_manifest(
    payload: &ProjectWorkspaceQueuedFollowUpPayloadRef,
    evidence_mode: QueuedAssetEvidenceMode<'_>,
    budget: &mut AssetEvidenceBudget,
    missing: &mut BTreeSet<String>,
    stored_references: Option<&[PayloadAssetReference]>,
) -> Result<PayloadManifest, StoreError> {
    if payload.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(invalid(
            "Unsupported queued follow-up payload schema version",
        ));
    }
    validate_sha256("payload sha256", &payload.sha256)?;
    if payload.byte_length < 2 || payload.byte_length > MAX_MANIFEST_BYTES {
        return Err(resource_exhausted(
            "Queued follow-up payload manifest exceeds its byte bound",
        ));
    }
    let file_name = queue_manifest_file_name(&payload.asset_uri, &payload.sha256)?;
    if matches!(evidence_mode, QueuedAssetEvidenceMode::DatabaseOnly) {
        let references = stored_references.ok_or_else(|| {
            corrupt("Stored queued follow-up manifest references are unavailable")
        })?;
        validate_reference_metadata(references)?;
        return Ok(PayloadManifest {
            schema_version: payload.schema_version,
            payload: Value::Object(Default::default()),
            asset_references: references.to_vec(),
        });
    }
    let Some(bytes) = read_manifest_evidence(
        evidence_mode,
        &file_name,
        payload.byte_length,
        &payload.sha256,
        budget,
        missing,
    )?
    else {
        let references = stored_references.unwrap_or_default();
        validate_reference_metadata(references)?;
        for reference in references {
            let nested_file_name = managed_asset_file_name(&reference.asset_uri)?;
            if let Some((length, hash)) = hash_asset_evidence(
                evidence_mode,
                &nested_file_name,
                MAX_REFERENCED_ASSET_BYTES,
                budget,
                missing,
            )? && (length != reference.byte_length || hash != reference.sha256)
            {
                return Err(invalid(
                    "Queued follow-up payload asset evidence does not match its file",
                ));
            }
        }
        return Ok(PayloadManifest {
            schema_version: payload.schema_version,
            payload: Value::Object(Default::default()),
            asset_references: references.to_vec(),
        });
    };
    if bytes.len() as u64 != payload.byte_length {
        return Err(invalid(
            "Queued follow-up payload manifest evidence does not match its file",
        ));
    }
    let manifest = serde_json::from_slice::<PayloadManifest>(&bytes)
        .map_err(|_| invalid("Queued follow-up payload manifest JSON is invalid"))?;
    let manifest_payload = manifest.payload.as_object();
    if manifest.schema_version != payload.schema_version
        || manifest_payload.is_none()
        || !manifest_payload.is_some_and(|value| {
            value.get("prompt").is_some_and(Value::is_string)
                && value.get("prompt_input").is_some_and(Value::is_object)
        })
    {
        return Err(invalid(
            "Queued follow-up payload manifest envelope is invalid",
        ));
    }
    if stored_references.is_some_and(|references| references != manifest.asset_references) {
        return Err(invalid(
            "Queued follow-up stored asset references do not match the manifest",
        ));
    }
    validate_asset_references(&manifest, evidence_mode, budget, missing)?;
    Ok(manifest)
}

fn validate_asset_references(
    manifest: &PayloadManifest,
    evidence_mode: QueuedAssetEvidenceMode<'_>,
    budget: &mut AssetEvidenceBudget,
    missing: &mut BTreeSet<String>,
) -> Result<(), StoreError> {
    validate_reference_metadata(&manifest.asset_references)?;
    let mut listed = BTreeSet::new();
    for reference in &manifest.asset_references {
        listed.insert(reference.asset_uri.as_str());
    }
    let mut embedded = BTreeSet::new();
    collect_and_validate_payload_locators(&manifest.payload, None, &mut embedded)?;
    if embedded != listed {
        return Err(invalid(
            "Queued follow-up payload managed asset locators do not match its references",
        ));
    }
    if matches!(evidence_mode, QueuedAssetEvidenceMode::DatabaseOnly) {
        return Ok(());
    }
    for reference in &manifest.asset_references {
        let file_name = managed_asset_file_name(&reference.asset_uri)?;
        let Some((actual_length, actual_hash)) = hash_asset_evidence(
            evidence_mode,
            &file_name,
            MAX_REFERENCED_ASSET_BYTES,
            budget,
            missing,
        )?
        else {
            continue;
        };
        if actual_length != reference.byte_length || actual_hash != reference.sha256 {
            return Err(invalid(
                "Queued follow-up payload asset evidence does not match its file",
            ));
        }
    }
    Ok(())
}

fn validate_reference_metadata(references: &[PayloadAssetReference]) -> Result<(), StoreError> {
    if references.len() > MAX_MANIFEST_ASSET_REFERENCES {
        return Err(resource_exhausted(
            "Queued follow-up payload has too many managed asset references",
        ));
    }
    let declared_total = references.iter().try_fold(0_u64, |total, reference| {
        total
            .checked_add(reference.byte_length)
            .ok_or_else(|| resource_exhausted("Queued follow-up asset evidence is too large"))
    })?;
    if declared_total > MAX_TOTAL_ASSET_EVIDENCE_BYTES {
        return Err(resource_exhausted(
            "Queued follow-up asset references exceed their total byte budget",
        ));
    }
    let mut listed = BTreeSet::new();
    for reference in references {
        validate_sha256("payload asset sha256", &reference.sha256)?;
        if reference.byte_length > MAX_REFERENCED_ASSET_BYTES {
            return Err(resource_exhausted(
                "Queued follow-up referenced asset exceeds its byte bound",
            ));
        }
        queue_manifest_file_name(&reference.asset_uri, &reference.sha256)?;
        if reference.mime_type.trim().is_empty()
            || reference.mime_type.len() > 255
            || reference.mime_type.chars().any(char::is_control)
        {
            return Err(invalid("Queued attachment MIME type is invalid"));
        }
        if !listed.insert(reference.asset_uri.as_str()) {
            return Err(invalid(
                "Queued follow-up payload asset references must be unique",
            ));
        }
    }
    Ok(())
}

fn collect_and_validate_payload_locators<'a>(
    value: &'a Value,
    field_name: Option<&str>,
    found: &mut BTreeSet<&'a str>,
) -> Result<(), StoreError> {
    match value {
        Value::String(value) => {
            if value.starts_with(ASSET_URI_PREFIX) {
                managed_asset_file_name(value)?;
                found.insert(value);
            } else if field_name.is_some_and(is_locator_field) && is_nonportable_locator(value) {
                return Err(invalid(
                    "Queued follow-up payload contains a volatile or local-only asset locator",
                ));
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_and_validate_payload_locators(value, field_name, found)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                collect_and_validate_payload_locators(value, Some(key), found)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn is_locator_field(field: &str) -> bool {
    matches!(
        field.to_ascii_lowercase().as_str(),
        "source"
            | "path"
            | "fspath"
            | "fs_path"
            | "localpath"
            | "local_path"
            | "uri"
            | "url"
            | "imagedataurl"
            | "image_data_url"
    )
}

fn is_nonportable_locator(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("blob:")
        || lower.starts_with("file:")
        || value.starts_with('/')
        || value.starts_with("\\\\")
        || (value.len() >= 3
            && value.as_bytes()[0].is_ascii_alphabetic()
            && value.as_bytes()[1] == b':'
            && matches!(value.as_bytes()[2], b'/' | b'\\'))
}

fn insert_manifest(
    connection: &Connection,
    payload: &ProjectWorkspaceQueuedFollowUpPayloadRef,
    manifest: &PayloadManifest,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT OR IGNORE INTO codex_queued_follow_up_payload_manifests( \
           payload_sha256, schema_version, asset_uri, byte_length \
         ) VALUES (?1, ?2, ?3, ?4)",
        params![
            payload.sha256,
            payload.schema_version,
            payload.asset_uri,
            i64::try_from(payload.byte_length)
                .map_err(|_| resource_exhausted("Queued follow-up manifest is too large"))?,
        ],
    )?;
    let stored = connection.query_row(
        "SELECT schema_version, asset_uri, byte_length \
         FROM codex_queued_follow_up_payload_manifests WHERE payload_sha256 = ?1",
        [&payload.sha256],
        |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )?;
    let stored_length = u64::try_from(stored.2)
        .map_err(|_| corrupt("Queued follow-up payload manifest length is invalid"))?;
    if (stored.0, stored.1, stored_length)
        != (
            payload.schema_version,
            payload.asset_uri.clone(),
            payload.byte_length,
        )
    {
        return Err(corrupt(
            "Queued follow-up payload manifest identity is inconsistent",
        ));
    }
    connection.execute(
        "DELETE FROM codex_queued_follow_up_payload_asset_refs WHERE payload_sha256 = ?1",
        [&payload.sha256],
    )?;
    for (ordinal, reference) in manifest.asset_references.iter().enumerate() {
        connection.execute(
            "INSERT INTO codex_queued_follow_up_payload_asset_refs( \
               payload_sha256, ordinal, asset_uri, sha256, byte_length, mime_type \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                payload.sha256,
                i64::try_from(ordinal).expect("manifest asset count fits SQLite integer"),
                reference.asset_uri,
                reference.sha256,
                i64::try_from(reference.byte_length).map_err(|_| {
                    resource_exhausted("Queued follow-up referenced asset is too large")
                })?,
                reference.mime_type,
            ],
        )?;
    }
    Ok(())
}

fn read_stored_asset_references(
    connection: &Connection,
    payload_sha256: &str,
) -> Result<Vec<PayloadAssetReference>, StoreError> {
    let rows = connection
        .prepare(
            "SELECT ordinal, asset_uri, sha256, byte_length, mime_type \
             FROM codex_queued_follow_up_payload_asset_refs \
             WHERE payload_sha256 = ?1 ORDER BY ordinal",
        )?
        .query_map([payload_sha256], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                PayloadAssetReference {
                    asset_uri: row.get(1)?,
                    sha256: row.get(2)?,
                    mime_type: row.get(4)?,
                    byte_length: u64::try_from(row.get::<_, i64>(3)?).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Integer,
                            Box::new(error),
                        )
                    })?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (expected, (actual, _)) in rows.iter().enumerate() {
        if i64::try_from(expected).ok() != Some(*actual) {
            return Err(corrupt(
                "Stored queued follow-up asset reference ordinals are not contiguous",
            ));
        }
    }
    Ok(rows.into_iter().map(|(_, reference)| reference).collect())
}

fn release_orphaned_manifests(
    connection: &Connection,
    candidates: &BTreeSet<String>,
) -> Result<(), StoreError> {
    for sha in candidates {
        connection.execute(
            "DELETE FROM codex_queued_follow_up_payload_manifests WHERE payload_sha256 = ?1
             AND NOT EXISTS (SELECT 1 FROM codex_queued_follow_up_entries WHERE payload_sha256 = ?1)",
            [sha],
        )?;
    }
    Ok(())
}

fn ledger_hash(entries: &[ProjectWorkspaceQueuedFollowUpEntry]) -> Result<String, StoreError> {
    serde_json::to_vec(entries)
        .map(|encoded| sha256(&encoded))
        .map_err(|_| corrupt("Queued follow-up ledger cannot be encoded"))
}

/// Rebinds ledger identities after v151 payload manifests are rewritten to the
/// content-addressed schema. Entry order and user payloads stay unchanged.
pub(crate) fn refresh_migrated_queued_follow_up_ledgers(
    connection: &Connection,
) -> Result<(), StoreError> {
    let thread_ids = connection
        .prepare("SELECT thread_id FROM codex_queued_follow_up_ledgers ORDER BY thread_id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for thread_id in thread_ids {
        let rows = connection
            .prepare(
                "SELECT entry.position, entry.follow_up_id, entry.client_user_message_id, \
                        entry.created_at_ms, entry.pause_kind, entry.pause_reason, \
                        manifest.schema_version, manifest.asset_uri, manifest.payload_sha256, \
                        manifest.byte_length \
                 FROM codex_queued_follow_up_entries entry \
                 JOIN codex_queued_follow_up_payload_manifests manifest \
                   ON manifest.payload_sha256 = entry.payload_sha256 \
                 WHERE entry.thread_id = ?1 ORDER BY entry.position",
            )?
            .query_map([&thread_id], |row| {
                let pause = match (
                    row.get::<_, Option<String>>(4)?.as_deref(),
                    row.get::<_, Option<String>>(5)?,
                ) {
                    (None, None) => None,
                    (Some("interrupted"), Some(reason)) => {
                        Some(ProjectWorkspaceQueuedFollowUpPause::Interrupted { reason })
                    }
                    (Some("failed"), Some(reason)) => {
                        Some(ProjectWorkspaceQueuedFollowUpPause::Failed { reason })
                    }
                    _ => return Err(rusqlite::Error::InvalidQuery),
                };
                Ok((
                    row.get::<_, i64>(0)?,
                    ProjectWorkspaceQueuedFollowUpEntry {
                        follow_up_id: row.get(1)?,
                        client_user_message_id: row.get(2)?,
                        created_at_ms: row.get(3)?,
                        pause,
                        payload: ProjectWorkspaceQueuedFollowUpPayloadRef {
                            schema_version: row.get::<_, u32>(6)?,
                            asset_uri: row.get(7)?,
                            sha256: row.get(8)?,
                            byte_length: u64::try_from(row.get::<_, i64>(9)?).map_err(|error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    9,
                                    rusqlite::types::Type::Integer,
                                    Box::new(error),
                                )
                            })?,
                        },
                    },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (expected, (position, _)) in rows.iter().enumerate() {
            if i64::try_from(expected).ok() != Some(*position) {
                return Err(corrupt(
                    "Migrated queued follow-up positions are not contiguous",
                ));
            }
        }
        let entries = rows.into_iter().map(|(_, entry)| entry).collect::<Vec<_>>();
        connection.execute(
            "UPDATE codex_queued_follow_up_ledgers SET ledger_hash = ?1 WHERE thread_id = ?2",
            params![ledger_hash(&entries)?, thread_id],
        )?;
    }
    Ok(())
}

fn pause_storage(
    pause: Option<&ProjectWorkspaceQueuedFollowUpPause>,
) -> (Option<&'static str>, Option<&str>) {
    match pause {
        None => (None, None),
        Some(ProjectWorkspaceQueuedFollowUpPause::Interrupted { reason }) => {
            (Some("interrupted"), Some(reason))
        }
        Some(ProjectWorkspaceQueuedFollowUpPause::Failed { reason }) => {
            (Some("failed"), Some(reason))
        }
    }
}

fn queue_manifest_file_name(asset_uri: &str, sha: &str) -> Result<String, StoreError> {
    let file_name = managed_asset_file_name(asset_uri)?;
    if file_name != format!("{sha}.blob") {
        return Err(invalid(
            "Queued follow-up payload manifest URI is not content-addressed",
        ));
    }
    Ok(file_name)
}

fn managed_asset_file_name(asset_uri: &str) -> Result<String, StoreError> {
    let file_name = asset_uri
        .strip_prefix(ASSET_URI_PREFIX)
        .ok_or_else(|| invalid("Queued follow-up payload requires a managed asset URI"))?;
    if !safe_asset_file_name(file_name) {
        return Err(invalid("Queued follow-up managed asset URI is unsafe"));
    }
    Ok(file_name.to_owned())
}

fn safe_asset_file_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= MAX_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn read_manifest_evidence(
    evidence_mode: QueuedAssetEvidenceMode<'_>,
    file_name: &str,
    expected_length: u64,
    expected_hash: &str,
    budget: &mut AssetEvidenceBudget,
    missing: &mut BTreeSet<String>,
) -> Result<Option<Vec<u8>>, StoreError> {
    let Some(assets_root) = evidence_assets_root(evidence_mode) else {
        return Ok(None);
    };
    let path = confined_asset_path(assets_root, file_name)?;
    let Some(metadata) = evidence_metadata(&path, file_name, evidence_mode, missing)? else {
        return Ok(None);
    };
    if metadata.len() != expected_length || metadata.len() > MAX_MANIFEST_BYTES {
        return Err(invalid(
            "Queued follow-up payload manifest evidence has an invalid length",
        ));
    }
    budget.reserve(metadata.len())?;
    let mut file =
        crate::infrastructure::managed_blobs::open(assets_root, file_name, expected_length)?;
    let capacity = usize::try_from(metadata.len())
        .map_err(|_| resource_exhausted("Queued follow-up manifest is too large"))?;
    let mut bytes = Vec::with_capacity(capacity);
    file.read_to_end(&mut bytes)
        .map_err(|error| io_error("Queued follow-up manifest could not be read", error))?;
    if sha256(&bytes) != expected_hash {
        return Err(invalid(
            "Queued follow-up payload manifest evidence does not match its hash",
        ));
    }
    Ok(Some(bytes))
}

fn hash_asset_evidence(
    evidence_mode: QueuedAssetEvidenceMode<'_>,
    file_name: &str,
    maximum_bytes: u64,
    budget: &mut AssetEvidenceBudget,
    missing: &mut BTreeSet<String>,
) -> Result<Option<(u64, String)>, StoreError> {
    let Some(assets_root) = evidence_assets_root(evidence_mode) else {
        return Ok(None);
    };
    let path = confined_asset_path(assets_root, file_name)?;
    let Some(metadata) = evidence_metadata(&path, file_name, evidence_mode, missing)? else {
        return Ok(None);
    };
    if metadata.len() > maximum_bytes {
        return Err(resource_exhausted(
            "Queued follow-up managed asset exceeds its byte bound",
        ));
    }
    budget.reserve(metadata.len())?;
    let mut file =
        crate::infrastructure::managed_blobs::open(assets_root, file_name, metadata.len())?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut chunk)
            .map_err(|error| io_error("Queued follow-up managed asset could not be read", error))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| resource_exhausted("Queued follow-up managed asset is too large"))?;
        if total > maximum_bytes || total > metadata.len() {
            return Err(resource_exhausted(
                "Queued follow-up managed asset changed while it was validated",
            ));
        }
        digest.update(&chunk[..read]);
    }
    Ok(Some((total, format!("{:x}", digest.finalize()))))
}

fn evidence_assets_root(mode: QueuedAssetEvidenceMode<'_>) -> Option<&Path> {
    match mode {
        QueuedAssetEvidenceMode::DatabaseOnly => None,
        QueuedAssetEvidenceMode::RequireFiles(root)
        | QueuedAssetEvidenceMode::AllowMissing(root) => Some(root),
    }
}

fn evidence_metadata(
    path: &Path,
    file_name: &str,
    mode: QueuedAssetEvidenceMode<'_>,
    missing: &mut BTreeSet<String>,
) -> Result<Option<fs::Metadata>, StoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && matches!(mode, QueuedAssetEvidenceMode::AllowMissing(_)) =>
        {
            missing.insert(file_name.to_owned());
            return Ok(None);
        }
        Err(error) => return Err(io_error("Queued follow-up managed asset is missing", error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid(
            "Queued follow-up managed asset is not a regular file",
        ));
    }
    Ok(Some(metadata))
}

fn confined_asset_path(assets_root: &Path, file_name: &str) -> Result<PathBuf, StoreError> {
    if !safe_asset_file_name(file_name) {
        return Err(invalid("Queued follow-up managed asset name is unsafe"));
    }
    Ok(assets_root.join(file_name))
}

fn as_stored_corruption(error: StoreError) -> StoreError {
    if error.code == StoreErrorCode::StoreCorrupt {
        return error;
    }
    corrupt(format!(
        "Stored queued follow-up ledger is invalid: {}",
        error.message
    ))
}

fn validate_id(field: &str, value: &str) -> Result<(), StoreError> {
    if value.trim().is_empty() || value.len() > MAX_ID_BYTES {
        return Err(invalid(format!("{field} is invalid")));
    }
    Ok(())
}

fn validate_sha256(field: &str, value: &str) -> Result<(), StoreError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(invalid(format!("{field} is invalid")));
    }
    Ok(())
}

fn io_error(message: &str, error: std::io::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::InvalidInput,
        format!("{message}: {error}"),
        false,
    )
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message.into(), false)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message.into(), false)
}

fn resource_exhausted(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::ResourceExhausted, message.into(), false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message.into(), false)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use nodex_core_contracts::workspace::{
        ProjectWorkspaceIntent, ProjectWorkspaceQueuedFollowUpEntry,
        ProjectWorkspaceQueuedFollowUpPause, ProjectWorkspaceQueuedFollowUpPayloadRef,
        ProjectWorkspaceRead, ProjectWorkspaceReadValue,
    };
    use nodex_core_contracts::{
        CoreErrorCode, ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION,
    };
    use serde_json::json;

    use super::super::test_support::{context, create_session_thread, read, seeded_workspace};
    use super::*;

    fn prepare_blob(
        workspace: &super::super::test_support::TestWorkspace,
        operation: &str,
        source: &Path,
    ) -> Option<String> {
        let bytes = fs::read(source).ok()?;
        let root = workspace._directory.path().join("assets");
        let mut writer = crate::infrastructure::managed_blobs::BlobWriter::new(
            &root,
            MAX_REFERENCED_ASSET_BYTES,
        )
        .unwrap();
        writer.write_chunk(&bytes).unwrap();
        let blob = writer.finish().unwrap();
        let library =
            crate::library::LibraryModule::new("profile-1", "library-1", &workspace.kernel);
        let expiry = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60_000;
        Some(
            library
                .register_prepared_file_blob(
                    &context(),
                    "epoch-1",
                    operation,
                    &format!("receipt:{operation}:{}", blob.content_hash),
                    &blob.content_hash,
                    &blob.physical_asset_name,
                    blob.byte_length,
                    expiry,
                )
                .unwrap()
                .receipt_id,
        )
    }

    fn request(
        workspace: &super::super::test_support::TestWorkspace,
        operation: &str,
        mut intent: ProjectWorkspaceIntent,
    ) -> nodex_core_contracts::ModuleApplyRequest<ProjectWorkspaceIntent> {
        if let ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
            entries,
            prepared_blob_receipt_ids,
            ..
        } = &mut intent
        {
            let root = workspace._directory.path().join("assets");
            let mut names = BTreeSet::new();
            for entry in entries {
                let Some(name) = entry.payload.asset_uri.strip_prefix(ASSET_URI_PREFIX) else {
                    continue;
                };
                names.insert(name.to_owned());
                let Ok(bytes) = fs::read(root.join(name)) else {
                    continue;
                };
                let Ok(manifest) = serde_json::from_slice::<PayloadManifest>(&bytes) else {
                    continue;
                };
                for reference in manifest.asset_references {
                    if let Ok(name) = managed_asset_file_name(&reference.asset_uri) {
                        names.insert(name);
                    }
                }
            }
            *prepared_blob_receipt_ids = names
                .iter()
                .filter_map(|name| prepare_blob(workspace, operation, &root.join(name)))
                .collect();
        }
        super::super::test_support::request(operation, intent)
    }

    fn apply(
        workspace: &super::super::test_support::TestWorkspace,
        operation: &str,
        intent: ProjectWorkspaceIntent,
    ) {
        workspace
            .module
            .apply(&context(), request(workspace, operation, intent))
            .unwrap();
    }

    fn payload(
        workspace: &super::super::test_support::TestWorkspace,
        label: &str,
        include_attachment: bool,
    ) -> ProjectWorkspaceQueuedFollowUpPayloadRef {
        let assets = workspace._directory.path().join("assets");
        let mut asset_references = Vec::new();
        let prompt_input = if include_attachment {
            let bytes = format!("attachment:{label}").into_bytes();
            let digest = sha256(&bytes);
            let file_name = format!("{digest}.blob");
            fs::write(assets.join(&file_name), &bytes).expect("attachment asset");
            asset_references.push(json!({
                "asset_uri": format!("nodex://assets/{file_name}"),
                "sha256": digest,
                "byte_length": bytes.len(),
                "mime_type": "application/octet-stream",
            }));
            json!({ "items": [{ "source": format!("nodex://assets/{file_name}") }] })
        } else {
            json!({ "items": [] })
        };
        payload_from_manifest(
            workspace,
            json!({
                "schema_version": 2,
                "payload": {
                    "prompt": label,
                    "prompt_input": prompt_input,
                },
                "asset_references": asset_references,
            }),
        )
    }

    fn payload_from_manifest(
        workspace: &super::super::test_support::TestWorkspace,
        value: Value,
    ) -> ProjectWorkspaceQueuedFollowUpPayloadRef {
        let manifest = serde_json::to_vec(&value).expect("manifest JSON");
        let digest = sha256(&manifest);
        let file_name = format!("{digest}.blob");
        fs::write(
            workspace._directory.path().join("assets").join(&file_name),
            &manifest,
        )
        .expect("payload manifest");
        ProjectWorkspaceQueuedFollowUpPayloadRef {
            schema_version: 2,
            asset_uri: format!("nodex://assets/{file_name}"),
            sha256: digest,
            byte_length: manifest.len() as u64,
        }
    }

    fn entry(
        workspace: &super::super::test_support::TestWorkspace,
        label: &str,
        include_attachment: bool,
    ) -> ProjectWorkspaceQueuedFollowUpEntry {
        ProjectWorkspaceQueuedFollowUpEntry {
            follow_up_id: format!("follow-up:{label}"),
            client_user_message_id: format!("message:{label}"),
            created_at_ms: 1,
            pause: None,
            payload: payload(workspace, label, include_attachment),
        }
    }

    fn seeded_thread() -> super::super::test_support::TestWorkspace {
        let workspace = seeded_workspace();
        create_session_thread(
            &workspace.module,
            "queue",
            "session:queue",
            "thread:queue",
            Some("project:default"),
            1,
        );
        workspace
    }

    fn ledger(
        workspace: &super::super::test_support::TestWorkspace,
    ) -> ProjectWorkspaceQueuedFollowUpLedger {
        let ProjectWorkspaceReadValue::QueuedFollowUpLedger { ledger } = read(
            &workspace.module,
            ProjectWorkspaceRead::QueuedFollowUpLedger {
                thread_id: "thread:queue".to_owned(),
            },
        ) else {
            panic!("queued follow-up ledger")
        };
        ledger
    }

    #[test]
    fn queued_follow_up_ledger_commits_ordered_rows_and_replays_exactly() {
        let workspace = seeded_thread();
        let first = entry(&workspace, "first", true);
        let mut second = entry(&workspace, "second", false);
        second.pause = Some(ProjectWorkspaceQueuedFollowUpPause::Failed {
            reason: "delivery failed".to_owned(),
        });
        assert_eq!(ledger(&workspace).revision, 0);

        let intent = ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
            prepared_blob_receipt_ids: Vec::new(),
            thread_id: "thread:queue".to_owned(),
            expected_revision: 0,
            entries: vec![second.clone(), first.clone()],
        };
        let committed = workspace
            .module
            .apply(
                &context(),
                request(&workspace, "queue-commit", intent.clone()),
            )
            .expect("queue commit");
        let queue_commit = committed
            .committed
            .value
            .queued_follow_up_ledger
            .as_ref()
            .expect("queue commit value");
        assert_eq!(queue_commit.revision, 1);
        assert!(queue_commit.changed);
        assert_eq!(
            ledger(&workspace).entries,
            vec![second.clone(), first.clone()]
        );

        let replay = workspace
            .module
            .apply(&context(), request(&workspace, "queue-commit", intent))
            .expect("exact replay");
        assert!(replay.committed.receipt.mutation.duplicate);
        assert_eq!(replay.committed.value, committed.committed.value);

        let no_op = workspace
            .module
            .apply(
                &context(),
                request(
                    &workspace,
                    "queue-no-op",
                    ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                        prepared_blob_receipt_ids: Vec::new(),
                        thread_id: "thread:queue".to_owned(),
                        expected_revision: 1,
                        entries: vec![second, first],
                    },
                ),
            )
            .expect("byte-identical no-op");
        let no_op_value = no_op
            .committed
            .value
            .queued_follow_up_ledger
            .expect("queue no-op value");
        assert_eq!(no_op_value.revision, 1);
        assert!(!no_op_value.changed);
        assert!(no_op.event.is_none());
    }

    #[test]
    fn queued_follow_up_publication_requires_matching_receipts_and_thread_authority() {
        let workspace = seeded_thread();
        let row = entry(&workspace, "authorized", true);
        let prepared = request(
            &workspace,
            "queue-publication",
            ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                thread_id: "thread:queue".to_owned(),
                expected_revision: 0,
                entries: vec![row],
                prepared_blob_receipt_ids: Vec::new(),
            },
        );
        let mut wrong_operation = prepared.clone();
        wrong_operation.operation_id = "queue-wrong-operation".to_owned();
        assert_eq!(
            workspace
                .module
                .apply(&context(), wrong_operation)
                .unwrap_err()
                .code,
            CoreErrorCode::NotFound
        );
        let mut no_receipts = prepared.clone();
        if let ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
            prepared_blob_receipt_ids,
            ..
        } = &mut no_receipts.intent
        {
            prepared_blob_receipt_ids.clear();
        }
        assert_eq!(
            workspace
                .module
                .apply(&context(), no_receipts)
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        let mut outsider = context();
        outsider.project_id = Some(nodex_core_contracts::ProjectId("other-project".to_owned()));
        assert_eq!(
            workspace
                .module
                .apply(&outsider, prepared.clone())
                .unwrap_err()
                .code,
            CoreErrorCode::Unauthorized
        );
        assert_eq!(ledger(&workspace).revision, 0);
        workspace.module.apply(&context(), prepared).unwrap();
        let read = ModuleReadRequest {
            contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
            read: ProjectWorkspaceRead::QueuedFollowUpLedger {
                thread_id: "thread:queue".to_owned(),
            },
        };
        assert_eq!(
            workspace.module.read(&outsider, read).unwrap_err().code,
            CoreErrorCode::Unauthorized
        );
        let retained = ledger(&workspace);
        workspace
            .module
            .apply(
                &context(),
                super::super::test_support::request(
                    "queue-retained-reorder",
                    ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                        thread_id: "thread:queue".to_owned(),
                        expected_revision: 1,
                        entries: retained
                            .entries
                            .into_iter()
                            .map(|mut entry| {
                                entry.pause = Some(ProjectWorkspaceQueuedFollowUpPause::Failed {
                                    reason: "Retry later".to_owned(),
                                });
                                entry
                            })
                            .collect(),
                        prepared_blob_receipt_ids: Vec::new(),
                    },
                ),
            )
            .unwrap();
        assert_eq!(ledger(&workspace).revision, 2);
    }

    #[test]
    fn queued_follow_up_ledger_rejects_stale_revision_and_invalid_bounds() {
        let workspace = seeded_thread();
        let row = entry(&workspace, "row", false);
        apply(
            &workspace,
            "queue-initial",
            ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                prepared_blob_receipt_ids: Vec::new(),
                thread_id: "thread:queue".to_owned(),
                expected_revision: 0,
                entries: vec![row.clone()],
            },
        );
        let stale = workspace
            .module
            .apply(
                &context(),
                request(
                    &workspace,
                    "queue-stale",
                    ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                        prepared_blob_receipt_ids: Vec::new(),
                        thread_id: "thread:queue".to_owned(),
                        expected_revision: 0,
                        entries: Vec::new(),
                    },
                ),
            )
            .expect_err("stale queue revision");
        assert_eq!(stale.code, CoreErrorCode::RevisionConflict);

        let too_many = workspace
            .module
            .apply(
                &context(),
                request(
                    &workspace,
                    "queue-too-many",
                    ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                        prepared_blob_receipt_ids: Vec::new(),
                        thread_id: "thread:queue".to_owned(),
                        expected_revision: 1,
                        entries: (0..=MAX_QUEUED_FOLLOW_UP_ENTRIES)
                            .map(|index| ProjectWorkspaceQueuedFollowUpEntry {
                                follow_up_id: format!("follow-up:{index}"),
                                client_user_message_id: format!("message:{index}"),
                                ..row.clone()
                            })
                            .collect(),
                    },
                ),
            )
            .expect_err("queue count bound");
        assert_eq!(too_many.code, CoreErrorCode::ResourceExhausted);

        let mut oversized = (0..200)
            .map(|index| ProjectWorkspaceQueuedFollowUpEntry {
                follow_up_id: format!("follow-up:metadata:{index}"),
                client_user_message_id: format!("message:metadata:{index}"),
                pause: Some(ProjectWorkspaceQueuedFollowUpPause::Failed {
                    reason: "x".repeat(MAX_PAUSE_REASON_BYTES),
                }),
                ..row.clone()
            })
            .collect::<Vec<_>>();
        assert!(
            serde_json::to_vec(&oversized)
                .expect("oversized metadata")
                .len()
                > MAX_QUEUED_FOLLOW_UP_LEDGER_METADATA_BYTES
        );
        let oversized_error = workspace
            .module
            .apply(
                &context(),
                request(
                    &workspace,
                    "queue-metadata-too-large",
                    ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                        prepared_blob_receipt_ids: Vec::new(),
                        thread_id: "thread:queue".to_owned(),
                        expected_revision: 1,
                        entries: std::mem::take(&mut oversized),
                    },
                ),
            )
            .expect_err("queue metadata bound");
        assert_eq!(oversized_error.code, CoreErrorCode::ResourceExhausted);
    }

    #[test]
    fn queued_follow_up_release_preserves_thread_owned_bytes() {
        let workspace = seeded_thread();
        let row = entry(&workspace, "asset", true);
        let manifest_name = row
            .payload
            .asset_uri
            .strip_prefix(ASSET_URI_PREFIX)
            .expect("manifest URI")
            .to_owned();
        let attachment = workspace
            ._directory
            .path()
            .join("assets")
            .join(format!("{}.blob", sha256(b"attachment:asset")));
        apply(
            &workspace,
            "queue-with-asset",
            ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                prepared_blob_receipt_ids: Vec::new(),
                thread_id: "thread:queue".to_owned(),
                expected_revision: 0,
                entries: vec![row],
            },
        );
        let receipt = prepare_blob(&workspace, "retain-queued-input", &attachment).unwrap();
        apply(
            &workspace,
            "retain-queued-input",
            ProjectWorkspaceIntent::RetainThreadAssets {
                thread_id: "thread:queue".to_owned(),
                prepared_blob_receipt_ids: vec![receipt],
            },
        );
        let retained = workspace
            .module
            .resolve_thread_asset_blob(&context(), "thread:queue", &sha256(b"attachment:asset"))
            .unwrap();
        assert_eq!(retained.byte_length, b"attachment:asset".len() as u64);
        apply(
            &workspace,
            "queue-clear",
            ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                prepared_blob_receipt_ids: Vec::new(),
                thread_id: "thread:queue".to_owned(),
                expected_revision: 1,
                entries: Vec::new(),
            },
        );
        assert!(
            !workspace
                ._directory
                .path()
                .join("assets")
                .join(manifest_name)
                .exists()
        );
        assert!(attachment.exists(), "Thread input survives queue removal");
        assert_eq!(ledger(&workspace).revision, 2);
        assert!(ledger(&workspace).entries.is_empty());
        apply(
            &workspace,
            "release-input",
            ProjectWorkspaceIntent::DeleteThread {
                thread_id: "thread:queue".to_owned(),
            },
        );
        assert!(
            !attachment.exists(),
            "last owner release allows shared Blob collection"
        );
    }

    #[test]
    fn queued_follow_up_manifest_evidence_must_match_the_managed_file() {
        let workspace = seeded_thread();
        let mut row = entry(&workspace, "tampered", false);
        row.payload.sha256 = "0".repeat(64);
        row.payload.asset_uri = format!("nodex://assets/{}.blob", row.payload.sha256);
        let error = workspace
            .module
            .apply(
                &context(),
                request(
                    &workspace,
                    "queue-tampered-manifest",
                    ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                        prepared_blob_receipt_ids: Vec::new(),
                        thread_id: "thread:queue".to_owned(),
                        expected_revision: 0,
                        entries: vec![row],
                    },
                ),
            )
            .expect_err("tampered manifest evidence");
        assert_eq!(error.code, CoreErrorCode::InvalidInput);
        assert_eq!(ledger(&workspace).revision, 0);
    }

    #[test]
    fn queued_follow_up_manifest_rejects_nonportable_payload_locators() {
        for (index, locator) in [
            "blob:temporary",
            "file:///Users/example/image.png",
            "/Users/example/image.png",
            r"C:\Users\example\image.png",
            r"\\server\share\image.png",
        ]
        .into_iter()
        .enumerate()
        {
            let workspace = seeded_thread();
            let payload = payload_from_manifest(
                &workspace,
                json!({
                    "schema_version": 2,
                    "payload": {
                        "prompt": "portable",
                        "prompt_input": {"items": [{"source": locator}]},
                    },
                    "asset_references": [],
                }),
            );
            let error = workspace
                .module
                .apply(
                    &context(),
                    request(
                        &workspace,
                        &format!("queue-nonportable-{index}"),
                        ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                            prepared_blob_receipt_ids: Vec::new(),
                            thread_id: "thread:queue".to_owned(),
                            expected_revision: 0,
                            entries: vec![ProjectWorkspaceQueuedFollowUpEntry {
                                follow_up_id: "follow-up:portable".to_owned(),
                                client_user_message_id: "message:portable".to_owned(),
                                created_at_ms: 1,
                                pause: None,
                                payload,
                            }],
                        },
                    ),
                )
                .expect_err("local-only locator");
            assert_eq!(error.code, CoreErrorCode::InvalidInput);
            assert_eq!(ledger(&workspace).revision, 0);
        }
    }

    #[test]
    fn queued_follow_up_manifest_rejects_total_reference_evidence_over_budget() {
        let workspace = seeded_thread();
        let references = [MAX_REFERENCED_ASSET_BYTES, MAX_REFERENCED_ASSET_BYTES, 1]
            .into_iter()
            .enumerate()
            .map(|(index, byte_length)| {
                json!({
                    "asset_uri": format!("nodex://assets/oversized-{index}.bin"),
                    "sha256": "0".repeat(64),
                    "byte_length": byte_length,
                    "mime_type": "application/octet-stream",
                })
            })
            .collect::<Vec<_>>();
        let sources = (0..3)
            .map(|index| json!({"source": format!("nodex://assets/oversized-{index}.bin")}))
            .collect::<Vec<_>>();
        let payload = payload_from_manifest(
            &workspace,
            json!({
                "schema_version": 2,
                "payload": {"prompt": "bounded", "prompt_input": {"items": sources}},
                "asset_references": references,
            }),
        );
        let error = workspace
            .module
            .apply(
                &context(),
                request(
                    &workspace,
                    "queue-total-reference-budget",
                    ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                        prepared_blob_receipt_ids: Vec::new(),
                        thread_id: "thread:queue".to_owned(),
                        expected_revision: 0,
                        entries: vec![ProjectWorkspaceQueuedFollowUpEntry {
                            follow_up_id: "follow-up:bounded".to_owned(),
                            client_user_message_id: "message:bounded".to_owned(),
                            created_at_ms: 1,
                            pause: None,
                            payload,
                        }],
                    },
                ),
            )
            .expect_err("total evidence budget");
        assert_eq!(error.code, CoreErrorCode::ResourceExhausted);
    }

    #[test]
    fn queued_follow_up_reads_revalidate_stored_nested_reference_semantics() {
        let workspace = seeded_thread();
        apply(
            &workspace,
            "queue-deep-validation",
            ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                prepared_blob_receipt_ids: Vec::new(),
                thread_id: "thread:queue".to_owned(),
                expected_revision: 0,
                entries: vec![entry(&workspace, "deep", true)],
            },
        );
        workspace
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE codex_queued_follow_up_payload_asset_refs SET byte_length = byte_length + 1",
                    [],
                )?;
                Ok(())
            })
            .expect("corrupt stored reference");
        let semantic_error = workspace
            .kernel
            .writer()
            .call(|connection| {
                crate::infrastructure::store_validation::validate_store_semantics(connection)
            })
            .expect_err("deep Store validation rejects the stored reference");
        assert_eq!(semantic_error.code, StoreErrorCode::StoreCorrupt);
        let error = workspace
            .module
            .read(
                &context(),
                ModuleReadRequest {
                    contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::QueuedFollowUpLedger {
                        thread_id: "thread:queue".to_owned(),
                    },
                },
            )
            .expect_err("stored reference validation");
        assert_eq!(error.code, CoreErrorCode::StoreCorrupt);
    }

    #[test]
    fn queued_follow_up_ledger_cascades_with_thread_deletion() {
        let workspace = seeded_thread();
        let row = entry(&workspace, "delete", false);
        let manifest_name = row
            .payload
            .asset_uri
            .strip_prefix(ASSET_URI_PREFIX)
            .expect("manifest URI")
            .to_owned();
        apply(
            &workspace,
            "queue-before-delete",
            ProjectWorkspaceIntent::CommitQueuedFollowUpLedger {
                prepared_blob_receipt_ids: Vec::new(),
                thread_id: "thread:queue".to_owned(),
                expected_revision: 0,
                entries: vec![row],
            },
        );
        apply(
            &workspace,
            "delete-queue-thread",
            ProjectWorkspaceIntent::DeleteThread {
                thread_id: "thread:queue".to_owned(),
            },
        );
        let counts = workspace
            .kernel
            .writer()
            .call(|connection| {
                Ok((
                    connection.query_row(
                        "SELECT count(*) FROM codex_queued_follow_up_ledgers",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    connection.query_row(
                        "SELECT count(*) FROM codex_queued_follow_up_entries",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                ))
            })
            .expect("queue rows after Thread delete");
        assert_eq!(counts, (0, 0));
        let root = workspace._directory.path().join("assets");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while root.join(&manifest_name).exists() {
            workspace
                .kernel
                .writer()
                .call({
                    let root = root.clone();
                    move |connection| {
                        crate::infrastructure::managed_blob_gc::collect(connection, &root, 100)
                    }
                })
                .unwrap();
            assert!(
                std::time::Instant::now() < deadline,
                "Thread deletion releases its manifest Blob"
            );
            std::thread::yield_now();
        }
    }
}
