use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::administration::StoreAdministrationEvent;
use nodex_core_contracts::events::{
    CommitIdentity, CommitManifest, DeliveryAtomDescriptor, DeliveryAtomKind, DeliveryAtomPayload,
    DeliveryAuthorizationScope, DocumentEffectRef, DocumentEffectResourceKind,
    LocalCommitReceiptRef, LocalProjectionPatch, LocalProjectionScope, PageDocumentHeadImpact,
    PhysicalEvidenceDigest, ProjectionEffect, ProjectionImpact, ResourceKey, ResourceRevocation,
    ResourceRevocationReason, RevokedResourceKind, RoutingClaim,
};
use nodex_core_contracts::{CORE_EVENT_VERSION, ModuleName, StoreEpoch};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::projection_impact::{canonicalize, decode, encode};
use super::projection_scope_head;
use super::sqlite::{StoreError, StoreErrorCode};

const CANONICAL_HASH_VERSION: u32 = 7;
const PROJECTION_SCHEMA_VERSION: u32 = 1;
const PHYSICAL_EFFECT_EVIDENCE_SQL: &str =
    "SELECT effect.effect_order, effect.change_log_seq, effect.project_id,
            change.project_id, effect.module_name, effect.effect_kind,
            change.operation_id, effect.resources_json, effect.payload_hash,
            change.payload_json, effect.projection_impact_json
     FROM local_commit_effects effect
     JOIN change_log change ON change.seq = effect.change_log_seq
     WHERE effect.store_epoch = ?1 AND effect.commit_seq = ?2
     ORDER BY effect.effect_order ASC";
const LIBRARY_EFFECT_EVIDENCE_SQL: &str =
    "SELECT effect.effect_order, effect.library_id, effect.module_name,
            effect.effect_kind, effect.operation_id, effect.payload_json,
            effect.payload_hash, parent.operation_id
     FROM local_commit_library_effects effect
     JOIN local_commits parent
       ON parent.store_epoch = effect.store_epoch
      AND parent.commit_seq = effect.commit_seq
     WHERE effect.store_epoch = ?1 AND effect.commit_seq = ?2
     ORDER BY effect.effect_order ASC";
const CANONICAL_DOCUMENT_EFFECTS_SQL: &str =
    "SELECT document_order, project_id, page_id, document_id, generation,
            base_head_seq, head_seq, update_id, update_hash, update_byte_length
     FROM local_commit_documents
     WHERE store_epoch = ?1 AND commit_seq = ?2
     ORDER BY document_order ASC, document_id ASC";
const CANONICAL_REVOCATIONS_SQL: &str =
    "SELECT scope_key, authorization_scope_json, resource_kind, resource_id, reason
     FROM local_commit_revocations
     WHERE store_epoch = ?1 AND commit_seq = ?2
     ORDER BY scope_key ASC, resource_kind ASC, resource_id ASC";
const CANONICAL_DELIVERY_ATOMS_SQL: &str =
    "SELECT atom_order, atom_id, atom_kind, required_resources_json,
            payload_json, payload_hash
     FROM local_commit_delivery_atoms
     WHERE store_epoch = ?1 AND commit_seq = ?2
     ORDER BY atom_order ASC";

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
struct CommitCursor {
    store_epoch: StoreEpoch,
    commit_seq: i64,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
struct CommitProjectionDraft {
    schema_version: u32,
    result_cursor: CommitCursor,
    impact: ProjectionImpact,
    patches: Vec<LocalProjectionPatch>,
    requires_read_at_least: Vec<LocalProjectionScope>,
    #[serde(default)]
    effects: Vec<ProjectionEffect>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
struct RoutingEvidence {
    library_id: String,
    project_ids: Vec<String>,
    document_ids: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) struct DocumentDeliveryResource {
    pub effect_order: i64,
    pub project_id: String,
    pub page_id: Option<String>,
    pub document_id: String,
    pub generation: i64,
    pub base_head_seq: i64,
    pub result_head_seq: i64,
    pub update_id: String,
    pub update_hash: String,
    pub update_byte_length: i64,
    pub resource_kind: DocumentEffectResourceKind,
    pub inline_update: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalCommitResourceMode {
    RefOnly,
    Inline,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommitContext {
    commit_seq: i64,
    store_epoch: String,
    operation_id: String,
    intent_hash: String,
    committed_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CommitCoordinate<'a> {
    store_epoch: &'a str,
    commit_seq: i64,
}

impl<'a> CommitCoordinate<'a> {
    pub(crate) fn new(store_epoch: &'a str, commit_seq: i64) -> Self {
        Self {
            store_epoch,
            commit_seq,
        }
    }
}

impl CommitContext {
    pub(crate) fn commit_seq(&self) -> i64 {
        self.commit_seq
    }

    pub(crate) fn store_epoch(&self) -> &str {
        &self.store_epoch
    }

    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(crate) fn committed_at(&self) -> &str {
        &self.committed_at
    }

    fn coordinate(&self) -> CommitCoordinate<'_> {
        CommitCoordinate::new(&self.store_epoch, self.commit_seq)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RegisteredPhysicalEffect<'a> {
    pub change_log_seq: i64,
    pub project_id: &'a str,
    pub module: ModuleName,
    pub kind: &'a str,
    pub operation_id: Option<&'a str>,
    pub resources: &'a PhysicalEffectResources,
    pub payload_hash: &'a str,
    pub projection_impact: &'a ProjectionImpact,
}

/// Private PhysicalJournal routing evidence. This is deliberately not part of
/// the Core contract: renderer delivery is described only by DeliveryAtoms.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct PhysicalEffectResources {
    pub block_ids: Vec<String>,
    pub document_ids: Vec<String>,
    pub database_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RegisteredDocumentEffect<'a> {
    pub project_id: &'a str,
    pub page_id: Option<&'a str>,
    pub document_id: &'a str,
    pub generation: i64,
    pub base_head_seq: i64,
    pub head_seq: i64,
    pub update_id: &'a str,
    pub update_hash: &'a str,
    pub update_byte_length: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalCommitRow {
    pub commit_seq: i64,
    pub store_epoch: String,
    pub operation_id: String,
    pub intent_hash: String,
    pub committed_at: String,
    projection: CommitProjectionDraft,
    pub receipt: LocalCommitReceiptRef,
    audience: RoutingEvidence,
    pub canonical_hash: String,
    pub manifest: Option<CommitManifest>,
}

pub(crate) struct VerifiedCommit {
    pub manifest: CommitManifest,
    pub(crate) sealed_projection_effects: Vec<SealedProjectionEffect>,
    #[cfg(test)]
    pub physical_effects: Vec<PhysicalEffectEvidence>,
    pub delivery_atoms: Vec<StoredDeliveryAtom>,
    document_effects: Vec<CanonicalDocumentEffect>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StoredDeliveryAtom {
    pub descriptor: DeliveryAtomDescriptor,
    pub payload: DeliveryAtomPayload,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct SealedProjectionEffect {
    pub transition: ProjectionEffect,
    pub subject: ResourceKey,
    pub required_resources: Vec<ResourceKey>,
    pub patch_hash: Option<String>,
}

#[derive(Serialize)]
struct CanonicalManifest<'a> {
    hash_version: u32,
    event_version: u32,
    store_epoch: &'a str,
    commit_seq: i64,
    operation_id: &'a str,
    intent_hash: &'a str,
    committed_at: &'a str,
    delivery_atoms: &'a [DeliveryAtomDescriptor],
    document_effects: &'a [DocumentEffectRef],
    projection_effects: &'a [ProjectionEffect],
    sealed_projection_effects: &'a [SealedProjectionEffect],
    visibility_deltas: &'a [CanonicalVisibilityDeltaEvidence],
    revocations: &'a [ResourceRevocation],
    receipt: &'a LocalCommitReceiptRef,
    routing_claims: &'a [RoutingClaim],
    physical_evidence: &'a PhysicalEvidenceDigest,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct CanonicalVisibilityDeltaEvidence {
    scope_key: String,
    authorization_scope_json: String,
    delta_kind: String,
    roots_json: String,
    delta_hash: String,
}

#[derive(Debug, Serialize)]
struct CanonicalPhysicalEffect {
    effect_order: i64,
    change_log_seq: i64,
    project_id: String,
    module: ModuleName,
    kind: String,
    operation_id: Option<String>,
    resources: PhysicalEffectResources,
    payload_hash: String,
    projection_impact: ProjectionImpact,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct CanonicalLibraryEffect {
    effect_order: i64,
    library_id: String,
    module: ModuleName,
    kind: String,
    operation_id: String,
    payload: StoreAdministrationEvent,
    payload_hash: String,
}

#[derive(Serialize)]
struct CanonicalPhysicalEvidence<'a> {
    physical_effects: &'a [CanonicalPhysicalEffect],
    library_effects: &'a [CanonicalLibraryEffect],
}

#[derive(Serialize)]
struct CanonicalAtomIdentity<'a> {
    hash_version: u32,
    store_epoch: &'a str,
    commit_seq: i64,
    atom_order: i64,
    kind: DeliveryAtomKind,
    required_resources: &'a [ResourceKey],
    payload_hash: &'a str,
}

#[derive(Clone, Debug, Serialize)]
struct CanonicalDocumentEffect {
    effect_order: i64,
    project_id: String,
    page_id: Option<String>,
    document_id: String,
    generation: i64,
    base_head_seq: i64,
    head_seq: i64,
    update_id: String,
    update_hash: String,
    update_byte_length: i64,
    resource_kind: DocumentEffectResourceKind,
}

pub(crate) type PhysicalEffectEvidence = (
    i64,
    i64,
    String,
    ModuleName,
    String,
    Option<String>,
    PhysicalEffectResources,
    String,
    ProjectionImpact,
);

pub(super) fn allocate(
    connection: &Connection,
    store_epoch: &str,
    operation_id: &str,
    intent_hash: &str,
    committed_at: &str,
) -> Result<CommitContext, StoreError> {
    validate_identity(store_epoch, "LocalCommit Store epoch")?;
    validate_identity(operation_id, "LocalCommit operation")?;
    validate_sha256(intent_hash, "LocalCommit intent hash")?;
    validate_timestamp(committed_at)?;
    let projection_impact_json = encode(&ProjectionImpact::None)?;
    let inserted = connection.execute(
        "INSERT OR IGNORE INTO local_commits(
           store_epoch, operation_id, committed_at, projection_impact_json,
           canonical_hash, intent_hash, projection_json, receipt_json,
           audience_json, finalized
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', '{}', '{}', 0)",
        params![
            store_epoch,
            operation_id,
            committed_at,
            projection_impact_json,
            empty_hash(),
            intent_hash,
        ],
    )?;
    if inserted == 0 {
        let existing = connection
            .query_row(
                "SELECT intent_hash, finalized FROM local_commits
                 WHERE store_epoch = ?1 AND operation_id = ?2",
                params![store_epoch, operation_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        let Some((existing_intent_hash, finalized)) = existing else {
            return Err(corrupt(
                "LocalCommit identity disappeared during allocation",
            ));
        };
        let message = if existing_intent_hash == intent_hash && finalized == 1 {
            "LocalCommit operation was already finalized; replay its receipt"
        } else {
            "LocalCommit operation identity was reused with another intent"
        };
        return Err(StoreError::new(
            StoreErrorCode::IdempotencyKeyReused,
            message,
            false,
        ));
    }
    let commit_seq = connection.last_insert_rowid();
    if commit_seq < 1 {
        return Err(corrupt("LocalCommit sequence allocation failed"));
    }
    Ok(CommitContext {
        commit_seq,
        store_epoch: store_epoch.to_owned(),
        operation_id: operation_id.to_owned(),
        intent_hash: intent_hash.to_owned(),
        committed_at: committed_at.to_owned(),
    })
}

// Test fixtures outside `infrastructure` may construct historical/corruption
// scenarios. Production domain modules cannot allocate LocalCommits directly;
// their only lifecycle entry point is `durable_mutation::run`.
#[cfg(test)]
pub(crate) fn begin(
    connection: &Connection,
    store_epoch: &str,
    operation_id: &str,
    intent_hash: &str,
    committed_at: &str,
) -> Result<CommitContext, StoreError> {
    allocate(
        connection,
        store_epoch,
        operation_id,
        intent_hash,
        committed_at,
    )
}

pub(crate) fn record_effect(
    connection: &Connection,
    context: &CommitContext,
    effect: RegisteredPhysicalEffect<'_>,
) -> Result<i64, StoreError> {
    assert_open(connection, context)?;
    if effect.change_log_seq < 1 {
        return Err(corrupt("LocalCommit physical effect sequence is invalid"));
    }
    validate_identity(effect.project_id, "LocalCommit effect Project")?;
    validate_identity(effect.kind, "LocalCommit effect kind")?;
    if let Some(operation_id) = effect.operation_id {
        validate_identity(operation_id, "LocalCommit physical operation")?;
    }
    validate_sha256(effect.payload_hash, "LocalCommit effect payload hash")?;
    let effect_epoch = connection
        .query_row(
            "SELECT store_epoch FROM change_log WHERE seq = ?1",
            [effect.change_log_seq],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if effect_epoch.as_deref() != Some(context.store_epoch.as_str()) {
        return Err(corrupt(
            "LocalCommit physical effect belongs to another Store epoch",
        ));
    }
    let effect_order: i64 = connection.query_row(
        "SELECT COALESCE(MAX(effect_order), -1) + 1
         FROM local_commit_effects WHERE store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch, context.commit_seq],
        |row| row.get(0),
    )?;
    let resources = canonicalize_resources(effect.resources.clone());
    let resources_json = serde_json::to_string(&resources)
        .map_err(|_| corrupt("LocalCommit effect resources are invalid"))?;
    let projection_impact = canonicalize(effect.projection_impact.clone())?;
    connection.execute(
        "INSERT INTO local_commit_effects(
           store_epoch, commit_seq, effect_order, change_log_seq, module_name,
           effect_kind, project_id, resources_json, payload_hash,
           projection_impact_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            context.store_epoch,
            context.commit_seq,
            effect_order,
            effect.change_log_seq,
            module_name(effect.module),
            effect.kind,
            effect.project_id,
            resources_json,
            effect.payload_hash,
            encode(&projection_impact)?,
        ],
    )?;
    Ok(effect_order)
}

/// Records a semantic Store Administration change at Library scope without
/// fabricating a Project-owned change-log row. The typed payload is retained
/// as immutable private evidence and compiled into a Library-authorized atom
/// only when the enclosing LocalCommit seals.
pub(crate) fn record_administration_effect(
    connection: &Connection,
    context: &CommitContext,
    library_id: &str,
    event: &StoreAdministrationEvent,
) -> Result<i64, StoreError> {
    assert_open(connection, context)?;
    validate_identity(library_id, "Store Administration effect Library")?;
    let library_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM libraries WHERE id = ?1)",
        [library_id],
        |row| row.get(0),
    )?;
    if !library_exists {
        return Err(corrupt(
            "Store Administration effect Library does not exist",
        ));
    }
    let payload_json = serde_json::to_string(event)
        .map_err(|_| corrupt("Store Administration effect payload is invalid"))?;
    let payload_hash = sha256(payload_json.as_bytes());
    let effect_order: i64 = connection.query_row(
        "SELECT COALESCE(MAX(effect_order), -1) + 1
         FROM local_commit_library_effects
         WHERE store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch, context.commit_seq],
        |row| row.get(0),
    )?;
    connection.execute(
        "INSERT INTO local_commit_library_effects(
           store_epoch, commit_seq, effect_order, library_id, module_name,
           effect_kind, operation_id, payload_json, payload_hash
         ) VALUES (?1, ?2, ?3, ?4, 'store_administration',
                   'store_administration.changed', ?5, ?6, ?7)",
        params![
            context.store_epoch,
            context.commit_seq,
            effect_order,
            library_id,
            context.operation_id,
            payload_json,
            payload_hash,
        ],
    )?;
    Ok(effect_order)
}

pub(crate) fn record_delivery_atoms(
    connection: &Connection,
    context: &CommitContext,
    drafts: impl IntoIterator<Item = super::delivery_atom::DeliveryAtomDraft>,
) -> Result<(), StoreError> {
    assert_open(connection, context)?;
    let mut atom_order: i64 = connection.query_row(
        "SELECT COALESCE(MAX(atom_order), -1) + 1
         FROM local_commit_delivery_atoms WHERE store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch, context.commit_seq],
        |row| row.get(0),
    )?;
    for draft in drafts {
        let mut required_resources = draft.required_resources;
        required_resources.sort();
        required_resources.dedup();
        if required_resources.is_empty()
            || super::delivery_atom::payload_claims(&draft.payload)? != required_resources
        {
            return Err(corrupt(
                "DeliveryAtom payload claims and authorization requirements diverge",
            ));
        }
        let payload_json = serde_json::to_string(&draft.payload)
            .map_err(|_| corrupt("DeliveryAtom payload is invalid"))?;
        let payload_hash = sha256(payload_json.as_bytes());
        let atom_id = atom_identity(
            context,
            atom_order,
            draft.kind,
            &required_resources,
            &payload_hash,
        )?;
        connection.execute(
            "INSERT INTO local_commit_delivery_atoms(
               store_epoch, commit_seq, atom_order, atom_id, atom_kind,
               required_resources_json, payload_json, payload_hash
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                context.store_epoch,
                context.commit_seq,
                atom_order,
                atom_id,
                delivery_atom_kind_name(draft.kind),
                serde_json::to_string(&required_resources)
                    .map_err(|_| corrupt("DeliveryAtom requirements are invalid"))?,
                payload_json,
                payload_hash,
            ],
        )?;
        atom_order = atom_order
            .checked_add(1)
            .ok_or_else(|| corrupt("DeliveryAtom order overflowed"))?;
    }
    Ok(())
}

