use nodex_core_contracts::administration::{
    StoreAdministrationEvent, StoreAdministrationEventKind,
};
use nodex_core_contracts::automation::{AutomationEvent, AutomationEventKind};
use nodex_core_contracts::database::{
    DatabaseEvent, DatabaseEventKind, DatabasePersonalViewChange, DatabaseViewDisclosureTarget,
};
use nodex_core_contracts::events::DeliveryAuthorizationScope;
use nodex_core_contracts::library::{LibraryEvent, LibraryEventKind, LibraryPageFileInvalidation};
use nodex_core_contracts::workspace::{
    ProjectCatalogChangeKind, ProjectSessionInvalidationScope, ProjectWorkspaceEvent,
    ProjectWorkspaceEventKind,
};
use nodex_core_contracts::{
    AdapterKind, AuthorizedDeliveryPacket, BoundModuleContext, CORE_EVENT_VERSION, CommitIdentity,
    CommittedCoreModuleEvent, CoreModuleEventPayload, ProjectId, ProjectionImpact, StoreEpoch,
    StreamCheckpoint,
};
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::document::event_log::{
    ChangeLogRow, reconstruct_document_event, validate_change_log_row,
};

use super::authorized_delivery::{self, DeliveryAudience, DeliveryRequest, DeliveryResourceMode};
use super::local_commit;
use super::projection_impact::{
    canonicalize as canonicalize_projection_impact, decode as decode_projection_impact,
    encode as encode_projection_impact,
};
use super::sqlite::{StoreError, StoreErrorCode};
use super::writer::StoreReaders;

const DEFAULT_REPLAY_LIMIT: u32 = 256;
const MAX_REPLAY_LIMIT: u32 = 1_024;
const AUTHORIZED_STREAM_BOUNDS_SQL: &str = "SELECT metadata.store_epoch,
            journal.replay_floor_seq, journal.commit_head_seq
     FROM block_store_metadata metadata
     JOIN operational_journal_state journal ON journal.id = 1
     WHERE metadata.id = 1";
const AUTHORIZED_STREAM_PAGE_SQL: &str = "SELECT commit_seq FROM local_commits
     WHERE store_epoch = ?1 AND finalized = 1 AND commit_seq > ?2
     ORDER BY commit_seq ASC LIMIT ?3";
const DOCUMENT_LIVE_ROUTE_SQL: &str = "SELECT
       EXISTS(
         SELECT 1 FROM local_commit_documents document
         WHERE document.store_epoch = ?1
           AND document.commit_seq = ?2 AND document.document_id = ?3
       ) OR EXISTS(
         SELECT 1 FROM local_commit_revocations revocation
         WHERE revocation.store_epoch = ?1 AND revocation.commit_seq = ?2
           AND revocation.resource_kind = 'document'
           AND revocation.resource_id = ?3
       ) OR EXISTS(
         SELECT 1 FROM local_commit_effects effect
         JOIN change_log change ON change.seq = effect.change_log_seq
         JOIN json_each(change.document_ids_json) routed
         WHERE effect.store_epoch = ?1 AND effect.commit_seq = ?2
           AND routed.value = ?3
       )";
const DOCUMENT_LIVE_ROUTES_SQL: &str = "SELECT document_id FROM (
       SELECT document.document_id AS document_id
       FROM local_commit_documents document
       WHERE document.store_epoch = ?1 AND document.commit_seq = ?2
       UNION
       SELECT revocation.resource_id AS document_id
       FROM local_commit_revocations revocation
       WHERE revocation.store_epoch = ?1 AND revocation.commit_seq = ?2
         AND revocation.resource_kind = 'document'
       UNION
       SELECT CAST(routed.value AS TEXT) AS document_id
       FROM local_commit_effects effect
       JOIN change_log change ON change.seq = effect.change_log_seq
       JOIN json_each(change.document_ids_json) routed
       WHERE effect.store_epoch = ?1 AND effect.commit_seq = ?2
     ) ORDER BY document_id";
const MAX_EVENT_PAYLOAD_BYTES: usize = 1024 * 1024;
const MAX_EVENT_IDENTITIES: usize = 10_000;

pub(crate) struct NewChangeLogEntry<'a> {
    pub project_id: &'a str,
    pub store_epoch: &'a str,
    pub kind: &'a str,
    pub operation_id: Option<&'a str>,
    pub block_ids: &'a [String],
    pub document_ids: &'a [String],
    pub database_block_ids: &'a [String],
    pub payload_json: &'a str,
    pub projection_impact: &'a ProjectionImpact,
    pub committed_at: &'a str,
}

pub(crate) fn append_change_log(
    connection: &Connection,
    entry: NewChangeLogEntry<'_>,
    context: &local_commit::CommitContext,
) -> Result<i64, StoreError> {
    append_change_log_inner(connection, entry, context)
}

