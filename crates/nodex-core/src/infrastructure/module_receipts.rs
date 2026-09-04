use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

use super::local_commit::{self, CommitContext};
use super::sqlite::{StoreError, StoreErrorCode};

const MAX_RECEIPT_JSON_BYTES: usize = 1024 * 1024;
pub(crate) const RECEIPT_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const MAX_OPERATION_CLOCK_SKEW_MS: i64 = 5 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OperationIdentityWindow {
    issued_at_ms: i64,
    expires_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredModuleReceipt {
    pub profile_id: String,
    pub project_id: Option<String>,
    pub store_epoch: String,
    pub request_hash: String,
    pub result: Value,
    pub event_sequence: Option<i64>,
    pub local_commit_seq: Option<i64>,
    pub commit_manifest_hash: Option<String>,
    pub committed_at: String,
    pub detached: bool,
}

pub(crate) struct NewModuleReceipt<'a> {
    pub(crate) module_name: &'a str,
    pub(crate) operation_id: &'a str,
    pub(crate) context: &'a BoundModuleContext,
    pub(crate) operation_kind: &'a str,
    pub(crate) store_epoch: &'a str,
    pub(crate) request_hash: &'a str,
    pub(crate) result: &'a Value,
    pub(crate) event_sequence: Option<i64>,
    pub(crate) local_commit: Option<&'a CommitContext>,
    pub(crate) committed_at: &'a str,
}

/// The authority fields that may participate in a durable idempotency
/// fingerprint. A physical connection authenticates a request, but it is not
/// part of the request's semantic identity and must never make a committed
/// operation unreplayable after reconnecting.
#[derive(Serialize)]
pub struct DurableModuleContext<'a> {
    profile_id: &'a str,
    library_id: &'a str,
    project_id: Option<&'a str>,
    adapter: &'static str,
}

impl<'a> From<&'a BoundModuleContext> for DurableModuleContext<'a> {
    fn from(context: &'a BoundModuleContext) -> Self {
        Self {
            profile_id: &context.profile_id.0,
            library_id: &context.library_id.0,
            project_id: context.project_id.as_ref().map(|id| id.0.as_str()),
            adapter: adapter_kind(&context.adapter),
        }
    }
}