fn atom_identity(
    context: &CommitContext,
    atom_order: i64,
    kind: DeliveryAtomKind,
    required_resources: &[ResourceKey],
    payload_hash: &str,
) -> Result<String, StoreError> {
    let encoded = serde_json::to_vec(&CanonicalAtomIdentity {
        hash_version: 1,
        store_epoch: &context.store_epoch,
        commit_seq: context.commit_seq,
        atom_order,
        kind,
        required_resources,
        payload_hash,
    })
    .map_err(|_| corrupt("DeliveryAtom identity is invalid"))?;
    Ok(sha256(&encoded))
}

fn canonicalize_identities(identities: &mut Vec<String>) {
    identities.sort();
    identities.dedup();
}

fn canonicalize_resources(mut resources: PhysicalEffectResources) -> PhysicalEffectResources {
    canonicalize_identities(&mut resources.block_ids);
    canonicalize_identities(&mut resources.document_ids);
    canonicalize_identities(&mut resources.database_ids);
    resources
}

pub(crate) fn record_document_effect(
    connection: &Connection,
    context: &CommitContext,
    effect: RegisteredDocumentEffect<'_>,
) -> Result<i64, StoreError> {
    assert_open(connection, context)?;
    validate_identity(effect.project_id, "LocalCommit Document Project")?;
    if let Some(page_id) = effect.page_id {
        validate_identity(page_id, "LocalCommit Document Page")?;
    }
    validate_identity(effect.document_id, "LocalCommit Document")?;
    validate_identity(effect.update_id, "LocalCommit Document update")?;
    validate_sha256(effect.update_hash, "LocalCommit Document update hash")?;
    // Yjs updates may legitimately commit from a stale causal base after
    // concurrent updates. The durable result sequence must advance that base,
    // but it need not be the immediately following sequence.
    if !valid_document_transition(
        effect.generation,
        effect.base_head_seq,
        effect.head_seq,
        effect.update_byte_length,
    ) {
        return Err(corrupt("LocalCommit Document head transition is invalid"));
    }
    let durable = connection
        .query_row(
            "SELECT update_hash, length(update_blob), base_head_seq
             FROM document_updates
             WHERE document_id = ?1 AND generation = ?2 AND seq = ?3 AND update_id = ?4",
            params![
                effect.document_id,
                effect.generation,
                effect.head_seq,
                effect.update_id,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    if durable
        != Some((
            effect.update_hash.to_owned(),
            effect.update_byte_length,
            effect.base_head_seq,
        ))
    {
        return Err(corrupt(
            "LocalCommit Document effect does not match its durable update",
        ));
    }
    let document_order: i64 = connection.query_row(
        "SELECT COALESCE(MAX(document_order), -1) + 1
         FROM local_commit_documents WHERE store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch, context.commit_seq],
        |row| row.get(0),
    )?;
    connection.execute(
        "INSERT INTO local_commit_documents(
           store_epoch, commit_seq, document_id, generation, head_seq,
           update_id, update_hash, document_order, project_id, page_id,
           base_head_seq, update_byte_length
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            context.store_epoch,
            context.commit_seq,
            effect.document_id,
            effect.generation,
            effect.head_seq,
            effect.update_id,
            effect.update_hash,
            document_order,
            effect.project_id,
            effect.page_id,
            effect.base_head_seq,
            effect.update_byte_length,
        ],
    )?;
    Ok(document_order)
}

pub(crate) fn record_projection_patch(
    connection: &Connection,
    context: &CommitContext,
    patch: LocalProjectionPatch,
) -> Result<(), StoreError> {
    let mut projection = draft_projection(connection, context)?;
    projection.patches.push(patch);
    write_projection(connection, context, &projection)
}

/// Record one semantic batch without decoding and rewriting its growing draft
/// once per affected resource. Finalization canonicalizes shared scope entries.
pub(crate) fn record_projection_batch(
    connection: &Connection,
    context: &CommitContext,
    patches: impl IntoIterator<Item = LocalProjectionPatch>,
    scopes: impl IntoIterator<Item = LocalProjectionScope>,
) -> Result<(), StoreError> {
    super::request_execution::check_request_interruption()?;
    let mut projection = draft_projection(connection, context)?;
    projection.patches.extend(patches);
    projection.requires_read_at_least.extend(scopes);
    write_projection(connection, context, &projection)
}

pub(crate) fn require_projection_read(
    connection: &Connection,
    context: &CommitContext,
    scope: LocalProjectionScope,
) -> Result<(), StoreError> {
    let mut projection = draft_projection(connection, context)?;
    if !projection.requires_read_at_least.contains(&scope) {
        projection.requires_read_at_least.push(scope);
    }
    write_projection(connection, context, &projection)
}

pub(crate) fn record_receipt(
    connection: &Connection,
    context: &CommitContext,
    receipt: &LocalCommitReceiptRef,
) -> Result<(), StoreError> {
    assert_open(connection, context)?;
    if receipt.operation_id != context.operation_id {
        return Err(corrupt("LocalCommit receipt operation identity diverges"));
    }
    validate_sha256(&receipt.result_hash, "LocalCommit receipt result hash")?;
    let encoded = serde_json::to_string(receipt)
        .map_err(|_| corrupt("LocalCommit receipt reference is invalid"))?;
    let changed = connection.execute(
        "UPDATE local_commits SET receipt_json = ?1
         WHERE store_epoch = ?2 AND commit_seq = ?3 AND finalized = 0",
        params![encoded, context.store_epoch, context.commit_seq],
    )?;
    if changed != 1 {
        return Err(corrupt("LocalCommit receipt parent is unavailable"));
    }
    Ok(())
}

pub(crate) fn record_revocation(
    connection: &Connection,
    context: &CommitContext,
    revocation: &ResourceRevocation,
) -> Result<(), StoreError> {
    assert_open(connection, context)?;
    validate_revocation(revocation)?;
    let scope_key = authorization_scope_key(&revocation.authorization_scope)?;
    let scope_json = serde_json::to_string(&revocation.authorization_scope)
        .map_err(|_| corrupt("LocalCommit revocation scope is invalid"))?;
    let resource_kind = revoked_resource_kind_name(revocation.resource_kind);
    let reason = revocation_reason_name(revocation.reason);
    connection.execute(
        "INSERT INTO local_commit_revocations(
           store_epoch, commit_seq, scope_key, authorization_scope_json,
           resource_kind, resource_id, reason
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(store_epoch, commit_seq, scope_key, resource_kind, resource_id)
         DO NOTHING",
        params![
            context.store_epoch,
            context.commit_seq,
            scope_key,
            scope_json,
            resource_kind,
            revocation.resource_id,
            reason,
        ],
    )?;
    let stored = connection.query_row(
        "SELECT authorization_scope_json, reason
         FROM local_commit_revocations
         WHERE store_epoch = ?1 AND commit_seq = ?2 AND scope_key = ?3
           AND resource_kind = ?4 AND resource_id = ?5",
        params![
            context.store_epoch,
            context.commit_seq,
            scope_key,
            resource_kind,
            revocation.resource_id,
        ],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )?;
    if stored != (scope_json, reason.to_owned()) {
        return Err(corrupt("LocalCommit revocation identity collision"));
    }
    Ok(())
}

