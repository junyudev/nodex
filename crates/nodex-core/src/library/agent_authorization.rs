use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use nodex_core_contracts::agent::{
    AgentAuthorizationTarget, AgentProjectResourceAccess, AgentProjectResourceAction,
    AgentResourceAccessOverlay, AgentResourceAccessOverlayKind, AgentResourceAccessOverlayScope,
    AgentResourceAccessPlan, AgentResourceAuthorizationReason, AgentResourceConsentReason,
    AgentResourceConsentRequirement, AgentResourceGrantRoot, AgentResourceGrantSpec,
    AgentResourceIntent, AgentTurnProvenance,
};
use nodex_core_contracts::workspace::{
    ProjectWorkspaceTurnAuthority, ProjectWorkspaceTurnAuthorityScope,
};
use nodex_core_contracts::{AdapterKind, BoundModuleContext, ModuleName};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value as SqlValue};

use crate::document::sha256;
use crate::infrastructure::durable_mutation::{self, OperationIdentity};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use crate::workspace::validate_persisted_turn_authority;

use super::LibraryApplyOutcome;
use super::mutation::{MutationEffects, library_commit_result, seal_mutation, sqlite_now};

const MAX_ID_BYTES: usize = 512;
const MAX_INTENTS: usize = 64;
const MAX_GRANTS: usize = 128;

#[derive(Clone)]
struct ProjectAuthority {
    lifecycle: String,
    primary_database_id: Option<String>,
}

#[derive(Clone)]
struct ResourceCoordinates {
    target: AgentAuthorizationTarget,
    owning_database_ids: Vec<String>,
    page_ancestor_ids: Vec<String>,
    preferred_grant_root: AgentResourceGrantRoot,
}

enum CoordinateResolution {
    Found(ResourceCoordinates),
    Missing,
    Corrupt,
}

struct GrantMatch {
    access: AgentProjectResourceAccess,
}

struct ProjectGrant {
    root_kind: String,
    root_id: String,
    access: AgentProjectResourceAccess,
}

#[derive(Default)]
struct PageCoordinateBuilder {
    ancestor_ids: Vec<String>,
    terminal: Option<(String, String, Option<String>)>,
}

pub(super) fn plan(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    provenance: &AgentTurnProvenance,
    call_id: &str,
    intents: &[AgentResourceIntent],
    task_access: Option<&AgentResourceAccessOverlay>,
) -> Result<AgentResourceAccessPlan, StoreError> {
    validate_transport_context(context, provenance)?;
    validate_id("call_id", call_id)?;
    if intents.is_empty() || intents.len() > MAX_INTENTS {
        return Err(invalid("Agent resource intent count is invalid"));
    }
    validate_persisted_turn_authority(connection, library_id, provenance)?;
    if let Some(overlay) = task_access {
        validate_overlay_shape(overlay)?;
    }

    let authority = &provenance.authority;
    let project = read_project(connection, library_id, &authority.actor_project_id)?
        .ok_or_else(|| unauthorized("Agent Turn Project is unavailable"))?;
    let mut requirements = Vec::new();
    let mut uses_task_access = false;

    for intent in intents {
        validate_intent(intent)?;
        if let AgentAuthorizationTarget::Library {
            library_id: target_library_id,
        } = &intent.target
        {
            if target_library_id != library_id {
                return Ok(denied(
                    intent,
                    AgentResourceAuthorizationReason::LibraryMismatch,
                ));
            }
            if authority.scope == ProjectWorkspaceTurnAuthorityScope::Library {
                continue;
            }
            if intent.action != AgentProjectResourceAction::CreateChild {
                return Ok(denied(
                    intent,
                    AgentResourceAuthorizationReason::StructuralCapabilityRequired,
                ));
            }
            if task_access.is_some_and(|overlay| {
                overlay_covers_library(authority, overlay, target_library_id, call_id)
            }) {
                uses_task_access = true;
                continue;
            }
            requirements.push(AgentResourceConsentRequirement {
                intent: intent.clone(),
                grant: AgentResourceGrantSpec {
                    root: AgentResourceGrantRoot::Library {
                        library_id: target_library_id.clone(),
                    },
                    access: AgentProjectResourceAccess::ReadWrite,
                    library_actions: vec![AgentProjectResourceAction::CreateChild],
                },
                reason: AgentResourceConsentReason::LibraryConsentRequired,
                persistable: false,
            });
            continue;
        }

        let coordinates = match resolve_coordinates(connection, library_id, &intent.target)? {
            CoordinateResolution::Found(coordinates) => coordinates,
            CoordinateResolution::Missing => {
                return Ok(denied(
                    intent,
                    AgentResourceAuthorizationReason::ResourceNotFound,
                ));
            }
            CoordinateResolution::Corrupt => {
                return Ok(denied(
                    intent,
                    AgentResourceAuthorizationReason::ResourceHierarchyCorrupt,
                ));
            }
        };
        let direct = authorize_resource(
            connection,
            authority.scope,
            &authority.actor_project_id,
            &project,
            &coordinates,
            intent.action,
        )?;
        if direct == AgentResourceAuthorizationReason::Allowed {
            continue;
        }
        let consent_reason = match direct {
            AgentResourceAuthorizationReason::GrantMissing => {
                AgentResourceConsentReason::GrantMissing
            }
            AgentResourceAuthorizationReason::GrantReadOnly => {
                AgentResourceConsentReason::GrantReadOnly
            }
            reason => return Ok(denied(intent, reason)),
        };
        if task_access.is_some_and(|overlay| {
            overlay_covers_resource(authority, overlay, &coordinates, intent.action, call_id)
        }) {
            uses_task_access = true;
            continue;
        }
        requirements.push(AgentResourceConsentRequirement {
            intent: AgentResourceIntent {
                target: coordinates.target.clone(),
                action: intent.action,
            },
            grant: AgentResourceGrantSpec {
                root: coordinates.preferred_grant_root,
                access: required_access(intent.action),
                library_actions: Vec::new(),
            },
            reason: consent_reason,
            persistable: true,
        });
    }

    let requirements = canonicalize_requirements(requirements);
    if requirements.is_empty() {
        return Ok(AgentResourceAccessPlan::Authorized {
            resource_access: uses_task_access.then(|| task_access.cloned()).flatten(),
        });
    }
    let grants = task_access
        .into_iter()
        .flat_map(|overlay| overlay.grants.iter().cloned())
        .chain(
            requirements
                .iter()
                .map(|requirement| requirement.grant.clone()),
        )
        .collect::<Vec<_>>();
    Ok(AgentResourceAccessPlan::ConsentRequired {
        requirements,
        inspection_access: AgentResourceAccessOverlay {
            kind: AgentResourceAccessOverlayKind::Inspection,
            scope: AgentResourceAccessOverlayScope::Call,
            thread_id: Some(authority.thread_id.clone()),
            turn_id: Some(authority.turn_id.clone()),
            call_id: Some(call_id.to_owned()),
            root_thread_id: authority.root_thread_id.clone(),
            actor_project_id: authority.actor_project_id.clone(),
            library_id: authority.library_id.clone(),
            store_epoch: authority.store_epoch.clone(),
            grants: canonicalize_grants(&grants)?,
            persist_resulting_page_grants: false,
        },
    })
}