pub fn read_module_receipt(
    connection: &Connection,
    module_name: &str,
    operation_id: &str,
) -> Result<Option<StoredModuleReceipt>, StoreError> {
    let raw = connection
        .query_row(
            "SELECT profile_id, project_id, store_epoch, request_hash, result_json, \
                    event_sequence, local_commit_seq, commit_manifest_hash, committed_at, detached \
             FROM ( \
               SELECT profile_id, project_id, store_epoch, request_hash, result_json, \
                      event_sequence, local_commit_seq, NULL AS commit_manifest_hash, \
                      committed_at, 0 AS detached \
                 FROM core_module_receipts WHERE module_name = ?1 AND operation_id = ?2 \
               UNION ALL \
               SELECT profile_id, project_id, store_epoch, request_hash, result_json, \
                      event_sequence, local_commit_seq, commit_manifest_hash, committed_at, \
                      1 AS detached \
                 FROM detached_module_receipts WHERE module_name = ?1 AND operation_id = ?2 \
             ) ORDER BY detached LIMIT 1",
            params![module_name, operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, bool>(9)?,
                ))
            },
        )
        .optional()
        .map_err(|_| corrupt("Core Module receipt column types are invalid"))?;
    let Some((
        profile_id,
        project_id,
        store_epoch,
        request_hash,
        result_json,
        event_sequence,
        local_commit_seq,
        commit_manifest_hash,
        committed_at,
        detached,
    )) = raw
    else {
        let foreign_module = connection
            .query_row(
                "SELECT module_name FROM ( \
                   SELECT module_name FROM core_module_receipts WHERE operation_id = ?1 \
                   UNION ALL \
                   SELECT module_name FROM detached_module_receipts WHERE operation_id = ?1 \
                 ) WHERE module_name <> ?2 ORDER BY module_name LIMIT 1",
                params![operation_id, module_name],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| corrupt("Core Module receipt identity is invalid"))?;
        if foreign_module.is_some() {
            return Err(StoreError::new(
                StoreErrorCode::IdempotencyKeyReused,
                "operation_id is already bound to another Module",
                false,
            ));
        }
        validate_missing_operation_identity(connection, module_name, operation_id)?;
        return Ok(None);
    };
    if profile_id.is_empty() || store_epoch.is_empty() {
        return Err(corrupt("Core Module receipt authority identity is invalid"));
    }
    if !is_sha256(&request_hash) {
        return Err(corrupt("Core Module receipt request hash is invalid"));
    }
    if result_json.len() > MAX_RECEIPT_JSON_BYTES {
        return Err(corrupt("Core Module receipt result exceeds its bound"));
    }
    let result = serde_json::from_str::<Value>(&result_json)
        .map_err(|_| corrupt("Core Module receipt result JSON is invalid"))?;
    if !result.is_object() {
        return Err(corrupt("Core Module receipt result must be an object"));
    }
    if event_sequence.is_some_and(|sequence| sequence < 1) {
        return Err(corrupt("Core Module receipt event sequence is invalid"));
    }
    if local_commit_seq.is_some_and(|sequence| sequence < 1) {
        return Err(corrupt(
            "Core Module receipt local commit sequence is invalid",
        ));
    }
    if detached != commit_manifest_hash.is_some()
        || (detached && local_commit_seq.is_none())
        || commit_manifest_hash
            .as_deref()
            .is_some_and(|hash| !is_sha256(hash))
    {
        return Err(corrupt("Core Module receipt commit identity is invalid"));
    }
    if committed_at.is_empty() || committed_at.len() > 64 {
        return Err(corrupt("Core Module receipt timestamp is invalid"));
    }
    if let Some(commit_seq) = local_commit_seq {
        let commit_identity = connection
            .query_row(
                "SELECT store_epoch, canonical_hash FROM local_commits WHERE commit_seq = ?1",
                [commit_seq],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|_| corrupt("Core Module receipt local commit reference is invalid"))?;
        if (!detached && commit_identity.is_none())
            || commit_identity
                .as_ref()
                .is_some_and(|(commit_epoch, canonical_hash)| {
                    commit_epoch != &store_epoch
                        || (detached
                            && Some(canonical_hash.as_str()) != commit_manifest_hash.as_deref())
                })
        {
            return Err(corrupt(
                "Core Module receipt local commit identity diverges",
            ));
        }
    }
    Ok(Some(StoredModuleReceipt {
        profile_id,
        project_id,
        store_epoch,
        request_hash,
        result,
        event_sequence,
        local_commit_seq,
        commit_manifest_hash,
        committed_at,
        detached,
    }))
}