fn append_change_log_inner(
    connection: &Connection,
    entry: NewChangeLogEntry<'_>,
    context: &local_commit::CommitContext,
) -> Result<i64, StoreError> {
    if entry.store_epoch != context.store_epoch() {
        return Err(corrupt(
            "Change-log effect and LocalCommit context have different Store epochs",
        ));
    }
    let projection_impact = canonicalize_projection_impact(entry.projection_impact.clone())?;
    let projection_impact_json = encode_projection_impact(&projection_impact)?;
    connection.execute(
        "INSERT INTO change_log(\
           project_id, store_epoch, kind, operation_id, block_ids_json, document_ids_json, \
           database_block_ids_json, payload_json, projection_impact_json, committed_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            entry.project_id,
            entry.store_epoch,
            entry.kind,
            entry.operation_id,
            serde_json::to_string(entry.block_ids)
                .map_err(|_| corrupt("Change log Block identities are invalid"))?,
            serde_json::to_string(entry.document_ids)
                .map_err(|_| corrupt("Change log Document identities are invalid"))?,
            serde_json::to_string(entry.database_block_ids)
                .map_err(|_| corrupt("Change log Database identities are invalid"))?,
            entry.payload_json,
            projection_impact_json,
            entry.committed_at,
        ],
    )?;
    let sequence = connection.last_insert_rowid();
    let resources = local_commit::PhysicalEffectResources {
        block_ids: entry.block_ids.to_vec(),
        document_ids: entry.document_ids.to_vec(),
        database_ids: entry.database_block_ids.to_vec(),
    };
    local_commit::record_effect(
        connection,
        context,
        local_commit::RegisteredPhysicalEffect {
            change_log_seq: sequence,
            project_id: entry.project_id,
            module: local_commit::module_from_kind(entry.kind)?,
            kind: entry.kind,
            operation_id: entry.operation_id,
            resources: &resources,
            payload_hash: &format!("{:x}", Sha256::digest(entry.payload_json.as_bytes())),
            projection_impact: &projection_impact,
        },
    )?;
    Ok(sequence)
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct TestCommitEffect {
    payload: CoreModuleEventPayload,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TestCommitEnvelope {
    pub(crate) commit_seq: i64,
    effects: Vec<TestCommitEffect>,
}

#[cfg(test)]
fn load_test_commit(
    connection: &Connection,
    commit_seq: i64,
) -> Result<TestCommitEnvelope, StoreError> {
    let verified = local_commit::load_verified_commit(connection, commit_seq)?;
    let mut effects = Vec::with_capacity(verified.physical_effects.len());
    for (_, change_log_seq, _, module, _, _, _, _, _) in verified.physical_effects {
        let event = load_committed_event_by_sequence(connection, change_log_seq)?;
        if event.payload.module_name() != module {
            return Err(corrupt(
                "LocalCommit physical effect Module facet is inconsistent",
            ));
        }
        effects.push(TestCommitEffect {
            payload: event.payload,
        });
    }
    Ok(TestCommitEnvelope {
        commit_seq,
        effects,
    })
}

pub(crate) fn load_committed_event_by_sequence(
    connection: &Connection,
    sequence: i64,
) -> Result<CommittedCoreModuleEvent, StoreError> {
    if sequence < 1 {
        return Err(corrupt("Core event sequence is invalid"));
    }
    let row = connection
        .query_row(
            "SELECT seq, project_id, store_epoch, kind, operation_id, payload_json, \
                    projection_impact_json, committed_at \
             FROM change_log WHERE seq = ?1",
            [sequence],
            |row| {
                Ok(ChangeLogRow {
                    sequence: row.get(0)?,
                    project_id: row.get(1)?,
                    store_epoch: row.get(2)?,
                    kind: row.get(3)?,
                    operation_id: row.get(4)?,
                    payload_json: row.get(5)?,
                    projection_impact_json: row.get(6)?,
                    committed_at: row.get(7)?,
                })
            },
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => corrupt("Committed Core event is missing"),
            _ => StoreError::from(error),
        })?;
    validate_change_log_row(&row, sequence - 1, physical_event_head(connection)?)?;
    reconstruct_event(connection, &row)?
        .ok_or_else(|| corrupt("Committed Core event cannot be reconstructed"))
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CoreEventReplay {
    Events {
        events: Vec<TestCommitEnvelope>,
        commit_head: i64,
    },
    ResyncRequired {
        requested_after: i64,
        oldest_available: i64,
        commit_head: i64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoreAuthorizedEventReplay {
    Scan {
        packets: Vec<AuthorizedDeliveryPacket>,
        checkpoint: StreamCheckpoint,
        commit_head: i64,
    },
    ResyncRequired {
        requested_after: i64,
        oldest_available: i64,
        commit_head: i64,
        resync_token: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DocumentLiveDelivery {
    Unrelated,
    Packet(Box<AuthorizedDeliveryPacket>),
    IdentityChanged(StreamCheckpoint),
    AccessRevoked,
}

#[derive(Clone)]
pub struct CoreEventLog {
    readers: StoreReaders,
}

impl CoreEventLog {
    pub fn new(readers: StoreReaders) -> Self {
        Self { readers }
    }

    pub fn head(&self) -> Result<i64, StoreError> {
        self.readers.read_default(local_commit_head)
    }

    pub fn stream_barrier(&self) -> Result<(StoreEpoch, i64), StoreError> {
        self.readers.read_default(|connection| {
            let (store_epoch, _, commit_head) = authorized_stream_bounds(connection)?;
            Ok((StoreEpoch(store_epoch), commit_head))
        })
    }

    pub fn commit_identity(&self, commit_seq: i64) -> Result<CommitIdentity, StoreError> {
        self.readers.read_default(move |connection| {
            local_commit::read_manifest(connection, commit_seq).map(|manifest| manifest.identity)
        })
    }

    #[cfg(test)]
    pub(crate) fn replay(
        &self,
        after: i64,
        limit: Option<u32>,
    ) -> Result<CoreEventReplay, StoreError> {
        self.readers.read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            validate_local_commit_index(&transaction)?;
            let replay = replay_core_events(&transaction, after, limit)?;
            transaction.commit()?;
            Ok(replay)
        })
    }

    pub fn authorized_packet(
        &self,
        commit_seq: i64,
        context: &BoundModuleContext,
        document_id: Option<&str>,
        inline_resources: bool,
    ) -> Result<Option<AuthorizedDeliveryPacket>, StoreError> {
        self.authorized_packet_for_audience(
            commit_seq,
            context,
            document_id,
            inline_resources,
            DeliveryAudience::BoundScope,
        )
    }

    /// Resolves one post-barrier packet for an exact Document subscription.
    /// The immutable route indexes are checked before manifest verification so
    /// unrelated commits never pay the reconstruction cost per open surface.
    pub fn authorized_document_live_delivery(
        &self,
        commit_seq: i64,
        context: &BoundModuleContext,
        document_id: &str,
        expected_store_epoch: &StoreEpoch,
        generation: &str,
        live_after: i64,
    ) -> Result<DocumentLiveDelivery, StoreError> {
        if commit_seq <= 0
            || document_id.is_empty()
            || document_id.len() > 512
            || generation.is_empty()
            || generation.len() > 512
            || live_after < 0
        {
            return Err(corrupt("Document live delivery coordinate is invalid"));
        }
        let context = context.clone();
        let document_id = document_id.to_owned();
        let expected_store_epoch = expected_store_epoch.clone();
        let generation = generation.to_owned();
        self.readers.read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let (store_epoch, oldest_available_seq, scanned_through_seq) =
                authorized_stream_bounds(&transaction)?;
            if store_epoch != expected_store_epoch.0 {
                transaction.commit()?;
                return Ok(DocumentLiveDelivery::IdentityChanged(StreamCheckpoint {
                    store_epoch: StoreEpoch(store_epoch),
                    generation,
                    scanned_through_seq,
                    oldest_available_seq,
                    resync_token: None,
                }));
            }
            if commit_seq <= live_after {
                transaction.commit()?;
                return Ok(DocumentLiveDelivery::Unrelated);
            }
            let addressed = transaction.query_row(
                DOCUMENT_LIVE_ROUTE_SQL,
                params![&expected_store_epoch.0, commit_seq, &document_id],
                |row| row.get::<_, i64>(0),
            )? == 1;
            if !addressed {
                transaction.commit()?;
                return Ok(DocumentLiveDelivery::Unrelated);
            }
            let authorization_scope =
                nodex_core_contracts::events::DeliveryAuthorizationScope::Document {
                    library_id: context.library_id.0.clone(),
                    project_id: context
                        .project_id
                        .as_ref()
                        .map(|project_id| project_id.0.clone()),
                    document_id: document_id.clone(),
                };
            if !super::resource_authorization::can_read(
                &transaction,
                &context,
                &authorization_scope,
                &nodex_core_contracts::events::ResourceKey::Document {
                    document_id: document_id.clone(),
                },
            )? {
                transaction.commit()?;
                return Ok(DocumentLiveDelivery::AccessRevoked);
            }
            let packet = authorized_delivery::resolve(
                &transaction,
                commit_seq,
                DeliveryRequest {
                    context: &context,
                    audience: DeliveryAudience::BoundScope,
                    document_id: Some(&document_id),
                    resource_mode: DeliveryResourceMode::RefOnly,
                },
            )?;
            transaction.commit()?;
            Ok(packet.map_or(DocumentLiveDelivery::Unrelated, |packet| {
                DocumentLiveDelivery::Packet(Box::new(packet))
            }))
        })
    }

    /// Resolves the immutable routing claims for one committed mutation once,
    /// before the server wakes exact-resource live streams. Authorization is
    /// deliberately not decided here; every addressed stream still resolves
    /// its own scoped packet through Core.
    pub fn document_live_routes(
        &self,
        store_epoch: &str,
        commit_seq: i64,
    ) -> Result<Vec<String>, StoreError> {
        if store_epoch.is_empty() || store_epoch.len() > 512 || commit_seq <= 0 {
            return Err(corrupt("Document live route commit sequence is invalid"));
        }
        let store_epoch = store_epoch.to_owned();
        self.readers.read_default(move |connection| {
            let mut statement = connection.prepare_cached(DOCUMENT_LIVE_ROUTES_SQL)?;
            let rows = statement.query_map(params![store_epoch, commit_seq], |row| {
                row.get::<_, String>(0)
            })?;
            let mut routes = Vec::new();
            for row in rows {
                let document_id = row?;
                if document_id.is_empty() || document_id.len() > 512 {
                    return Err(corrupt("Document live route identity is invalid"));
                }
                routes.push(document_id);
            }
            Ok(routes)
        })
    }

    /// Resolves a packet for the trusted Electron Host's Library broker while
    /// preserving the command's original Project-bound context.
    pub fn authorized_packet_for_library_broker(
        &self,
        commit_seq: i64,
        context: &BoundModuleContext,
        inline_resources: bool,
    ) -> Result<Option<AuthorizedDeliveryPacket>, StoreError> {
        self.authorized_packet_for_audience(
            commit_seq,
            context,
            None,
            inline_resources,
            DeliveryAudience::HostLibraryBroker,
        )
    }

    /// Resolves metadata packets (atoms, projections and revocations) for one trusted Host broker
    /// publication. The commit is verified once and every requested audience
    /// is authorized by Core inside the same read transaction.
    pub fn authorized_projection_live_packets(
        &self,
        commit_seq: i64,
        host_context: &BoundModuleContext,
        scopes: &[DeliveryAuthorizationScope],
    ) -> Result<Vec<AuthorizedDeliveryPacket>, StoreError> {
        validate_projection_live_request(host_context, scopes)?;
        let host_context = host_context.clone();
        let scopes = scopes.to_vec();
        self.readers.read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let packets =
                resolve_projection_live_packets(&transaction, commit_seq, &host_context, &scopes)?;
            transaction.commit()?;
            Ok(packets)
        })
    }

    /// Scans the durable LocalCommit ledger for one trusted Host projection
    /// broker. Broadcast delivery is deliberately absent from this interface:
    /// callers can only advance from a durable cursor and the returned
    /// checkpoint includes commits that authorize to zero packets.
    pub fn scan_authorized_projection_live(
        &self,
        after: i64,
        limit: Option<u32>,
        generation: &str,
        host_context: &BoundModuleContext,
        scopes: &[DeliveryAuthorizationScope],
    ) -> Result<CoreAuthorizedEventReplay, StoreError> {
        validate_projection_live_request(host_context, scopes)?;
        let generation = generation.to_owned();
        let host_context = host_context.clone();
        let scopes = scopes.to_vec();
        self.readers.read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let replay = scan_authorized_events_with(
                &transaction,
                after,
                limit,
                &generation,
                |connection, commit_seq| {
                    resolve_projection_live_packets(connection, commit_seq, &host_context, &scopes)
                },
            )?;
            transaction.commit()?;
            Ok(replay)
        })
    }

    fn authorized_packet_for_audience(
        &self,
        commit_seq: i64,
        context: &BoundModuleContext,
        document_id: Option<&str>,
        inline_resources: bool,
        audience: DeliveryAudience,
    ) -> Result<Option<AuthorizedDeliveryPacket>, StoreError> {
        let context = context.clone();
        let document_id = document_id.map(str::to_owned);
        self.readers.read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let packet = authorized_delivery::resolve(
                &transaction,
                commit_seq,
                DeliveryRequest {
                    context: &context,
                    audience,
                    document_id: document_id.as_deref(),
                    resource_mode: if inline_resources {
                        DeliveryResourceMode::Inline
                    } else {
                        DeliveryResourceMode::RefOnly
                    },
                },
            )?;
            transaction.commit()?;
            Ok(packet)
        })
    }

    pub fn scan_authorized(
        &self,
        after: i64,
        limit: Option<u32>,
        generation: &str,
        context: &BoundModuleContext,
        document_id: Option<&str>,
    ) -> Result<CoreAuthorizedEventReplay, StoreError> {
        let generation = generation.to_owned();
        let context = context.clone();
        let document_id = document_id.map(str::to_owned);
        self.readers.read_default(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            let replay = scan_authorized_events(
                &transaction,
                after,
                limit,
                &generation,
                &context,
                document_id.as_deref(),
            )?;
            transaction.commit()?;
            Ok(replay)
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryMetadata {
    #[serde(default)]
    file_revisions: std::collections::BTreeMap<String, i64>,
    module: String,
    affected_page_ids: Vec<String>,
    affected_database_ids: Vec<String>,
    #[serde(default)]
    affected_view_ids: Vec<String>,
    affected_parent_keys: Vec<String>,
    #[serde(default)]
    page_file_manifest_invalidations:
        std::collections::BTreeMap<String, LibraryPageFileInvalidation>,
    #[serde(default)]
    page_file_manifest_revisions: std::collections::BTreeMap<String, i64>,
    #[serde(default)]
    page_file_content_invalidations:
        std::collections::BTreeMap<String, LibraryPageFileInvalidation>,
    #[serde(default)]
    page_file_content_revisions: std::collections::BTreeMap<String, i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseMetadata {
    module: String,
    kind: String,
    #[serde(default)]
    project_id: Option<String>,
    database_ids: Vec<String>,
    data_source_ids: Vec<String>,
    page_ids: Vec<String>,
    view_ids: Vec<String>,
    #[serde(default)]
    personal_view_changes: Vec<DatabasePersonalViewChange>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMetadata {
    module: String,
    kind: String,
    #[serde(default)]
    operation_kind: Option<String>,
    #[serde(default)]
    project_catalog_change: Option<ProjectCatalogChangeKind>,
    #[serde(default)]
    project_catalog_changed: Option<bool>,
    #[serde(default)]
    project_ids: Vec<String>,
    #[serde(default)]
    session_ids: Vec<String>,
    #[serde(default)]
    thread_ids: Vec<String>,
    #[serde(default)]
    session_summary_scopes: Option<Vec<ProjectSessionInvalidationScope>>,
    #[serde(default)]
    session_detail_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationMetadata {
    module: String,
    kind: String,
    automation_ids: Vec<String>,
    lease_ids: Vec<String>,
    run_ids: Vec<String>,
    reminder_lease_ids: Vec<String>,
    snooze_ids: Vec<i64>,
    page_ids: Vec<String>,
    document_ids: Vec<String>,
    database_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdministrationMetadata {
    module: String,
    operation_kind: String,
    kind: String,
    backup_ids: Vec<String>,
    readiness_changed: bool,
}

#[cfg(test)]
fn replay_core_events(
    connection: &Connection,
    after: i64,
    limit: Option<u32>,
) -> Result<CoreEventReplay, StoreError> {
    if after < 0 {
        return Err(invalid("Core event replay boundary is invalid"));
    }
    let limit = limit
        .unwrap_or(DEFAULT_REPLAY_LIMIT)
        .clamp(1, MAX_REPLAY_LIMIT);
    let (_, oldest_commit, commit_head) = authorized_stream_bounds(connection)?;
    if oldest_commit < 0 || oldest_commit > commit_head.saturating_add(1) {
        return Err(corrupt("LocalCommit retention boundary is invalid"));
    }
    if oldest_commit > 0 && after < oldest_commit - 1 {
        return Ok(CoreEventReplay::ResyncRequired {
            requested_after: after,
            oldest_available: oldest_commit,
            commit_head,
        });
    }

    let rows = connection
        .prepare(
            "SELECT commit_seq FROM local_commits \
             WHERE commit_seq > ?1 ORDER BY commit_seq ASC LIMIT ?2",
        )?
        .query_map(params![after, i64::from(limit) + 1], |row| {
            row.get::<_, i64>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("LocalCommit sequence has invalid column types"))?;
    if rows.len() > usize::try_from(limit).expect("bounded replay limit") {
        return Ok(CoreEventReplay::ResyncRequired {
            requested_after: after,
            oldest_available: rows.first().copied().unwrap_or(commit_head),
            commit_head,
        });
    }

    let mut events = Vec::with_capacity(rows.len());
    for commit_seq in rows {
        events.push(load_test_commit(connection, commit_seq)?);
    }
    Ok(CoreEventReplay::Events {
        events,
        commit_head,
    })
}

fn scan_authorized_events(
    connection: &Connection,
    after: i64,
    limit: Option<u32>,
    generation: &str,
    context: &BoundModuleContext,
    document_id: Option<&str>,
) -> Result<CoreAuthorizedEventReplay, StoreError> {
    scan_authorized_events_with(
        connection,
        after,
        limit,
        generation,
        |connection, commit_seq| {
            Ok(authorized_delivery::resolve(
                connection,
                commit_seq,
                DeliveryRequest {
                    context,
                    audience: DeliveryAudience::BoundScope,
                    document_id,
                    resource_mode: DeliveryResourceMode::RefOnly,
                },
            )?
            .into_iter()
            .collect())
        },
    )
}

fn scan_authorized_events_with(
    connection: &Connection,
    after: i64,
    limit: Option<u32>,
    generation: &str,
    mut resolve: impl FnMut(&Connection, i64) -> Result<Vec<AuthorizedDeliveryPacket>, StoreError>,
) -> Result<CoreAuthorizedEventReplay, StoreError> {
    if after < 0 || generation.is_empty() || generation.len() > 512 {
        return Err(corrupt("Authorized commit stream cursor is invalid"));
    }
    let limit = limit.unwrap_or(DEFAULT_REPLAY_LIMIT).min(MAX_REPLAY_LIMIT);
    if limit == 0 {
        return Err(corrupt("Authorized commit stream limit is invalid"));
    }
    let (store_epoch, oldest_commit, commit_head) = authorized_stream_bounds(connection)?;
    if oldest_commit < 0 || oldest_commit > commit_head.saturating_add(1) {
        return Err(corrupt("Authorized commit retention boundary is invalid"));
    }
    if oldest_commit > 0 && after < oldest_commit - 1 {
        let token = format!(
            "{:x}",
            Sha256::digest(
                format!("resync\0{store_epoch}\0{generation}\0{oldest_commit}\0{commit_head}")
                    .as_bytes()
            )
        );
        return Ok(CoreAuthorizedEventReplay::ResyncRequired {
            requested_after: after,
            oldest_available: oldest_commit,
            commit_head,
            resync_token: token,
        });
    }

    let mut sequences = connection
        .prepare_cached(AUTHORIZED_STREAM_PAGE_SQL)?
        .query_map(params![&store_epoch, after, i64::from(limit) + 1], |row| {
            row.get::<_, i64>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = sequences.len() > usize::try_from(limit).expect("bounded stream limit");
    if has_more {
        sequences.pop();
    }
    let scanned_through_seq = if has_more {
        sequences.last().copied().unwrap_or(after)
    } else {
        commit_head.max(after)
    };
    let mut packets = Vec::new();
    for commit_seq in sequences {
        packets.extend(resolve(connection, commit_seq)?);
    }
    Ok(CoreAuthorizedEventReplay::Scan {
        packets,
        checkpoint: StreamCheckpoint {
            store_epoch: StoreEpoch(store_epoch),
            generation: generation.to_owned(),
            scanned_through_seq,
            oldest_available_seq: oldest_commit,
            resync_token: None,
        },
        commit_head,
    })
}

fn validate_projection_live_request(
    host_context: &BoundModuleContext,
    scopes: &[DeliveryAuthorizationScope],
) -> Result<(), StoreError> {
    if host_context.adapter != AdapterKind::ElectronHost || host_context.project_id.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Projection live broker requires an unscoped Electron Host",
            false,
        ));
    }
    if scopes.len() > 200 {
        return Err(StoreError::new(
            StoreErrorCode::ResourceExhausted,
            "Projection live broker exceeds the active scope bound",
            false,
        ));
    }
    Ok(())
}

fn resolve_projection_live_packets(
    connection: &Connection,
    commit_seq: i64,
    host_context: &BoundModuleContext,
    scopes: &[DeliveryAuthorizationScope],
) -> Result<Vec<AuthorizedDeliveryPacket>, StoreError> {
    let verified = local_commit::load_verified_commit(connection, commit_seq)?;
    let mut packets = Vec::with_capacity(scopes.len());
    for scope in scopes {
        let context = match scope {
            DeliveryAuthorizationScope::Library { library_id }
                if library_id == &host_context.library_id.0 =>
            {
                host_context.clone()
            }
            DeliveryAuthorizationScope::Project {
                library_id,
                project_id,
            } if library_id == &host_context.library_id.0 => BoundModuleContext {
                editor_history_owner: None,
                project_id: Some(ProjectId(project_id.clone())),
                ..host_context.clone()
            },
            DeliveryAuthorizationScope::Library { .. }
            | DeliveryAuthorizationScope::Project { .. }
            | DeliveryAuthorizationScope::Document { .. } => {
                return Err(StoreError::new(
                    StoreErrorCode::Unauthorized,
                    "Projection live scope is outside the Host Library",
                    false,
                ));
            }
        };
        if let Some(packet) = authorized_delivery::resolve_verified(
            connection,
            &verified,
            DeliveryRequest {
                context: &context,
                audience: DeliveryAudience::BoundScope,
                document_id: None,
                resource_mode: DeliveryResourceMode::MetadataOnly,
            },
        )? {
            packets.push(packet);
        }
    }
    Ok(packets)
}

fn authorized_stream_bounds(connection: &Connection) -> Result<(String, i64, i64), StoreError> {
    let bounds = connection.query_row(AUTHORIZED_STREAM_BOUNDS_SQL, [], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    if bounds.1 < 0 || bounds.2 < 0 || bounds.1 > bounds.2.saturating_add(1) {
        return Err(corrupt("Authorized commit retention boundary is invalid"));
    }
    Ok(bounds)
}

pub(crate) fn validate_local_commit_index(connection: &Connection) -> Result<(), StoreError> {
    let unfinished_count: i64 = connection.query_row(
        "SELECT count(*) FROM local_commits WHERE finalized <> 1",
        [],
        |row| row.get(0),
    )?;
    if unfinished_count != 0 {
        return Err(corrupt(
            "Durable LocalCommit history contains unfinished transactions",
        ));
    }
    let orphaned_effects: i64 = connection.query_row(
        "SELECT count(*) FROM local_commit_effects effect
         LEFT JOIN local_commits parent
           ON parent.store_epoch = effect.store_epoch
          AND parent.commit_seq = effect.commit_seq
         LEFT JOIN change_log change ON change.seq = effect.change_log_seq
         WHERE parent.commit_seq IS NULL OR change.seq IS NULL",
        [],
        |row| row.get(0),
    )?;
    if orphaned_effects > 0 {
        return Err(corrupt(
            "LocalCommit effects are not addressable by their complete parent coordinate",
        ));
    }
    let orphaned_documents: i64 = connection.query_row(
        "SELECT count(*) FROM local_commit_documents document
         LEFT JOIN local_commits parent
           ON parent.store_epoch = document.store_epoch
          AND parent.commit_seq = document.commit_seq
         WHERE parent.commit_seq IS NULL",
        [],
        |row| row.get(0),
    )?;
    if orphaned_documents > 0 {
        return Err(corrupt(
            "LocalCommit Documents are not addressable by their complete parent coordinate",
        ));
    }
    let orphaned_library_effects: i64 = connection.query_row(
        "SELECT count(*) FROM local_commit_library_effects effect
         LEFT JOIN local_commits parent
           ON parent.store_epoch = effect.store_epoch
          AND parent.commit_seq = effect.commit_seq
         WHERE parent.commit_seq IS NULL",
        [],
        |row| row.get(0),
    )?;
    if orphaned_library_effects > 0 {
        return Err(corrupt(
            "Library effects are not addressable by their complete LocalCommit coordinate",
        ));
    }
    let orphaned_atoms: i64 = connection.query_row(
        "SELECT count(*) FROM local_commit_delivery_atoms atom
         LEFT JOIN local_commits parent
           ON parent.store_epoch = atom.store_epoch
          AND parent.commit_seq = atom.commit_seq
         WHERE parent.commit_seq IS NULL",
        [],
        |row| row.get(0),
    )?;
    if orphaned_atoms > 0 {
        return Err(corrupt(
            "DeliveryAtoms are not addressable by their complete LocalCommit coordinate",
        ));
    }
    let orphaned_receipts: i64 = connection.query_row(
        "SELECT count(*) FROM core_module_receipts receipt
         LEFT JOIN local_commits parent
           ON parent.store_epoch = receipt.store_epoch
          AND parent.commit_seq = receipt.local_commit_seq
         WHERE receipt.local_commit_seq IS NOT NULL
           AND parent.commit_seq IS NULL",
        [],
        |row| row.get(0),
    )?;
    if orphaned_receipts > 0 {
        return Err(corrupt(
            "LocalCommit receipts are not addressable by their complete parent coordinate",
        ));
    }
    let (commit_head, replay_floor, retained_min, retained_max) = connection.query_row(
        "SELECT journal.commit_head_seq, journal.replay_floor_seq, \
                COALESCE(min(commit_row.commit_seq), \
                  CASE WHEN journal.commit_head_seq = 0 THEN 0 ELSE journal.commit_head_seq + 1 END), \
                COALESCE(max(commit_row.commit_seq), 0) \
         FROM operational_journal_state journal \
         LEFT JOIN local_commits commit_row ON commit_row.finalized = 1 \
         WHERE journal.id = 1 \
         GROUP BY journal.commit_head_seq, journal.replay_floor_seq",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        },
    )?;
    if commit_head < 0
        || replay_floor < 0
        || replay_floor > commit_head.saturating_add(1)
        || retained_min != replay_floor
        || retained_max > commit_head
    {
        return Err(corrupt("Operational Journal boundaries are invalid"));
    }
    let accounting = connection.query_row(
        "SELECT journal.retained_commit_count, journal.retained_delivery_bytes, \
                journal.pending_metadata_count, \
                (SELECT count(*) FROM local_commits WHERE finalized = 1), \
                (SELECT count(*) FROM local_commit_retention_metadata), \
                COALESCE((SELECT sum(delivery_bytes) \
                            FROM local_commit_retention_metadata), 0), \
                (SELECT count(*) FROM detached_module_receipts receipt \
                  JOIN local_commits commit_row \
                    ON commit_row.store_epoch = receipt.store_epoch \
                   AND commit_row.commit_seq = receipt.local_commit_seq), \
                (SELECT count(*) FROM core_module_receipts active \
                  JOIN detached_module_receipts detached \
                    ON detached.module_name = active.module_name \
                   AND detached.operation_id = active.operation_id), \
                journal.retained_receipt_count, journal.retained_receipt_bytes, \
                journal.pending_receipt_metadata_count, \
                (SELECT count(*) FROM core_module_receipts) \
                  + (SELECT count(*) FROM detached_module_receipts), \
                (SELECT count(*) FROM module_receipt_retention_metadata), \
                COALESCE((SELECT sum(receipt_bytes) \
                            FROM module_receipt_retention_metadata), 0), \
                (SELECT count(*) FROM module_receipt_retention_metadata retention \
                  WHERE NOT EXISTS( \
                    SELECT 1 FROM core_module_receipts active \
                    WHERE active.module_name = retention.module_name \
                      AND active.operation_id = retention.operation_id \
                  ) AND NOT EXISTS( \
                    SELECT 1 FROM detached_module_receipts detached \
                    WHERE detached.module_name = retention.module_name \
                      AND detached.operation_id = retention.operation_id \
                  )) \
         FROM operational_journal_state journal WHERE journal.id = 1",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, i64>(11)?,
                row.get::<_, i64>(12)?,
                row.get::<_, i64>(13)?,
                row.get::<_, i64>(14)?,
            ))
        },
    )?;
    if accounting.0 != accounting.3
        || accounting.1 != accounting.5
        || accounting.2 != accounting.3.saturating_sub(accounting.4)
        || accounting.6 != 0
        || accounting.7 != 0
        || accounting.8 != accounting.11
        || accounting.9 != accounting.13
        || accounting.10 != accounting.11.saturating_sub(accounting.12)
        || accounting.14 != 0
    {
        return Err(corrupt("Operational Journal accounting is inconsistent"));
    }
    Ok(())
}

fn reconstruct_event(
    connection: &Connection,
    row: &ChangeLogRow,
) -> Result<Option<CommittedCoreModuleEvent>, StoreError> {
    if row.kind.starts_with("owned_document.") {
        return reconstruct_document_event(connection, row);
    }
    if row.payload_json.len() > MAX_EVENT_PAYLOAD_BYTES {
        return Err(corrupt("Core event payload exceeds its bound"));
    }
    let payload = match row.kind.as_str() {
        "library.changed" | "block_mutation" | "block_relocation" | "block_transfer" => {
            let metadata = decode_library_metadata(row)?;
            require_module(&metadata.module, "library")?;
            validate_strings(&metadata.affected_page_ids, "Library Page")?;
            validate_strings(&metadata.affected_database_ids, "Library Database")?;
            validate_strings(&metadata.affected_view_ids, "Library View")?;
            validate_strings(&metadata.affected_parent_keys, "Library parent")?;
            let page_file_manifest_invalidations = normalize_page_file_invalidations(
                metadata.page_file_manifest_invalidations,
                metadata.page_file_manifest_revisions,
                "Page File manifest",
            )?;
            let page_file_content_invalidations = normalize_page_file_invalidations(
                metadata.page_file_content_invalidations,
                metadata.page_file_content_revisions,
                "Page File content",
            )?;
            CoreModuleEventPayload::Library(LibraryEvent {
                file_revisions: metadata.file_revisions,
                kind: LibraryEventKind::LibraryChanged,
                page_ids: metadata.affected_page_ids,
                database_ids: metadata.affected_database_ids,
                view_ids: metadata.affected_view_ids,
                parent_keys: metadata.affected_parent_keys,
                page_file_manifest_invalidations,
                page_file_body_usage_revisions: std::collections::BTreeMap::new(),
                page_file_content_invalidations,
            })
        }
        "database.changed" => {
            let metadata = decode::<DatabaseMetadata>(row, "Database")?;
            require_module_kind(
                &metadata.module,
                "database",
                &metadata.kind,
                "database_changed",
            )?;
            validate_strings(&metadata.database_ids, "Database")?;
            validate_strings(&metadata.data_source_ids, "Data Source")?;
            validate_strings(&metadata.page_ids, "Database Page")?;
            validate_strings(&metadata.view_ids, "Database View")?;
            validate_personal_view_changes(&metadata.personal_view_changes)?;
            if let Some(project_id) = metadata.project_id.as_deref() {
                validate_identity(project_id, "Database Project")?;
                if project_id != row.project_id {
                    return Err(corrupt(
                        "Database event Project and ledger authority diverge",
                    ));
                }
            }
            CoreModuleEventPayload::Database(DatabaseEvent {
                kind: DatabaseEventKind::DatabaseChanged,
                project_id: metadata.project_id,
                database_ids: metadata.database_ids,
                data_source_ids: metadata.data_source_ids,
                page_ids: metadata.page_ids,
                view_ids: metadata.view_ids,
                personal_view_changes: metadata.personal_view_changes,
            })
        }
        "project_workspace.changed" => {
            let metadata = decode::<WorkspaceMetadata>(row, "Project Workspace")?;
            require_module_kind(
                &metadata.module,
                "project_workspace",
                &metadata.kind,
                "workspace_changed",
            )?;
            validate_strings(&metadata.project_ids, "Project Workspace Project")?;
            validate_strings(&metadata.session_ids, "Project Workspace Session")?;
            validate_strings(&metadata.thread_ids, "Project Workspace Thread")?;
            let project_catalog_change = metadata.project_catalog_change.or_else(|| {
                metadata
                    .project_catalog_changed
                    .unwrap_or(false)
                    .then(|| legacy_project_catalog_change(metadata.operation_kind.as_deref()))
                    .flatten()
            });
            let session_summary_scopes = metadata.session_summary_scopes.unwrap_or_else(|| {
                legacy_session_summary_scopes(
                    metadata.operation_kind.as_deref(),
                    &metadata.project_ids,
                    &metadata.session_ids,
                )
            });
            validate_session_summary_scopes(&session_summary_scopes)?;
            let session_detail_ids = metadata
                .session_detail_ids
                .unwrap_or_else(|| metadata.session_ids.clone());
            validate_strings(&session_detail_ids, "Project Workspace Session detail")?;
            CoreModuleEventPayload::ProjectWorkspace(ProjectWorkspaceEvent {
                kind: ProjectWorkspaceEventKind::WorkspaceChanged,
                project_catalog_change,
                project_ids: metadata.project_ids,
                session_ids: metadata.session_ids,
                thread_ids: metadata.thread_ids,
                session_summary_scopes,
                session_detail_ids,
            })
        }
        "automation.changed" => {
            let metadata = decode::<AutomationMetadata>(row, "Automation")?;
            require_module_kind(
                &metadata.module,
                "automation",
                &metadata.kind,
                "automation_changed",
            )?;
            validate_strings(&metadata.automation_ids, "Automation")?;
            validate_strings(&metadata.lease_ids, "Automation lease")?;
            validate_strings(&metadata.run_ids, "Automation run")?;
            validate_strings(&metadata.reminder_lease_ids, "Reminder lease")?;
            validate_strings(&metadata.page_ids, "Automation Page")?;
            validate_strings(&metadata.document_ids, "Automation Document")?;
            validate_strings(&metadata.database_ids, "Automation Database")?;
            if metadata.snooze_ids.len() > MAX_EVENT_IDENTITIES
                || metadata.snooze_ids.iter().any(|id| *id < 1)
            {
                return Err(corrupt("Automation snooze event identities are invalid"));
            }
            CoreModuleEventPayload::Automation(AutomationEvent {
                kind: AutomationEventKind::AutomationChanged,
                automation_ids: metadata.automation_ids,
                lease_ids: metadata.lease_ids,
                run_ids: metadata.run_ids,
                reminder_lease_ids: metadata.reminder_lease_ids,
                snooze_ids: metadata.snooze_ids,
                page_ids: metadata.page_ids,
                document_ids: metadata.document_ids,
                database_ids: metadata.database_ids,
            })
        }
        "store_administration.changed" => {
            let metadata = decode::<AdministrationMetadata>(row, "Store Administration")?;
            require_module_kind(
                &metadata.module,
                "store_administration",
                &metadata.kind,
                "store_administration_changed",
            )?;
            validate_identity(&metadata.operation_kind, "Store Administration operation")?;
            validate_strings(&metadata.backup_ids, "Store Administration backup")?;
            CoreModuleEventPayload::StoreAdministration(StoreAdministrationEvent {
                kind: StoreAdministrationEventKind::StoreAdministrationChanged,
                operation: metadata.operation_kind,
                backup_ids: metadata.backup_ids,
                readiness_changed: metadata.readiness_changed,
            })
        }
        _ => return Err(corrupt("Core event kind is unsupported")),
    };
    let projection_impact = row
        .projection_impact_json
        .as_deref()
        .map(decode_projection_impact)
        .transpose()?
        .unwrap_or(ProjectionImpact::None);
    Ok(Some(CommittedCoreModuleEvent {
        event_version: CORE_EVENT_VERSION,
        sequence: row.sequence,
        store_epoch: StoreEpoch(row.store_epoch.clone()),
        operation_id: row.operation_id.clone(),
        committed_at: row.committed_at.clone(),
        projection_impact,
        payload,
    }))
}

fn physical_event_head(connection: &Connection) -> Result<i64, StoreError> {
    let head = connection.query_row("SELECT COALESCE(max(seq), 0) FROM change_log", [], |row| {
        row.get::<_, i64>(0)
    })?;
    if head < 0 {
        return Err(corrupt("Core event head is invalid"));
    }
    Ok(head)
}

fn local_commit_head(connection: &Connection) -> Result<i64, StoreError> {
    local_commit::head(connection)
}

fn decode<T: for<'de> Deserialize<'de>>(row: &ChangeLogRow, label: &str) -> Result<T, StoreError> {
    serde_json::from_str(&row.payload_json)
        .map_err(|_| corrupt(&format!("{label} event payload is invalid")))
}

fn decode_library_metadata(row: &ChangeLogRow) -> Result<LibraryMetadata, StoreError> {
    match serde_json::from_str(&row.payload_json) {
        Ok(metadata) => Ok(metadata),
        Err(_)
            if matches!(
                row.kind.as_str(),
                "block_mutation" | "block_relocation" | "block_transfer"
            ) =>
        {
            let payload = serde_json::from_str::<Value>(&row.payload_json)
                .map_err(|_| corrupt("Library event payload is invalid"))?;
            if !is_valid_legacy_typescript_library_payload(&row.kind, &payload) {
                return Err(corrupt("Library event payload is invalid"));
            }
            // TypeScript v84 retained the durable effect resources in the
            // change-log columns, but its payload envelope predates the typed
            // Core Library metadata. Reconstruct the event facet without
            // rewriting the immutable historical payload.
            Ok(LibraryMetadata {
                file_revisions: Default::default(),
                module: "library".to_owned(),
                affected_page_ids: Vec::new(),
                affected_database_ids: Vec::new(),
                affected_view_ids: Vec::new(),
                affected_parent_keys: Vec::new(),
                page_file_manifest_invalidations: std::collections::BTreeMap::new(),
                page_file_manifest_revisions: std::collections::BTreeMap::new(),
                page_file_content_invalidations: std::collections::BTreeMap::new(),
                page_file_content_revisions: std::collections::BTreeMap::new(),
            })
        }
        Err(_) => Err(corrupt("Library event payload is invalid")),
    }
}

const MAX_LEGACY_TRANSFER_STRING_LENGTH: usize = 512;
const MAX_SAFE_LEGACY_TRANSFER_INTEGER: i64 = 9_007_199_254_740_991;

fn has_exact_legacy_transfer_keys(
    object: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
) -> bool {
    required.iter().all(|key| object.contains_key(*key))
        && object.keys().all(|key| {
            required
                .iter()
                .chain(optional.iter())
                .any(|allowed| *allowed == key.as_str())
        })
}

fn is_valid_legacy_transfer_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(is_valid_legacy_transfer_string_value)
}

fn is_valid_legacy_transfer_string_value(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_LEGACY_TRANSFER_STRING_LENGTH && value.trim() == value
}

fn is_valid_legacy_transfer_optional_string(object: &Map<String, Value>, key: &str) -> bool {
    object
        .get(key)
        .is_none_or(|value| is_valid_legacy_transfer_string(Some(value)))
}

fn is_valid_legacy_transfer_integer(value: Option<&Value>, minimum: i64) -> bool {
    value
        .and_then(Value::as_i64)
        .is_some_and(|value| value >= minimum && value <= MAX_SAFE_LEGACY_TRANSFER_INTEGER)
}

fn is_valid_legacy_transfer_memberships(value: Option<&Value>) -> bool {
    let Some(memberships) = value.and_then(Value::as_object) else {
        return false;
    };
    !memberships.is_empty()
        && memberships.iter().all(|(root_block_id, membership)| {
            if !is_valid_legacy_transfer_string_value(root_block_id) {
                return false;
            }
            let Some(membership) = membership.as_object() else {
                return false;
            };
            has_exact_legacy_transfer_keys(membership, &["membershipId", "revision"], &[])
                && is_valid_legacy_transfer_string(membership.get("membershipId"))
                && is_valid_legacy_transfer_integer(membership.get("revision"), 1)
        })
}

fn is_valid_legacy_transfer_endpoint(value: Option<&Value>, source: bool) -> bool {
    let Some(object) = value.and_then(Value::as_object) else {
        return false;
    };
    let Some(kind) = object.get("kind").and_then(Value::as_str) else {
        return false;
    };
    match (source, kind) {
        (true, "space") => {
            has_exact_legacy_transfer_keys(object, &["kind"], &["libraryId"])
                && is_valid_legacy_transfer_optional_string(object, "libraryId")
        }
        (true, "document") => {
            has_exact_legacy_transfer_keys(
                object,
                &["kind", "documentId", "generation", "expectedHeadSeq"],
                &["pageId"],
            ) && is_valid_legacy_transfer_string(object.get("documentId"))
                && is_valid_legacy_transfer_optional_string(object, "pageId")
                && is_valid_legacy_transfer_integer(object.get("generation"), 1)
                && is_valid_legacy_transfer_integer(object.get("expectedHeadSeq"), 0)
        }
        (true, "database") => {
            has_exact_legacy_transfer_keys(
                object,
                &["kind", "databaseBlockId", "memberships"],
                &["dataSourceId"],
            ) && is_valid_legacy_transfer_string(object.get("databaseBlockId"))
                && is_valid_legacy_transfer_optional_string(object, "dataSourceId")
                && is_valid_legacy_transfer_memberships(object.get("memberships"))
        }
        (false, "space") => {
            has_exact_legacy_transfer_keys(object, &["kind"], &["libraryId", "beforeBlockId"])
                && is_valid_legacy_transfer_optional_string(object, "libraryId")
                && is_valid_legacy_transfer_optional_string(object, "beforeBlockId")
        }
        (false, "document") => {
            has_exact_legacy_transfer_keys(
                object,
                &["kind", "documentId", "generation", "expectedHeadSeq"],
                &["pageId", "parentBlockId", "beforeBlockId"],
            ) && is_valid_legacy_transfer_string(object.get("documentId"))
                && is_valid_legacy_transfer_optional_string(object, "pageId")
                && is_valid_legacy_transfer_optional_string(object, "parentBlockId")
                && is_valid_legacy_transfer_optional_string(object, "beforeBlockId")
                && is_valid_legacy_transfer_integer(object.get("generation"), 1)
                && is_valid_legacy_transfer_integer(object.get("expectedHeadSeq"), 0)
        }
        (false, "database") => {
            has_exact_legacy_transfer_keys(
                object,
                &["kind", "databaseBlockId", "viewId", "groupKey"],
                &["dataSourceId", "beforePageId"],
            ) && is_valid_legacy_transfer_string(object.get("databaseBlockId"))
                && is_valid_legacy_transfer_optional_string(object, "dataSourceId")
                && is_valid_legacy_transfer_string(object.get("viewId"))
                && matches!(object.get("groupKey"), Some(value) if value.is_null() || value.is_string())
                && is_valid_legacy_transfer_optional_string(object, "beforePageId")
        }
        _ => false,
    }
}

fn is_valid_legacy_typescript_library_payload(kind: &str, payload: &Value) -> bool {
    let Some(payload) = payload.as_object() else {
        return false;
    };
    if payload.contains_key("module") {
        return false;
    }
    let valid_hash = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| {
                value.len() == 64
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
    };
    let non_empty_string = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty() && value.trim() == value)
    };
    let non_negative_integer = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_i64)
            .is_some_and(|value| value >= 0)
    };
    let string_array = |key: &str, require_non_empty: bool| {
        let Some(values) = payload.get(key).and_then(Value::as_array) else {
            return false;
        };
        (!require_non_empty || !values.is_empty())
            && values.iter().all(|value| {
                value
                    .as_str()
                    .is_some_and(|value| !value.is_empty() && value.trim() == value)
            })
    };
    let nullable_string = |key: &str| {
        payload.get(key).is_some_and(|value| {
            value.is_null()
                || value
                    .as_str()
                    .is_some_and(|value| !value.is_empty() && value.trim() == value)
        })
    };

    match kind {
        "block_mutation" => {
            valid_hash("requestHash")
                && (non_empty_string("mutationKind")
                    || (payload.get("version").and_then(Value::as_i64) == Some(2)
                        && string_array("fieldPaths", false)
                        && payload.get("fieldChanges").is_some_and(Value::is_array)))
        }
        "block_relocation" => {
            valid_hash("requestHash")
                && string_array("rootBlockIds", true)
                && non_negative_integer("sourceHeadSeq")
                && non_negative_integer("targetHeadSeq")
                && nullable_string("targetParentBlockId")
                && nullable_string("targetBeforeBlockId")
        }
        "block_transfer" => {
            valid_hash("requestHash")
                && payload.get("version").and_then(Value::as_i64) == Some(1)
                && matches!(
                    payload.get("mode").and_then(Value::as_str),
                    Some("move" | "copy")
                )
                && is_valid_legacy_transfer_endpoint(payload.get("source"), true)
                && is_valid_legacy_transfer_endpoint(payload.get("target"), false)
        }
        _ => false,
    }
}