/// Registers Blocks removed from a Document without terminal deletion. The
/// LocalCommit cannot seal until every identity has exactly one replacement
/// authority, preventing source-only relocations from leaving active orphans.
pub(crate) fn register_relocation_obligations(
    connection: &Connection,
    context: &CommitContext,
    source_document_id: &str,
    block_ids: &[String],
) -> Result<(), StoreError> {
    assert_open(connection, context)?;
    for block_id in block_ids {
        connection.execute(
            "INSERT OR IGNORE INTO local_commit_relocation_obligations( \
               store_epoch, commit_seq, block_id, source_document_id \
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                context.store_epoch,
                context.commit_seq,
                block_id,
                source_document_id,
            ],
        )?;
        let stored_source = connection.query_row(
            "SELECT source_document_id FROM local_commit_relocation_obligations \
             WHERE store_epoch = ?1 AND commit_seq = ?2 AND block_id = ?3",
            params![context.store_epoch, context.commit_seq, block_id],
            |row| row.get::<_, String>(0),
        )?;
        if stored_source != source_document_id {
            return Err(corrupt(
                "One LocalCommit detached a Block from multiple source Documents",
            ));
        }
    }
    Ok(())
}

fn validate_and_clear_relocation_obligations(
    connection: &Connection,
    context: &CommitContext,
) -> Result<(), StoreError> {
    let obligations = connection
        .prepare(
            "SELECT block_id, source_document_id \
             FROM local_commit_relocation_obligations \
             WHERE store_epoch = ?1 AND commit_seq = ?2 ORDER BY block_id",
        )?
        .query_map(params![context.store_epoch, context.commit_seq], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (block_id, source_document_id) in &obligations {
        let (
            lifecycle,
            document_locations,
            source_locations,
            library_locations,
            data_source_parent,
        ) = connection.query_row(
            "SELECT block.lifecycle, \
                   (SELECT count(*) FROM document_block_index entry \
                    WHERE entry.block_id = block.id), \
                   (SELECT count(*) FROM document_block_index entry \
                    WHERE entry.block_id = block.id AND entry.document_id = ?2), \
                   (SELECT count(*) FROM library_block_placements placement \
                    WHERE placement.block_id = block.id), \
                   EXISTS( \
                     SELECT 1 \
                     FROM pages page \
                     JOIN data_source_page_memberships membership \
                       ON membership.page_block_id = page.block_id \
                      AND membership.data_source_id = page.parent_id \
                      AND membership.removed_at IS NULL \
                     WHERE page.block_id = block.id \
                       AND page.library_id = block.library_id \
                       AND page.parent_kind = 'data_source' \
                   ) \
                 FROM blocks block WHERE block.id = ?1",
            params![block_id, source_document_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, bool>(4)?,
                ))
            },
        )?;
        let location_count = document_locations + library_locations + i64::from(data_source_parent);
        if lifecycle != "active" || source_locations != 0 || location_count != 1 {
            return Err(corrupt(&format!(
                "Relocated Block {block_id} did not finish at exactly one destination authority"
            )));
        }
    }
    connection.execute(
        "DELETE FROM local_commit_relocation_obligations \
         WHERE store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch, context.commit_seq],
    )?;
    Ok(())
}

pub(super) fn seal(connection: &Connection, context: &CommitContext) -> Result<i64, StoreError> {
    assert_open(connection, context)?;
    super::visibility_delta_journal::validate_seal(connection, context)?;
    validate_and_clear_relocation_obligations(connection, context)?;
    let effect_count: i64 = connection.query_row(
        "SELECT count(*) FROM local_commit_effects
         WHERE store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch, context.commit_seq],
        |row| row.get(0),
    )?;
    let document_count: i64 = connection.query_row(
        "SELECT count(*) FROM local_commit_documents
         WHERE store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch, context.commit_seq],
        |row| row.get(0),
    )?;
    let library_effect_count: i64 = connection.query_row(
        "SELECT count(*) FROM local_commit_library_effects
         WHERE store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch, context.commit_seq],
        |row| row.get(0),
    )?;
    if effect_count == 0 && document_count == 0 && library_effect_count == 0 {
        return Err(corrupt("LocalCommit has no semantic effects"));
    }

    let effects = canonical_effects(connection, context.coordinate())?;
    let library_effects = canonical_library_effects(connection, context.coordinate())?;
    let document_effects = canonical_document_effects(connection, context.coordinate())?;
    let revocations = canonical_revocations(connection, context.coordinate())?;
    let audience = derive_audience(
        connection,
        context.commit_seq,
        &effects,
        &library_effects,
        &document_effects,
    )?;
    compile_delivery_atoms(connection, context, &audience, &effects, &library_effects)?;
    let delivery_atoms = canonical_delivery_atoms(connection, context)?;
    let impact = merged_projection_impact(&effects)?;
    let mut projection = draft_projection(connection, context)?;
    projection.impact = impact.clone();
    projection.result_cursor = CommitCursor {
        store_epoch: StoreEpoch(context.store_epoch.clone()),
        commit_seq: context.commit_seq,
    };
    if projection.requires_read_at_least.is_empty() && projection.patches.is_empty() {
        projection.requires_read_at_least =
            default_projection_scopes(connection, &impact, &audience.project_ids)?;
    }
    canonicalize_projection(&mut projection);
    projection.effects = seal_projection_effects(connection, context, &projection)?;
    let sealed_projection_effects = sealed_projection_effects(&projection.effects)?;
    persist_sealed_projection_effects(connection, context, &sealed_projection_effects)?;

    let receipt = read_required_receipt(connection, context.commit_seq)?;
    let visibility_deltas = canonical_visibility_deltas(connection, context.coordinate())?;
    let manifest = compile_manifest(
        context,
        ManifestEvidence {
            effects: &effects,
            library_effects: &library_effects,
            atoms: &delivery_atoms,
            documents: &document_effects,
            projection: &projection,
            visibility_deltas: &visibility_deltas,
            revocations: &revocations,
            receipt: &receipt,
            audience: &audience,
        },
    )?;
    let projection_json = serde_json::to_string(&projection)
        .map_err(|_| corrupt("LocalCommit projection is invalid"))?;
    let audience_json =
        serde_json::to_string(&audience).map_err(|_| corrupt("LocalCommit audience is invalid"))?;
    let manifest_json =
        serde_json::to_string(&manifest).map_err(|_| corrupt("CommitManifest is invalid"))?;
    let sealed_at_ms = connection.query_row(
        "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    let child_bytes = connection.query_row(
        "SELECT COALESCE(SUM(byte_length), 0) FROM (\
           SELECT length(resources_json) + length(projection_impact_json) AS byte_length \
             FROM local_commit_effects WHERE store_epoch = ?1 AND commit_seq = ?2 \
           UNION ALL \
           SELECT length(required_resources_json) + length(payload_json) \
             FROM local_commit_delivery_atoms WHERE store_epoch = ?1 AND commit_seq = ?2 \
           UNION ALL \
           SELECT length(descriptor_json) FROM local_commit_sealed_projection_effects \
             WHERE store_epoch = ?1 AND commit_seq = ?2 \
           UNION ALL \
           SELECT update_byte_length FROM local_commit_documents \
             WHERE store_epoch = ?1 AND commit_seq = ?2\
         )",
        params![context.store_epoch, context.commit_seq],
        |row| row.get::<_, i64>(0),
    )?;
    let delivery_bytes =
        i64::try_from(projection_json.len() + audience_json.len() + manifest_json.len())
            .map_err(|_| corrupt("LocalCommit delivery size exceeds SQLite bounds"))?
            .checked_add(child_bytes)
            .ok_or_else(|| corrupt("LocalCommit delivery size overflowed"))?;
    super::operational_journal::ensure_capacity_for_seal(connection, delivery_bytes)?;
    let changed = connection.execute(
        "UPDATE local_commits
         SET projection_impact_json = ?1, projection_json = ?2,
             audience_json = ?3, canonical_hash = ?4, manifest_json = ?5,
             finalized = 1
         WHERE store_epoch = ?6 AND commit_seq = ?7 AND finalized = 0",
        params![
            encode(&impact)?,
            projection_json,
            audience_json,
            manifest.identity.manifest_hash,
            manifest_json,
            context.store_epoch,
            context.commit_seq,
        ],
    )?;
    if changed != 1 {
        return Err(corrupt("LocalCommit finalization lost its open parent"));
    }
    connection.execute(
        "INSERT INTO local_commit_retention_metadata( \
           store_epoch, commit_seq, sealed_at_ms, delivery_bytes \
         ) VALUES (?1, ?2, ?3, ?4)",
        params![
            context.store_epoch,
            context.commit_seq,
            sealed_at_ms,
            delivery_bytes,
        ],
    )?;
    let advanced = connection.execute(
        "UPDATE operational_journal_state \
         SET commit_head_seq = ?1, \
             replay_floor_seq = CASE WHEN replay_floor_seq = 0 THEN ?1 ELSE replay_floor_seq END, \
             retained_commit_count = retained_commit_count + 1, \
             retained_delivery_bytes = retained_delivery_bytes + ?3, \
             updated_at = ?2 \
         WHERE id = 1 AND commit_head_seq < ?1",
        params![
            context.commit_seq,
            super::operational_journal::timestamp_from_ms(sealed_at_ms)?,
            delivery_bytes,
        ],
    )?;
    if advanced != 1 {
        return Err(corrupt("LocalCommit head did not advance monotonically"));
    }
    super::operational_journal::refresh_delivery_pressure(connection)?;
    Ok(context.commit_seq)
}

#[cfg(test)]
pub(crate) fn finalize(
    connection: &Connection,
    context: &CommitContext,
) -> Result<i64, StoreError> {
    seal(connection, context)
}

/// Compiles delivery artifacts only after every domain write and supporting
/// receipt is present. Some owning Modules (notably Canvas) deliberately write
/// physical evidence before their supporting receipt; compiling at journal
/// append time would observe a transient, internally inconsistent state.
fn compile_delivery_atoms(
    connection: &Connection,
    context: &CommitContext,
    audience: &RoutingEvidence,
    effects: &[CanonicalPhysicalEffect],
    library_effects: &[CanonicalLibraryEffect],
) -> Result<(), StoreError> {
    let existing_count: i64 = connection.query_row(
        "SELECT count(*) FROM local_commit_delivery_atoms
         WHERE store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch, context.commit_seq],
        |row| row.get(0),
    )?;
    if existing_count != 0 {
        return Err(corrupt(
            "LocalCommit delivery artifacts were compiled before sealing",
        ));
    }
    for effect in effects {
        let event =
            super::event_log::load_committed_event_by_sequence(connection, effect.change_log_seq)?;
        if event.payload.module_name() != effect.module {
            return Err(corrupt(
                "DeliveryAtom source Module diverges from physical evidence",
            ));
        }
        let drafts = super::delivery_atom::compile(
            connection,
            &audience.library_id,
            &effect.project_id,
            event.payload,
        )?;
        record_delivery_atoms(connection, context, drafts)?;
    }
    for effect in library_effects {
        if effect.module != ModuleName::StoreAdministration {
            return Err(corrupt("Library-scoped effect Module is unsupported"));
        }
        let drafts = super::delivery_atom::compile_store_administration(
            &effect.library_id,
            effect.payload.clone(),
        )?;
        record_delivery_atoms(connection, context, drafts)?;
    }
    Ok(())
}

/// Discards a deliberately unused transaction context for a validated no-op
/// or rejected mutation. Any registered evidence makes abandonment fail
/// closed so callers cannot erase a partially built semantic commit.
pub(crate) fn abandon(connection: &Connection, context: &CommitContext) -> Result<(), StoreError> {
    assert_open(connection, context)?;
    let evidence_count: i64 = connection.query_row(
        "SELECT
           (SELECT count(*) FROM local_commit_effects
             WHERE store_epoch = ?1 AND commit_seq = ?2)
         + (SELECT count(*) FROM local_commit_documents
             WHERE store_epoch = ?1 AND commit_seq = ?2)
         + (SELECT count(*) FROM local_commit_revocations
             WHERE store_epoch = ?1 AND commit_seq = ?2)
         + (SELECT count(*) FROM local_commit_delivery_atoms
             WHERE store_epoch = ?1 AND commit_seq = ?2)
         + (SELECT count(*) FROM local_commit_library_effects
             WHERE store_epoch = ?1 AND commit_seq = ?2)
         + (SELECT count(*) FROM core_module_receipts
             WHERE store_epoch = ?1 AND local_commit_seq = ?2)",
        params![context.store_epoch, context.commit_seq],
        |row| row.get(0),
    )?;
    if evidence_count != 0 {
        return Err(corrupt(
            "LocalCommit with registered evidence cannot be abandoned",
        ));
    }
    let deleted = connection.execute(
        "DELETE FROM local_commits
         WHERE store_epoch = ?1 AND commit_seq = ?2 AND finalized = 0",
        params![context.store_epoch, context.commit_seq],
    )?;
    if deleted != 1 {
        return Err(corrupt("Unused LocalCommit parent could not be abandoned"));
    }
    Ok(())
}

