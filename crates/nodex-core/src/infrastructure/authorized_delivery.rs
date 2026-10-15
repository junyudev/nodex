use super::local_commit::{self, LocalCommitResourceMode};
use super::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::events::{
    AuthorizedDeliveryAtom, AuthorizedDeliveryPacket, AuthorizedDocumentEffect,
    CommitManifestHeader, DeliveryAddress, DeliveryCoverage, DocumentEffectRef,
    LocalProjectionScope, ResourceKey,
};
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};
const DELIVERY_PACKET_VERSION: u32 = 5;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DeliveryResourceMode {
    RefOnly,
    Inline,
    MetadataOnly,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DeliveryAudience {
    BoundScope,
    HostLibraryBroker,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct DeliveryRequest<'a> {
    pub context: &'a BoundModuleContext,
    pub audience: DeliveryAudience,
    pub document_id: Option<&'a str>,
    pub resource_mode: DeliveryResourceMode,
}
#[derive(Serialize)]
struct CanonicalPacket<'a> {
    hash_version: u32,
    packet_version: u32,
    delivery_address: &'a DeliveryAddress,
    manifest: &'a CommitManifestHeader,
    atoms: &'a [AuthorizedDeliveryAtom],
    document_effects: &'a [AuthorizedDocumentEffect],
    projection_effects: &'a [nodex_core_contracts::ProjectionEffect],
    coverage: &'a DeliveryCoverage,
}
pub(crate) fn resolve(
    connection: &Connection,
    commit_seq: i64,
    request: DeliveryRequest<'_>,
) -> Result<Option<AuthorizedDeliveryPacket>, StoreError> {
    let verified = local_commit::load_verified_commit(connection, commit_seq)?;
    resolve_verified(connection, &verified, request)
}
pub(crate) fn resolve_verified(
    connection: &Connection,
    verified: &local_commit::VerifiedCommit,
    request: DeliveryRequest<'_>,
) -> Result<Option<AuthorizedDeliveryPacket>, StoreError> {
    let manifest = &verified.manifest;
    if manifest.identity.store_epoch.0 != request.context_store_epoch(connection)? {
        return Err(corrupt(
            "Delivery request and CommitManifest Store epoch differ",
        ));
    }
    if !manifest.routing_claims.iter().any(|claim|matches!(claim,nodex_core_contracts::RoutingClaim::Library{library_id} if library_id==&request.context.library_id.0)){return Ok(None);}
    if request.audience == DeliveryAudience::HostLibraryBroker
        && request.context.adapter != AdapterKind::ElectronHost
    {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Only the Electron Host may request the Library broker",
            false,
        ));
    }
    let delivery_address = delivery_address(request);
    let atoms=verified.delivery_atoms.iter().filter(|atom|request.document_id.is_none_or(|id|atom.descriptor.required_resources.iter().any(|resource|matches!(resource,ResourceKey::Document{document_id} if document_id==id))))
        .map(|atom|AuthorizedDeliveryAtom{descriptor:atom.descriptor.clone(),payload:atom.payload.clone()}).collect::<Vec<_>>();
    let mut document_effects = Vec::new();
    if request.resource_mode != DeliveryResourceMode::MetadataOnly {
        let resources = verified.delivery_document_effects(
            connection,
            match request.resource_mode {
                DeliveryResourceMode::RefOnly => LocalCommitResourceMode::RefOnly,
                DeliveryResourceMode::Inline => LocalCommitResourceMode::Inline,
                DeliveryResourceMode::MetadataOnly => unreachable!(),
            },
        )?;
        for resource in resources {
            if request
                .document_id
                .is_some_and(|id| id != resource.document_id)
            {
                continue;
            }
            // Dormant/deleted owners cannot receive live updates. This is Document lifecycle,
            // independent of the calling Project or Agent interaction mode.
            match crate::document::require_owned_document_for_live_delivery(
                connection,
                request.context,
                &resource.document_id,
            ) {
                Ok(()) => {}
                Err(error) if error.code == StoreErrorCode::NotFound => continue,
                Err(error) => return Err(error),
            }
            document_effects.push(AuthorizedDocumentEffect {
                history_fence: Some(crate::document::history_fence::read(
                    connection,
                    &resource.document_id,
                    resource.generation,
                    resource.base_head_seq,
                    resource.result_head_seq,
                )?),
                reference: DocumentEffectRef {
                    effect_order: resource.effect_order,
                    page_id: resource.page_id,
                    document_id: resource.document_id,
                    generation: resource.generation,
                    base_head_seq: resource.base_head_seq,
                    result_head_seq: resource.result_head_seq,
                    update_id: resource.update_id,
                    update_hash: resource.update_hash,
                    update_byte_length: resource.update_byte_length,
                    resource_kind: resource.resource_kind,
                },
                inline_update: resource.inline_update,
            });
        }
    }
    let projection_effects = route_projection_effects(
        &verified.sealed_projection_effects,
        request.document_id.is_none(),
        request.audience == DeliveryAudience::HostLibraryBroker
            || request.context.project_id.is_none(),
        request.context.project_id.as_ref().map(|id| id.0.as_str()),
    );
    if atoms.is_empty() && document_effects.is_empty() && projection_effects.is_empty() {
        return Ok(None);
    }
    let coverage = DeliveryCoverage {
        atom_ids: atoms
            .iter()
            .map(|atom| atom.descriptor.atom_id.clone())
            .collect(),
        document_effect_orders: document_effects
            .iter()
            .map(|effect| effect.reference.effect_order)
            .collect(),
        inline_document_effect_orders: document_effects
            .iter()
            .filter(|effect| effect.inline_update.is_some())
            .map(|effect| effect.reference.effect_order)
            .collect(),
        projection_scope_keys: projection_effects
            .iter()
            .map(|effect| effect.scope.canonical_key.clone())
            .collect(),
    };
    let header = CommitManifestHeader {
        event_version: manifest.event_version,
        identity: manifest.identity.clone(),
        operation_id: manifest.operation_id.clone(),
        committed_at: manifest.committed_at.clone(),
    };
    let packet_hash = packet_hash(CanonicalPacket {
        hash_version: 5,
        packet_version: DELIVERY_PACKET_VERSION,
        delivery_address: &delivery_address,
        manifest: &header,
        atoms: &atoms,
        document_effects: &document_effects,
        projection_effects: &projection_effects,
        coverage: &coverage,
    })?;
    Ok(Some(AuthorizedDeliveryPacket {
        packet_version: DELIVERY_PACKET_VERSION,
        delivery_address,
        manifest: header,
        atoms,
        document_effects,
        projection_effects,
        coverage,
        packet_hash,
    }))
}
impl DeliveryRequest<'_> {
    fn context_store_epoch(&self, connection: &Connection) -> Result<String, StoreError> {
        connection
            .query_row(
                "SELECT store_epoch FROM block_store_metadata WHERE id=1",
                [],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
    }
}
fn delivery_address(request: DeliveryRequest<'_>) -> DeliveryAddress {
    let library_id = request.context.library_id.0.clone();
    if let Some(document_id) = request.document_id {
        return DeliveryAddress::Document {
            library_id,
            project_id: request
                .context
                .project_id
                .as_ref()
                .map(|project_id| project_id.0.clone()),
            document_id: document_id.to_owned(),
        };
    }
    if request.audience == DeliveryAudience::HostLibraryBroker {
        return DeliveryAddress::Library { library_id };
    }
    match &request.context.project_id {
        Some(project_id) => DeliveryAddress::Project {
            library_id,
            project_id: project_id.0.clone(),
        },
        None => DeliveryAddress::Library { library_id },
    }
}

