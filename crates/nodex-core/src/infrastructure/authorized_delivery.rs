use nodex_core_contracts::events::{
    AuthorizedDeliveryAtom, AuthorizedDeliveryPacket, AuthorizedDocumentEffect,
    CommitManifestHeader, ConservativeResetReason, DeliveryAddress, DeliveryAuthorizationScope,
    DeliveryCoverage, DocumentEffectRef, LocalProjectionScope, ResourceKey, ResourceRevocation,
    VisibilityDelta, VisibilityDeltaKind,
};
use nodex_core_contracts::{AdapterKind, BoundModuleContext};
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::local_commit::{self, LocalCommitResourceMode};
use super::sqlite::{StoreError, StoreErrorCode};

const DELIVERY_PACKET_VERSION: u32 = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DeliveryResourceMode {
    RefOnly,
    Inline,
    /// Authorized metadata atoms and projections, without engine update resources.
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
    authorization_scope: &'a DeliveryAuthorizationScope,
    manifest: &'a CommitManifestHeader,
    atoms: &'a [AuthorizedDeliveryAtom],
    document_effects: &'a [AuthorizedDocumentEffect],
    projection_effects: &'a [nodex_core_contracts::ProjectionEffect],
    visibility_deltas: &'a [VisibilityDelta],
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
    if !manifest.routing_claims.iter().any(|claim| {
        matches!(
            claim,
            nodex_core_contracts::RoutingClaim::Library { library_id }
                if library_id == &request.context.library_id.0
        )
    }) {
        return Ok(None);
    }

    if request.audience == DeliveryAudience::HostLibraryBroker
        && request.context.adapter != AdapterKind::ElectronHost
    {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Only the Electron Host may request the Library broker delivery audience",
            false,
        ));
    }

    let library_authority = request.audience == DeliveryAudience::HostLibraryBroker
        || (request.context.project_id.is_none()
            && matches!(
                request.context.adapter,
                AdapterKind::ElectronHost | AdapterKind::NativeCli | AdapterKind::Test
            ));
    let project_id = request.context.project_id.as_ref().map(|id| id.0.as_str());
    if !library_authority && project_id.is_none() {
        return Ok(None);
    }
    let authorization_scope = delivery_authorization_scope(request);
    let delivery_address = delivery_address(request);
    validate_address_scope_compatibility(&delivery_address, &authorization_scope)?;

    let mut atoms = Vec::new();
    for atom in &verified.delivery_atoms {
        if request.document_id.is_some_and(|document_id| {
            !atom.descriptor.required_resources.iter().any(|resource| {
                matches!(
                    resource,
                    ResourceKey::Document {
                        document_id: candidate,
                    } if candidate == document_id
                )
            })
        }) {
            continue;
        }
        let mut allowed = true;
        for resource in &atom.descriptor.required_resources {
            if !super::resource_authorization::can_read(
                connection,
                request.context,
                &authorization_scope,
                resource,
            )? {
                allowed = false;
                break;
            }
        }
        if allowed {
            atoms.push(AuthorizedDeliveryAtom {
                descriptor: atom.descriptor.clone(),
                payload: atom.payload.clone(),
            });
        }
    }

    let mut document_effects = Vec::new();
    if request.resource_mode != DeliveryResourceMode::MetadataOnly {
        let document_resources = verified.delivery_document_effects(
            connection,
            match request.resource_mode {
                DeliveryResourceMode::RefOnly => LocalCommitResourceMode::RefOnly,
                DeliveryResourceMode::Inline => LocalCommitResourceMode::Inline,
                DeliveryResourceMode::MetadataOnly => unreachable!(),
            },
        )?;
        for resource in document_resources {
            if request
                .document_id
                .is_some_and(|document_id| document_id != resource.document_id)
            {
                continue;
            }
            let allowed = super::resource_authorization::can_read(
                connection,
                request.context,
                &authorization_scope,
                &ResourceKey::Document {
                    document_id: resource.document_id.clone(),
                },
            )?;
            if !allowed {
                continue;
            }
            document_effects.push(AuthorizedDocumentEffect {
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

    let projection_effects = authorize_projection_effects(
        &verified.sealed_projection_effects,
        request.document_id.is_none(),
        library_authority,
        project_id,
        |resource| {
            super::resource_authorization::can_read(
                connection,
                request.context,
                &authorization_scope,
                resource,
            )
        },
    )?;
    let visibility_deltas =
        authorized_visibility_deltas(connection, manifest, request, &authorization_scope)?;
    if atoms.is_empty()
        && document_effects.is_empty()
        && projection_effects.is_empty()
        && visibility_deltas.is_empty()
    {
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
        hash_version: 4,
        packet_version: DELIVERY_PACKET_VERSION,
        delivery_address: &delivery_address,
        authorization_scope: &authorization_scope,
        manifest: &header,
        atoms: &atoms,
        document_effects: &document_effects,
        projection_effects: &projection_effects,
        visibility_deltas: &visibility_deltas,
        coverage: &coverage,
    })?;
    Ok(Some(AuthorizedDeliveryPacket {
        packet_version: DELIVERY_PACKET_VERSION,
        delivery_address,
        authorization_scope,
        manifest: header,
        atoms,
        document_effects,
        projection_effects,
        visibility_deltas,
        coverage,
        packet_hash,
    }))
}

impl DeliveryRequest<'_> {
    fn context_store_epoch(&self, connection: &Connection) -> Result<String, StoreError> {
        connection
            .query_row(
                "SELECT store_epoch FROM block_store_metadata WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
    }
}

fn delivery_authorization_scope(request: DeliveryRequest<'_>) -> DeliveryAuthorizationScope {
    let library_id = request.context.library_id.0.clone();
    if let Some(document_id) = request.document_id {
        return DeliveryAuthorizationScope::Document {
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
        return DeliveryAuthorizationScope::Library { library_id };
    }
    match &request.context.project_id {
        Some(project_id) => DeliveryAuthorizationScope::Project {
            library_id,
            project_id: project_id.0.clone(),
        },
        None => DeliveryAuthorizationScope::Library { library_id },
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

fn validate_address_scope_compatibility(
    address: &DeliveryAddress,
    scope: &DeliveryAuthorizationScope,
) -> Result<(), StoreError> {
    let compatible = match (address, scope) {
        (
            DeliveryAddress::Library {
                library_id: address_library,
            },
            DeliveryAuthorizationScope::Library {
                library_id: scope_library,
            },
        ) => address_library == scope_library,
        (
            DeliveryAddress::Project {
                library_id: address_library,
                project_id: address_project,
            },
            DeliveryAuthorizationScope::Project {
                library_id: scope_library,
                project_id: scope_project,
            },
        ) => address_library == scope_library && address_project == scope_project,
        (
            DeliveryAddress::Document {
                library_id: address_library,
                project_id: address_project,
                document_id: address_document,
            },
            DeliveryAuthorizationScope::Document {
                library_id: scope_library,
                project_id: scope_project,
                document_id: scope_document,
            },
        ) => {
            address_library == scope_library
                && address_project == scope_project
                && address_document == scope_document
        }
        _ => false,
    };
    if compatible {
        return Ok(());
    }
    Err(corrupt(
        "Authorized delivery address and authorization scope diverge",
    ))
}

fn authorized_visibility_deltas(
    connection: &Connection,
    manifest: &nodex_core_contracts::CommitManifest,
    request: DeliveryRequest<'_>,
    authorization_scope: &DeliveryAuthorizationScope,
) -> Result<Vec<VisibilityDelta>, StoreError> {
    let rows = connection
        .prepare_cached(
            "SELECT authorization_scope_json, delta_kind, roots_json, delta_hash
             FROM local_commit_visibility_deltas
             WHERE store_epoch = ?1 AND commit_seq = ?2
             ORDER BY scope_key, delta_hash",
        )?
        .query_map(
            rusqlite::params![
                manifest.identity.store_epoch.0,
                manifest.identity.commit_seq
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut deltas = Vec::new();
    for (scope_json, kind, roots_json, delta_hash) in rows {
        let scope = serde_json::from_str::<DeliveryAuthorizationScope>(&scope_json)
            .map_err(|_| corrupt("Visibility delta scope is invalid"))?;
        if &scope != authorization_scope {
            continue;
        }
        let roots = serde_json::from_str::<Vec<ResourceKey>>(&roots_json)
            .map_err(|_| corrupt("Visibility delta roots are invalid"))?;
        let change = match kind.as_str() {
            "grant" => VisibilityDeltaKind::Grant,
            "revoke" => VisibilityDeltaKind::Revoke {
                reason: nodex_core_contracts::ResourceRevocationReason::AccessRevoked,
            },
            "conservative_reset" => VisibilityDeltaKind::ConservativeReset {
                reason: ConservativeResetReason::AuthorizationClosureExceeded,
            },
            _ => return Err(corrupt("Visibility delta kind is invalid")),
        };
        deltas.push(VisibilityDelta {
            authorization_scope: scope,
            change,
            roots,
            delta_hash,
        });
    }

    for revocation in authorized_revocations(manifest, request) {
        if revocation.authorization_scope != *authorization_scope {
            continue;
        }
        let root = revocation_root(&revocation);
        if deltas.iter().any(|delta| {
            matches!(delta.change, VisibilityDeltaKind::Revoke { .. })
                && delta.roots.iter().any(|candidate| candidate == &root)
        }) {
            continue;
        }
        let encoded = serde_json::to_vec(&(
            "legacy-revocation-v1",
            &manifest.identity,
            &revocation,
            &root,
        ))
        .map_err(|_| corrupt("Legacy visibility delta hash input is invalid"))?;
        deltas.push(VisibilityDelta {
            authorization_scope: revocation.authorization_scope,
            change: VisibilityDeltaKind::Revoke {
                reason: revocation.reason,
            },
            roots: vec![root],
            delta_hash: format!("{:x}", Sha256::digest(encoded)),
        });
    }
    deltas.sort_by(|left, right| left.delta_hash.cmp(&right.delta_hash));
    Ok(deltas)
}

fn revocation_root(revocation: &ResourceRevocation) -> ResourceKey {
    match revocation.resource_kind {
        nodex_core_contracts::RevokedResourceKind::Page => ResourceKey::Page {
            page_id: revocation.resource_id.clone(),
        },
        nodex_core_contracts::RevokedResourceKind::Document => ResourceKey::Document {
            document_id: revocation.resource_id.clone(),
        },
        nodex_core_contracts::RevokedResourceKind::Database => ResourceKey::Database {
            database_id: revocation.resource_id.clone(),
        },
        nodex_core_contracts::RevokedResourceKind::DataSource => ResourceKey::DataSource {
            data_source_id: revocation.resource_id.clone(),
        },
        nodex_core_contracts::RevokedResourceKind::View => ResourceKey::View {
            view_id: revocation.resource_id.clone(),
        },
        nodex_core_contracts::RevokedResourceKind::Canvas => ResourceKey::Canvas {
            canvas_id: revocation.resource_id.clone(),
        },
        nodex_core_contracts::RevokedResourceKind::File => ResourceKey::File {
            file_id: revocation.resource_id.clone(),
        },
    }
}

fn authorized_revocations(
    manifest: &nodex_core_contracts::CommitManifest,
    request: DeliveryRequest<'_>,
) -> Vec<ResourceRevocation> {
    let library_id = &request.context.library_id.0;
    let project_id = request.context.project_id.as_ref().map(|id| id.0.as_str());
    manifest
        .revocations
        .iter()
        .filter(|revocation| {
            revocation_scope_matches(
                &revocation.authorization_scope,
                library_id,
                project_id,
                request.document_id,
            )
        })
        .cloned()
        .collect()
}

fn revocation_scope_matches(
    scope: &DeliveryAuthorizationScope,
    library_id: &str,
    project_id: Option<&str>,
    document_id: Option<&str>,
) -> bool {
    if let Some(document_id) = document_id {
        return matches!(
            scope,
            DeliveryAuthorizationScope::Document {
                library_id: scope_library_id,
                project_id: scope_project_id,
                document_id: scope_document_id,
            } if scope_library_id == library_id
                && scope_project_id.as_deref() == project_id
                && scope_document_id == document_id
        );
    }
    match scope {
        DeliveryAuthorizationScope::Library {
            library_id: scope_library_id,
        } => scope_library_id == library_id && project_id.is_none(),
        DeliveryAuthorizationScope::Project {
            library_id: scope_library_id,
            project_id: scope_project_id,
        } => {
            scope_library_id == library_id
                && (project_id.is_none() || project_id == Some(scope_project_id.as_str()))
        }
        DeliveryAuthorizationScope::Document {
            library_id: scope_library_id,
            project_id: scope_project_id,
            ..
        } => {
            scope_library_id == library_id
                && (project_id.is_none() || project_id == scope_project_id.as_deref())
        }
    }
}

fn projection_scope_project(scope: &LocalProjectionScope) -> Option<&str> {
    match scope {
        LocalProjectionScope::Library { .. } => None,
        LocalProjectionScope::Project { project_id }
        | LocalProjectionScope::Page { project_id, .. }
        | LocalProjectionScope::PageDetailDatabase { project_id, .. }
        | LocalProjectionScope::PageDetailDataSource { project_id, .. }
        | LocalProjectionScope::DatabaseView { project_id, .. } => Some(project_id),
    }
}

fn authorize_projection_effects(
    effects: &[local_commit::SealedProjectionEffect],
    include_projections: bool,
    library_authority: bool,
    project_id: Option<&str>,
    mut can_read: impl FnMut(&ResourceKey) -> Result<bool, StoreError>,
) -> Result<Vec<nodex_core_contracts::ProjectionEffect>, StoreError> {
    if !include_projections {
        return Ok(Vec::new());
    }
    let mut authorized = Vec::new();
    for sealed in effects {
        let audience_matches = library_authority
            || project_id.is_some_and(|project_id| {
                projection_scope_project(&sealed.transition.scope.scope) == Some(project_id)
            });
        if !audience_matches || !can_read(&sealed.subject)? {
            continue;
        }
        let mut all_requirements_readable = true;
        for resource in &sealed.required_resources {
            if !can_read(resource)? {
                all_requirements_readable = false;
                break;
            }
        }
        if all_requirements_readable {
            authorized.push(sealed.transition.clone());
            continue;
        }
        let mut repair = sealed.transition.clone();
        repair.patch = None;
        repair.requires_read_at_least = true;
        authorized.push(repair);
    }
    Ok(authorized)
}

fn packet_hash(packet: CanonicalPacket<'_>) -> Result<String, StoreError> {
    let encoded = serde_json::to_vec(&packet)
        .map_err(|_| corrupt("AuthorizedDeliveryPacket hash input is invalid"))?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use nodex_core_contracts::events::{
        CommitIdentity, CoreModuleEventPayload, DocumentEffectResourceKind, LocalProjectionPatch,
        LocalProjectionScope, ProjectionEffect, ProjectionScopeKey,
    };
    use nodex_core_contracts::{StoreEpoch, document::OwnedDocumentEvent};

    use super::*;

    fn header() -> CommitManifestHeader {
        CommitManifestHeader {
            event_version: nodex_core_contracts::CORE_EVENT_VERSION,
            identity: CommitIdentity {
                store_epoch: StoreEpoch("epoch:test".to_owned()),
                commit_seq: 7,
                manifest_hash: "a".repeat(64),
            },
            operation_id: "operation:test".to_owned(),
            committed_at: "2026-08-07T00:00:00Z".to_owned(),
        }
    }

    fn document_effect(inline_update: Option<Vec<u8>>) -> AuthorizedDocumentEffect {
        AuthorizedDocumentEffect {
            reference: DocumentEffectRef {
                effect_order: 0,
                page_id: Some("page:test".to_owned()),
                document_id: "document:test".to_owned(),
                generation: 1,
                base_head_seq: 3,
                result_head_seq: 4,
                update_id: "update:test".to_owned(),
                update_hash: "b".repeat(64),
                update_byte_length: 3,
                resource_kind: DocumentEffectResourceKind::DocumentUpdate,
            },
            inline_update,
        }
    }

    #[test]
    fn document_update_bytes_have_no_delivery_atom() {
        let connection = Connection::open_in_memory().expect("in-memory compiler store");
        let payload = CoreModuleEventPayload::OwnedDocument(OwnedDocumentEvent::DocumentUpdated {
            document_id: "document:test".to_owned(),
            generation: 1,
            head_seq: 4,
            update: vec![1, 2, 3],
            page_file_body_usage_changed: false,
            page_file_reference_change: None,
        });

        assert!(
            super::super::delivery_atom::compile(
                &connection,
                "library:test",
                "project:test",
                payload,
            )
            .expect("compile document update")
            .is_empty()
        );
    }

    #[test]
    fn delivery_address_scope_matrix_is_exact_and_closed() {
        let library_address = DeliveryAddress::Library {
            library_id: "library:test".to_owned(),
        };
        let library_scope = DeliveryAuthorizationScope::Library {
            library_id: "library:test".to_owned(),
        };
        let project_address = DeliveryAddress::Project {
            library_id: "library:test".to_owned(),
            project_id: "project:test".to_owned(),
        };
        let project_scope = DeliveryAuthorizationScope::Project {
            library_id: "library:test".to_owned(),
            project_id: "project:test".to_owned(),
        };
        let document_address = DeliveryAddress::Document {
            library_id: "library:test".to_owned(),
            project_id: Some("project:test".to_owned()),
            document_id: "document:test".to_owned(),
        };
        let document_scope = DeliveryAuthorizationScope::Document {
            library_id: "library:test".to_owned(),
            project_id: Some("project:test".to_owned()),
            document_id: "document:test".to_owned(),
        };

        assert!(validate_address_scope_compatibility(&library_address, &library_scope).is_ok());
        assert!(validate_address_scope_compatibility(&project_address, &project_scope).is_ok());
        assert!(validate_address_scope_compatibility(&document_address, &document_scope).is_ok());
        assert!(validate_address_scope_compatibility(&library_address, &project_scope).is_err());
        assert!(validate_address_scope_compatibility(&project_address, &library_scope).is_err());
        assert!(validate_address_scope_compatibility(&project_address, &document_scope).is_err());
    }

    #[test]
    fn inline_coverage_changes_only_the_packet_hash_not_manifest_identity() {
        let manifest = header();
        let reference = vec![document_effect(None)];
        let inline = vec![document_effect(Some(vec![1, 2, 3]))];
        let reference_coverage = DeliveryCoverage {
            atom_ids: Vec::new(),
            document_effect_orders: vec![0],
            inline_document_effect_orders: Vec::new(),
            projection_scope_keys: Vec::new(),
        };
        let inline_coverage = DeliveryCoverage {
            inline_document_effect_orders: vec![0],
            ..reference_coverage.clone()
        };
        let scope = DeliveryAuthorizationScope::Project {
            library_id: "library:test".to_owned(),
            project_id: "project:test".to_owned(),
        };
        let address = DeliveryAddress::Project {
            library_id: "library:test".to_owned(),
            project_id: "project:test".to_owned(),
        };

        let reference_hash = packet_hash(CanonicalPacket {
            hash_version: 4,
            packet_version: DELIVERY_PACKET_VERSION,
            delivery_address: &address,
            authorization_scope: &scope,
            manifest: &manifest,
            atoms: &[],
            document_effects: &reference,
            projection_effects: &[],
            visibility_deltas: &[],
            coverage: &reference_coverage,
        })
        .expect("reference packet hash");
        let inline_hash = packet_hash(CanonicalPacket {
            hash_version: 4,
            packet_version: DELIVERY_PACKET_VERSION,
            delivery_address: &address,
            authorization_scope: &scope,
            manifest: &manifest,
            atoms: &[],
            document_effects: &inline,
            projection_effects: &[],
            visibility_deltas: &[],
            coverage: &inline_coverage,
        })
        .expect("inline packet hash");
        let other_scope = DeliveryAuthorizationScope::Project {
            library_id: "library:test".to_owned(),
            project_id: "project:other".to_owned(),
        };
        let other_address = DeliveryAddress::Project {
            library_id: "library:test".to_owned(),
            project_id: "project:other".to_owned(),
        };
        let other_scope_hash = packet_hash(CanonicalPacket {
            hash_version: 4,
            packet_version: DELIVERY_PACKET_VERSION,
            delivery_address: &other_address,
            authorization_scope: &other_scope,
            manifest: &manifest,
            atoms: &[],
            document_effects: &reference,
            projection_effects: &[],
            visibility_deltas: &[],
            coverage: &reference_coverage,
        })
        .expect("other-scope packet hash");

        assert_ne!(reference_hash, inline_hash);
        assert_ne!(reference_hash, other_scope_hash);
        assert_eq!(manifest.identity.manifest_hash, "a".repeat(64));
    }

    #[test]
    fn historical_projection_with_a_revoked_relation_target_becomes_read_at_least() {
        let patch: LocalProjectionPatch = serde_json::from_value(serde_json::json!({
            "kind": "database_row_upsert",
            "project_id": "project:reader",
            "database_id": "database:board",
            "data_source_id": "source:board",
            "view_id": "view:board",
            "row": {
                "page_id": "page:row",
                "lifecycle": "active",
                "title": "Row",
                "rich_title": [],
                "description_preview": "",
                "description_length": 0,
                "has_description": false,
                "database_values": {
                    "p_relation": {
                        "kind": "relation",
                        "value": {
                            "value_revision": 1,
                            "total_count": 1,
                            "targets": [{
                                "kind": "visible",
                                "edge_id": "edge:target",
                                "page_id": "page:revoked-target",
                                "title": "Secret target",
                                "lifecycle": "active",
                                "membership_state": "active"
                            }],
                            "restricted_count": 0,
                            "has_more": false
                        }
                    }
                },
                "database_display_values": {},
                "intrinsic_properties": {},
                "database_value_revisions": {},
                "task_parent_value_revision": 1,
                "metadata_revision": 1,
                "parent_revision": 1,
                "document_id": "document:row",
                "document_generation": 1,
                "document_head_seq": 1,
                "membership_id": "membership:row",
                "membership_revision": 1,
                "membership_created_at": "2026-08-09T00:00:00Z",
                "created_at": "2026-08-09T00:00:00Z",
                "updated_at": "2026-08-09T00:00:00Z",
                "effective_group_key": null,
                "rank_key": null,
                "position_revision": null,
                "position_order": null
            },
            "total_rows": 1,
            "group_total": null
        }))
        .expect("projection patch");
        let effects = vec![ProjectionEffect {
            scope: ProjectionScopeKey {
                schema_version: 1,
                canonical_key: "scope:view".to_owned(),
                scope: LocalProjectionScope::DatabaseView {
                    project_id: "project:reader".to_owned(),
                    database_id: "database:board".to_owned(),
                    data_source_id: "source:board".to_owned(),
                    view_id: "view:board".to_owned(),
                },
            },
            base_revision: 4,
            result_revision: 5,
            covered_commit_seq: 9,
            patch: Some(patch),
            requires_read_at_least: false,
            effect_hash: "e".repeat(64),
        }];
        let sealed = local_commit::sealed_projection_effects(&effects)
            .expect("seal projection requirements");

        let authorized = authorize_projection_effects(
            &sealed,
            true,
            false,
            Some("project:reader"),
            |resource| {
                Ok(!matches!(
                    resource,
                    ResourceKey::Page { page_id } if page_id == "page:revoked-target"
                ))
            },
        )
        .expect("authorize historical projection");

        assert_eq!(authorized.len(), 1);
        assert!(authorized[0].patch.is_none());
        assert!(authorized[0].requires_read_at_least);
        assert_eq!(authorized[0].effect_hash, "e".repeat(64));
        let encoded = serde_json::to_string(&authorized).expect("encode repair effect");
        assert!(!encoded.contains("page:revoked-target"));
        assert!(!encoded.contains("Secret target"));
        assert!(!encoded.contains("edge:target"));
    }

    #[test]
    fn consecutive_safe_projection_transitions_remain_incremental() {
        let effects = [4_i64, 5_i64]
            .into_iter()
            .map(|result_revision| ProjectionEffect {
                scope: ProjectionScopeKey {
                    schema_version: 1,
                    canonical_key: "scope:page".to_owned(),
                    scope: LocalProjectionScope::Page {
                        project_id: "project:reader".to_owned(),
                        page_id: "page:visible".to_owned(),
                    },
                },
                base_revision: result_revision - 1,
                result_revision,
                covered_commit_seq: result_revision + 10,
                patch: Some(LocalProjectionPatch::PageChanged {
                    project_id: "project:reader".to_owned(),
                    page_id: "page:visible".to_owned(),
                }),
                requires_read_at_least: false,
                effect_hash: format!("{result_revision:x}").repeat(64),
            })
            .collect::<Vec<_>>();
        let sealed = local_commit::sealed_projection_effects(&effects)
            .expect("seal consecutive transitions");

        let authorized =
            authorize_projection_effects(&sealed, true, false, Some("project:reader"), |_| {
                Ok(true)
            })
            .expect("authorize consecutive transitions");

        assert_eq!(
            authorized
                .iter()
                .map(|effect| effect.result_revision)
                .collect::<Vec<_>>(),
            vec![4, 5]
        );
        assert!(authorized.iter().all(|effect| effect.patch.is_some()));
        assert!(
            authorized
                .iter()
                .all(|effect| !effect.requires_read_at_least)
        );
    }
}