fn require_module(actual: &str, expected: &str) -> Result<(), StoreError> {
    if actual == expected {
        return Ok(());
    }
    Err(corrupt("Core event Module identity is inconsistent"))
}

fn require_module_kind(
    actual_module: &str,
    expected_module: &str,
    actual_kind: &str,
    expected_kind: &str,
) -> Result<(), StoreError> {
    require_module(actual_module, expected_module)?;
    if actual_kind == expected_kind {
        return Ok(());
    }
    Err(corrupt("Core event kind metadata is inconsistent"))
}

fn legacy_project_catalog_change(operation_kind: Option<&str>) -> Option<ProjectCatalogChangeKind> {
    match operation_kind {
        Some("create_project") => Some(ProjectCatalogChangeKind::Created),
        Some("set_project_lifecycle") => Some(ProjectCatalogChangeKind::LifecycleUpdated),
        Some("reorder_projects") => Some(ProjectCatalogChangeKind::Reordered),
        Some("set_project_pinned" | "reorder_pinned_projects") => {
            Some(ProjectCatalogChangeKind::PinUpdated)
        }
        Some("update_project") | None => Some(ProjectCatalogChangeKind::MetadataUpdated),
        Some(_) => Some(ProjectCatalogChangeKind::MetadataUpdated),
    }
}