pub(crate) fn authorize_execution(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    authorization: &nodex_core_contracts::agent::AgentExecutionAuthorization,
    target: &AgentAuthorizationTarget,
    action: AgentProjectResourceAction,
) -> Result<String, StoreError> {
    validate_execution_transport_context(context, &authorization.provenance)?;
    validate_id("call_id", &authorization.call_id)?;
    let authority_fingerprint =
        validate_persisted_turn_authority(connection, library_id, &authorization.provenance)?;
    if let Some(overlay) = authorization.resource_access.as_ref() {
        validate_overlay_shape(overlay)?;
    }
    let authority = &authorization.provenance.authority;
    let project = read_project(connection, library_id, &authority.actor_project_id)?
        .ok_or_else(|| unauthorized("Agent Turn Project is unavailable"))?;
    if let AgentAuthorizationTarget::Library {
        library_id: target_library_id,
    } = target
    {
        if target_library_id != library_id {
            return Err(unauthorized("Agent target belongs to another Library"));
        }
        if authority.scope == ProjectWorkspaceTurnAuthorityScope::Library {
            return Ok(authority_fingerprint);
        }
        if action != AgentProjectResourceAction::CreateChild {
            return Err(unauthorized(
                "Agent target requires a structural Project capability",
            ));
        }
        let overlay_allowed = authorization
            .resource_access
            .as_ref()
            .is_some_and(|overlay| {
                overlay_covers_library(
                    authority,
                    overlay,
                    target_library_id,
                    &authorization.call_id,
                )
            });
        if overlay_allowed {
            return Ok(authority_fingerprint);
        }
        return Err(unauthorized(
            "Agent target requires Library resource consent",
        ));
    }
    let coordinates = match resolve_coordinates(connection, library_id, target)? {
        CoordinateResolution::Found(coordinates) => coordinates,
        CoordinateResolution::Missing => {
            return Err(StoreError::new(
                StoreErrorCode::NotFound,
                "Agent target resource was not found",
                false,
            ));
        }
        CoordinateResolution::Corrupt => {
            return Err(corrupt("Agent target resource hierarchy is corrupt"));
        }
    };
    let direct = authorize_resource(
        connection,
        authority.scope,
        &authority.actor_project_id,
        &project,
        &coordinates,
        action,
    )?;
    let overlay_allowed = authorization
        .resource_access
        .as_ref()
        .is_some_and(|overlay| {
            overlay_covers_resource(
                authority,
                overlay,
                &coordinates,
                action,
                &authorization.call_id,
            )
        });
    if direct == AgentResourceAuthorizationReason::Allowed || overlay_allowed {
        return Ok(authority_fingerprint);
    }
    Err(unauthorized(match direct {
        AgentResourceAuthorizationReason::GrantMissing => {
            "Agent target requires Project resource consent"
        }
        AgentResourceAuthorizationReason::GrantReadOnly => {
            "Agent target requires write-capable Project resource consent"
        }
        AgentResourceAuthorizationReason::ProjectReadOnly => "Agent Turn Project is read-only",
        AgentResourceAuthorizationReason::StructuralCapabilityRequired => {
            "Agent target requires a structural Project capability"
        }
        AgentResourceAuthorizationReason::LibraryMismatch => {
            "Agent target belongs to another Library"
        }
        AgentResourceAuthorizationReason::ResourceNotFound => "Agent target resource was not found",
        AgentResourceAuthorizationReason::ResourceHierarchyCorrupt => {
            "Agent target resource hierarchy is corrupt"
        }
        AgentResourceAuthorizationReason::ProjectNotFound => "Agent Turn Project is unavailable",
        AgentResourceAuthorizationReason::AuthorityStale => "Agent Turn authority is stale",
        AgentResourceAuthorizationReason::Allowed => unreachable!("allowed returned above"),
    }))
}