pub(crate) fn head(connection: &Connection) -> Result<i64, StoreError> {
    let head = connection.query_row(
        "SELECT commit_head_seq FROM operational_journal_state WHERE id = 1",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    if head < 0 {
        return Err(corrupt("LocalCommit head is invalid"));
    }
    Ok(head)
}

pub(crate) fn read_commit(
    connection: &Connection,
    commit_seq: i64,
) -> Result<Option<LocalCommitRow>, StoreError> {
    let raw = connection
        .query_row(
            "SELECT commit_seq, store_epoch, operation_id, intent_hash, committed_at,
                    projection_json, receipt_json, audience_json, canonical_hash,
                    manifest_json
             FROM local_commits WHERE commit_seq = ?1 AND finalized = 1",
            [commit_seq],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            },
        )
        .optional()?;
    let Some((
        commit_seq,
        store_epoch,
        operation_id,
        intent_hash,
        committed_at,
        projection_json,
        receipt_json,
        audience_json,
        canonical_hash,
        manifest_json,
    )) = raw
    else {
        return Ok(None);
    };
    validate_sha256(&intent_hash, "LocalCommit intent hash")?;
    validate_sha256(&canonical_hash, "LocalCommit canonical hash")?;
    Ok(Some(LocalCommitRow {
        commit_seq,
        store_epoch,
        operation_id,
        intent_hash,
        committed_at,
        projection: decode_json(&projection_json, "LocalCommit projection")?,
        receipt: decode_json(&receipt_json, "LocalCommit receipt")?,
        audience: decode_json(&audience_json, "LocalCommit audience")?,
        canonical_hash,
        manifest: manifest_json
            .filter(|raw| raw != "{}")
            .map(|raw| decode_json(&raw, "CommitManifest"))
            .transpose()?,
    }))
}

pub(crate) fn physical_effect_evidence(
    connection: &Connection,
    coordinate: CommitCoordinate<'_>,
) -> Result<Vec<PhysicalEffectEvidence>, StoreError> {
    connection
        .prepare_cached(PHYSICAL_EFFECT_EVIDENCE_SQL)?
        .query_map(
            params![coordinate.store_epoch, coordinate.commit_seq],
            |row| {
                let effect_project_id = row.get::<_, String>(2)?;
                let change_project_id = row.get::<_, String>(3)?;
                if effect_project_id != change_project_id {
                    return Err(rusqlite::Error::InvalidColumnType(
                        3,
                        "change.project_id".to_owned(),
                        rusqlite::types::Type::Text,
                    ));
                }
                let module_raw = row.get::<_, String>(4)?;
                let resources_raw = row.get::<_, String>(7)?;
                let payload_hash = row.get::<_, String>(8)?;
                let payload_json = row.get::<_, String>(9)?;
                if payload_hash != sha256(payload_json.as_bytes()) {
                    return Err(rusqlite::Error::InvalidColumnType(
                        9,
                        "change.payload_json".to_owned(),
                        rusqlite::types::Type::Text,
                    ));
                }
                let impact_raw = row.get::<_, String>(10)?;
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    effect_project_id,
                    parse_module_sql(&module_raw)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    serde_json::from_str(&resources_raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            resources_raw.len(),
                            rusqlite::types::Type::Text,
                            error.into(),
                        )
                    })?,
                    payload_hash,
                    decode(&impact_raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            impact_raw.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("LocalCommit physical effect evidence is invalid"))
}

fn canonical_library_effects(
    connection: &Connection,
    coordinate: CommitCoordinate<'_>,
) -> Result<Vec<CanonicalLibraryEffect>, StoreError> {
    let rows = connection
        .prepare_cached(LIBRARY_EFFECT_EVIDENCE_SQL)?
        .query_map(
            params![coordinate.store_epoch, coordinate.commit_seq],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut effects = Vec::with_capacity(rows.len());
    for (expected_order, row) in rows.into_iter().enumerate() {
        let (
            effect_order,
            library_id,
            module_raw,
            kind,
            operation_id,
            payload_json,
            payload_hash,
            parent_operation_id,
        ) = row;
        if effect_order != i64::try_from(expected_order).expect("effect order is bounded")
            || module_raw != "store_administration"
            || kind != "store_administration.changed"
            || operation_id != parent_operation_id
            || payload_hash != sha256(payload_json.as_bytes())
        {
            return Err(corrupt(
                "Store Administration Library effect evidence is invalid",
            ));
        }
        let payload: StoreAdministrationEvent =
            decode_json(&payload_json, "Store Administration Library effect")?;
        effects.push(CanonicalLibraryEffect {
            effect_order,
            library_id,
            module: ModuleName::StoreAdministration,
            kind,
            operation_id,
            payload,
            payload_hash,
        });
    }
    Ok(effects)
}

fn canonical_delivery_atoms(
    connection: &Connection,
    context: &CommitContext,
) -> Result<Vec<StoredDeliveryAtom>, StoreError> {
    let rows = connection
        .prepare_cached(CANONICAL_DELIVERY_ATOMS_SQL)?
        .query_map(params![context.store_epoch, context.commit_seq], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut atoms = Vec::with_capacity(rows.len());
    for (expected_order, row) in rows.into_iter().enumerate() {
        let (atom_order, atom_id, kind_raw, requirements_raw, payload_json, payload_hash) = row;
        if atom_order != i64::try_from(expected_order).expect("atom order is bounded")
            || payload_hash != sha256(payload_json.as_bytes())
        {
            return Err(corrupt("DeliveryAtom durable evidence is invalid"));
        }
        let kind = parse_delivery_atom_kind(&kind_raw)?;
        let required_resources: Vec<ResourceKey> =
            decode_json(&requirements_raw, "DeliveryAtom requirements")?;
        let payload: DeliveryAtomPayload = decode_json(&payload_json, "DeliveryAtom payload")?;
        if required_resources.is_empty()
            || required_resources.windows(2).any(|pair| pair[0] >= pair[1])
            || super::delivery_atom::payload_claims(&payload)? != required_resources
            || atom_id
                != atom_identity(
                    context,
                    atom_order,
                    kind,
                    &required_resources,
                    &payload_hash,
                )?
        {
            return Err(corrupt(
                "DeliveryAtom claims or identity failed canonical verification",
            ));
        }
        atoms.push(StoredDeliveryAtom {
            descriptor: DeliveryAtomDescriptor {
                atom_id,
                atom_order,
                kind,
                required_resources,
                payload_hash,
            },
            payload,
        });
    }
    Ok(atoms)
}

impl VerifiedCommit {
    pub(crate) fn delivery_document_effects(
        &self,
        connection: &Connection,
        mode: LocalCommitResourceMode,
    ) -> Result<Vec<DocumentDeliveryResource>, StoreError> {
        self.document_effects
            .iter()
            .cloned()
            .map(|effect| {
                let inline_update = if mode == LocalCommitResourceMode::Inline {
                    let bytes = connection
                        .query_row(
                            "SELECT update_blob FROM document_updates
                         WHERE document_id = ?1 AND generation = ?2
                           AND seq = ?3 AND update_id = ?4 AND update_hash = ?5",
                            params![
                                effect.document_id,
                                effect.generation,
                                effect.head_seq,
                                effect.update_id,
                                effect.update_hash,
                            ],
                            |row| row.get::<_, Vec<u8>>(0),
                        )
                        .optional()?;
                    match bytes {
                        Some(bytes)
                            if i64::try_from(bytes.len()).ok()
                                == Some(effect.update_byte_length)
                                && sha256(&bytes) == effect.update_hash =>
                        {
                            Some(bytes)
                        }
                        Some(_) => {
                            return Err(corrupt(
                                "LocalCommit inline Document resource failed verification",
                            ));
                        }
                        None => None,
                    }
                } else {
                    None
                };
                Ok(DocumentDeliveryResource {
                    effect_order: effect.effect_order,
                    project_id: effect.project_id,
                    page_id: effect.page_id,
                    document_id: effect.document_id,
                    generation: effect.generation,
                    base_head_seq: effect.base_head_seq,
                    result_head_seq: effect.head_seq,
                    update_id: effect.update_id,
                    update_hash: effect.update_hash,
                    update_byte_length: effect.update_byte_length,
                    resource_kind: effect.resource_kind,
                    inline_update,
                })
            })
            .collect()
    }
}

pub(crate) fn load_verified_commit(
    connection: &Connection,
    commit_seq: i64,
) -> Result<VerifiedCommit, StoreError> {
    let Some(row) = read_commit(connection, commit_seq)? else {
        return Err(corrupt("CommitManifest parent is missing or unfinalized"));
    };
    let context = CommitContext {
        commit_seq: row.commit_seq,
        store_epoch: row.store_epoch.clone(),
        operation_id: row.operation_id.clone(),
        intent_hash: row.intent_hash.clone(),
        committed_at: row.committed_at.clone(),
    };
    let coordinate = context.coordinate();
    let physical_effects = physical_effect_evidence(connection, coordinate)?;
    let effects = canonical_effects_from_evidence(&physical_effects)?;
    let library_effects = canonical_library_effects(connection, coordinate)?;
    let delivery_atoms = canonical_delivery_atoms(connection, &context)?;
    let documents = canonical_document_effects(connection, coordinate)?;
    let revocations = canonical_revocations(connection, coordinate)?;
    let visibility_deltas = canonical_visibility_deltas(connection, coordinate)?;
    let sealed_projection_effects = sealed_projection_effects(&row.projection.effects)?;
    if stored_sealed_projection_effects(connection, coordinate)? != sealed_projection_effects {
        return Err(corrupt(
            "Stored projection descriptors diverge from immutable projection evidence",
        ));
    }
    let compiled = compile_manifest(
        &context,
        ManifestEvidence {
            effects: &effects,
            library_effects: &library_effects,
            atoms: &delivery_atoms,
            documents: &documents,
            projection: &row.projection,
            visibility_deltas: &visibility_deltas,
            revocations: &revocations,
            receipt: &row.receipt,
            audience: &row.audience,
        },
    )?;
    if row.canonical_hash != compiled.identity.manifest_hash
        || row
            .manifest
            .as_ref()
            .is_some_and(|stored| stored != &compiled)
        || row.projection.impact != merged_projection_impact(&effects)?
    {
        return Err(corrupt(
            "LocalCommit canonical evidence does not match its manifest",
        ));
    }
    Ok(VerifiedCommit {
        sealed_projection_effects,
        manifest: row.manifest.unwrap_or(compiled),
        #[cfg(test)]
        physical_effects,
        delivery_atoms,
        document_effects: documents,
    })
}

pub(crate) fn read_manifest(
    connection: &Connection,
    commit_seq: i64,
) -> Result<CommitManifest, StoreError> {
    load_verified_commit(connection, commit_seq).map(|verified| verified.manifest)
}

/// Rebinds finalized commit evidence after a Store replacement rotates epoch.
pub(crate) fn rebase_store_epoch(
    connection: &Connection,
    store_epoch: &str,
) -> Result<(), StoreError> {
    validate_identity(store_epoch, "LocalCommit Store epoch")?;
    connection.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
    // A Store replacement rotates the authorization epoch, so every existing
    // delivery cursor must resync from semantic state. Keeping and resealing
    // the old delivery graph made restore cost proportional to all retained
    // operations. Instead, cut one canonical resync checkpoint at the durable
    // head and discard only the bounded, rebuildable delivery window.
    let previous_head = head(connection)?;
    connection.execute(
        "UPDATE core_module_receipts SET local_commit_seq = NULL \
         WHERE local_commit_seq IS NOT NULL",
        [],
    )?;
    connection.execute("DELETE FROM projection_scope_heads", [])?;
    connection.execute("DELETE FROM local_commits", [])?;
    connection.execute(
        "UPDATE operational_journal_state \
         SET commit_head_seq = ?1, replay_floor_seq = ?2, \
             retained_commit_count = 0, retained_delivery_bytes = 0, \
             delivery_pressure_active = 0, \
             pending_metadata_count = 0, maintenance_revision = maintenance_revision + 1, \
             updated_at = ?3 WHERE id = 1",
        params![
            previous_head,
            previous_head.saturating_add(1),
            connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
                row.get::<_, String>(0)
            },)?,
        ],
    )?;
    Ok(())
}

fn assert_open(connection: &Connection, context: &CommitContext) -> Result<(), StoreError> {
    let parent = connection
        .query_row(
            "SELECT operation_id, intent_hash, committed_at, finalized
             FROM local_commits WHERE store_epoch = ?1 AND commit_seq = ?2",
            params![context.store_epoch, context.commit_seq],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    if parent
        != Some((
            context.operation_id.clone(),
            context.intent_hash.clone(),
            context.committed_at.clone(),
            0,
        ))
    {
        return Err(corrupt(
            "LocalCommit context is missing, mismatched, or sealed",
        ));
    }
    Ok(())
}

fn draft_projection(
    connection: &Connection,
    context: &CommitContext,
) -> Result<CommitProjectionDraft, StoreError> {
    assert_open(connection, context)?;
    let raw = connection.query_row(
        "SELECT projection_json FROM local_commits
         WHERE store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch, context.commit_seq],
        |row| row.get::<_, String>(0),
    )?;
    if raw == "{}" {
        return Ok(CommitProjectionDraft {
            schema_version: PROJECTION_SCHEMA_VERSION,
            result_cursor: CommitCursor {
                store_epoch: StoreEpoch(context.store_epoch.clone()),
                commit_seq: context.commit_seq,
            },
            impact: ProjectionImpact::None,
            patches: Vec::new(),
            requires_read_at_least: Vec::new(),
            effects: Vec::new(),
        });
    }
    decode_json(&raw, "LocalCommit projection")
}