fn legacy_session_summary_scopes(
    operation_kind: Option<&str>,
    project_ids: &[String],
    session_ids: &[String],
) -> Vec<ProjectSessionInvalidationScope> {
    if session_ids.is_empty() {
        return Vec::new();
    }
    if matches!(operation_kind, Some("move_session" | "move_thread")) {
        return vec![ProjectSessionInvalidationScope::All];
    }
    if project_ids.is_empty() {
        return vec![ProjectSessionInvalidationScope::Projectless];
    }
    project_ids
        .iter()
        .map(|project_id| ProjectSessionInvalidationScope::Project {
            project_id: project_id.clone(),
        })
        .collect()
}

fn validate_session_summary_scopes(
    scopes: &[ProjectSessionInvalidationScope],
) -> Result<(), StoreError> {
    if scopes.len() > MAX_EVENT_IDENTITIES {
        return Err(corrupt(
            "Project Workspace Session scope event list exceeds its bound",
        ));
    }
    for scope in scopes {
        if let ProjectSessionInvalidationScope::Project { project_id } = scope {
            validate_identity(project_id, "Project Workspace Session scope Project")?;
        }
    }
    Ok(())
}

fn validate_strings(values: &[String], label: &str) -> Result<(), StoreError> {
    if values.len() > MAX_EVENT_IDENTITIES {
        return Err(corrupt(&format!("{label} event list exceeds its bound")));
    }
    for value in values {
        validate_identity(value, label)?;
    }
    Ok(())
}