pub(crate) fn insert_module_receipt(
    connection: &Connection,
    receipt: NewModuleReceipt<'_>,
) -> Result<(), StoreError> {
    // The LocalCommit ledger is the durable source for the full event/update
    // envelope. Receipts retain only the replayable module result and cursor;
    // storing the envelope here would duplicate Yjs updates and make an
    // otherwise valid large document mutation exceed the receipt bound.
    let mut compact_result = receipt.result.clone();
    if let Some(object) = compact_result.as_object_mut() {
        object.insert("local_commit".to_owned(), Value::Null);
    }
    let result_json = serde_json::to_string(&compact_result).map_err(|_| {
        StoreError::new(
            StoreErrorCode::Internal,
            "Core Module receipt result could not be encoded",
            false,
        )
    })?;
    if result_json.len() > MAX_RECEIPT_JSON_BYTES {
        return Err(StoreError::new(
            StoreErrorCode::Internal,
            "Core Module receipt result exceeds its bound",
            false,
        ));
    }
    let cutover_ms = operation_identity_cutover_ms(connection)?;
    let (issued_at_ms, expires_at_ms, receipt_bytes) = receipt_retention_values(
        cutover_ms,
        receipt.operation_id,
        receipt.committed_at,
        receipt.module_name,
        receipt.context.profile_id.0.as_str(),
        receipt.context.project_id.as_ref().map(|id| id.0.as_str()),
        adapter_kind(&receipt.context.adapter),
        receipt.operation_kind,
        receipt.store_epoch,
        receipt.request_hash,
        &result_json,
    )?;
    super::operational_journal::ensure_capacity_for_receipt(connection, receipt_bytes)?;
    let local_commit_seq = receipt.local_commit.map(CommitContext::commit_seq);
    connection.execute(
        "INSERT INTO core_module_receipts (\
           module_name, operation_id, profile_id, project_id, adapter_kind, operation_kind, \
           store_epoch, request_hash, result_json, event_sequence, local_commit_seq, committed_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            receipt.module_name,
            receipt.operation_id,
            receipt.context.profile_id.0.as_str(),
            receipt.context.project_id.as_ref().map(|id| id.0.as_str()),
            adapter_kind(&receipt.context.adapter),
            receipt.operation_kind,
            receipt.store_epoch,
            receipt.request_hash,
            result_json,
            receipt.event_sequence,
            local_commit_seq,
            receipt.committed_at,
        ],
    )?;
    connection.execute(
        "INSERT INTO module_receipt_retention_metadata( \
           module_name, operation_id, issued_at_ms, expires_at_ms, receipt_bytes \
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            receipt.module_name,
            receipt.operation_id,
            issued_at_ms,
            expires_at_ms,
            receipt_bytes,
        ],
    )?;
    let updated_at = super::operational_journal::timestamp_from_ms(
        chrono::DateTime::parse_from_rfc3339(receipt.committed_at)
            .map_err(|_| corrupt("Core Module receipt timestamp is invalid"))?
            .timestamp_millis(),
    )?;
    let changed = connection.execute(
        "UPDATE operational_journal_state \
         SET retained_receipt_count = retained_receipt_count + 1, \
             retained_receipt_bytes = retained_receipt_bytes + ?1, updated_at = ?2 \
         WHERE id = 1",
        params![receipt_bytes, updated_at],
    )?;
    if changed != 1 {
        return Err(corrupt(
            "Operational Journal receipt accounting is unavailable",
        ));
    }
    super::operational_journal::refresh_receipt_pressure(connection)?;
    if let Some(context) = receipt.local_commit {
        let module = parse_module_name(receipt.module_name)?;
        let result_hash = sha256(result_json.as_bytes());
        local_commit::record_receipt(
            connection,
            context,
            &nodex_core_contracts::LocalCommitReceiptRef {
                module,
                operation_id: receipt.operation_id.to_owned(),
                result_hash,
            },
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn receipt_retention_values(
    operation_identity_cutover_ms: i64,
    operation_id: &str,
    committed_at: &str,
    module_name: &str,
    profile_id: &str,
    project_id: Option<&str>,
    adapter_kind: &str,
    operation_kind: &str,
    store_epoch: &str,
    request_hash: &str,
    result_json: &str,
) -> Result<(i64, i64, i64), StoreError> {
    let committed_at_ms = chrono::DateTime::parse_from_rfc3339(committed_at)
        .map_err(|_| corrupt("Core Module receipt timestamp is invalid"))?
        .timestamp_millis();
    let identity = match operation_identity_window(operation_id)? {
        Some(identity) => identity,
        None => {
            OperationIdentityWindow {
                issued_at_ms: committed_at_ms,
                // Existing legacy callers remain exactly replayable throughout one
                // complete bounded-ID window. Retention may only remove their
                // receipts after every upgraded producer has had that overlap.
                expires_at_ms: committed_at_ms
                    .checked_add(RECEIPT_RETENTION_MS)
                    .and_then(|expiry| {
                        operation_identity_cutover_ms
                            .checked_add(RECEIPT_RETENTION_MS)
                            .map(|cutover_expiry| expiry.max(cutover_expiry))
                    })
                    .ok_or_else(|| corrupt("Core Module receipt expiry overflowed"))?,
            }
        }
    };
    let string_bytes = [
        module_name.len(),
        operation_id.len(),
        profile_id.len(),
        project_id.map_or(0, str::len),
        adapter_kind.len(),
        operation_kind.len(),
        store_epoch.len(),
        request_hash.len(),
        result_json.len(),
        committed_at.len(),
    ]
    .into_iter()
    .try_fold(0usize, |total, value| total.checked_add(value))
    .ok_or_else(|| corrupt("Core Module receipt size overflowed"))?;
    let receipt_bytes = i64::try_from(string_bytes)
        .map_err(|_| corrupt("Core Module receipt size exceeds SQLite bounds"))?;
    Ok((identity.issued_at_ms, identity.expires_at_ms, receipt_bytes))
}

fn operation_identity_window(
    operation_id: &str,
) -> Result<Option<OperationIdentityWindow>, StoreError> {
    if let Some(encoded) = operation_id.strip_prefix("nodexop:v1:") {
        let mut parts = encoded.split(':');
        let issued_at_ms = parts.next().and_then(|value| value.parse::<i64>().ok());
        let expires_at_ms = parts.next().and_then(|value| value.parse::<i64>().ok());
        let scope = parts.next();
        let entropy = parts.next();
        let exact_expiry = issued_at_ms.and_then(|issued| issued.checked_add(RECEIPT_RETENTION_MS));
        if parts.next().is_some()
            || issued_at_ms.is_none()
            || expires_at_ms.is_none()
            || expires_at_ms != exact_expiry
            || scope.is_none_or(str::is_empty)
            || entropy.is_none_or(str::is_empty)
        {
            return Err(invalid_operation_identity());
        }
        return Ok(Some(OperationIdentityWindow {
            issued_at_ms: issued_at_ms.expect("validated operation issue time"),
            expires_at_ms: expires_at_ms.expect("validated operation expiry"),
        }));
    }
    let issued_at_ms = if let Some(encoded) = operation_id.strip_prefix("cli-") {
        encoded
            .split('-')
            .next()
            .and_then(|value| value.parse().ok())
    } else {
        operation_id.split(':').rev().find_map(uuid_v7_timestamp)
    };
    let Some(issued_at_ms) = issued_at_ms else {
        return Ok(None);
    };
    let expires_at_ms = issued_at_ms
        .checked_add(RECEIPT_RETENTION_MS)
        .ok_or_else(invalid_operation_identity)?;
    Ok(Some(OperationIdentityWindow {
        issued_at_ms,
        expires_at_ms,
    }))
}

fn uuid_v7_timestamp(candidate: &str) -> Option<i64> {
    let compact = candidate.replace('-', "");
    if compact.len() != 32
        || !compact.as_bytes().iter().all(u8::is_ascii_hexdigit)
        || compact.as_bytes().get(12).copied() != Some(b'7')
        || !matches!(
            compact.as_bytes().get(16).copied(),
            Some(b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        )
    {
        return None;
    }
    i64::from_str_radix(&compact[..12], 16).ok()
}

fn validate_missing_operation_identity(
    connection: &Connection,
    module_name: &str,
    operation_id: &str,
) -> Result<(), StoreError> {
    let (receipt_floor, cutover_ms, now_ms) = connection.query_row(
        "SELECT CAST(unixepoch(receipt_floor_at, 'subsec') * 1000 AS INTEGER), \
                receipt_floor_module, receipt_floor_operation_id, \
                CAST(unixepoch(operation_identity_cutover_at, 'subsec') * 1000 AS INTEGER), \
                CAST(unixepoch('subsec') * 1000 AS INTEGER) \
         FROM operational_journal_state WHERE id = 1",
        [],
        |row| {
            let floor_ms = row.get::<_, Option<i64>>(0)?;
            let floor_module = row.get::<_, Option<String>>(1)?;
            let floor_operation_id = row.get::<_, Option<String>>(2)?;
            let floor = match (floor_ms, floor_module, floor_operation_id) {
                (Some(at), Some(module), Some(operation)) => Some((at, module, operation)),
                (None, None, None) => None,
                _ => return Err(rusqlite::Error::InvalidQuery),
            };
            Ok((floor, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?))
        },
    )?;
    let Some(identity) = operation_identity_window(operation_id)? else {
        if now_ms < cutover_ms.saturating_add(RECEIPT_RETENTION_MS) {
            return Ok(());
        }
        return Err(StoreError::new(
            StoreErrorCode::LegacyIdempotencyUnavailable,
            "This legacy operation identity is outside Core's retained idempotency history; issue a new bounded operation",
            false,
        ));
    };
    if identity.issued_at_ms > now_ms.saturating_add(MAX_OPERATION_CLOCK_SKEW_MS) {
        return Err(invalid_operation_identity());
    }
    let at_or_below_floor =
        receipt_floor.is_some_and(|(floor_ms, floor_module, floor_operation)| {
            (identity.issued_at_ms, module_name, operation_id)
                <= (floor_ms, floor_module.as_str(), floor_operation.as_str())
        });
    if identity.expires_at_ms <= now_ms || at_or_below_floor {
        return Err(StoreError::new(
            StoreErrorCode::IdempotencyWindowExpired,
            "This operation is outside Core's retained idempotency window; do not replay it implicitly",
            false,
        ));
    }
    Ok(())
}

fn operation_identity_cutover_ms(connection: &Connection) -> Result<i64, StoreError> {
    connection
        .query_row(
            "SELECT CAST(unixepoch(operation_identity_cutover_at, 'subsec') * 1000 AS INTEGER) \
             FROM operational_journal_state WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(StoreError::from)
}

fn invalid_operation_identity() -> StoreError {
    StoreError::new(
        StoreErrorCode::InvalidInput,
        "operation_id has an invalid bounded identity",
        false,
    )
}

fn parse_module_name(value: &str) -> Result<nodex_core_contracts::ModuleName, StoreError> {
    use nodex_core_contracts::ModuleName;
    match value {
        "library" => Ok(ModuleName::Library),
        "database" => Ok(ModuleName::Database),
        "owned_document" => Ok(ModuleName::OwnedDocument),
        "project_workspace" => Ok(ModuleName::ProjectWorkspace),
        "automation" => Ok(ModuleName::Automation),
        "store_administration" => Ok(ModuleName::StoreAdministration),
        _ => Err(corrupt("Core Module receipt Module identity is invalid")),
    }
}

fn sha256(value: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(value))
}

fn adapter_kind(kind: &AdapterKind) -> &'static str {
    match kind {
        AdapterKind::ElectronHost => "electron_host",
        AdapterKind::LoopbackHttp => "loopback_http",
        AdapterKind::NativeCli => "native_cli",
        AdapterKind::Agent => "agent",
        AdapterKind::Test => "test",
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use nodex_core_contracts::{LibraryId, ProfileId, ProjectId};

    use super::*;
    use crate::infrastructure::migration::prepare_test_current_store;
    use crate::infrastructure::sqlite::open_writer;

    fn context(connection_id: &str, adapter: AdapterKind) -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project-1".to_owned())),
            connection_id: connection_id.to_owned(),
            adapter,
        }
    }

    #[test]
    fn durable_context_ignores_physical_connections_but_retains_authority() {
        let first = serde_json::to_vec(&DurableModuleContext::from(&context(
            "connection-1",
            AdapterKind::ElectronHost,
        )))
        .expect("durable context");
        let reconnected = serde_json::to_vec(&DurableModuleContext::from(&context(
            "connection-2",
            AdapterKind::ElectronHost,
        )))
        .expect("reconnected durable context");
        let another_adapter = serde_json::to_vec(&DurableModuleContext::from(&context(
            "connection-2",
            AdapterKind::NativeCli,
        )))
        .expect("other adapter durable context");

        assert_eq!(first, reconnected);
        assert_ne!(first, another_adapter);
    }

    #[test]
    fn missing_receipts_have_typed_finite_window_semantics_after_the_floor_advances() {
        let directory = tempfile::tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        prepare_test_current_store(&mut connection, Path::new("/__receipt_window_test__"))
            .expect("current Store");
        let now_ms = connection
            .query_row(
                "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("Core time");
        let floor_ms = now_ms - 60 * 60 * 1_000;
        connection
            .execute(
                "UPDATE operational_journal_state \
                 SET receipt_floor_at = ?1, receipt_floor_module = 'automation', \
                     receipt_floor_operation_id = 'floor-operation', \
                     operation_identity_cutover_at = ?2 \
                 WHERE id = 1",
                params![
                    super::super::operational_journal::timestamp_from_ms(floor_ms)
                        .expect("receipt floor"),
                    super::super::operational_journal::timestamp_from_ms(
                        now_ms - RECEIPT_RETENTION_MS - 1
                    )
                    .expect("expired cutover"),
                ],
            )
            .expect("advance receipt floor");
        let bounded = |issued_at_ms: i64| {
            format!(
                "nodexop:v1:{issued_at_ms}:{}:test:entropy",
                issued_at_ms + RECEIPT_RETENTION_MS
            )
        };

        assert!(
            read_module_receipt(&connection, "automation", &bounded(now_ms))
                .expect("fresh missing identity")
                .is_none()
        );
        let expired = read_module_receipt(
            &connection,
            "automation",
            &bounded(now_ms - RECEIPT_RETENTION_MS - 1),
        )
        .expect_err("expired operation");
        assert_eq!(expired.code, StoreErrorCode::IdempotencyWindowExpired);
        let below_floor = read_module_receipt(&connection, "automation", &bounded(floor_ms - 1))
            .expect_err("operation below floor");
        assert_eq!(below_floor.code, StoreErrorCode::IdempotencyWindowExpired);
        let legacy = read_module_receipt(&connection, "automation", "legacy-operation")
            .expect_err("legacy operation");
        assert_eq!(legacy.code, StoreErrorCode::LegacyIdempotencyUnavailable);
        let malformed = read_module_receipt(
            &connection,
            "automation",
            &format!("nodexop:v1:{now_ms}:{now_ms}:test:entropy"),
        )
        .expect_err("malformed bounded operation");
        assert_eq!(malformed.code, StoreErrorCode::InvalidInput);
    }
}