pub(crate) fn authorized_page_ids(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    authorization: &nodex_core_contracts::agent::AgentExecutionAuthorization,
    page_ids: &[String],
) -> Result<HashSet<String>, StoreError> {
    validate_execution_transport_context(context, &authorization.provenance)?;
    validate_id("call_id", &authorization.call_id)?;
    validate_persisted_turn_authority(connection, library_id, &authorization.provenance)?;
    if let Some(overlay) = authorization.resource_access.as_ref() {
        validate_overlay_shape(overlay)?;
    }
    let authority = &authorization.provenance.authority;
    let project = read_project(connection, library_id, &authority.actor_project_id)?
        .ok_or_else(|| unauthorized("Agent Turn Project is unavailable"))?;
    let grants = read_project_grants(connection, &authority.actor_project_id)?;
    let coordinates = page_coordinates_batch(connection, library_id, page_ids)?;
    let mut authorized = HashSet::new();
    for page_id in page_ids {
        let Some(coordinates) = coordinates.get(page_id) else {
            continue;
        };
        let direct = authorize_resource_with_grants(
            authority.scope,
            &project,
            coordinates,
            AgentProjectResourceAction::Read,
            &grants,
        );
        let overlay_allowed = authorization
            .resource_access
            .as_ref()
            .is_some_and(|overlay| {
                overlay_covers_resource(
                    authority,
                    overlay,
                    coordinates,
                    AgentProjectResourceAction::Read,
                    &authorization.call_id,
                )
            });
        if direct == AgentResourceAuthorizationReason::Allowed || overlay_allowed {
            authorized.insert(page_id.clone());
        }
    }
    Ok(authorized)
}

pub(super) fn validate_transport_context(
    context: &BoundModuleContext,
    provenance: &AgentTurnProvenance,
) -> Result<(), StoreError> {
    let authority = &provenance.authority;
    let valid = matches!(
        context.adapter,
        AdapterKind::ElectronHost | AdapterKind::Test
    ) && context.profile_id.0 == provenance.profile_id
        && context.library_id.0 == authority.library_id
        && context
            .project_id
            .as_ref()
            .map(|project| project.0.as_str())
            == Some(authority.actor_project_id.as_str())
        && !context.connection_id.is_empty()
        && context.connection_id.len() <= MAX_ID_BYTES;
    if valid {
        return Ok(());
    }
    Err(unauthorized(
        "Agent resource authorization is not bound to its trusted Electron context",
    ))
}

fn validate_execution_transport_context(
    context: &BoundModuleContext,
    provenance: &AgentTurnProvenance,
) -> Result<(), StoreError> {
    if context.adapter != AdapterKind::Agent {
        return validate_transport_context(context, provenance);
    }
    let authority = &provenance.authority;
    let valid = context.profile_id.0 == provenance.profile_id
        && context.library_id.0 == authority.library_id
        && context
            .project_id
            .as_ref()
            .map(|project| project.0.as_str())
            == Some(authority.actor_project_id.as_str())
        && !context.connection_id.is_empty()
        && context.connection_id.len() <= MAX_ID_BYTES;
    if valid {
        return Ok(());
    }
    Err(unauthorized(
        "Agent execution is not bound to its trusted Electron context",
    ))
}