fn write_projection(
    connection: &Connection,
    context: &CommitContext,
    projection: &CommitProjectionDraft,
) -> Result<(), StoreError> {
    assert_open(connection, context)?;
    if projection.schema_version != PROJECTION_SCHEMA_VERSION
        || projection.result_cursor.store_epoch.0 != context.store_epoch
        || projection.result_cursor.commit_seq != context.commit_seq
    {
        return Err(corrupt("LocalCommit projection coordinate is invalid"));
    }
    let changed = connection.execute(
        "UPDATE local_commits SET projection_json = ?1
         WHERE store_epoch = ?2 AND commit_seq = ?3 AND finalized = 0",
        params![
            serde_json::to_string(projection)
                .map_err(|_| corrupt("LocalCommit projection is invalid"))?,
            context.store_epoch,
            context.commit_seq,
        ],
    )?;
    if changed != 1 {
        return Err(corrupt("LocalCommit projection parent is unavailable"));
    }
    Ok(())
}

fn read_required_receipt(
    connection: &Connection,
    commit_seq: i64,
) -> Result<LocalCommitReceiptRef, StoreError> {
    let raw = connection.query_row(
        "SELECT receipt_json FROM local_commits WHERE commit_seq = ?1",
        [commit_seq],
        |row| row.get::<_, String>(0),
    )?;
    if raw == "{}" {
        return Err(corrupt("LocalCommit has no receipt reference"));
    }
    decode_json(&raw, "LocalCommit receipt")
}

fn canonical_effects(
    connection: &Connection,
    coordinate: CommitCoordinate<'_>,
) -> Result<Vec<CanonicalPhysicalEffect>, StoreError> {
    let evidence = physical_effect_evidence(connection, coordinate)?;
    canonical_effects_from_evidence(&evidence)
}

fn canonical_effects_from_evidence(
    evidence: &[PhysicalEffectEvidence],
) -> Result<Vec<CanonicalPhysicalEffect>, StoreError> {
    evidence
        .iter()
        .cloned()
        .map(
            |(
                effect_order,
                change_log_seq,
                project_id,
                module,
                kind,
                operation_id,
                resources,
                payload_hash,
                projection_impact,
            )| {
                validate_sha256(&payload_hash, "LocalCommit effect payload hash")?;
                Ok(CanonicalPhysicalEffect {
                    effect_order,
                    change_log_seq,
                    project_id,
                    module,
                    kind,
                    operation_id,
                    resources,
                    payload_hash,
                    projection_impact,
                })
            },
        )
        .collect()
}