fn normalize_page_file_invalidations(
    mut invalidations: std::collections::BTreeMap<String, LibraryPageFileInvalidation>,
    legacy_revisions: std::collections::BTreeMap<String, i64>,
    label: &str,
) -> Result<std::collections::BTreeMap<String, LibraryPageFileInvalidation>, StoreError> {
    for (page_id, revision) in legacy_revisions {
        if invalidations
            .insert(page_id, LibraryPageFileInvalidation::Reset { revision })
            .is_some()
        {
            return Err(corrupt(&format!(
                "{label} event contains duplicate invalidation evidence"
            )));
        }
    }
    let mut exact_identity_count = 0_usize;
    for (page_id, invalidation) in &invalidations {
        validate_identity(page_id, &format!("{label} Page"))?;
        let (revision, file_ids) = match invalidation {
            LibraryPageFileInvalidation::Exact { revision, file_ids } => {
                (*revision, Some(file_ids))
            }
            LibraryPageFileInvalidation::Reset { revision } => (*revision, None),
        };
        if revision < 0 {
            return Err(corrupt(&format!("{label} revision is invalid")));
        }
        let Some(file_ids) = file_ids else {
            continue;
        };
        if file_ids.is_empty()
            || file_ids.len() > MAX_EVENT_IDENTITIES
            || file_ids.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(corrupt(&format!("{label} File identities are invalid")));
        }
        validate_strings(file_ids, &format!("{label} File"))?;
        exact_identity_count = exact_identity_count.saturating_add(file_ids.len());
        if exact_identity_count > MAX_EVENT_IDENTITIES {
            return Err(corrupt(&format!(
                "{label} exact invalidation evidence exceeds its bound"
            )));
        }
    }
    Ok(invalidations)
}

fn validate_personal_view_changes(
    changes: &[DatabasePersonalViewChange],
) -> Result<(), StoreError> {
    if changes.len() > MAX_EVENT_IDENTITIES {
        return Err(corrupt(
            "Database personal View change list exceeds its bound",
        ));
    }
    for change in changes {
        validate_identity(change.view_id(), "Database personal View")?;
        let DatabasePersonalViewChange::OccurrenceDisclosure { target, .. } = change else {
            continue;
        };
        let occurrence_key = target.occurrence_key();
        let matches_kind = match target {
            DatabaseViewDisclosureTarget::Group { .. } => occurrence_key.starts_with("GROUP_"),
            DatabaseViewDisclosureTarget::Page { .. } => occurrence_key.starts_with("ITEM_"),
        };
        if occurrence_key.is_empty() || occurrence_key.len() > 1_024 || !matches_kind {
            return Err(corrupt(
                "Database personal View occurrence target is invalid",
            ));
        }
    }
    Ok(())
}

fn validate_identity(value: &str, label: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.len() <= 512 && value.trim() == value {
        return Ok(());
    }
    Err(corrupt(&format!("{label} event identity is invalid")))
}