pub(super) fn canonicalize_grants(
    grants: &[AgentResourceGrantSpec],
) -> Result<Vec<AgentResourceGrantSpec>, StoreError> {
    if grants.len() > MAX_GRANTS {
        return Err(invalid("Agent resource grant count exceeds its Core bound"));
    }
    let mut by_root = BTreeMap::<String, AgentResourceGrantSpec>::new();
    for grant in grants {
        validate_grant(grant)?;
        let key = grant_root_key(&grant.root);
        let Some(existing) = by_root.get_mut(&key) else {
            let mut grant = grant.clone();
            grant.library_actions.sort();
            grant.library_actions.dedup();
            by_root.insert(key, grant);
            continue;
        };
        if grant.access == AgentProjectResourceAccess::ReadWrite {
            existing.access = AgentProjectResourceAccess::ReadWrite;
        }
        let actions = existing
            .library_actions
            .iter()
            .copied()
            .chain(grant.library_actions.iter().copied())
            .collect::<BTreeSet<_>>();
        existing.library_actions = actions.into_iter().collect();
    }
    Ok(by_root.into_values().collect())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn persist_project_grants(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    library_id: &str,
    operation_id: &str,
    request_hash: &str,
    provenance: &AgentTurnProvenance,
    grants: &[AgentResourceGrantSpec],
) -> Result<LibraryApplyOutcome, StoreError> {
    validate_transport_context(context, provenance)?;
    validate_persisted_turn_authority(connection, library_id, provenance)?;
    if provenance.authority.scope != ProjectWorkspaceTurnAuthorityScope::Project {
        return Err(unauthorized(
            "Library-scoped Agent authority cannot persist Project grants",
        ));
    }
    let grants = canonicalize_grants(grants)?;
    if grants.is_empty() {
        return Err(invalid("Agent Project grant batch cannot be empty"));
    }
    let project_id = provenance.authority.actor_project_id.as_str();
    let project = read_project(connection, library_id, project_id)?
        .ok_or_else(|| unauthorized("Agent Turn Project is unavailable"))?;
    if project.lifecycle != "active" {
        return Err(unauthorized("Agent Turn Project is read-only"));
    }

    let now = sqlite_now(connection)?;
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
            let mut did_mutate = false;
            let mut affected_page_ids = Vec::new();
            let mut affected_database_ids = Vec::new();
            let mut committed_revisions = BTreeMap::new();
            for grant in grants {
                let (resource_kind, resource_id) = match grant.root {
                    AgentResourceGrantRoot::Page { page_id } => ("page", page_id),
                    AgentResourceGrantRoot::Database { database_id } => ("database", database_id),
                    AgentResourceGrantRoot::Library { .. } => {
                        return Err(invalid(
                            "Library consent cannot be persisted as a Project resource grant",
                        ));
                    }
                };
                let exists = connection
                    .query_row(
                        if resource_kind == "page" {
                            "SELECT 1 FROM pages page JOIN blocks block ON block.id = page.block_id \
                             WHERE page.block_id = ?1 AND page.library_id = ?2 \
                               AND block.library_id = page.library_id \
                               AND block.lifecycle <> 'deleted'"
                        } else {
                            "SELECT 1 FROM database_containers container \
                             JOIN blocks block ON block.id = container.block_id \
                             WHERE container.block_id = ?1 AND container.library_id = ?2 \
                               AND block.library_id = container.library_id \
                               AND container.lifecycle <> 'deleted' \
                               AND block.lifecycle <> 'deleted'"
                        },
                        params![resource_id, library_id],
                        |_| Ok(()),
                    )
                    .optional()?;
                if exists.is_none() {
                    return Err(StoreError::new(
                        StoreErrorCode::NotFound,
                        format!("Agent Project grant {resource_kind} is unavailable"),
                        false,
                    ));
                }
                let access = match grant.access {
                    AgentProjectResourceAccess::Read => "read",
                    AgentProjectResourceAccess::ReadWrite => "read_write",
                };
                let existing = connection
                    .query_row(
                        "SELECT id, access, lifecycle, revision FROM project_resource_grants \
                 WHERE project_id = ?1 AND root_kind = ?2 AND root_id = ?3",
                        params![project_id, resource_kind, resource_id],
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
                let revision =
                    if let Some((grant_id, current_access, lifecycle, revision)) = existing {
                        if current_access == access && lifecycle == "active" {
                            revision
                        } else {
                            let changed = connection.execute(
                    "UPDATE project_resource_grants SET access = ?1, lifecycle = 'active', \
                       revision = revision + 1, updated_at = ?2 \
                     WHERE id = ?3 AND revision = ?4",
                    params![access, now, grant_id, revision],
                )?;
                            if changed != 1 {
                                return Err(StoreError::new(
                                    StoreErrorCode::RevisionConflict,
                                    "Project grant changed during Agent consent persistence",
                                    true,
                                ));
                            }
                            did_mutate = true;
                            revision + 1
                        }
                    } else {
                        let identity =
                            serde_json::to_vec(&(project_id, resource_kind, &resource_id))
                                .map_err(|_| corrupt("Agent Project grant identity is invalid"))?;
                        let grant_id = format!("grant:{}", sha256(&identity));
                        connection.execute(
                            "INSERT INTO project_resource_grants(\
                   id, project_id, library_id, root_kind, root_id, access, recursive, revision, \
                   lifecycle, created_at, updated_at\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, 'active', ?7, ?7)",
                            params![
                                grant_id,
                                project_id,
                                library_id,
                                resource_kind,
                                resource_id,
                                access,
                                now
                            ],
                        )?;
                        did_mutate = true;
                        1
                    };
                committed_revisions.insert(
                    format!("projectGrant:{project_id}:{resource_kind}:{resource_id}"),
                    revision,
                );
                if resource_kind == "page" {
                    affected_page_ids.push(resource_id);
                } else {
                    affected_database_ids.push(resource_id);
                }
            }

            seal_mutation(
                scope,
                context,
                operation_id,
                MutationEffects {
                    project_id: project_id.to_owned(),
                    operation_kind: "persist_agent_project_resource_grants",
                    change_kind: "library.changed",
                    did_mutate,
                    created_target: None,
                    affected_parent_keys: Vec::new(),
                    affected_block_ids: Vec::new(),
                    affected_page_ids,
                    affected_database_ids,
                    affected_view_ids: Vec::new(),
                    affected_document_ids: Vec::new(),
                    committed_revisions,
                    page_create: None,
                    page_copy: None,
                    page_files: None,
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
    library_commit_result(connection, result)
}

fn read_project(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
) -> Result<Option<ProjectAuthority>, StoreError> {
    connection
        .query_row(
            "SELECT lifecycle, database_block_id FROM projects \
             WHERE id = ?1 AND library_id = ?2",
            params![project_id, library_id],
            |row| {
                Ok(ProjectAuthority {
                    lifecycle: row.get(0)?,
                    primary_database_id: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn resolve_coordinates(
    connection: &Connection,
    library_id: &str,
    target: &AgentAuthorizationTarget,
) -> Result<CoordinateResolution, StoreError> {
    match target {
        AgentAuthorizationTarget::Page { page_id } => {
            page_coordinates(connection, library_id, page_id)
        }
        AgentAuthorizationTarget::PageOrBlock { id } => {
            let page_id = connection
                .query_row(
                    "SELECT page.block_id FROM pages page JOIN blocks page_block \
                       ON page_block.id = page.block_id AND page_block.library_id = page.library_id \
                     WHERE page.block_id = ?1 AND page.library_id = ?2 \
                       AND page_block.lifecycle <> 'deleted' \
                     UNION ALL \
                     SELECT owner.block_id FROM blocks block \
                     JOIN document_block_index block_index ON block_index.block_id = block.id \
                     JOIN block_documents ownership ON ownership.document_id = block_index.document_id \
                     JOIN pages owner ON owner.block_id = ownership.block_id \
                     JOIN blocks owner_block ON owner_block.id = owner.block_id \
                       AND owner_block.library_id = owner.library_id \
                     WHERE block.id = ?1 AND block.library_id = ?2 \
                       AND block.lifecycle <> 'deleted' AND owner.library_id = ?2 \
                       AND owner_block.lifecycle <> 'deleted' \
                     LIMIT 1",
                    params![id, library_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            match page_id {
                Some(page_id) => page_coordinates(connection, library_id, &page_id),
                None => Ok(CoordinateResolution::Missing),
            }
        }
        AgentAuthorizationTarget::Database { database_id } => {
            database_coordinates(connection, library_id, database_id)
        }
        AgentAuthorizationTarget::DataSource { data_source_id } => {
            let database_id = connection
                .query_row(
                    "SELECT home_database_block_id FROM data_sources \
                     WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
                    params![data_source_id, library_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let Some(database_id) = database_id else {
                return Ok(CoordinateResolution::Missing);
            };
            coordinates_for_database_target(
                connection,
                library_id,
                AgentAuthorizationTarget::DataSource {
                    data_source_id: data_source_id.clone(),
                },
                vec![database_id.clone()],
                &database_id,
            )
        }
        AgentAuthorizationTarget::View { view_id } => {
            let row = connection
                .query_row(
                    "SELECT view.database_block_id, source.home_database_block_id \
                     FROM database_views view \
                     JOIN database_containers container \
                       ON container.block_id = view.database_block_id \
                     JOIN blocks container_block ON container_block.id = container.block_id \
                     JOIN data_sources source ON source.id = view.data_source_id \
                     WHERE view.id = ?1 AND container.library_id = ?2 \
                       AND view.lifecycle = 'active' AND container.lifecycle <> 'deleted' \
                       AND container_block.lifecycle <> 'deleted' AND source.lifecycle = 'active'",
                    params![view_id, library_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let Some((host_database_id, source_database_id)) = row else {
                return Ok(CoordinateResolution::Missing);
            };
            let mut database_ids = vec![host_database_id.clone(), source_database_id];
            database_ids.sort();
            database_ids.dedup();
            coordinates_for_database_target(
                connection,
                library_id,
                AgentAuthorizationTarget::View {
                    view_id: view_id.clone(),
                },
                database_ids,
                &host_database_id,
            )
        }
        AgentAuthorizationTarget::Library { .. } => {
            Err(invalid("Library targets are planned separately"))
        }
    }
}

fn page_coordinates(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<CoordinateResolution, StoreError> {
    let active = connection
        .query_row(
            "SELECT 1 FROM pages page JOIN blocks block \
               ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.lifecycle <> 'deleted'",
            params![page_id, library_id],
            |_| Ok(()),
        )
        .optional()?;
    if active.is_none() {
        return Ok(CoordinateResolution::Missing);
    }
    let Some((page_ancestor_ids, terminal_kind, terminal_id)) =
        page_hierarchy(connection, library_id, page_id)?
    else {
        return Ok(CoordinateResolution::Corrupt);
    };
    let owning_database_ids = match terminal_kind.as_str() {
        "library" if terminal_id == library_id => Vec::new(),
        "data_source" => {
            let database_id = connection
                .query_row(
                    "SELECT home_database_block_id FROM data_sources \
                     WHERE id = ?1 AND library_id = ?2",
                    params![terminal_id, library_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let Some(database_id) = database_id else {
                return Ok(CoordinateResolution::Corrupt);
            };
            vec![database_id]
        }
        _ => return Ok(CoordinateResolution::Corrupt),
    };
    Ok(CoordinateResolution::Found(ResourceCoordinates {
        target: AgentAuthorizationTarget::Page {
            page_id: page_id.to_owned(),
        },
        owning_database_ids,
        page_ancestor_ids,
        preferred_grant_root: AgentResourceGrantRoot::Page {
            page_id: page_id.to_owned(),
        },
    }))
}

fn database_coordinates(
    connection: &Connection,
    library_id: &str,
    database_id: &str,
) -> Result<CoordinateResolution, StoreError> {
    let active = connection
        .query_row(
            "SELECT 1 FROM database_containers container JOIN blocks block \
               ON block.id = container.block_id \
             WHERE container.block_id = ?1 AND container.library_id = ?2 \
               AND container.lifecycle <> 'deleted' AND block.lifecycle <> 'deleted'",
            params![database_id, library_id],
            |_| Ok(()),
        )
        .optional()?;
    if active.is_none() {
        return Ok(CoordinateResolution::Missing);
    }
    coordinates_for_database_target(
        connection,
        library_id,
        AgentAuthorizationTarget::Database {
            database_id: database_id.to_owned(),
        },
        vec![database_id.to_owned()],
        database_id,
    )
}

fn coordinates_for_database_target(
    connection: &Connection,
    library_id: &str,
    target: AgentAuthorizationTarget,
    owning_database_ids: Vec<String>,
    host_database_id: &str,
) -> Result<CoordinateResolution, StoreError> {
    let host_page_id = connection
        .query_row(
            "SELECT owner.block_id FROM document_block_index block_index \
             JOIN block_documents ownership ON ownership.document_id = block_index.document_id \
             JOIN pages owner ON owner.block_id = ownership.block_id \
             WHERE block_index.block_id = ?1 AND owner.library_id = ?2",
            params![host_database_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let page_ancestor_ids = match host_page_id {
        Some(page_id) => match page_hierarchy(connection, library_id, &page_id)? {
            Some((ancestors, _, _)) => ancestors,
            None => return Ok(CoordinateResolution::Corrupt),
        },
        None => Vec::new(),
    };
    Ok(CoordinateResolution::Found(ResourceCoordinates {
        target,
        owning_database_ids,
        page_ancestor_ids,
        preferred_grant_root: AgentResourceGrantRoot::Database {
            database_id: host_database_id.to_owned(),
        },
    }))
}

fn page_hierarchy(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Option<(Vec<String>, String, String)>, StoreError> {
    let rows = connection
        .prepare(
            "WITH RECURSIVE ancestors(page_id, parent_kind, parent_id, path) AS ( \
               SELECT block_id, parent_kind, parent_id, '|' || block_id || '|' FROM pages \
                 WHERE block_id = ?1 AND library_id = ?2 \
               UNION ALL \
               SELECT parent.block_id, parent.parent_kind, parent.parent_id, \
                 ancestors.path || parent.block_id || '|' \
               FROM pages parent JOIN ancestors \
                 ON ancestors.parent_kind = 'page' AND parent.block_id = ancestors.parent_id \
               WHERE parent.library_id = ?2 \
                 AND instr(ancestors.path, '|' || parent.block_id || '|') = 0 \
             ) SELECT page_id, parent_kind, parent_id FROM ancestors",
        )?
        .query_map(params![page_id, library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.is_empty() {
        return Ok(None);
    }
    let Some(terminal) = rows.iter().find(|row| row.1 != "page") else {
        return Ok(None);
    };
    Ok(Some((
        rows.iter().map(|row| row.0.clone()).collect(),
        terminal.1.clone(),
        terminal.2.clone(),
    )))
}

fn authorize_resource(
    connection: &Connection,
    scope: ProjectWorkspaceTurnAuthorityScope,
    project_id: &str,
    project: &ProjectAuthority,
    coordinates: &ResourceCoordinates,
    action: AgentProjectResourceAction,
) -> Result<AgentResourceAuthorizationReason, StoreError> {
    let grants = read_project_grants(connection, project_id)?;
    Ok(authorize_resource_with_grants(
        scope,
        project,
        coordinates,
        action,
        &grants,
    ))
}

fn authorize_resource_with_grants(
    scope: ProjectWorkspaceTurnAuthorityScope,
    project: &ProjectAuthority,
    coordinates: &ResourceCoordinates,
    action: AgentProjectResourceAction,
    grants: &[ProjectGrant],
) -> AgentResourceAuthorizationReason {
    if scope == ProjectWorkspaceTurnAuthorityScope::Library {
        return AgentResourceAuthorizationReason::Allowed;
    }
    let implicit = project
        .primary_database_id
        .as_ref()
        .is_some_and(|database_id| coordinates.owning_database_ids.contains(database_id));
    let grant = if implicit {
        None
    } else {
        grant_match(grants, coordinates)
    };
    if !implicit && grant.is_none() {
        return AgentResourceAuthorizationReason::GrantMissing;
    }
    if action == AgentProjectResourceAction::Read {
        return AgentResourceAuthorizationReason::Allowed;
    }
    if project.lifecycle != "active" {
        return AgentResourceAuthorizationReason::ProjectReadOnly;
    }
    if matches!(
        action,
        AgentProjectResourceAction::ManageSchema
            | AgentProjectResourceAction::ManageViews
            | AgentProjectResourceAction::ManageDatabase
    ) && !implicit
    {
        return AgentResourceAuthorizationReason::StructuralCapabilityRequired;
    }
    if !implicit && grant.is_some_and(|grant| grant.access != AgentProjectResourceAccess::ReadWrite)
    {
        return AgentResourceAuthorizationReason::GrantReadOnly;
    }
    AgentResourceAuthorizationReason::Allowed
}

fn read_project_grants(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<ProjectGrant>, StoreError> {
    let rows = connection
        .prepare(
            "SELECT root_kind, root_id, access FROM project_resource_grants \
             WHERE project_id = ?1 AND lifecycle = 'active' \
             ORDER BY CASE access WHEN 'read_write' THEN 0 ELSE 1 END, \
               CASE root_kind WHEN 'page' THEN 0 ELSE 1 END, created_at, id",
        )?
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(root_kind, root_id, access)| {
            let access = match access.as_str() {
                "read" => AgentProjectResourceAccess::Read,
                "read_write" => AgentProjectResourceAccess::ReadWrite,
                _ => return Err(corrupt("Project resource grant access is invalid")),
            };
            Ok(ProjectGrant {
                root_kind,
                root_id,
                access,
            })
        })
        .collect()
}

fn grant_match(grants: &[ProjectGrant], coordinates: &ResourceCoordinates) -> Option<GrantMatch> {
    grants.iter().find_map(|grant| {
        let matches = match grant.root_kind.as_str() {
            "page" => coordinates.page_ancestor_ids.contains(&grant.root_id),
            "database" => coordinates.owning_database_ids.contains(&grant.root_id),
            _ => false,
        };
        matches.then_some(GrantMatch {
            access: grant.access,
        })
    })
}

fn page_coordinates_batch(
    connection: &Connection,
    library_id: &str,
    page_ids: &[String],
) -> Result<HashMap<String, ResourceCoordinates>, StoreError> {
    const SQLITE_ID_BATCH: usize = 400;
    let mut builders = HashMap::<String, PageCoordinateBuilder>::new();
    for page_ids in page_ids.chunks(SQLITE_ID_BATCH) {
        if page_ids.is_empty() {
            continue;
        }
        let placeholders = std::iter::repeat_n("?", page_ids.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "WITH RECURSIVE ancestors(root_page_id, page_id, parent_kind, parent_id, path) AS ( \
               SELECT page.block_id, page.block_id, page.parent_kind, page.parent_id, \
                 '|' || page.block_id || '|' \
               FROM pages page JOIN blocks block \
                 ON block.id = page.block_id AND block.library_id = page.library_id \
               WHERE page.library_id = ?1 AND block.lifecycle <> 'deleted' \
                 AND page.block_id IN ({placeholders}) \
               UNION ALL \
               SELECT ancestors.root_page_id, parent.block_id, parent.parent_kind, \
                 parent.parent_id, ancestors.path || parent.block_id || '|' \
               FROM ancestors JOIN pages parent \
                 ON ancestors.parent_kind = 'page' AND parent.block_id = ancestors.parent_id \
               WHERE parent.library_id = ?1 \
                 AND instr(ancestors.path, '|' || parent.block_id || '|') = 0 \
             ) \
             SELECT ancestors.root_page_id, ancestors.page_id, ancestors.parent_kind, \
               ancestors.parent_id, source.home_database_block_id \
             FROM ancestors LEFT JOIN data_sources source \
               ON ancestors.parent_kind = 'data_source' AND source.id = ancestors.parent_id \
                 AND source.library_id = ?1"
        );
        let parameters = std::iter::once(SqlValue::Text(library_id.to_owned()))
            .chain(page_ids.iter().cloned().map(SqlValue::Text))
            .collect::<Vec<_>>();
        let rows = connection
            .prepare(&sql)?
            .query_map(params_from_iter(parameters.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (root_page_id, page_id, parent_kind, parent_id, database_id) in rows {
            let builder = builders.entry(root_page_id).or_default();
            builder.ancestor_ids.push(page_id);
            if parent_kind != "page" {
                if builder.terminal.is_some() {
                    return Err(corrupt("Agent Page hierarchy has multiple roots"));
                }
                builder.terminal = Some((parent_kind, parent_id, database_id));
            }
        }
    }

    builders
        .into_iter()
        .map(|(page_id, builder)| {
            let Some((terminal_kind, terminal_id, database_id)) = builder.terminal else {
                return Err(corrupt("Agent Page hierarchy has no Library root"));
            };
            let owning_database_ids = match terminal_kind.as_str() {
                "library" if terminal_id == library_id => Vec::new(),
                "data_source" => vec![
                    database_id
                        .ok_or_else(|| corrupt("Agent Page data source hierarchy is incomplete"))?,
                ],
                _ => return Err(corrupt("Agent Page hierarchy has an invalid root")),
            };
            Ok((
                page_id.clone(),
                ResourceCoordinates {
                    target: AgentAuthorizationTarget::Page {
                        page_id: page_id.clone(),
                    },
                    owning_database_ids,
                    page_ancestor_ids: builder.ancestor_ids,
                    preferred_grant_root: AgentResourceGrantRoot::Page { page_id },
                },
            ))
        })
        .collect()
}

fn overlay_covers_resource(
    authority: &ProjectWorkspaceTurnAuthority,
    overlay: &AgentResourceAccessOverlay,
    coordinates: &ResourceCoordinates,
    action: AgentProjectResourceAction,
    call_id: &str,
) -> bool {
    overlay_identity_matches(authority, overlay, call_id)
        && overlay.grants.iter().any(|grant| {
            access_covers(grant.access, action)
                && match &grant.root {
                    AgentResourceGrantRoot::Page { page_id } => {
                        coordinates.page_ancestor_ids.contains(page_id)
                    }
                    AgentResourceGrantRoot::Database { database_id } => {
                        coordinates.owning_database_ids.contains(database_id)
                    }
                    AgentResourceGrantRoot::Library { .. } => false,
                }
        })
}

fn overlay_covers_library(
    authority: &ProjectWorkspaceTurnAuthority,
    overlay: &AgentResourceAccessOverlay,
    library_id: &str,
    call_id: &str,
) -> bool {
    overlay_identity_matches(authority, overlay, call_id)
        && overlay.grants.iter().any(|grant| {
            grant.access == AgentProjectResourceAccess::ReadWrite
                && matches!(
                    &grant.root,
                    AgentResourceGrantRoot::Library { library_id: granted }
                        if granted == library_id
                )
                && grant
                    .library_actions
                    .contains(&AgentProjectResourceAction::CreateChild)
        })
}

fn overlay_identity_matches(
    authority: &ProjectWorkspaceTurnAuthority,
    overlay: &AgentResourceAccessOverlay,
    call_id: &str,
) -> bool {
    if overlay.kind != AgentResourceAccessOverlayKind::Consent
        || overlay.actor_project_id != authority.actor_project_id
        || overlay.library_id != authority.library_id
        || overlay.store_epoch != authority.store_epoch
        || overlay.root_thread_id != authority.root_thread_id
    {
        return false;
    }
    match overlay.scope {
        AgentResourceAccessOverlayScope::Task => true,
        AgentResourceAccessOverlayScope::Call => {
            overlay.thread_id.as_deref() == Some(authority.thread_id.as_str())
                && overlay.turn_id.as_deref() == Some(authority.turn_id.as_str())
                && overlay.call_id.as_deref() == Some(call_id)
        }
    }
}

fn validate_overlay_shape(overlay: &AgentResourceAccessOverlay) -> Result<(), StoreError> {
    for (name, value) in [
        ("root_thread_id", overlay.root_thread_id.as_str()),
        ("actor_project_id", overlay.actor_project_id.as_str()),
        ("library_id", overlay.library_id.as_str()),
        ("store_epoch", overlay.store_epoch.as_str()),
    ] {
        validate_id(name, value)?;
    }
    match overlay.scope {
        AgentResourceAccessOverlayScope::Task => {
            if overlay.kind != AgentResourceAccessOverlayKind::Consent
                || overlay.thread_id.is_some()
                || overlay.turn_id.is_some()
                || overlay.call_id.is_some()
            {
                return Err(invalid("Task resource access has invalid call coordinates"));
            }
        }
        AgentResourceAccessOverlayScope::Call => {
            validate_id(
                "overlay.thread_id",
                overlay.thread_id.as_deref().unwrap_or_default(),
            )?;
            validate_id(
                "overlay.turn_id",
                overlay.turn_id.as_deref().unwrap_or_default(),
            )?;
            validate_id(
                "overlay.call_id",
                overlay.call_id.as_deref().unwrap_or_default(),
            )?;
        }
    }
    canonicalize_grants(&overlay.grants)?;
    Ok(())
}

fn validate_intent(intent: &AgentResourceIntent) -> Result<(), StoreError> {
    match &intent.target {
        AgentAuthorizationTarget::Page { page_id } => validate_id("page_id", page_id),
        AgentAuthorizationTarget::Database { database_id } => {
            validate_id("database_id", database_id)
        }
        AgentAuthorizationTarget::DataSource { data_source_id } => {
            validate_id("data_source_id", data_source_id)
        }
        AgentAuthorizationTarget::View { view_id } => validate_id("view_id", view_id),
        AgentAuthorizationTarget::Library { library_id } => validate_id("library_id", library_id),
        AgentAuthorizationTarget::PageOrBlock { id } => validate_id("block_id", id),
    }
}

fn validate_grant(grant: &AgentResourceGrantSpec) -> Result<(), StoreError> {
    match &grant.root {
        AgentResourceGrantRoot::Page { page_id } => {
            validate_id("grant.page_id", page_id)?;
            if !grant.library_actions.is_empty() {
                return Err(invalid("Page grants cannot carry Library actions"));
            }
        }
        AgentResourceGrantRoot::Database { database_id } => {
            validate_id("grant.database_id", database_id)?;
            if !grant.library_actions.is_empty() {
                return Err(invalid("Database grants cannot carry Library actions"));
            }
        }
        AgentResourceGrantRoot::Library { library_id } => {
            validate_id("grant.library_id", library_id)?;
            if grant
                .library_actions
                .iter()
                .any(|action| *action != AgentProjectResourceAction::CreateChild)
            {
                return Err(invalid("Library grant contains an unsupported action"));
            }
        }
    }
    Ok(())
}

fn canonicalize_requirements(
    requirements: Vec<AgentResourceConsentRequirement>,
) -> Vec<AgentResourceConsentRequirement> {
    let mut by_root = BTreeMap::<String, AgentResourceConsentRequirement>::new();
    for requirement in requirements {
        let key = grant_root_key(&requirement.grant.root);
        let replace = by_root.get(&key).is_none_or(|current| {
            current.grant.access == AgentProjectResourceAccess::Read
                && requirement.grant.access == AgentProjectResourceAccess::ReadWrite
        });
        if replace {
            by_root.insert(key, requirement);
        }
    }
    by_root.into_values().collect()
}

fn grant_root_key(root: &AgentResourceGrantRoot) -> String {
    match root {
        AgentResourceGrantRoot::Page { page_id } => format!("page:{page_id}"),
        AgentResourceGrantRoot::Database { database_id } => {
            format!("database:{database_id}")
        }
        AgentResourceGrantRoot::Library { library_id } => format!("library:{library_id}"),
    }
}

fn required_access(action: AgentProjectResourceAction) -> AgentProjectResourceAccess {
    if action == AgentProjectResourceAction::Read {
        AgentProjectResourceAccess::Read
    } else {
        AgentProjectResourceAccess::ReadWrite
    }
}

fn access_covers(access: AgentProjectResourceAccess, action: AgentProjectResourceAction) -> bool {
    action == AgentProjectResourceAction::Read || access == AgentProjectResourceAccess::ReadWrite
}

fn denied(
    intent: &AgentResourceIntent,
    reason: AgentResourceAuthorizationReason,
) -> AgentResourceAccessPlan {
    AgentResourceAccessPlan::Denied {
        intent: intent.clone(),
        reason,
    }
}

fn validate_id(name: &str, value: &str) -> Result<(), StoreError> {
    if !value.is_empty() && value.trim() == value && value.len() <= MAX_ID_BYTES {
        return Ok(());
    }
    Err(invalid(format!("{name} is invalid")))
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn unauthorized(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}