fn canonical_document_effects(
    connection: &Connection,
    coordinate: CommitCoordinate<'_>,
) -> Result<Vec<CanonicalDocumentEffect>, StoreError> {
    let effects = connection
        .prepare_cached(CANONICAL_DOCUMENT_EFFECTS_SQL)?
        .query_map(
            params![coordinate.store_epoch, coordinate.commit_seq],
            |row| {
                Ok(CanonicalDocumentEffect {
                    effect_order: row.get(0)?,
                    project_id: row.get(1)?,
                    page_id: row.get(2)?,
                    document_id: row.get(3)?,
                    generation: row.get(4)?,
                    base_head_seq: row.get(5)?,
                    head_seq: row.get(6)?,
                    update_id: row.get(7)?,
                    update_hash: row.get(8)?,
                    update_byte_length: row.get(9)?,
                    resource_kind: DocumentEffectResourceKind::DocumentUpdate,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut identities = BTreeSet::new();
    for effect in &effects {
        validate_sha256(&effect.update_hash, "LocalCommit Document update hash")?;
        if !valid_document_transition(
            effect.generation,
            effect.base_head_seq,
            effect.head_seq,
            effect.update_byte_length,
        ) || !identities.insert((
            effect.document_id.clone(),
            effect.generation,
            effect.head_seq,
        )) {
            return Err(corrupt(
                "LocalCommit Document effect is invalid or duplicated",
            ));
        }
        let durable = connection
            .query_row(
                "SELECT update_hash, length(update_blob), base_head_seq
                 FROM document_updates WHERE document_id = ?1 AND generation = ?2
                   AND seq = ?3 AND update_id = ?4",
                params![
                    effect.document_id,
                    effect.generation,
                    effect.head_seq,
                    effect.update_id,
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some(durable) = durable
            && durable
                != (
                    effect.update_hash.clone(),
                    effect.update_byte_length,
                    effect.base_head_seq,
                )
        {
            return Err(corrupt(
                "LocalCommit Document ref diverges from retained durable bytes",
            ));
        }
    }
    Ok(effects)
}

fn canonical_revocations(
    connection: &Connection,
    coordinate: CommitCoordinate<'_>,
) -> Result<Vec<ResourceRevocation>, StoreError> {
    let rows = connection
        .prepare_cached(CANONICAL_REVOCATIONS_SQL)?
        .query_map(
            params![coordinate.store_epoch, coordinate.commit_seq],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(
            |(scope_key, scope_json, resource_kind, resource_id, reason)| {
                let revocation = ResourceRevocation {
                    authorization_scope: decode_json(
                        &scope_json,
                        "LocalCommit revocation authorization scope",
                    )?,
                    resource_kind: parse_revoked_resource_kind(&resource_kind)?,
                    resource_id,
                    reason: parse_revocation_reason(&reason)?,
                };
                validate_revocation(&revocation)?;
                if authorization_scope_key(&revocation.authorization_scope)? != scope_key {
                    return Err(corrupt("LocalCommit revocation scope key diverges"));
                }
                Ok(revocation)
            },
        )
        .collect()
}

fn canonical_visibility_deltas(
    connection: &Connection,
    coordinate: CommitCoordinate<'_>,
) -> Result<Vec<CanonicalVisibilityDeltaEvidence>, StoreError> {
    connection
        .prepare_cached(
            "SELECT scope_key, authorization_scope_json, delta_kind, roots_json, delta_hash
             FROM local_commit_visibility_deltas
             WHERE store_epoch = ?1 AND commit_seq = ?2
             ORDER BY scope_key, delta_hash",
        )?
        .query_map(
            params![coordinate.store_epoch, coordinate.commit_seq],
            |row| {
                Ok(CanonicalVisibilityDeltaEvidence {
                    scope_key: row.get(0)?,
                    authorization_scope_json: row.get(1)?,
                    delta_kind: row.get(2)?,
                    roots_json: row.get(3)?,
                    delta_hash: row.get(4)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)
}

fn persist_sealed_projection_effects(
    connection: &Connection,
    context: &CommitContext,
    effects: &[SealedProjectionEffect],
) -> Result<(), StoreError> {
    let existing: i64 = connection.query_row(
        "SELECT count(*) FROM local_commit_sealed_projection_effects
         WHERE store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch, context.commit_seq],
        |row| row.get(0),
    )?;
    if existing != 0 {
        return Err(corrupt(
            "LocalCommit sealed projection descriptors already exist",
        ));
    }
    for (effect_order, effect) in effects.iter().enumerate() {
        let descriptor_json = serde_json::to_string(effect)
            .map_err(|_| corrupt("Sealed projection descriptor is invalid"))?;
        let descriptor_hash = sha256(descriptor_json.as_bytes());
        connection.execute(
            "INSERT INTO local_commit_sealed_projection_effects(
               store_epoch, commit_seq, effect_order, descriptor_json, descriptor_hash
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                context.store_epoch,
                context.commit_seq,
                i64::try_from(effect_order)
                    .map_err(|_| corrupt("Sealed projection descriptor order overflowed"))?,
                descriptor_json,
                descriptor_hash,
            ],
        )?;
    }
    Ok(())
}

fn stored_sealed_projection_effects(
    connection: &Connection,
    coordinate: CommitCoordinate<'_>,
) -> Result<Vec<SealedProjectionEffect>, StoreError> {
    let rows = connection
        .prepare_cached(
            "SELECT effect_order, descriptor_json, descriptor_hash
             FROM local_commit_sealed_projection_effects
             WHERE store_epoch = ?1 AND commit_seq = ?2
             ORDER BY effect_order",
        )?
        .query_map(
            params![coordinate.store_epoch, coordinate.commit_seq],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .enumerate()
        .map(
            |(expected_order, (effect_order, descriptor_json, descriptor_hash))| {
                if i64::try_from(expected_order).ok() != Some(effect_order)
                    || sha256(descriptor_json.as_bytes()) != descriptor_hash
                {
                    return Err(corrupt(
                        "Sealed projection descriptor evidence is noncanonical",
                    ));
                }
                decode_json(&descriptor_json, "Sealed projection descriptor")
            },
        )
        .collect()
}

fn valid_document_transition(
    generation: i64,
    base_head_seq: i64,
    result_head_seq: i64,
    update_byte_length: i64,
) -> bool {
    generation >= 1
        && base_head_seq >= 0
        && result_head_seq > base_head_seq
        && update_byte_length >= 0
}

fn merged_projection_impact(
    effects: &[CanonicalPhysicalEffect],
) -> Result<ProjectionImpact, StoreError> {
    effects
        .iter()
        .try_fold(ProjectionImpact::None, |impact, effect| {
            merge_projection_impact(impact, effect.projection_impact.clone())
        })
}

fn derive_audience(
    connection: &Connection,
    commit_seq: i64,
    effects: &[CanonicalPhysicalEffect],
    library_effects: &[CanonicalLibraryEffect],
    documents: &[CanonicalDocumentEffect],
) -> Result<RoutingEvidence, StoreError> {
    let mut project_ids = effects
        .iter()
        .map(|effect| effect.project_id.clone())
        .chain(documents.iter().map(|effect| effect.project_id.clone()))
        .collect::<Vec<_>>();
    project_ids.sort();
    project_ids.dedup();
    let mut library_ids = library_effects
        .iter()
        .map(|effect| effect.library_id.clone())
        .collect::<Vec<_>>();
    for project_id in &project_ids {
        let library_id = connection
            .query_row(
                "SELECT library_id FROM projects WHERE id = ?1",
                [project_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        if let Some(library_id) = library_id {
            library_ids.push(library_id);
        }
    }
    library_ids.sort();
    library_ids.dedup();
    let library_id = match library_ids.as_slice() {
        [library_id] => library_id.clone(),
        [] => connection
            .query_row("SELECT id FROM libraries ORDER BY id LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
            .unwrap_or_else(|| format!("store:commit:{commit_seq}")),
        _ => return Err(corrupt("LocalCommit audience spans multiple Libraries")),
    };
    let mut document_ids = documents
        .iter()
        .map(|effect| effect.document_id.clone())
        .collect::<Vec<_>>();
    document_ids.sort();
    document_ids.dedup();
    Ok(RoutingEvidence {
        library_id,
        project_ids,
        document_ids,
    })
}

struct ManifestEvidence<'a> {
    effects: &'a [CanonicalPhysicalEffect],
    library_effects: &'a [CanonicalLibraryEffect],
    atoms: &'a [StoredDeliveryAtom],
    documents: &'a [CanonicalDocumentEffect],
    projection: &'a CommitProjectionDraft,
    visibility_deltas: &'a [CanonicalVisibilityDeltaEvidence],
    revocations: &'a [ResourceRevocation],
    receipt: &'a LocalCommitReceiptRef,
    audience: &'a RoutingEvidence,
}

fn compile_manifest(
    context: &CommitContext,
    evidence: ManifestEvidence<'_>,
) -> Result<CommitManifest, StoreError> {
    let sealed_projection_effects = sealed_projection_effects(&evidence.projection.effects)?;
    let delivery_atoms = evidence
        .atoms
        .iter()
        .map(|atom| atom.descriptor.clone())
        .collect::<Vec<_>>();
    let document_effects = evidence
        .documents
        .iter()
        .map(|effect| DocumentEffectRef {
            effect_order: effect.effect_order,
            page_id: effect.page_id.clone(),
            document_id: effect.document_id.clone(),
            generation: effect.generation,
            base_head_seq: effect.base_head_seq,
            result_head_seq: effect.head_seq,
            update_id: effect.update_id.clone(),
            update_hash: effect.update_hash.clone(),
            update_byte_length: effect.update_byte_length,
            resource_kind: effect.resource_kind,
        })
        .collect::<Vec<_>>();
    let physical_encoded = if evidence.library_effects.is_empty() {
        serde_json::to_vec(evidence.effects)
    } else {
        serde_json::to_vec(&CanonicalPhysicalEvidence {
            physical_effects: evidence.effects,
            library_effects: evidence.library_effects,
        })
    }
    .map_err(|_| corrupt("PhysicalJournal evidence cannot be encoded"))?;
    let effect_count = evidence
        .effects
        .len()
        .checked_add(evidence.library_effects.len())
        .ok_or_else(|| corrupt("PhysicalJournal effect count overflowed"))?;
    let physical_evidence = PhysicalEvidenceDigest {
        effect_count: u32::try_from(effect_count)
            .map_err(|_| corrupt("PhysicalJournal effect count overflowed"))?,
        first_change_log_seq: evidence.effects.first().map(|effect| effect.change_log_seq),
        last_change_log_seq: evidence.effects.last().map(|effect| effect.change_log_seq),
        ordered_digest: sha256(&physical_encoded),
    };
    let routing_claims = routing_claims(
        evidence.audience,
        &delivery_atoms,
        &document_effects,
        &evidence.projection.impact,
        evidence.revocations,
    );
    let hash_input = CanonicalManifest {
        hash_version: CANONICAL_HASH_VERSION,
        event_version: CORE_EVENT_VERSION,
        store_epoch: &context.store_epoch,
        commit_seq: context.commit_seq,
        operation_id: &context.operation_id,
        intent_hash: &context.intent_hash,
        committed_at: &context.committed_at,
        delivery_atoms: &delivery_atoms,
        document_effects: &document_effects,
        projection_effects: &evidence.projection.effects,
        sealed_projection_effects: &sealed_projection_effects,
        visibility_deltas: evidence.visibility_deltas,
        revocations: evidence.revocations,
        receipt: evidence.receipt,
        routing_claims: &routing_claims,
        physical_evidence: &physical_evidence,
    };
    let encoded = serde_json::to_vec(&hash_input)
        .map_err(|_| corrupt("CommitManifest hash input is invalid"))?;
    Ok(CommitManifest {
        event_version: CORE_EVENT_VERSION,
        identity: CommitIdentity {
            store_epoch: StoreEpoch(context.store_epoch.clone()),
            commit_seq: context.commit_seq,
            manifest_hash: sha256(&encoded),
        },
        operation_id: context.operation_id.clone(),
        intent_hash: context.intent_hash.clone(),
        committed_at: context.committed_at.clone(),
        delivery_atoms,
        document_effects,
        projection_effects: evidence.projection.effects.clone(),
        revocations: evidence.revocations.to_vec(),
        receipt: evidence.receipt.clone(),
        routing_claims,
        physical_evidence,
    })
}

fn routing_claims(
    audience: &RoutingEvidence,
    atoms: &[DeliveryAtomDescriptor],
    documents: &[DocumentEffectRef],
    impact: &ProjectionImpact,
    revocations: &[ResourceRevocation],
) -> Vec<RoutingClaim> {
    let mut claims = BTreeSet::new();
    claims.insert(RoutingClaim::Library {
        library_id: audience.library_id.clone(),
    });
    claims.extend(
        audience
            .project_ids
            .iter()
            .cloned()
            .map(|project_id| RoutingClaim::Project { project_id }),
    );
    claims.extend(documents.iter().map(|effect| RoutingClaim::Document {
        document_id: effect.document_id.clone(),
    }));
    for resource in atoms.iter().flat_map(|atom| atom.required_resources.iter()) {
        match resource {
            ResourceKey::Library { library_id } => {
                claims.insert(RoutingClaim::Library {
                    library_id: library_id.clone(),
                });
            }
            ResourceKey::Project { project_id } => {
                claims.insert(RoutingClaim::Project {
                    project_id: project_id.clone(),
                });
            }
            ResourceKey::Page { page_id } => {
                claims.insert(RoutingClaim::Page {
                    page_id: page_id.clone(),
                });
            }
            ResourceKey::Document { document_id } => {
                claims.insert(RoutingClaim::Document {
                    document_id: document_id.clone(),
                });
            }
            ResourceKey::Database { database_id } => {
                claims.insert(RoutingClaim::Database {
                    database_id: database_id.clone(),
                });
            }
            ResourceKey::DataSource { data_source_id } => {
                claims.insert(RoutingClaim::DataSource {
                    data_source_id: data_source_id.clone(),
                });
            }
            ResourceKey::View { view_id } => {
                claims.insert(RoutingClaim::View {
                    view_id: view_id.clone(),
                });
            }
            ResourceKey::Canvas { .. } | ResourceKey::File { .. } => {}
        }
    }
    for revocation in revocations {
        match &revocation.authorization_scope {
            DeliveryAuthorizationScope::Library { .. } => {}
            DeliveryAuthorizationScope::Project { project_id, .. }
            | DeliveryAuthorizationScope::Document {
                project_id: Some(project_id),
                ..
            } => {
                claims.insert(RoutingClaim::Project {
                    project_id: project_id.clone(),
                });
            }
            DeliveryAuthorizationScope::Document {
                project_id: None, ..
            } => {}
        }
        match revocation.resource_kind {
            RevokedResourceKind::Page => {
                claims.insert(RoutingClaim::Page {
                    page_id: revocation.resource_id.clone(),
                });
            }
            RevokedResourceKind::Document => {
                claims.insert(RoutingClaim::Document {
                    document_id: revocation.resource_id.clone(),
                });
            }
            RevokedResourceKind::Database => {
                claims.insert(RoutingClaim::Database {
                    database_id: revocation.resource_id.clone(),
                });
            }
            RevokedResourceKind::DataSource => {
                claims.insert(RoutingClaim::DataSource {
                    data_source_id: revocation.resource_id.clone(),
                });
            }
            RevokedResourceKind::View => {
                claims.insert(RoutingClaim::View {
                    view_id: revocation.resource_id.clone(),
                });
            }
            RevokedResourceKind::Canvas | RevokedResourceKind::File => {}
        }
    }
    for page_id in documents.iter().filter_map(|effect| effect.page_id.clone()) {
        claims.insert(RoutingClaim::Page { page_id });
    }
    if let ProjectionImpact::Resources {
        page_ids,
        database_ids,
        data_source_ids,
        view_ids,
        document_heads,
    } = impact
    {
        claims.extend(
            page_ids
                .iter()
                .cloned()
                .map(|page_id| RoutingClaim::Page { page_id }),
        );
        claims.extend(
            database_ids
                .iter()
                .cloned()
                .map(|database_id| RoutingClaim::Database { database_id }),
        );
        claims.extend(
            data_source_ids
                .iter()
                .cloned()
                .map(|data_source_id| RoutingClaim::DataSource { data_source_id }),
        );
        claims.extend(
            view_ids
                .iter()
                .cloned()
                .map(|view_id| RoutingClaim::View { view_id }),
        );
        claims.extend(document_heads.iter().map(|head| RoutingClaim::Document {
            document_id: head.document_id.clone(),
        }));
    }
    claims.into_iter().collect()
}

fn authorization_scope_key(scope: &DeliveryAuthorizationScope) -> Result<String, StoreError> {
    match scope {
        DeliveryAuthorizationScope::Library { library_id } => {
            validate_identity(library_id, "Revocation Library")?;
        }
        DeliveryAuthorizationScope::Project {
            library_id,
            project_id,
        } => {
            validate_identity(library_id, "Revocation Library")?;
            validate_identity(project_id, "Revocation Project")?;
        }
        DeliveryAuthorizationScope::Document {
            library_id,
            project_id,
            document_id,
        } => {
            validate_identity(library_id, "Revocation Library")?;
            if let Some(project_id) = project_id {
                validate_identity(project_id, "Revocation Project")?;
            }
            validate_identity(document_id, "Revocation Document")?;
        }
    }
    let encoded = serde_json::to_vec(scope)
        .map_err(|_| corrupt("Revocation authorization scope cannot be encoded"))?;
    Ok(sha256(&encoded))
}

fn validate_revocation(revocation: &ResourceRevocation) -> Result<(), StoreError> {
    authorization_scope_key(&revocation.authorization_scope)?;
    validate_identity(&revocation.resource_id, "Revoked resource")
}

fn revoked_resource_kind_name(kind: RevokedResourceKind) -> &'static str {
    match kind {
        RevokedResourceKind::Page => "page",
        RevokedResourceKind::Document => "document",
        RevokedResourceKind::Database => "database",
        RevokedResourceKind::DataSource => "data_source",
        RevokedResourceKind::View => "view",
        RevokedResourceKind::Canvas => "canvas",
        RevokedResourceKind::File => "file",
    }
}

fn delivery_atom_kind_name(kind: DeliveryAtomKind) -> &'static str {
    match kind {
        DeliveryAtomKind::LibraryNavigationChanged => "library_navigation_changed",
        DeliveryAtomKind::DatabaseChanged => "database_changed",
        DeliveryAtomKind::OwnedDocumentChanged => "owned_document_changed",
        DeliveryAtomKind::ProjectWorkspaceChanged => "project_workspace_changed",
        DeliveryAtomKind::AutomationChanged => "automation_changed",
        DeliveryAtomKind::StoreAdministrationChanged => "store_administration_changed",
    }
}

fn parse_delivery_atom_kind(value: &str) -> Result<DeliveryAtomKind, StoreError> {
    match value {
        "library_navigation_changed" => Ok(DeliveryAtomKind::LibraryNavigationChanged),
        "database_changed" => Ok(DeliveryAtomKind::DatabaseChanged),
        "owned_document_changed" => Ok(DeliveryAtomKind::OwnedDocumentChanged),
        "project_workspace_changed" => Ok(DeliveryAtomKind::ProjectWorkspaceChanged),
        "automation_changed" => Ok(DeliveryAtomKind::AutomationChanged),
        "store_administration_changed" => Ok(DeliveryAtomKind::StoreAdministrationChanged),
        _ => Err(corrupt("DeliveryAtom kind is invalid")),
    }
}

fn parse_revoked_resource_kind(value: &str) -> Result<RevokedResourceKind, StoreError> {
    match value {
        "page" => Ok(RevokedResourceKind::Page),
        "document" => Ok(RevokedResourceKind::Document),
        "database" => Ok(RevokedResourceKind::Database),
        "data_source" => Ok(RevokedResourceKind::DataSource),
        "view" => Ok(RevokedResourceKind::View),
        "canvas" => Ok(RevokedResourceKind::Canvas),
        "file" => Ok(RevokedResourceKind::File),
        _ => Err(corrupt("LocalCommit revoked resource kind is invalid")),
    }
}

fn revocation_reason_name(reason: ResourceRevocationReason) -> &'static str {
    match reason {
        ResourceRevocationReason::OwnershipMoved => "ownership_moved",
        ResourceRevocationReason::AccessRevoked => "access_revoked",
        ResourceRevocationReason::Archived => "archived",
        ResourceRevocationReason::Deleted => "deleted",
    }
}

fn parse_revocation_reason(value: &str) -> Result<ResourceRevocationReason, StoreError> {
    match value {
        "ownership_moved" => Ok(ResourceRevocationReason::OwnershipMoved),
        "access_revoked" => Ok(ResourceRevocationReason::AccessRevoked),
        "archived" => Ok(ResourceRevocationReason::Archived),
        "deleted" => Ok(ResourceRevocationReason::Deleted),
        _ => Err(corrupt("LocalCommit revocation reason is invalid")),
    }
}

fn default_projection_scopes(
    connection: &Connection,
    impact: &ProjectionImpact,
    actor_project_ids: &[String],
) -> Result<Vec<LocalProjectionScope>, StoreError> {
    let ProjectionImpact::Resources {
        page_ids, view_ids, ..
    } = impact
    else {
        return Ok(Vec::new());
    };
    let mut scopes = Vec::new();
    for page_id in page_ids {
        for project_id in actor_project_ids {
            scopes.push(LocalProjectionScope::Page {
                project_id: project_id.clone(),
                page_id: page_id.clone(),
            });
        }
    }
    for view_id in view_ids {
        let coordinates = connection
            .query_row(
                "SELECT view.database_block_id, view.data_source_id
                 FROM database_views view
                 WHERE view.id = ?1",
                [view_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((database_id, data_source_id)) = coordinates {
            for project_id in actor_project_ids {
                scopes.push(LocalProjectionScope::DatabaseView {
                    project_id: project_id.clone(),
                    database_id: database_id.clone(),
                    data_source_id: data_source_id.clone(),
                    view_id: view_id.clone(),
                });
            }
        }
    }
    canonicalize_projection_scopes(&mut scopes);
    Ok(scopes)
}

fn canonicalize_projection(projection: &mut CommitProjectionDraft) {
    canonicalize_projection_scopes(&mut projection.requires_read_at_least);
}

fn seal_projection_effects(
    connection: &Connection,
    context: &CommitContext,
    projection: &CommitProjectionDraft,
) -> Result<Vec<ProjectionEffect>, StoreError> {
    if !projection_scope_head::is_installed(connection)? {
        return Ok(Vec::new());
    }
    if !projection.effects.is_empty() {
        for effect in &projection.effects {
            if effect.covered_commit_seq != context.commit_seq {
                return Err(corrupt(
                    "LocalCommit ProjectionEffect belongs to another commit",
                ));
            }
            let head =
                projection_scope_head::read(connection, &context.store_epoch, &effect.scope)?
                    .ok_or_else(|| corrupt("LocalCommit ProjectionEffect scope head is missing"))?;
            if head.revision != effect.result_revision
                || head.covered_commit_seq != effect.covered_commit_seq
                || head.effect_hash != effect.effect_hash
            {
                return Err(corrupt(
                    "LocalCommit ProjectionEffect diverges from its scope head",
                ));
            }
        }
        return Ok(projection.effects.clone());
    }

    let mut transitions =
        BTreeMap::<String, (LocalProjectionScope, Option<LocalProjectionPatch>, bool)>::new();
    for patch in &projection.patches {
        let scope = projection_scope_for_patch(patch);
        let key = projection_scope_head::canonical_scope_key(scope.clone())?;
        match transitions.get_mut(&key.canonical_key) {
            Some((_, existing_patch, requires_read)) => {
                *existing_patch = None;
                *requires_read = true;
            }
            None => {
                transitions.insert(key.canonical_key, (scope, Some(patch.clone()), false));
            }
        }
    }
    for scope in &projection.requires_read_at_least {
        let key = projection_scope_head::canonical_scope_key(scope.clone())?;
        transitions
            .entry(key.canonical_key)
            .and_modify(|(_, _, requires_read)| *requires_read = true)
            .or_insert_with(|| (scope.clone(), None, true));
    }

    transitions
        .into_values()
        .map(|(scope, patch, requires_read_at_least)| {
            let scope = projection_scope_head::canonical_scope_key(scope)?;
            let expected_revision =
                projection_scope_head::read(connection, &context.store_epoch, &scope)?
                    .map_or(0, |head| head.revision);
            projection_scope_head::compare_and_advance(
                connection,
                &context.store_epoch,
                context.commit_seq,
                scope,
                expected_revision,
                patch,
                requires_read_at_least,
            )
        })
        .collect()
}

fn projection_scope_for_patch(patch: &LocalProjectionPatch) -> LocalProjectionScope {
    match patch {
        LocalProjectionPatch::DatabaseRowUpsert {
            project_id,
            database_id,
            data_source_id,
            view_id,
            ..
        }
        | LocalProjectionPatch::DatabaseRowRemove {
            project_id,
            database_id,
            data_source_id,
            view_id,
            ..
        } => LocalProjectionScope::DatabaseView {
            project_id: project_id.clone(),
            database_id: database_id.clone(),
            data_source_id: data_source_id.clone(),
            view_id: view_id.clone(),
        },
        LocalProjectionPatch::PageChanged {
            project_id,
            page_id,
        } => LocalProjectionScope::Page {
            project_id: project_id.clone(),
            page_id: page_id.clone(),
        },
    }
}

pub(crate) fn sealed_projection_effects(
    effects: &[ProjectionEffect],
) -> Result<Vec<SealedProjectionEffect>, StoreError> {
    effects
        .iter()
        .map(|effect| {
            if effect.patch.is_none() {
                let (subject, required_resources) = requirements_for_scope(&effect.scope.scope);
                return Ok(SealedProjectionEffect {
                    transition: effect.clone(),
                    subject,
                    required_resources,
                    patch_hash: None,
                });
            }
            let patch = effect
                .patch
                .as_ref()
                .ok_or_else(|| corrupt("Projection patch disappeared during sealing"))?;
            if projection_scope_for_patch(patch) != effect.scope.scope {
                return Err(corrupt(
                    "Projection patch requirements belong to another scope",
                ));
            }
            let extracted = super::projection_requirement_extractor::extract(patch)?;
            Ok(SealedProjectionEffect {
                transition: effect.clone(),
                subject: extracted.subject,
                required_resources: extracted.required_resources,
                patch_hash: Some(extracted.patch_hash),
            })
        })
        .collect()
}

fn requirements_for_scope(scope: &LocalProjectionScope) -> (ResourceKey, Vec<ResourceKey>) {
    let (subject, required_resources) = match scope {
        LocalProjectionScope::Library { library_id } => {
            let subject = ResourceKey::Library {
                library_id: library_id.clone(),
            };
            (subject.clone(), BTreeSet::from([subject]))
        }
        LocalProjectionScope::Project { project_id }
        | LocalProjectionScope::StructuralHistory { project_id } => {
            let subject = ResourceKey::Project {
                project_id: project_id.clone(),
            };
            (subject.clone(), BTreeSet::from([subject]))
        }
        LocalProjectionScope::DatabaseView {
            project_id,
            database_id,
            data_source_id,
            view_id,
        } => {
            let subject = ResourceKey::View {
                view_id: view_id.clone(),
            };
            (
                subject.clone(),
                BTreeSet::from([
                    ResourceKey::Project {
                        project_id: project_id.clone(),
                    },
                    ResourceKey::Database {
                        database_id: database_id.clone(),
                    },
                    ResourceKey::DataSource {
                        data_source_id: data_source_id.clone(),
                    },
                    subject,
                ]),
            )
        }
        LocalProjectionScope::PageDetailDataSource {
            project_id,
            database_id,
            data_source_id,
        } => {
            let subject = ResourceKey::DataSource {
                data_source_id: data_source_id.clone(),
            };
            (
                subject.clone(),
                BTreeSet::from([
                    ResourceKey::Project {
                        project_id: project_id.clone(),
                    },
                    ResourceKey::Database {
                        database_id: database_id.clone(),
                    },
                    subject,
                ]),
            )
        }
        LocalProjectionScope::PageDetailDatabase {
            project_id,
            database_id,
        } => {
            let subject = ResourceKey::Database {
                database_id: database_id.clone(),
            };
            (
                subject.clone(),
                BTreeSet::from([
                    ResourceKey::Project {
                        project_id: project_id.clone(),
                    },
                    subject,
                ]),
            )
        }
        LocalProjectionScope::Page {
            project_id,
            page_id,
        } => {
            let subject = ResourceKey::Page {
                page_id: page_id.clone(),
            };
            (
                subject.clone(),
                BTreeSet::from([
                    ResourceKey::Project {
                        project_id: project_id.clone(),
                    },
                    subject,
                ]),
            )
        }
    };
    (subject, required_resources.into_iter().collect())
}

fn canonicalize_projection_scopes(scopes: &mut Vec<LocalProjectionScope>) {
    scopes.sort_by_key(|scope| serde_json::to_string(scope).unwrap_or_default());
    scopes.dedup();
}

pub(crate) fn merge_projection_impact(
    left: ProjectionImpact,
    right: ProjectionImpact,
) -> Result<ProjectionImpact, StoreError> {
    if matches!(left, ProjectionImpact::All) || matches!(right, ProjectionImpact::All) {
        return Ok(ProjectionImpact::All);
    }
    let (mut page_ids, mut database_ids, mut data_source_ids, mut view_ids, left_heads) = match left
    {
        ProjectionImpact::None => (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new()),
        ProjectionImpact::Resources {
            page_ids,
            database_ids,
            data_source_ids,
            view_ids,
            document_heads,
        } => (
            page_ids,
            database_ids,
            data_source_ids,
            view_ids,
            document_heads,
        ),
        ProjectionImpact::All => unreachable!(),
    };
    let right_heads = if let ProjectionImpact::Resources {
        page_ids: right_page_ids,
        database_ids: right_database_ids,
        data_source_ids: right_data_source_ids,
        view_ids: right_view_ids,
        document_heads: right_document_heads,
    } = right
    {
        page_ids.extend(right_page_ids);
        database_ids.extend(right_database_ids);
        data_source_ids.extend(right_data_source_ids);
        view_ids.extend(right_view_ids);
        right_document_heads
    } else {
        Vec::new()
    };
    let document_heads = merge_document_head_impacts(left_heads, right_heads)?;
    canonicalize(ProjectionImpact::Resources {
        page_ids,
        database_ids,
        data_source_ids,
        view_ids,
        document_heads,
    })
}

fn merge_document_head_impacts(
    left: Vec<PageDocumentHeadImpact>,
    right: Vec<PageDocumentHeadImpact>,
) -> Result<Vec<PageDocumentHeadImpact>, StoreError> {
    let mut heads = BTreeMap::<(String, String), PageDocumentHeadImpact>::new();
    for head in left.into_iter().chain(right) {
        let key = (head.page_id.clone(), head.document_id.clone());
        let Some(existing) = heads.get_mut(&key) else {
            heads.insert(key, head);
            continue;
        };
        if existing.generation != head.generation {
            return Err(corrupt(
                "LocalCommit contains multiple generations for one Document head",
            ));
        }
        if head.head_seq > existing.head_seq {
            *existing = head;
        }
    }
    Ok(heads.into_values().collect())
}

pub(crate) fn module_from_kind(kind: &str) -> Result<ModuleName, StoreError> {
    if kind.starts_with("owned_document.") {
        return Ok(ModuleName::OwnedDocument);
    }
    match kind {
        "library.changed" | "block_mutation" | "block_relocation" | "block_transfer"
        | "structural_edit" => Ok(ModuleName::Library),
        "database.changed" => Ok(ModuleName::Database),
        "project_workspace.changed" => Ok(ModuleName::ProjectWorkspace),
        "automation.changed" => Ok(ModuleName::Automation),
        "store_administration.changed" => Ok(ModuleName::StoreAdministration),
        _ => Err(corrupt("LocalCommit physical effect Module is unsupported")),
    }
}

fn module_name(module: ModuleName) -> &'static str {
    match module {
        ModuleName::Library => "library",
        ModuleName::Database => "database",
        ModuleName::OwnedDocument => "owned_document",
        ModuleName::ProjectWorkspace => "project_workspace",
        ModuleName::Automation => "automation",
        ModuleName::StoreAdministration => "store_administration",
    }
}

fn parse_module(value: &str) -> Result<ModuleName, StoreError> {
    match value {
        "library" => Ok(ModuleName::Library),
        "database" => Ok(ModuleName::Database),
        "owned_document" => Ok(ModuleName::OwnedDocument),
        "project_workspace" => Ok(ModuleName::ProjectWorkspace),
        "automation" => Ok(ModuleName::Automation),
        "store_administration" => Ok(ModuleName::StoreAdministration),
        _ => Err(corrupt("LocalCommit Module identity is invalid")),
    }
}

fn parse_module_sql(value: &str) -> rusqlite::Result<ModuleName> {
    parse_module(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn decode_json<T: serde::de::DeserializeOwned>(raw: &str, label: &str) -> Result<T, StoreError> {
    serde_json::from_str(raw).map_err(|_| corrupt(&format!("{label} is invalid")))
}

fn validate_identity(value: &str, label: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.len() <= 512 && value.trim() == value {
        return Ok(());
    }
    Err(corrupt(&format!("{label} identity is invalid")))
}

fn validate_timestamp(value: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.len() <= 64 {
        return Ok(());
    }
    Err(corrupt("LocalCommit timestamp is invalid"))
}

fn validate_sha256(value: &str, label: &str) -> Result<(), StoreError> {
    if is_sha256(value) {
        return Ok(());
    }
    Err(corrupt(&format!("{label} is invalid")))
}

fn empty_hash() -> String {
    "0".repeat(64)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;

    use super::*;

    fn head(generation: i64, head_seq: i64) -> PageDocumentHeadImpact {
        PageDocumentHeadImpact {
            page_id: "page-a".to_owned(),
            document_id: "document-a".to_owned(),
            generation,
            head_seq,
        }
    }

    fn query_plan(connection: &Connection, sql: &str) -> String {
        connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .expect("query plan")
            .query_map(params!["epoch:test", 1], |row| row.get::<_, String>(3))
            .expect("planned query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("query plan rows")
            .join("\n")
    }

    fn seed_relocation_ledger(connection: &Connection) -> Result<(), StoreError> {
        crate::infrastructure::visibility_delta_journal::install_test_maintenance_context(
            connection,
        )?;
        connection.execute_batch(
            "INSERT INTO profiles(id, created_at, updated_at) \
             VALUES ('profile:relocation-ledger', '2026-08-13', '2026-08-13'); \
             INSERT INTO libraries(id, profile_id, created_at, updated_at) \
             VALUES ( \
               'library:relocation-ledger', 'profile:relocation-ledger', \
               '2026-08-13', '2026-08-13' \
             ); \
             INSERT INTO projects(id, library_id, name, created, updated) \
             VALUES ( \
               'project:relocation-ledger', 'library:relocation-ledger', \
               'Relocation ledger', '2026-08-13', '2026-08-13' \
             ); \
             INSERT INTO documents( \
               id, library_id, generation, head_seq, schema_key, schema_version, \
               state_vector, state_hash, readiness, authority, sync_engine, created_at, updated_at \
             ) VALUES \
               ( \
                 'document:relocation-source', 'library:relocation-ledger', 1, 1, \
                 'nodex.page', 3, X'', '', 'ready', 'ydoc_primary', 'yjs', \
                 '2026-08-13', '2026-08-13' \
               ), \
               ( \
                 'document:relocation-target', 'library:relocation-ledger', 1, 1, \
                 'nodex.page', 3, X'', '', 'ready', 'ydoc_primary', 'yjs', \
                 '2026-08-13', '2026-08-13' \
               ), \
               ( \
                 'document:relocation-other', 'library:relocation-ledger', 1, 1, \
                 'nodex.page', 3, X'', '', 'ready', 'ydoc_primary', 'yjs', \
                 '2026-08-13', '2026-08-13' \
               ); \
             INSERT INTO blocks( \
               id, library_id, type, lifecycle, placement_revision, metadata_revision, \
               created_at, updated_at \
             ) VALUES \
               ( \
                 'block:relocation-a', 'library:relocation-ledger', 'paragraph', \
                 'active', 1, 1, '2026-08-13', '2026-08-13' \
               ), \
               ( \
                 'block:relocation-b', 'library:relocation-ledger', 'paragraph', \
                 'active', 1, 1, '2026-08-13', '2026-08-13' \
               ); \
             INSERT INTO document_block_index( \
               document_id, block_id, parent_block_id, ordinal, block_type, text, projected_seq \
             ) VALUES \
               ( \
                 'document:relocation-source', 'block:relocation-a', NULL, 0, \
                 'paragraph', 'A', 1 \
               ), \
               ( \
                 'document:relocation-source', 'block:relocation-b', NULL, 1, \
                 'paragraph', 'B', 1 \
               );",
        )?;
        Ok(())
    }

    #[test]
    fn relocation_ledger_rejects_lost_or_ambiguous_blocks_before_seal() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("current Core store");
        kernel
            .writer()
            .call(|connection| seed_relocation_ledger(connection))
            .expect("seed relocation authorities");

        let source_only = kernel.writer().call(|connection| {
            with_immediate_transaction(connection, |transaction| {
                let commit = begin(
                    transaction,
                    "epoch:relocation-ledger",
                    "operation:source-only-relocation",
                    &"a".repeat(64),
                    "2026-08-13",
                )?;
                let block_ids = vec!["block:relocation-a".to_owned()];
                register_relocation_obligations(
                    transaction,
                    &commit,
                    "document:relocation-source",
                    &block_ids,
                )?;
                transaction.execute(
                    "DELETE FROM document_block_index WHERE block_id = 'block:relocation-a'",
                    [],
                )?;
                finalize(transaction, &commit).map(|_| ())
            })
        });
        let error = source_only.expect_err("source-only detach cannot seal");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);

        let partial = kernel.writer().call(|connection| {
            with_immediate_transaction(connection, |transaction| {
                let commit = begin(
                    transaction,
                    "epoch:relocation-ledger",
                    "operation:partial-relocation",
                    &"b".repeat(64),
                    "2026-08-13",
                )?;
                let block_ids = vec![
                    "block:relocation-a".to_owned(),
                    "block:relocation-b".to_owned(),
                ];
                register_relocation_obligations(
                    transaction,
                    &commit,
                    "document:relocation-source",
                    &block_ids,
                )?;
                transaction.execute(
                    "DELETE FROM document_block_index \
                     WHERE block_id IN ('block:relocation-a', 'block:relocation-b')",
                    [],
                )?;
                transaction.execute(
                    "INSERT INTO document_block_index( \
                       document_id, block_id, parent_block_id, ordinal, block_type, text, projected_seq \
                     ) VALUES ( \
                       'document:relocation-target', 'block:relocation-a', NULL, 0, \
                       'paragraph', 'A', 1 \
                     )",
                    [],
                )?;
                finalize(transaction, &commit).map(|_| ())
            })
        });
        let error = partial.expect_err("partial closure cannot seal");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);

        let ambiguous_source = kernel.writer().call(|connection| {
            with_immediate_transaction(connection, |transaction| {
                let commit = begin(
                    transaction,
                    "epoch:relocation-ledger",
                    "operation:ambiguous-relocation-source",
                    &"c".repeat(64),
                    "2026-08-13",
                )?;
                let block_ids = vec!["block:relocation-a".to_owned()];
                register_relocation_obligations(
                    transaction,
                    &commit,
                    "document:relocation-source",
                    &block_ids,
                )?;
                register_relocation_obligations(
                    transaction,
                    &commit,
                    "document:relocation-other",
                    &block_ids,
                )
            })
        });
        let error = ambiguous_source.expect_err("one Block cannot name two sources");
        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);

        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    let commit = begin(
                        transaction,
                        "epoch:relocation-ledger",
                        "operation:complete-relocation",
                        &"d".repeat(64),
                        "2026-08-13",
                    )?;
                    let block_ids = vec![
                        "block:relocation-a".to_owned(),
                        "block:relocation-b".to_owned(),
                    ];
                    register_relocation_obligations(
                        transaction,
                        &commit,
                        "document:relocation-source",
                        &block_ids,
                    )?;
                    transaction.execute(
                        "DELETE FROM document_block_index \
                         WHERE block_id IN ('block:relocation-a', 'block:relocation-b')",
                        [],
                    )?;
                    transaction.execute_batch(
                        "INSERT INTO document_block_index( \
                           document_id, block_id, parent_block_id, ordinal, block_type, text, projected_seq \
                         ) VALUES \
                           ( \
                             'document:relocation-target', 'block:relocation-a', NULL, 0, \
                             'paragraph', 'A', 1 \
                           ), \
                           ( \
                             'document:relocation-target', 'block:relocation-b', NULL, 1, \
                             'paragraph', 'B', 1 \
                           );",
                    )?;
                    validate_and_clear_relocation_obligations(transaction, &commit)?;
                    let obligations: i64 = transaction.query_row(
                        "SELECT count(*) FROM local_commit_relocation_obligations \
                         WHERE store_epoch = ?1 AND commit_seq = ?2",
                        params![commit.store_epoch(), commit.commit_seq()],
                        |row| row.get(0),
                    )?;
                    assert_eq!(obligations, 0);
                    Ok(())
                })
            })
            .expect("complete closure discharges every obligation");

        kernel
            .readers()
            .read_default(|connection| {
                let source_locations: i64 = connection.query_row(
                    "SELECT count(*) FROM document_block_index \
                     WHERE document_id = 'document:relocation-source'",
                    [],
                    |row| row.get(0),
                )?;
                let target_locations: i64 = connection.query_row(
                    "SELECT count(*) FROM document_block_index \
                     WHERE document_id = 'document:relocation-target'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!((source_locations, target_locations), (0, 2));
                Ok::<_, StoreError>(())
            })
            .expect("complete relocation authority");
    }

    #[test]
    fn local_commit_child_queries_use_the_complete_epoch_coordinate() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("current Core store");

        kernel
            .readers()
            .read_default(|connection| {
                let physical = query_plan(connection, PHYSICAL_EFFECT_EVIDENCE_SQL);
                assert!(
                    physical.contains(
                        "SEARCH effect USING PRIMARY KEY (store_epoch=? AND commit_seq=?)"
                    ),
                    "physical evidence lost its exact coordinate lookup:\n{physical}",
                );
                assert!(!physical.contains("USE TEMP B-TREE"), "{physical}");

                let documents = query_plan(connection, CANONICAL_DOCUMENT_EFFECTS_SQL);
                assert!(
                    documents.contains("idx_local_commit_documents_commit_order"),
                    "Document evidence lost its commit-order lookup:\n{documents}",
                );
                assert!(!documents.contains("USE TEMP B-TREE"), "{documents}");

                Ok(())
            })
            .expect("LocalCommit query plans");
    }

    #[test]
    fn document_effects_allow_concurrent_yjs_updates_from_an_older_base() {
        assert!(valid_document_transition(1, 99, 101, 29));
        assert!(valid_document_transition(1, 100, 101, 29));
        assert!(!valid_document_transition(1, 101, 101, 29));
        assert!(!valid_document_transition(1, 102, 101, 29));
    }

    #[test]
    fn local_commit_merges_repeated_document_effects_at_the_latest_head() {
        let merged = merge_projection_impact(
            ProjectionImpact::Resources {
                page_ids: vec!["page-a".to_owned()],
                database_ids: Vec::new(),
                data_source_ids: Vec::new(),
                view_ids: Vec::new(),
                document_heads: vec![head(1, 2)],
            },
            ProjectionImpact::Resources {
                page_ids: vec!["page-a".to_owned()],
                database_ids: Vec::new(),
                data_source_ids: Vec::new(),
                view_ids: Vec::new(),
                document_heads: vec![head(1, 3)],
            },
        )
        .expect("repeated Document effects should coalesce");

        assert_eq!(
            merged,
            ProjectionImpact::Resources {
                page_ids: vec!["page-a".to_owned()],
                database_ids: Vec::new(),
                data_source_ids: Vec::new(),
                view_ids: Vec::new(),
                document_heads: vec![head(1, 3)],
            }
        );
    }

    #[test]
    fn local_commit_rejects_repeated_document_identity_across_generations() {
        let error = merge_projection_impact(
            ProjectionImpact::Resources {
                page_ids: vec!["page-a".to_owned()],
                database_ids: Vec::new(),
                data_source_ids: Vec::new(),
                view_ids: Vec::new(),
                document_heads: vec![head(1, 2)],
            },
            ProjectionImpact::Resources {
                page_ids: vec!["page-a".to_owned()],
                database_ids: Vec::new(),
                data_source_ids: Vec::new(),
                view_ids: Vec::new(),
                document_heads: vec![head(2, 1)],
            },
        )
        .expect_err("one LocalCommit cannot span Document generations");

        assert_eq!(error.code, StoreErrorCode::StoreCorrupt);
    }

    #[test]
    fn local_commit_resources_are_canonical_before_they_enter_the_manifest() {
        let resources = canonicalize_resources(PhysicalEffectResources {
            block_ids: vec![
                "block-b".to_owned(),
                "block-a".to_owned(),
                "block-b".to_owned(),
            ],
            document_ids: vec![
                "document-b".to_owned(),
                "document-a".to_owned(),
                "document-a".to_owned(),
            ],
            database_ids: vec![
                "database-b".to_owned(),
                "database-b".to_owned(),
                "database-a".to_owned(),
            ],
        });

        assert_eq!(
            resources,
            PhysicalEffectResources {
                block_ids: vec!["block-a".to_owned(), "block-b".to_owned()],
                document_ids: vec!["document-a".to_owned(), "document-b".to_owned()],
                database_ids: vec!["database-a".to_owned(), "database-b".to_owned()],
            }
        );
    }

    #[test]
    fn exact_resource_fallback_does_not_promote_to_a_project_reset() {
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("current Core store");

        kernel
            .writer()
            .call(|connection| {
                let scopes = default_projection_scopes(
                    connection,
                    &ProjectionImpact::Resources {
                        page_ids: vec!["page:exact-fallback".to_owned()],
                        database_ids: vec!["database:routing-evidence".to_owned()],
                        data_source_ids: vec!["data-source:routing-evidence".to_owned()],
                        view_ids: Vec::new(),
                        document_heads: Vec::new(),
                    },
                    &["project:exact-fallback".to_owned()],
                )?;
                assert_eq!(
                    scopes,
                    vec![LocalProjectionScope::Page {
                        project_id: "project:exact-fallback".to_owned(),
                        page_id: "page:exact-fallback".to_owned(),
                    }]
                );
                Ok(())
            })
            .expect("exact projection fallback");
    }

    #[test]
    fn revocation_scope_identity_is_unambiguous_across_delimited_ids() {
        let first = DeliveryAuthorizationScope::Document {
            library_id: "library:test".to_owned(),
            project_id: Some("project:a".to_owned()),
            document_id: "document:b:c".to_owned(),
        };
        let second = DeliveryAuthorizationScope::Document {
            library_id: "library:test".to_owned(),
            project_id: Some("project:a:document:b".to_owned()),
            document_id: "c".to_owned(),
        };

        assert_ne!(
            authorization_scope_key(&first).expect("first scope key"),
            authorization_scope_key(&second).expect("second scope key"),
        );
    }
}