fn projection_scope_project(scope: &LocalProjectionScope) -> Option<&str> {
    match scope {
        LocalProjectionScope::Library { .. } => None,
        LocalProjectionScope::Project { project_id }
        | LocalProjectionScope::StructuralHistory { project_id }
        | LocalProjectionScope::Page { project_id, .. }
        | LocalProjectionScope::PageDetailDatabase { project_id, .. }
        | LocalProjectionScope::PageDetailDataSource { project_id, .. }
        | LocalProjectionScope::DatabaseView { project_id, .. } => Some(project_id),
    }
}

fn route_projection_effects(
    effects: &[local_commit::SealedProjectionEffect],
    include: bool,
    all_projects: bool,
    project_id: Option<&str>,
) -> Vec<nodex_core_contracts::ProjectionEffect> {
    if !include {
        return Vec::new();
    }
    effects
        .iter()
        .filter(|sealed| {
            all_projects
                || project_id.is_some_and(|id| {
                    projection_scope_project(&sealed.transition.scope.scope) == Some(id)
                })
        })
        .map(|sealed| sealed.transition.clone())
        .collect()
}
fn packet_hash(packet: CanonicalPacket<'_>) -> Result<String, StoreError> {
    let encoded =
        serde_json::to_vec(&packet).map_err(|_| corrupt("DeliveryPacket hash input is invalid"))?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}
fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