#[cfg(test)]
fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use nodex_core_contracts::{
        AdapterKind, BoundModuleContext, LibraryId, ProfileId, ProjectId, ResourceRevocation,
        ResourceRevocationReason, RevokedResourceKind,
        events::{DeliveryAtomPayload, DeliveryAuthorizationScope},
    };
    use rusqlite::OptionalExtension;
    use tempfile::tempdir;

    use super::*;
    use crate::infrastructure::module_receipts::{NewModuleReceipt, insert_module_receipt};
    use crate::infrastructure::store::SqliteStoreKernel;

    fn context(library_id: &str, project_id: &str) -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId("profile:events".to_owned()),
            library_id: LibraryId(library_id.to_owned()),
            project_id: Some(ProjectId(project_id.to_owned())),
            connection_id: format!("connection:{project_id}"),
            adapter: AdapterKind::Test,
        }
    }

    fn host_context(library_id: &str) -> BoundModuleContext {
        BoundModuleContext {
            editor_history_owner: None,
            profile_id: ProfileId("profile:events".to_owned()),
            library_id: LibraryId(library_id.to_owned()),
            project_id: None,
            connection_id: "connection:host".to_owned(),
            adapter: AdapterKind::ElectronHost,
        }
    }

    #[test]
    fn legacy_page_file_revisions_replay_as_reset_invalidations() {
        let invalidations = normalize_page_file_invalidations(
            BTreeMap::new(),
            BTreeMap::from([("page:test".to_owned(), 7)]),
            "Page File manifest",
        )
        .expect("normalize legacy invalidation");

        assert_eq!(
            invalidations.get("page:test"),
            Some(&LibraryPageFileInvalidation::Reset { revision: 7 })
        );
    }

    #[test]
    fn persisted_exact_page_file_invalidations_keep_their_file_id_evidence() {
        let exact = LibraryPageFileInvalidation::Exact {
            revision: 9,
            file_ids: vec!["file:a".to_owned(), "file:b".to_owned()],
        };
        let invalidations = normalize_page_file_invalidations(
            BTreeMap::from([("page:test".to_owned(), exact.clone())]),
            BTreeMap::new(),
            "Page File content",
        )
        .expect("normalize exact invalidation");

        assert_eq!(invalidations.get("page:test"), Some(&exact));
    }

    fn store_identity(connection: &Connection) -> Result<(String, String), StoreError> {
        let store_epoch = connection
            .query_row(
                "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| "epoch:events".to_owned());
        connection.execute(
            "INSERT OR IGNORE INTO block_store_metadata(id, store_epoch, created_at, updated_at)
             VALUES (1, ?1, '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z')",
            [&store_epoch],
        )?;
        connection.execute_batch(
            "INSERT OR IGNORE INTO profiles(id, created_at, updated_at)
             VALUES ( \
               'profile:events', '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z' \
             );
             INSERT OR IGNORE INTO libraries(id, profile_id, created_at, updated_at)
             VALUES ( \
               'library:events', 'profile:events', \
               '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z' \
             );",
        )?;
        let library_id = "library:events".to_owned();
        Ok((store_epoch, library_id))
    }

    fn append_finalized_test_event(
        connection: &Connection,
        module_name: &str,
        entry: NewChangeLogEntry<'_>,
    ) -> Result<i64, StoreError> {
        append_finalized_test_events_with_revocations(connection, module_name, vec![entry], &[])
    }

    fn append_finalized_test_event_with_revocations(
        connection: &Connection,
        module_name: &str,
        entry: NewChangeLogEntry<'_>,
        revocations: &[ResourceRevocation],
    ) -> Result<i64, StoreError> {
        append_finalized_test_events_with_revocations(
            connection,
            module_name,
            vec![entry],
            revocations,
        )
    }

    fn append_finalized_test_events(
        connection: &Connection,
        module_name: &str,
        entries: Vec<NewChangeLogEntry<'_>>,
    ) -> Result<i64, StoreError> {
        append_finalized_test_events_with_revocations(connection, module_name, entries, &[])
    }

    fn append_finalized_test_events_with_revocations(
        connection: &Connection,
        module_name: &str,
        entries: Vec<NewChangeLogEntry<'_>>,
        revocations: &[ResourceRevocation],
    ) -> Result<i64, StoreError> {
        let _ = store_identity(connection)?;
        let first = entries
            .first()
            .ok_or_else(|| corrupt("Test LocalCommit needs at least one effect"))?;
        let operation_id = first
            .operation_id
            .ok_or_else(|| corrupt("Test LocalCommit needs an operation identity"))?
            .to_owned();
        let store_epoch = first.store_epoch.to_owned();
        let project_id = first.project_id.to_owned();
        let committed_at = first.committed_at.to_owned();
        for entry in &entries {
            if entry.operation_id != Some(operation_id.as_str())
                || entry.project_id != project_id
                || entry.store_epoch != store_epoch
                || entry.committed_at != committed_at
            {
                return Err(corrupt("Test LocalCommit effects must share one identity"));
            }
        }
        let request_hash = format!(
            "{:x}",
            Sha256::digest(format!("{module_name}\0{operation_id}").as_bytes())
        );
        let commit = local_commit::begin(
            connection,
            &store_epoch,
            &operation_id,
            &request_hash,
            &committed_at,
        )?;
        let mut event_sequence = None;
        for entry in entries {
            event_sequence = Some(append_change_log(connection, entry, &commit)?);
        }
        let event_sequence =
            event_sequence.ok_or_else(|| corrupt("Test LocalCommit needs at least one effect"))?;
        for revocation in revocations {
            local_commit::record_revocation(connection, &commit, revocation)?;
        }
        let result = serde_json::json!({ "eventSequence": event_sequence });
        insert_module_receipt(
            connection,
            NewModuleReceipt {
                module_name,
                operation_id: &operation_id,
                context: &BoundModuleContext {
                    editor_history_owner: None,
                    profile_id: ProfileId("profile:events".to_owned()),
                    library_id: LibraryId("library:events".to_owned()),
                    project_id: Some(ProjectId(project_id)),
                    connection_id: "connection:events".to_owned(),
                    adapter: AdapterKind::Test,
                },
                operation_kind: "test_event",
                store_epoch: &store_epoch,
                request_hash: &request_hash,
                result: &result,
                event_sequence: Some(event_sequence),
                local_commit: Some(&commit),
                committed_at: &committed_at,
            },
        )?;
        local_commit::finalize(connection, &commit)?;
        Ok(event_sequence)
    }

    #[test]
    fn test_local_commit_fixture_rejects_mixed_store_epochs_before_allocation() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                let (store_epoch, _) = store_identity(connection)?;
                let other_store_epoch = format!("{store_epoch}:other");
                let before: i64 =
                    connection
                        .query_row("SELECT count(*) FROM local_commits", [], |row| row.get(0))?;
                let error = append_finalized_test_events(
                    connection,
                    "library",
                    vec![
                        NewChangeLogEntry {
                            project_id: "project:events",
                            store_epoch: &store_epoch,
                            kind: "library.changed",
                            operation_id: Some("fixture:mixed-epoch"),
                            block_ids: &[],
                            document_ids: &[],
                            database_block_ids: &[],
                            payload_json: "{}",
                            projection_impact: &ProjectionImpact::None,
                            committed_at: "2026-01-01T00:00:00.000Z",
                        },
                        NewChangeLogEntry {
                            project_id: "project:events",
                            store_epoch: &other_store_epoch,
                            kind: "library.changed",
                            operation_id: Some("fixture:mixed-epoch"),
                            block_ids: &[],
                            document_ids: &[],
                            database_block_ids: &[],
                            payload_json: "{}",
                            projection_impact: &ProjectionImpact::None,
                            committed_at: "2026-01-01T00:00:00.000Z",
                        },
                    ],
                )
                .expect_err("mixed Store epochs");
                assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
                assert_eq!(
                    error.message,
                    "Test LocalCommit effects must share one identity"
                );
                let after: i64 =
                    connection
                        .query_row("SELECT count(*) FROM local_commits", [], |row| row.get(0))?;
                assert_eq!(after, before);
                Ok(())
            })
            .expect("fixture identity validation");
    }

    #[test]
    fn legacy_typescript_library_payloads_reconstruct_as_library_events() {
        let row = ChangeLogRow {
            sequence: 1,
            project_id: "project:events".to_owned(),
            store_epoch: "epoch:events".to_owned(),
            kind: "block_transfer".to_owned(),
            operation_id: Some("operation:legacy-transfer".to_owned()),
            payload_json: r#"{
              "mode": "move",
              "requestHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "source": {"kind": "space"},
              "target": {"kind": "space"},
              "version": 1
            }"#
            .to_owned(),
            projection_impact_json: None,
            committed_at: "2026-08-07T00:00:00.000Z".to_owned(),
        };

        let connection = Connection::open_in_memory().expect("in-memory event connection");
        let event = reconstruct_event(&connection, &row)
            .expect("legacy Library payload should reconstruct")
            .expect("Library event should be present");

        assert!(matches!(event.payload, CoreModuleEventPayload::Library(_)));
    }

    #[test]
    fn legacy_typescript_library_payloads_require_complete_typed_envelopes() {
        let hash = "a".repeat(64);
        for (kind, payload) in [
            ("block_mutation", r#"{"mode":"move"}"#.to_owned()),
            (
                "block_mutation",
                format!(r#"{{"requestHash":"{hash}","mutationKind":1}}"#),
            ),
            (
                "block_relocation",
                format!(
                    r#"{{"requestHash":"{hash}","rootBlockIds":[],"sourceHeadSeq":0,"targetHeadSeq":1,"targetParentBlockId":null,"targetBeforeBlockId":null}}"#
                ),
            ),
            (
                "block_relocation",
                format!(
                    r#"{{"requestHash":"{hash}","rootBlockIds":["block:root"],"sourceHeadSeq":0,"targetHeadSeq":1}}"#
                ),
            ),
            (
                "block_transfer",
                format!(
                    r#"{{"requestHash":"{hash}","version":"1","mode":"move","source":{{"kind":"space"}},"target":{{"kind":"space"}}}}"#
                ),
            ),
            (
                "block_transfer",
                format!(
                    r#"{{"requestHash":"{hash}","version":1,"mode":"move","source":{{}},"target":{{"kind":"space"}}}}"#
                ),
            ),
            (
                "block_transfer",
                format!(
                    r#"{{"requestHash":"{hash}","version":1,"mode":"move","source":{{"kind":"space"}},"target":{{}}}}"#
                ),
            ),
            (
                "block_transfer",
                format!(
                    r#"{{"requestHash":"{hash}","version":1,"mode":"move","source":{{"kind":"document"}},"target":{{"kind":"space"}}}}"#
                ),
            ),
        ] {
            let row = ChangeLogRow {
                sequence: 1,
                project_id: "project:events".to_owned(),
                store_epoch: "epoch:events".to_owned(),
                kind: kind.to_owned(),
                operation_id: Some("operation:legacy".to_owned()),
                payload_json: payload,
                projection_impact_json: None,
                committed_at: "2026-08-07T00:00:00.000Z".to_owned(),
            };
            let error = match decode_library_metadata(&row) {
                Ok(_) => panic!("malformed legacy payload was accepted"),
                Err(error) => error,
            };
            assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
        }
    }

    #[test]
    fn ledger_append_canonicalizes_required_projection_impact() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        let encoded = kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, created, updated) \
                     VALUES ('project:events', 'Events', '2026-01-01', '2026-01-01')",
                    [],
                )?;
                let impact = ProjectionImpact::Resources {
                    page_ids: vec![
                        "page:b".to_owned(),
                        "page:a".to_owned(),
                        "page:a".to_owned(),
                    ],
                    database_ids: Vec::new(),
                    data_source_ids: Vec::new(),
                    view_ids: Vec::new(),
                    document_heads: Vec::new(),
                };
                append_finalized_test_event(
                    connection,
                    "project_workspace",
                    NewChangeLogEntry {
                        project_id: "project:events",
                        store_epoch: "epoch:events",
                        kind: "project_workspace.changed",
                        operation_id: Some("workspace:canonical-impact"),
                        block_ids: &[],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: r#"{
                          "module":"project_workspace",
                          "kind":"workspace_changed",
                          "projectIds":["project:events"]
                        }"#,
                        projection_impact: &impact,
                        committed_at: "2026-07-22T00:00:00Z",
                    },
                )?;
                connection
                    .query_row("SELECT projection_impact_json FROM change_log", [], |row| {
                        row.get::<_, String>(0)
                    })
                    .map_err(StoreError::from)
            })
            .expect("canonical append");

        assert_eq!(
            decode_projection_impact(&encoded).expect("stored canonical impact"),
            ProjectionImpact::Resources {
                page_ids: vec!["page:a".to_owned(), "page:b".to_owned()],
                database_ids: Vec::new(),
                data_source_ids: Vec::new(),
                view_ids: Vec::new(),
                document_heads: Vec::new(),
            }
        );
    }

    #[test]
    fn authorized_stream_boundaries_and_pages_use_epoch_indexes() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");

        kernel
            .readers()
            .read_default(|connection| {
                let bounds = connection
                    .prepare(&format!(
                        "EXPLAIN QUERY PLAN {AUTHORIZED_STREAM_BOUNDS_SQL}"
                    ))?
                    .query_map([], |row| row.get::<_, String>(3))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
                    .join("\n");
                assert!(
                    bounds.contains("SEARCH journal USING PRIMARY KEY (id=?)")
                        && bounds.contains("SEARCH metadata USING INTEGER PRIMARY KEY (rowid=?)",),
                    "stream boundaries lost their constant-time authority lookups:\n{bounds}",
                );

                let page = connection
                    .prepare(&format!("EXPLAIN QUERY PLAN {AUTHORIZED_STREAM_PAGE_SQL}"))?
                    .query_map(params!["epoch:test", 0, 257], |row| row.get::<_, String>(3))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
                    .join("\n");
                assert!(
                    page.contains("idx_local_commits_epoch_seq (store_epoch=? AND commit_seq>?)"),
                    "stream page lost its bounded epoch range lookup:\n{page}",
                );
                Ok(())
            })
            .expect("authorized stream query plans");
    }

    #[test]
    fn replays_typed_module_events_from_durable_change_log() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, created, updated) \
                     VALUES ('project:events', 'Events', '2026-01-01', '2026-01-01')",
                    [],
                )?;
                for (module_name, kind, operation_id, payload) in [
                    (
                        "library",
                        "library.changed",
                        "library:event",
                        serde_json::json!({
                            "module": "library",
                            "affectedPageIds": ["page:one"],
                            "affectedDatabaseIds": [],
                            "affectedParentKeys": ["library:events"]
                        }),
                    ),
                    (
                        "database",
                        "database.changed",
                        "database:event",
                        serde_json::json!({
                            "module": "database",
                            "kind": "database_changed",
                            "databaseIds": ["database:one"],
                            "dataSourceIds": ["source:one"],
                            "pageIds": [],
                            "viewIds": ["view:one"],
                            "personalViewChanges": [{
                                "kind": "occurrence_disclosure",
                                "view_id": "view:one",
                                "target": {
                                    "kind": "page",
                                    "occurrence_key": "ITEM_parent/child"
                                },
                                "collapsed": true
                            }]
                        }),
                    ),
                ] {
                    let payload = payload.to_string();
                    append_finalized_test_event(
                        connection,
                        module_name,
                        NewChangeLogEntry {
                            project_id: "project:events",
                            store_epoch: "epoch:events",
                            kind,
                            operation_id: Some(operation_id),
                            block_ids: &[],
                            document_ids: &[],
                            database_block_ids: &[],
                            payload_json: &payload,
                            projection_impact: &ProjectionImpact::None,
                            committed_at: "2026-01-01T00:00:00.000Z",
                        },
                    )?;
                }
                Ok(())
            })
            .expect("event fixtures");
        let event_log = CoreEventLog::new(kernel.readers());

        let CoreEventReplay::Events {
            events,
            commit_head,
        } = event_log.replay(0, None).expect("durable replay")
        else {
            panic!("expected replayed events");
        };
        assert_eq!(commit_head, 2);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0].effects[0].payload,
            CoreModuleEventPayload::Library(_)
        ));
        let CoreModuleEventPayload::Database(database_event) = &events[1].effects[0].payload else {
            panic!("expected Database event");
        };
        assert_eq!(
            database_event.personal_view_changes,
            vec![DatabasePersonalViewChange::OccurrenceDisclosure {
                view_id: "view:one".to_owned(),
                target: DatabaseViewDisclosureTarget::Page {
                    occurrence_key: "ITEM_parent/child".to_owned(),
                },
                collapsed: true,
            }]
        );
    }

    #[test]
    fn groups_multiple_physical_effects_into_one_semantic_local_commit() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, created, updated) \
                     VALUES ('project:events', 'Events', '2026-01-01', '2026-01-01')",
                    [],
                )?;
                let source_payload = serde_json::json!({
                    "module": "library",
                    "affectedPageIds": ["page:source"],
                    "affectedDatabaseIds": [],
                    "affectedParentKeys": ["library:events"]
                })
                .to_string();
                let target_payload = serde_json::json!({
                    "module": "library",
                    "affectedPageIds": ["page:target"],
                    "affectedDatabaseIds": [],
                    "affectedParentKeys": ["library:events"]
                })
                .to_string();
                append_finalized_test_events(
                    connection,
                    "library",
                    vec![
                        NewChangeLogEntry {
                            project_id: "project:events",
                            store_epoch: "epoch:events",
                            kind: "library.changed",
                            operation_id: Some("transfer:grouped"),
                            block_ids: &[],
                            document_ids: &[],
                            database_block_ids: &[],
                            payload_json: &source_payload,
                            projection_impact: &ProjectionImpact::None,
                            committed_at: "2026-01-01T00:00:00.000Z",
                        },
                        NewChangeLogEntry {
                            project_id: "project:events",
                            store_epoch: "epoch:events",
                            kind: "block_mutation",
                            operation_id: Some("transfer:grouped"),
                            block_ids: &[],
                            document_ids: &[],
                            database_block_ids: &[],
                            payload_json: &target_payload,
                            projection_impact: &ProjectionImpact::None,
                            committed_at: "2026-01-01T00:00:00.000Z",
                        },
                    ],
                )?;
                Ok(())
            })
            .expect("grouped event fixture");

        let CoreEventReplay::Events {
            events,
            commit_head,
        } = CoreEventLog::new(kernel.readers())
            .replay(0, None)
            .expect("grouped durable replay")
        else {
            panic!("expected grouped replay");
        };
        assert_eq!(commit_head, 1);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].commit_seq, 1);
        assert_eq!(events[0].effects.len(), 2);
    }

    #[test]
    fn rejects_tampered_local_commit_canonical_hash() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, created, updated) \
                     VALUES ('project:events', 'Events', '2026-01-01', '2026-01-01')",
                    [],
                )?;
                append_finalized_test_event(
                    connection,
                    "library",
                    NewChangeLogEntry {
                        project_id: "project:events",
                        store_epoch: "epoch:events",
                        kind: "library.changed",
                        operation_id: Some("library:tamper-proof"),
                        block_ids: &[],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: r#"{
                          "module":"library",
                          "affectedPageIds":["page:original"],
                          "affectedDatabaseIds":[],
                          "affectedParentKeys":["library:events"]
                        }"#,
                        projection_impact: &ProjectionImpact::None,
                        committed_at: "2026-01-01T00:00:00.000Z",
                    },
                )?;
                Ok(())
            })
            .expect("valid local commit fixture");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "UPDATE local_commits SET canonical_hash = ?1 WHERE operation_id = ?2",
                    params!["0".repeat(64), "library:tamper-proof"],
                )?;
                Ok(())
            })
            .expect("tamper fixture");

        let error = CoreEventLog::new(kernel.readers())
            .replay(0, None)
            .expect_err("tampered effect must fail replay");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
    }

    #[test]
    fn rejects_change_payload_bytes_that_diverge_from_effect_evidence() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, created, updated) \
                     VALUES ('project:events', 'Events', '2026-01-01', '2026-01-01')",
                    [],
                )?;
                append_finalized_test_event(
                    connection,
                    "library",
                    NewChangeLogEntry {
                        project_id: "project:events",
                        store_epoch: "epoch:events",
                        kind: "library.changed",
                        operation_id: Some("library:payload-evidence"),
                        block_ids: &[],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: r#"{
                          "module":"library",
                          "affectedPageIds":["page:original"],
                          "affectedDatabaseIds":[],
                          "affectedParentKeys":["library:events"]
                        }"#,
                        projection_impact: &ProjectionImpact::None,
                        committed_at: "2026-01-01T00:00:00.000Z",
                    },
                )?;
                connection.execute_batch(
                    "DROP TRIGGER change_log_is_immutable;
                     DROP TRIGGER prevent_change_log_projection_impact_update;",
                )?;
                connection.execute(
                    "UPDATE change_log SET payload_json = ?1 WHERE operation_id = ?2",
                    params![
                        r#"{"module":"library","affectedPageIds":["page:tampered"],"affectedDatabaseIds":[],"affectedParentKeys":["library:events"]}"#,
                        "library:payload-evidence"
                    ],
                )?;
                Ok(())
            })
            .expect("tampered payload fixture");

        let error = CoreEventLog::new(kernel.readers())
            .replay(0, None)
            .expect_err("payload bytes must remain bound to LocalCommit evidence");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
    }

    #[test]
    fn rejects_physical_effects_that_claim_a_different_project() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "INSERT INTO projects(id, name, created, updated)
                     VALUES ('project:events', 'Events', '2026-01-01', '2026-01-01');
                     INSERT INTO projects(id, name, created, updated)
                     VALUES ('project:other', 'Other', '2026-01-01', '2026-01-01');",
                )?;
                append_finalized_test_event(
                    connection,
                    "library",
                    NewChangeLogEntry {
                        project_id: "project:events",
                        store_epoch: "epoch:events",
                        kind: "library.changed",
                        operation_id: Some("library:project-evidence"),
                        block_ids: &[],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: r#"{
                          "module":"library",
                          "affectedPageIds":["page:original"],
                          "affectedDatabaseIds":[],
                          "affectedParentKeys":["library:events"]
                        }"#,
                        projection_impact: &ProjectionImpact::None,
                        committed_at: "2026-01-01T00:00:00.000Z",
                    },
                )?;
                connection.execute(
                    "UPDATE local_commit_effects SET project_id = 'project:other'",
                    [],
                )?;
                Ok(())
            })
            .expect("mismatched project fixture");

        let error = CoreEventLog::new(kernel.readers())
            .replay(0, None)
            .expect_err("effect evidence cannot escape its physical change");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
    }

    #[test]
    fn rejects_local_commit_effects_that_escape_the_parent_epoch() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        let error = kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, created, updated) \
                     VALUES ('project:events', 'Events', '2026-01-01', '2026-01-01')",
                    [],
                )?;
                let payload = serde_json::json!({
                    "module": "library",
                    "affectedPageIds": ["page:one"],
                    "affectedDatabaseIds": [],
                    "affectedParentKeys": ["library:events"]
                })
                .to_string();
                append_finalized_test_event(
                    connection,
                    "library",
                    NewChangeLogEntry {
                        project_id: "project:events",
                        store_epoch: "epoch:events",
                        kind: "library.changed",
                        operation_id: Some("transfer:epoch"),
                        block_ids: &[],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: &payload,
                        projection_impact: &ProjectionImpact::None,
                        committed_at: "2026-01-01T00:00:00.000Z",
                    },
                )?;
                connection.execute(
                    "UPDATE local_commit_effects SET store_epoch = 'epoch:other'",
                    [],
                )?;
                Ok(())
            })
            .expect_err("cross-epoch effect must fail the composite foreign key");
        assert_eq!(error.code, StoreErrorCode::SqliteFailure);
    }

    #[test]
    fn bounded_replay_requires_resync_instead_of_returning_a_partial_prefix() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, created, updated) \
                     VALUES ('project:events', 'Events', '2026-01-01', '2026-01-01')",
                    [],
                )?;
                for index in 0..3 {
                    let operation_id = format!("library:event:{index}");
                    let payload = serde_json::json!({
                        "module": "library",
                        "affectedPageIds": [format!("page:{index}")],
                        "affectedDatabaseIds": [],
                        "affectedParentKeys": ["library:events"]
                    })
                    .to_string();
                    append_finalized_test_event(
                        connection,
                        "library",
                        NewChangeLogEntry {
                            project_id: "project:events",
                            store_epoch: "epoch:events",
                            kind: "library.changed",
                            operation_id: Some(&operation_id),
                            block_ids: &[],
                            document_ids: &[],
                            database_block_ids: &[],
                            payload_json: &payload,
                            projection_impact: &ProjectionImpact::None,
                            committed_at: "2026-01-01T00:00:00.000Z",
                        },
                    )?;
                }
                Ok(())
            })
            .expect("event fixtures");
        let event_log = CoreEventLog::new(kernel.readers());

        assert!(matches!(
            event_log.replay(0, Some(2)).expect("bounded replay"),
            CoreEventReplay::ResyncRequired { commit_head: 3, .. }
        ));
    }

    #[test]
    fn corrupt_post_floor_projection_impact_fails_closed() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, created, updated) \
                     VALUES ('project:events', 'Events', '2026-01-01', '2026-01-01')",
                    [],
                )?;
                append_finalized_test_event(
                    connection,
                    "project_workspace",
                    NewChangeLogEntry {
                        project_id: "project:events",
                        store_epoch: "epoch:events",
                        kind: "project_workspace.changed",
                        operation_id: Some("workspace:corrupt-impact"),
                        block_ids: &[],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: r#"{
                          "module":"project_workspace",
                          "kind":"workspace_changed",
                          "projectIds":[],
                          "sessionIds":[],
                          "threadIds":[],
                          "sessionSummaryScopes":[],
                          "sessionDetailIds":[]
                        }"#,
                        projection_impact: &ProjectionImpact::None,
                        committed_at: "2026-07-22T00:00:00.000Z",
                    },
                )?;
                connection.execute_batch(
                    "DROP TRIGGER change_log_is_immutable;
                     DROP TRIGGER prevent_change_log_projection_impact_update;",
                )?;
                connection.execute(
                    "UPDATE change_log SET projection_impact_json = ?1 \
                     WHERE operation_id = 'workspace:corrupt-impact'",
                    [r#"{"kind":"resources","page_ids":["b","a"],"database_ids":[],"data_source_ids":[],"view_ids":[],"document_heads":[]}"#],
                )?;
                Ok(())
            })
            .expect("corrupt impact fixture");

        let error = CoreEventLog::new(kernel.readers())
            .replay(0, None)
            .expect_err("post-floor corruption must fail replay");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
    }

    #[test]
    fn upgrades_legacy_workspace_move_events_to_global_session_invalidation() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, created, updated) \
                     VALUES ('project:events', 'Events', '2026-01-01', '2026-01-01')",
                    [],
                )?;
                let payload = serde_json::json!({
                    "module": "project_workspace",
                    "operationKind": "move_session",
                    "kind": "workspace_changed",
                    "projectCatalogChanged": false,
                    "projectIds": ["project:events"],
                    "sessionIds": ["session:legacy"],
                    "threadIds": []
                })
                .to_string();
                append_finalized_test_event(
                    connection,
                    "project_workspace",
                    NewChangeLogEntry {
                        project_id: "project:events",
                        store_epoch: "epoch:events",
                        kind: "project_workspace.changed",
                        operation_id: Some("workspace:legacy-move"),
                        block_ids: &[],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: &payload,
                        projection_impact: &ProjectionImpact::None,
                        committed_at: "2026-01-01T00:00:00.000Z",
                    },
                )?;
                Ok(())
            })
            .expect("legacy event fixture");

        let CoreEventReplay::Events { events, .. } = CoreEventLog::new(kernel.readers())
            .replay(0, None)
            .expect("legacy replay")
        else {
            panic!("expected replayed legacy event");
        };
        let CoreModuleEventPayload::ProjectWorkspace(event) = &events[0].effects[0].payload else {
            panic!("expected Project Workspace event");
        };
        assert_eq!(
            event.session_summary_scopes,
            vec![ProjectSessionInvalidationScope::All]
        );
        assert_eq!(event.session_detail_ids, vec!["session:legacy"]);
    }

    #[test]
    fn authorized_scan_uses_explicit_checkpoint_across_sequence_gaps_and_filters() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        let (store_epoch, library_id, first_commit, second_commit) = kernel
            .writer()
            .call(|connection| {
                let (store_epoch, library_id) = store_identity(connection)?;
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated)
                     VALUES ('project:events', ?1, 'Events', '2026-01-01', '2026-01-01')",
                    [&library_id],
                )?;
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated)
                     VALUES ('project:other', ?1, 'Other', '2026-01-01', '2026-01-01')",
                    [&library_id],
                )?;
                append_finalized_test_event_with_revocations(
                    connection,
                    "project_workspace",
                    NewChangeLogEntry {
                        project_id: "project:events",
                        store_epoch: &store_epoch,
                        kind: "project_workspace.changed",
                        operation_id: Some("workspace:gap:first"),
                        block_ids: &[],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: r#"{
                          "module":"project_workspace","kind":"workspace_changed",
                          "projectIds":[],"sessionIds":[],"threadIds":[],
                          "sessionSummaryScopes":[],"sessionDetailIds":[]
                        }"#,
                        projection_impact: &ProjectionImpact::None,
                        committed_at: "2026-08-07T00:00:00Z",
                    },
                    &[ResourceRevocation {
                        authorization_scope: DeliveryAuthorizationScope::Project {
                            library_id: library_id.clone(),
                            project_id: "project:events".to_owned(),
                        },
                        resource_kind: RevokedResourceKind::Page,
                        resource_id: "page:first".to_owned(),
                        reason: ResourceRevocationReason::AccessRevoked,
                    }],
                )?;
                let first_commit = local_commit::head(connection)?;
                connection.execute(
                    "UPDATE sqlite_sequence SET seq = ?1 WHERE name = 'local_commits'",
                    [first_commit + 7],
                )?;
                append_finalized_test_event_with_revocations(
                    connection,
                    "project_workspace",
                    NewChangeLogEntry {
                        project_id: "project:events",
                        store_epoch: &store_epoch,
                        kind: "project_workspace.changed",
                        operation_id: Some("workspace:gap:second"),
                        block_ids: &[],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: r#"{
                          "module":"project_workspace","kind":"workspace_changed",
                          "projectIds":[],"sessionIds":[],"threadIds":[],
                          "sessionSummaryScopes":[],"sessionDetailIds":[]
                        }"#,
                        projection_impact: &ProjectionImpact::None,
                        committed_at: "2026-08-07T00:00:01Z",
                    },
                    &[ResourceRevocation {
                        authorization_scope: DeliveryAuthorizationScope::Project {
                            library_id: library_id.clone(),
                            project_id: "project:events".to_owned(),
                        },
                        resource_kind: RevokedResourceKind::Page,
                        resource_id: "page:second".to_owned(),
                        reason: ResourceRevocationReason::AccessRevoked,
                    }],
                )?;
                let second_commit = local_commit::head(connection)?;
                Ok((store_epoch, library_id, first_commit, second_commit))
            })
            .expect("gapped commit fixture");
        assert!(second_commit > first_commit + 1);
        let log = CoreEventLog::new(kernel.readers());

        let CoreAuthorizedEventReplay::Scan {
            packets,
            checkpoint,
            commit_head,
        } = log
            .scan_authorized(
                first_commit,
                None,
                "generation:test",
                &context(&library_id, "project:events"),
                None,
            )
            .expect("authorized scan")
        else {
            panic!("expected authorized scan");
        };
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0].manifest.identity.commit_seq, second_commit);
        assert_eq!(checkpoint.store_epoch.0, store_epoch);
        assert_eq!(checkpoint.scanned_through_seq, second_commit);
        assert_eq!(commit_head, second_commit);

        let CoreAuthorizedEventReplay::Scan {
            packets,
            checkpoint,
            ..
        } = log
            .scan_authorized(
                first_commit,
                None,
                "generation:test",
                &context(&library_id, "project:other"),
                None,
            )
            .expect("filtered scan")
        else {
            panic!("expected filtered scan");
        };
        assert!(packets.is_empty());
        assert_eq!(checkpoint.scanned_through_seq, second_commit);

        let project_scope = [DeliveryAuthorizationScope::Project {
            library_id: library_id.clone(),
            project_id: "project:events".to_owned(),
        }];
        let CoreAuthorizedEventReplay::Scan {
            packets,
            checkpoint,
            commit_head,
        } = log
            .scan_authorized_projection_live(
                0,
                Some(1),
                "generation:test",
                &host_context(&library_id),
                &project_scope,
            )
            .expect("first projection scan page")
        else {
            panic!("expected first projection scan page");
        };
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0].manifest.identity.commit_seq, first_commit);
        assert_eq!(checkpoint.scanned_through_seq, first_commit);
        assert_eq!(commit_head, second_commit);

        let CoreAuthorizedEventReplay::Scan {
            packets,
            checkpoint,
            commit_head,
        } = log
            .scan_authorized_projection_live(
                checkpoint.scanned_through_seq,
                Some(1),
                "generation:test",
                &host_context(&library_id),
                &project_scope,
            )
            .expect("second projection scan page")
        else {
            panic!("expected second projection scan page");
        };
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0].manifest.identity.commit_seq, second_commit);
        assert_eq!(checkpoint.scanned_through_seq, second_commit);
        assert_eq!(commit_head, second_commit);

        let unrelated_scope = [DeliveryAuthorizationScope::Project {
            library_id: library_id.clone(),
            project_id: "project:other".to_owned(),
        }];
        let CoreAuthorizedEventReplay::Scan {
            packets,
            checkpoint,
            ..
        } = log
            .scan_authorized_projection_live(
                0,
                None,
                "generation:test",
                &host_context(&library_id),
                &unrelated_scope,
            )
            .expect("zero-packet projection scan")
        else {
            panic!("expected zero-packet projection scan");
        };
        assert!(packets.is_empty());
        assert_eq!(checkpoint.scanned_through_seq, second_commit);
    }

    #[test]
    fn exact_document_live_delivery_skips_unrelated_manifest_reconstruction() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        let (store_epoch, library_id, commit_seq) = kernel
            .writer()
            .call(|connection| {
                let (store_epoch, library_id) = store_identity(connection)?;
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated)
                     VALUES ('project:events', ?1, 'Events', '2026-01-01', '2026-01-01')",
                    [&library_id],
                )?;
                append_finalized_test_event(
                    connection,
                    "project_workspace",
                    NewChangeLogEntry {
                        project_id: "project:events",
                        store_epoch: &store_epoch,
                        kind: "project_workspace.changed",
                        operation_id: Some("workspace:unrelated-to-document"),
                        block_ids: &[],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: r#"{
                          "module":"project_workspace","kind":"workspace_changed",
                          "projectIds":[],"sessionIds":[],"threadIds":[],
                          "sessionSummaryScopes":[],"sessionDetailIds":[]
                        }"#,
                        projection_impact: &ProjectionImpact::None,
                        committed_at: "2026-08-07T00:00:00Z",
                    },
                )?;
                let commit_seq = local_commit::head(connection)?;
                connection.execute(
                    "UPDATE local_commits SET canonical_hash = ?1
                     WHERE commit_seq = ?2",
                    params!["0".repeat(64), commit_seq],
                )?;
                Ok((store_epoch, library_id, commit_seq))
            })
            .expect("unrelated corrupt manifest fixture");
        let log = CoreEventLog::new(kernel.readers());

        let packet = log
            .authorized_document_live_delivery(
                commit_seq,
                &context(&library_id, "project:events"),
                "document:exact",
                &StoreEpoch(store_epoch.clone()),
                "generation:test",
                0,
            )
            .expect("unrelated commit bypasses manifest reconstruction");
        assert_eq!(packet, DocumentLiveDelivery::Unrelated);

        assert_eq!(
            log.document_live_routes(&store_epoch, commit_seq)
                .expect("Document routes"),
            Vec::<String>::new(),
        );
    }

    #[test]
    fn authorized_scan_returns_typed_resync_when_cursor_predates_retention() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        let (library_id, retained_commit) = kernel
            .writer()
            .call(|connection| {
                let (store_epoch, library_id) = store_identity(connection)?;
                connection.execute(
                    "INSERT INTO projects(id, library_id, name, created, updated)
                     VALUES ('project:events', ?1, 'Events', '2026-01-01', '2026-01-01')",
                    [&library_id],
                )?;
                for index in 0..2 {
                    append_finalized_test_event(
                        connection,
                        "project_workspace",
                        NewChangeLogEntry {
                            project_id: "project:events",
                            store_epoch: &store_epoch,
                            kind: "project_workspace.changed",
                            operation_id: Some(if index == 0 {
                                "workspace:retention:removed"
                            } else {
                                "workspace:retention:retained"
                            }),
                            block_ids: &[],
                            document_ids: &[],
                            database_block_ids: &[],
                            payload_json: r#"{
                              "module":"project_workspace","kind":"workspace_changed",
                              "projectIds":[],"sessionIds":[],"threadIds":[],
                              "sessionSummaryScopes":[],"sessionDetailIds":[]
                            }"#,
                            projection_impact: &ProjectionImpact::None,
                            committed_at: "2026-08-07T00:00:00Z",
                        },
                    )?;
                }
                let (removed_epoch, removed_commit) = connection.query_row(
                    "SELECT store_epoch, commit_seq FROM local_commits
                     ORDER BY commit_seq LIMIT 1",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )?;
                let removed_change = connection.query_row(
                    "SELECT change_log_seq FROM local_commit_effects
                     WHERE store_epoch = ?1 AND commit_seq = ?2",
                    params![removed_epoch, removed_commit],
                    |row| row.get::<_, i64>(0),
                )?;
                connection.execute(
                    "DELETE FROM core_module_receipts
                     WHERE store_epoch = ?1 AND local_commit_seq = ?2",
                    params![removed_epoch, removed_commit],
                )?;
                connection.execute(
                    "DELETE FROM local_commit_effects
                     WHERE store_epoch = ?1 AND commit_seq = ?2",
                    params![removed_epoch, removed_commit],
                )?;
                connection.execute("DELETE FROM change_log WHERE seq = ?1", [removed_change])?;
                connection.execute(
                    "DELETE FROM local_commits WHERE commit_seq = ?1",
                    [removed_commit],
                )?;
                connection.execute(
                    "UPDATE operational_journal_state \
                     SET replay_floor_seq = (SELECT min(commit_seq) FROM local_commits), \
                         retained_commit_count = 1, \
                         retained_delivery_bytes = COALESCE(( \
                           SELECT sum(delivery_bytes) FROM local_commit_retention_metadata \
                         ), 0)",
                    [],
                )?;
                Ok((library_id, local_commit::head(connection)?))
            })
            .expect("retention fixture");

        let replay = CoreEventLog::new(kernel.readers())
            .scan_authorized(
                0,
                None,
                "generation:test",
                &context(&library_id, "project:events"),
                None,
            )
            .expect("typed resync");
        let CoreAuthorizedEventReplay::ResyncRequired {
            oldest_available,
            commit_head,
            resync_token,
            ..
        } = replay
        else {
            panic!("cursor before retention must resync");
        };
        assert_eq!(oldest_available, retained_commit);
        assert_eq!(commit_head, retained_commit);
        assert_eq!(resync_token.len(), 64);
    }

    #[test]
    fn post_state_delivery_revokes_source_access_and_grants_target_access() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        let (store_epoch, library_id, commit_seq) = kernel
            .writer()
            .call(|connection| {
                let (store_epoch, library_id) = store_identity(connection)?;
                connection.execute_batch(
                    "INSERT INTO projects(id, library_id, name, created, updated)
                     VALUES ('project:a', 'library:events', 'A', '2026-08-07', '2026-08-07');
                     INSERT INTO projects(id, library_id, name, created, updated)
                     VALUES ('project:b', 'library:events', 'B', '2026-08-07', '2026-08-07');
                     INSERT INTO blocks(
                       id, library_id, type, lifecycle, placement_revision,
                       metadata_revision, created_at, updated_at
                     ) VALUES (
                       'page:moved', 'library:events', 'page', 'active', 1, 1,
                       '2026-08-07', '2026-08-07'
                     );
                     INSERT INTO documents(
                       id, library_id, generation, head_seq, schema_key, schema_version,
                       state_vector, state_hash, readiness, authority, created_at, updated_at,
                       sync_engine
                     ) VALUES (
                       'document:moved', 'library:events', 1, 0, 'nodex.page', 3,
                       X'', '', 'ready', 'ydoc_primary', '2026-08-07', '2026-08-07', 'yjs'
                     );
                     INSERT INTO block_documents(block_id, document_id, library_id, created_at)
                     VALUES ('page:moved', 'document:moved', 'library:events', '2026-08-07');
                     INSERT INTO pages(
                       block_id, library_id, document_id, parent_kind, parent_id,
                       created_at, updated_at
                     ) VALUES (
                       'page:moved', 'library:events', 'document:moved', 'library',
                       'library:events', '2026-08-07', '2026-08-07'
                     );
                     INSERT INTO library_block_placements(
                       block_id, library_id, rank_key, revision, created_at, updated_at
                     ) VALUES (
                       'page:moved', 'library:events', '7fffffffffffffffffffffffffffffff',
                       1, '2026-08-07', '2026-08-07'
                     );
                     INSERT INTO project_resource_grants(
                       id, project_id, library_id, root_kind, root_id, access,
                       recursive, revision, lifecycle, created_at, updated_at
                     ) VALUES (
                       'grant:moved-target', 'project:b', 'library:events', 'page',
                       'page:moved', 'read_write', 1, 1, 'active',
                       '2026-08-07', '2026-08-07'
                     );",
                )?;
                append_finalized_test_event_with_revocations(
                    connection,
                    "library",
                    NewChangeLogEntry {
                        project_id: "project:a",
                        store_epoch: &store_epoch,
                        kind: "library.changed",
                        operation_id: Some("page:move:a-to-b"),
                        block_ids: &["page:moved".to_owned()],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: r#"{
                          "module":"library","affectedPageIds":["page:moved"],
                          "affectedDatabaseIds":[],"affectedViewIds":[],
                          "affectedParentKeys":["library:events"]
                        }"#,
                        projection_impact: &ProjectionImpact::Resources {
                            page_ids: vec!["page:moved".to_owned()],
                            database_ids: Vec::new(),
                            data_source_ids: Vec::new(),
                            view_ids: Vec::new(),
                            document_heads: Vec::new(),
                        },
                        committed_at: "2026-08-07T00:00:00Z",
                    },
                    &[
                        ResourceRevocation {
                            authorization_scope: DeliveryAuthorizationScope::Project {
                                library_id: "library:events".to_owned(),
                                project_id: "project:a".to_owned(),
                            },
                            resource_kind: RevokedResourceKind::Page,
                            resource_id: "page:moved".to_owned(),
                            reason: ResourceRevocationReason::AccessRevoked,
                        },
                        ResourceRevocation {
                            authorization_scope: DeliveryAuthorizationScope::Project {
                                library_id: "library:events".to_owned(),
                                project_id: "project:a".to_owned(),
                            },
                            resource_kind: RevokedResourceKind::Document,
                            resource_id: "document:moved".to_owned(),
                            reason: ResourceRevocationReason::AccessRevoked,
                        },
                    ],
                )?;
                Ok((store_epoch, library_id, local_commit::head(connection)?))
            })
            .expect("cross-Project delivery fixture");
        let log = CoreEventLog::new(kernel.readers());

        let source = log
            .authorized_packet(commit_seq, &context(&library_id, "project:a"), None, true)
            .expect("source packet")
            .expect("source revocation packet");
        let target = log
            .authorized_packet(commit_seq, &context(&library_id, "project:b"), None, true)
            .expect("target packet")
            .expect("target delivery packet");
        let root = log
            .authorized_packet(
                commit_seq,
                &BoundModuleContext {
                    editor_history_owner: None,
                    profile_id: ProfileId("profile:events".to_owned()),
                    library_id: LibraryId(library_id.clone()),
                    project_id: None,
                    connection_id: "connection:root".to_owned(),
                    adapter: AdapterKind::Test,
                },
                None,
                true,
            )
            .expect("root packet")
            .expect("root delivery packet");
        let broker = log
            .authorized_packet_for_library_broker(
                commit_seq,
                &BoundModuleContext {
                    editor_history_owner: None,
                    profile_id: ProfileId("profile:events".to_owned()),
                    library_id: LibraryId(library_id.clone()),
                    project_id: Some(ProjectId("project:a".to_owned())),
                    connection_id: "connection:broker".to_owned(),
                    adapter: AdapterKind::ElectronHost,
                },
                true,
            )
            .expect("broker packet")
            .expect("broker delivery packet");

        assert_eq!(source.atoms.len(), 1);
        assert!(source.atoms.iter().all(|atom| {
            let DeliveryAtomPayload::Library { event, .. } = &atom.payload else {
                return false;
            };
            event.page_ids.is_empty()
                && event.database_ids.is_empty()
                && event.view_ids.is_empty()
                && event.parent_keys == ["library:events"]
        }));
        assert!(source.document_effects.is_empty());
        assert!(source.visibility_deltas.iter().any(|delta| {
            matches!(
                delta.change,
                nodex_core_contracts::VisibilityDeltaKind::Revoke { .. }
            ) && delta.roots.iter().any(|root| {
                matches!(
                    root,
                    nodex_core_contracts::ResourceKey::Page { page_id }
                        if page_id == "page:moved"
                )
            })
        }));
        assert_eq!(target.atoms.len(), 2);
        assert!(target.visibility_deltas.is_empty());
        assert_eq!(root.atoms.len(), 2);
        assert!(root.visibility_deltas.is_empty());
        assert!(matches!(
            source.authorization_scope,
            DeliveryAuthorizationScope::Project { ref project_id, .. }
                if project_id == "project:a"
        ));
        assert!(matches!(
            target.authorization_scope,
            DeliveryAuthorizationScope::Project { ref project_id, .. }
                if project_id == "project:b"
        ));
        assert!(matches!(
            root.authorization_scope,
            DeliveryAuthorizationScope::Library { .. }
        ));
        assert_eq!(broker, root);
        assert_eq!(
            log.authorized_document_live_delivery(
                commit_seq,
                &context(&library_id, "project:a"),
                "document:moved",
                &StoreEpoch(store_epoch),
                "generation:test",
                0,
            )
            .expect("source exact Document revocation"),
            DocumentLiveDelivery::AccessRevoked,
        );
        assert_eq!(
            source.manifest.identity.manifest_hash,
            target.manifest.identity.manifest_hash
        );
        assert_ne!(source.packet_hash, target.packet_hash);
        assert_ne!(source.packet_hash, root.packet_hash);
    }

    #[test]
    fn mixed_resource_event_delivers_visible_atom_without_hidden_sibling() {
        let directory = tempdir().expect("temporary Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("Core store");
        let (library_id, commit_seq) = kernel
            .writer()
            .call(|connection| {
                let (store_epoch, library_id) = store_identity(connection)?;
                connection.execute_batch(
                    "INSERT INTO projects(id, library_id, name, created, updated)
                     VALUES ('project:reader', 'library:events', 'Reader', '2026-08-07', '2026-08-07');
                     INSERT INTO projects(id, library_id, name, created, updated)
                     VALUES ('project:owner', 'library:events', 'Owner', '2026-08-07', '2026-08-07');
                     INSERT INTO blocks(
                       id, library_id, type, lifecycle, placement_revision,
                       metadata_revision, created_at, updated_at
                     ) VALUES
                     ('page:visible', 'library:events', 'page', 'active', 1, 1,
                       '2026-08-07', '2026-08-07'),
                     ('page:hidden', 'library:events', 'page', 'active', 1, 1,
                       '2026-08-07', '2026-08-07');
                     INSERT INTO documents(
                       id, library_id, generation, head_seq, schema_key, schema_version,
                       state_vector, state_hash, readiness, authority, created_at, updated_at,
                       sync_engine
                     ) VALUES
                     ('document:visible', 'library:events', 1, 0, 'nodex.page', 3,
                       X'', '', 'ready', 'ydoc_primary', '2026-08-07', '2026-08-07', 'yjs'),
                     ('document:hidden', 'library:events', 1, 0, 'nodex.page', 3,
                       X'', '', 'ready', 'ydoc_primary', '2026-08-07', '2026-08-07', 'yjs');
                     INSERT INTO block_documents(block_id, document_id, library_id, created_at)
                     VALUES
                     ('page:visible', 'document:visible', 'library:events', '2026-08-07'),
                     ('page:hidden', 'document:hidden', 'library:events', '2026-08-07');
                     INSERT INTO pages(
                       block_id, library_id, document_id, parent_kind, parent_id,
                       created_at, updated_at
                     ) VALUES
                     ('page:visible', 'library:events', 'document:visible', 'library',
                       'library:events', '2026-08-07', '2026-08-07'),
                     ('page:hidden', 'library:events', 'document:hidden', 'library',
                       'library:events', '2026-08-07', '2026-08-07');
                     INSERT INTO library_block_placements(
                       block_id, library_id, rank_key, revision, created_at, updated_at
                     ) VALUES
                     ('page:visible', 'library:events', '3fffffffffffffffffffffffffffffff',
                       1, '2026-08-07', '2026-08-07'),
                     ('page:hidden', 'library:events', '7fffffffffffffffffffffffffffffff',
                       1, '2026-08-07', '2026-08-07');
                     INSERT INTO project_resource_grants(
                       id, project_id, library_id, root_kind, root_id, access,
                       recursive, revision, lifecycle, created_at, updated_at
                     ) VALUES (
                       'grant:visible', 'project:reader', 'library:events', 'page',
                       'page:visible', 'read', 1, 1, 'active', '2026-08-07', '2026-08-07'
                     );",
                )?;
                append_finalized_test_event(
                    connection,
                    "library",
                    NewChangeLogEntry {
                        project_id: "project:owner",
                        store_epoch: &store_epoch,
                        kind: "library.changed",
                        operation_id: Some("library:mixed-resource"),
                        block_ids: &["page:visible".to_owned(), "page:hidden".to_owned()],
                        document_ids: &[],
                        database_block_ids: &[],
                        payload_json: r#"{
                          "module":"library",
                          "affectedPageIds":["page:visible","page:hidden"],
                          "affectedDatabaseIds":[],"affectedViewIds":[],
                          "affectedParentKeys":[]
                        }"#,
                        projection_impact: &ProjectionImpact::Resources {
                            page_ids: vec!["page:hidden".to_owned(), "page:visible".to_owned()],
                            database_ids: Vec::new(),
                            data_source_ids: Vec::new(),
                            view_ids: Vec::new(),
                            document_heads: Vec::new(),
                        },
                        committed_at: "2026-08-07T00:00:00Z",
                    },
                )?;
                Ok((library_id, local_commit::head(connection)?))
            })
            .expect("mixed-resource fixture");
        let packet = CoreEventLog::new(kernel.readers())
            .authorized_packet(
                commit_seq,
                &context(&library_id, "project:reader"),
                None,
                false,
            )
            .expect("resolve packet")
            .expect("visible sibling packet");

        assert_eq!(packet.atoms.len(), 1);
        let bytes = serde_json::to_string(&packet).expect("serialize packet");
        assert!(bytes.contains("page:visible"));
        assert!(!bytes.contains("page:hidden"));
        assert_eq!(packet.coverage.atom_ids.len(), 1);
    }
}
