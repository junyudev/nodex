//! Canonical read authorization and transaction-scoped visibility capture.

use std::collections::BTreeSet;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::StoreEpoch;
use nodex_core_contracts::events::{
    AuthorizedReadStamp, DeliveryAddress, DeliveryAuthorizationScope, ResourceKey,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::sqlite::{StoreError, StoreErrorCode};

const MAX_AUTHORIZATION_DEPENDENCIES: usize = 4_096;

#[derive(Default)]
struct AuthorizationDependencyAccumulator {
    exact: BTreeSet<ResourceKey>,
    use_scope_aggregate: bool,
}

impl AuthorizationDependencyAccumulator {
    fn extend(&mut self, proof: impl IntoIterator<Item = ResourceKey>) {
        if self.use_scope_aggregate {
            return;
        }
        self.exact.extend(proof);
        if self.exact.len() <= MAX_AUTHORIZATION_DEPENDENCIES {
            return;
        }
        self.exact.clear();
        self.use_scope_aggregate = true;
    }

    fn finish(self, scope: &DeliveryAuthorizationScope) -> Vec<ResourceKey> {
        if self.use_scope_aggregate {
            return vec![authorization_scope_aggregate_root(scope)];
        }
        self.exact.into_iter().collect()
    }
}

pub(crate) trait AuthorizationGraphView {
    fn connection(&self) -> &Connection;
}

pub(crate) struct CurrentGraphView<'connection> {
    connection: &'connection Connection,
}

#[derive(Serialize)]
struct CanonicalAuthorizedReadStamp<'a> {
    hash_version: u32,
    store_epoch: &'a StoreEpoch,
    delivery_address: &'a DeliveryAddress,
    authorization_scope: &'a DeliveryAuthorizationScope,
    subject: &'a ResourceKey,
    request_dependencies: &'a [ResourceKey],
    authorization_dependencies: &'a [ResourceKey],
    covered_commit_seq: i64,
}

impl<'connection> CurrentGraphView<'connection> {
    pub(crate) fn new(connection: &'connection Connection) -> Self {
        Self { connection }
    }
}

impl AuthorizationGraphView for CurrentGraphView<'_> {
    fn connection(&self) -> &Connection {
        self.connection
    }
}

pub(crate) fn can_read(
    connection: &Connection,
    context: &BoundModuleContext,
    scope: &DeliveryAuthorizationScope,
    resource: &ResourceKey,
) -> Result<bool, StoreError> {
    can_read_in_view(&CurrentGraphView::new(connection), context, scope, resource)
}

pub(crate) fn issue_read_stamp(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: StoreEpoch,
    covered_commit_seq: i64,
    subject: ResourceKey,
    mut request_dependencies: Vec<ResourceKey>,
    protected_resources: Vec<ResourceKey>,
) -> Result<AuthorizedReadStamp, StoreError> {
    if covered_commit_seq < 0 {
        return Err(corrupt("Authorized read commit floor is invalid"));
    }
    request_dependencies.sort();
    request_dependencies.dedup();
    if request_dependencies.is_empty() || protected_resources.is_empty() {
        return Err(corrupt("Authorized read dependencies are empty"));
    }
    let authorization_scope = match &context.project_id {
        Some(project_id) => DeliveryAuthorizationScope::Project {
            library_id: context.library_id.0.clone(),
            project_id: project_id.0.clone(),
        },
        None => DeliveryAuthorizationScope::Library {
            library_id: context.library_id.0.clone(),
        },
    };
    let delivery_address = match &authorization_scope {
        DeliveryAuthorizationScope::Library { library_id } => DeliveryAddress::Library {
            library_id: library_id.clone(),
        },
        DeliveryAuthorizationScope::Project {
            library_id,
            project_id,
        } => DeliveryAddress::Project {
            library_id: library_id.clone(),
            project_id: project_id.clone(),
        },
        DeliveryAuthorizationScope::Document { .. } => {
            return Err(corrupt("Library read used a Document authorization scope"));
        }
    };
    let graph = CurrentGraphView::new(connection);
    let mut authorization_dependencies = AuthorizationDependencyAccumulator::default();
    for resource in &protected_resources {
        let Some(proof) =
            authorization_proof_in_view(&graph, context, &authorization_scope, resource)?
        else {
            return Err(StoreError::new(
                StoreErrorCode::Unauthorized,
                format!(
                    "Canonical read authorization changed before stamp issuance for {resource:?}"
                ),
                false,
            ));
        };
        authorization_dependencies.extend(proof);
    }
    let authorization_dependencies = authorization_dependencies.finish(&authorization_scope);
    let encoded = serde_json::to_vec(&CanonicalAuthorizedReadStamp {
        hash_version: 1,
        store_epoch: &store_epoch,
        delivery_address: &delivery_address,
        authorization_scope: &authorization_scope,
        subject: &subject,
        request_dependencies: &request_dependencies,
        authorization_dependencies: &authorization_dependencies,
        covered_commit_seq,
    })
    .map_err(|_| corrupt("Authorized read stamp input is invalid"))?;
    Ok(AuthorizedReadStamp {
        store_epoch,
        delivery_address,
        authorization_scope,
        subject,
        request_dependencies,
        authorization_dependencies,
        covered_commit_seq,
        stamp_hash: format!("{:x}", Sha256::digest(encoded)),
    })
}

pub(crate) fn authorization_scope_aggregate_root(
    scope: &DeliveryAuthorizationScope,
) -> ResourceKey {
    match scope {
        DeliveryAuthorizationScope::Library { library_id }
        | DeliveryAuthorizationScope::Document {
            library_id,
            project_id: None,
            ..
        } => ResourceKey::Library {
            library_id: library_id.clone(),
        },
        DeliveryAuthorizationScope::Project { project_id, .. }
        | DeliveryAuthorizationScope::Document {
            project_id: Some(project_id),
            ..
        } => ResourceKey::Project {
            project_id: project_id.clone(),
        },
    }
}

pub(crate) fn can_read_in_view(
    view: &impl AuthorizationGraphView,
    context: &BoundModuleContext,
    scope: &DeliveryAuthorizationScope,
    resource: &ResourceKey,
) -> Result<bool, StoreError> {
    Ok(authorization_proof_in_view(view, context, scope, resource)?.is_some())
}

fn authorization_proof_in_view(
    view: &impl AuthorizationGraphView,
    context: &BoundModuleContext,
    scope: &DeliveryAuthorizationScope,
    resource: &ResourceKey,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    let connection = view.connection();
    if scope_library_id(scope) != context.library_id.0 {
        return Ok(None);
    }
    match resource {
        ResourceKey::Library { library_id } => {
            Ok((library_id == &context.library_id.0).then(|| vec![resource.clone()]))
        }
        ResourceKey::Project { project_id } => {
            Ok(
                project_is_authorized(connection, scope, &context.library_id.0, project_id)?
                    .then(|| vec![resource.clone()]),
            )
        }
        ResourceKey::Page { page_id } => {
            page_authorization_proof(connection, scope, context, page_id, resource)
        }
        ResourceKey::Document { document_id } => {
            document_authorization_proof(connection, scope, context, document_id, resource)
        }
        ResourceKey::Database { database_id } => {
            database_authorization_proof(connection, scope, context, database_id, resource)
        }
        ResourceKey::DataSource { data_source_id } => {
            let coordinates = connection
                .query_row(
                    "SELECT library_id, home_database_block_id FROM data_sources
                     WHERE id = ?1 AND lifecycle = 'active'",
                    [data_source_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let Some((library_id, database_id)) = coordinates else {
                return Ok(None);
            };
            if library_id != context.library_id.0 {
                return Ok(None);
            }
            add_subject_to_proof(
                database_authorization_proof(
                    connection,
                    scope,
                    context,
                    &database_id,
                    &ResourceKey::Database {
                        database_id: database_id.clone(),
                    },
                )?,
                resource,
            )
        }
        ResourceKey::View { view_id } => {
            let database_id = connection
                .query_row(
                    "SELECT database_block_id FROM database_views
                     WHERE id = ?1 AND lifecycle = 'active'",
                    [view_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let Some(database_id) = database_id else {
                return Ok(None);
            };
            add_subject_to_proof(
                database_authorization_proof(
                    connection,
                    scope,
                    context,
                    &database_id,
                    &ResourceKey::Database {
                        database_id: database_id.clone(),
                    },
                )?,
                resource,
            )
        }
        ResourceKey::File { file_id } => match scope {
            DeliveryAuthorizationScope::Library { .. } => {
                let exists = connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM library_files WHERE file_id = ?1 AND library_id = ?2)",
                        params![file_id, context.library_id.0],
                        |row| row.get::<_, bool>(0),
                    )?;
                Ok(exists.then(|| vec![resource.clone()]))
            }
            DeliveryAuthorizationScope::Project { project_id, .. } => {
                crate::library::file_grant_authorization_proof(
                    connection,
                    &context.library_id.0,
                    project_id,
                    file_id,
                    false,
                )
            }
            DeliveryAuthorizationScope::Document { .. } => Ok(None),
        },
        ResourceKey::Canvas { canvas_id } => {
            canvas_authorization_proof(connection, scope, context, canvas_id, resource)
        }
    }
}

fn project_is_authorized(
    connection: &Connection,
    scope: &DeliveryAuthorizationScope,
    library_id: &str,
    project_id: &str,
) -> Result<bool, StoreError> {
    let belongs = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM projects
           WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'
         )",
        params![project_id, library_id],
        |row| row.get::<_, i64>(0),
    )? == 1;
    if !belongs {
        return Ok(false);
    }
    Ok(match scope {
        DeliveryAuthorizationScope::Library { .. } => true,
        DeliveryAuthorizationScope::Project {
            project_id: scope_project_id,
            ..
        } => scope_project_id == project_id,
        DeliveryAuthorizationScope::Document {
            project_id: Some(scope_project_id),
            ..
        } => scope_project_id == project_id,
        DeliveryAuthorizationScope::Document {
            project_id: None, ..
        } => false,
    })
}

fn page_authorization_proof(
    connection: &Connection,
    scope: &DeliveryAuthorizationScope,
    context: &BoundModuleContext,
    page_id: &str,
    subject: &ResourceKey,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    let page = connection
        .query_row(
            "SELECT page.document_id FROM pages page
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id
             WHERE page.block_id = ?1 AND page.library_id = ?2 AND block.lifecycle = 'active'",
            params![page_id, context.library_id.0],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(document_id) = page else {
        return Ok(None);
    };
    match scope {
        DeliveryAuthorizationScope::Library { .. } => Ok(Some(vec![subject.clone()])),
        DeliveryAuthorizationScope::Project { project_id, .. } => {
            match crate::library::page_read_authorization_roots(
                connection,
                &context.library_id.0,
                project_id,
                page_id,
            ) {
                Ok(proof) => Ok(proof),
                Err(error) if authorization_miss(&error) => Ok(None),
                Err(error) => Err(error),
            }
        }
        DeliveryAuthorizationScope::Document {
            document_id: scope_document_id,
            ..
        } => Ok((scope_document_id == &document_id).then(|| vec![subject.clone()])),
    }
}

fn document_authorization_proof(
    connection: &Connection,
    scope: &DeliveryAuthorizationScope,
    context: &BoundModuleContext,
    document_id: &str,
    subject: &ResourceKey,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    let belongs = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM documents document
           WHERE document.id = ?1 AND document.library_id = ?2
         )",
        params![document_id, context.library_id.0],
        |row| row.get::<_, i64>(0),
    )? == 1;
    if !belongs {
        return Ok(None);
    }
    // Structural history may retain a Page Document after its owner Block has
    // been reclassified. The retained Document is intentionally dormant: it
    // has no direct read surface until Undo restores the Page capability.
    // Treat that state as absent from the authorization graph. Canonical
    // Document reads remain fail-closed in the Document module itself.
    let has_owner = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM block_documents ownership
           JOIN blocks owner ON owner.id = ownership.block_id
           WHERE ownership.document_id = ?1
             AND owner.library_id = ?2
             AND owner.lifecycle = 'active'
         )",
        params![document_id, context.library_id.0],
        |row| row.get::<_, i64>(0),
    )? == 1;
    if !has_owner {
        return Ok(None);
    }
    if matches!(scope, DeliveryAuthorizationScope::Library { .. }) {
        return Ok(Some(vec![subject.clone()]));
    }
    if let DeliveryAuthorizationScope::Document {
        document_id: scope_document_id,
        ..
    } = scope
        && scope_document_id != document_id
    {
        return Ok(None);
    }
    match crate::document::require_owned_document_read_access(connection, context, document_id) {
        Ok(()) => {
            document_owner_authorization_proof(connection, scope, context, document_id, subject)
        }
        Err(error) if authorization_miss(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn document_owner_authorization_proof(
    connection: &Connection,
    scope: &DeliveryAuthorizationScope,
    context: &BoundModuleContext,
    document_id: &str,
    subject: &ResourceKey,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    let Some(authority) = crate::document::read_document_authority(connection, document_id)? else {
        return Ok(None);
    };
    let owner = match authority.owner_type.as_str() {
        "page" => ResourceKey::Page {
            page_id: authority.owner_block_id,
        },
        "database" => ResourceKey::Database {
            database_id: authority.owner_block_id,
        },
        "canvas" => ResourceKey::Canvas {
            canvas_id: authority.owner_block_id,
        },
        _ => return Ok(Some(vec![subject.clone()])),
    };
    add_subject_to_proof(
        authorization_proof_in_view(&CurrentGraphView::new(connection), context, scope, &owner)?,
        subject,
    )
}

fn database_authorization_proof(
    connection: &Connection,
    scope: &DeliveryAuthorizationScope,
    context: &BoundModuleContext,
    database_id: &str,
    subject: &ResourceKey,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM blocks block
           JOIN database_containers container ON container.block_id = block.id
           WHERE block.id = ?1 AND block.library_id = ?2
             AND block.lifecycle = 'active'
             AND container.lifecycle = 'active'",
            params![database_id, context.library_id.0],
            |_| Ok(()),
        )
        .optional()?;
    if exists.is_none() {
        return Ok(None);
    }
    if matches!(scope, DeliveryAuthorizationScope::Library { .. }) {
        return Ok(Some(vec![subject.clone()]));
    }
    let Some(project_id) = scope_project_id(scope) else {
        return Ok(None);
    };
    let primary = match crate::database::authorization::project_primary_database(
        connection,
        &context.library_id.0,
        project_id,
    ) {
        Ok(primary) => primary,
        Err(error) if authorization_miss(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    match crate::database::authorization::read_authorization_roots(
        connection,
        project_id,
        primary.as_deref(),
        database_id,
    ) {
        Ok(proof) => Ok(proof),
        Err(error) if authorization_miss(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn canvas_authorization_proof(
    connection: &Connection,
    scope: &DeliveryAuthorizationScope,
    context: &BoundModuleContext,
    canvas_id: &str,
    subject: &ResourceKey,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    let row = connection
        .query_row(
            "SELECT ownership.document_id, host_page.block_id
             FROM canvas_owners canvas
             JOIN blocks block ON block.id = canvas.block_id
               AND block.library_id = canvas.library_id
             JOIN block_documents ownership ON ownership.block_id = block.id
               AND ownership.library_id = block.library_id
             LEFT JOIN document_block_index containing
               ON containing.block_id = block.id
             LEFT JOIN pages host_page
               ON host_page.document_id = containing.document_id
              AND host_page.library_id = block.library_id
             WHERE block.id = ?1 AND canvas.library_id = ?2
               AND block.type = 'canvas' AND block.lifecycle = 'active'",
            params![canvas_id, context.library_id.0],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    let Some((document_id, host_page_id)) = row else {
        return Ok(None);
    };
    match scope {
        DeliveryAuthorizationScope::Library { .. } => Ok(Some(vec![subject.clone()])),
        DeliveryAuthorizationScope::Project { project_id, .. } => {
            let Some(page_id) = host_page_id else {
                return crate::library::canvas_grant_authorization_proof(
                    connection,
                    &context.library_id.0,
                    project_id,
                    canvas_id,
                    false,
                );
            };
            match crate::library::page_read_authorization_roots(
                connection,
                &context.library_id.0,
                project_id,
                &page_id,
            ) {
                Ok(proof) => add_subject_to_proof(proof, subject),
                Err(error) if authorization_miss(&error) => Ok(None),
                Err(error) => Err(error),
            }
        }
        DeliveryAuthorizationScope::Document {
            document_id: scope_document_id,
            ..
        } => Ok((scope_document_id == &document_id).then(|| vec![subject.clone()])),
    }
}

fn add_subject_to_proof(
    proof: Option<Vec<ResourceKey>>,
    subject: &ResourceKey,
) -> Result<Option<Vec<ResourceKey>>, StoreError> {
    let Some(proof) = proof else {
        return Ok(None);
    };
    let mut roots = proof.into_iter().collect::<BTreeSet<_>>();
    roots.insert(subject.clone());
    Ok(Some(roots.into_iter().collect()))
}

fn scope_library_id(scope: &DeliveryAuthorizationScope) -> &str {
    match scope {
        DeliveryAuthorizationScope::Library { library_id }
        | DeliveryAuthorizationScope::Project { library_id, .. }
        | DeliveryAuthorizationScope::Document { library_id, .. } => library_id,
    }
}

fn scope_project_id(scope: &DeliveryAuthorizationScope) -> Option<&str> {
    match scope {
        DeliveryAuthorizationScope::Project { project_id, .. }
        | DeliveryAuthorizationScope::Document {
            project_id: Some(project_id),
            ..
        } => Some(project_id),
        DeliveryAuthorizationScope::Library { .. }
        | DeliveryAuthorizationScope::Document {
            project_id: None, ..
        } => None,
    }
}

fn authorization_miss(error: &StoreError) -> bool {
    matches!(
        error.code,
        StoreErrorCode::NotFound | StoreErrorCode::Unauthorized
    )
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_project_proofs_use_the_project_authorization_aggregate() {
        let scope = DeliveryAuthorizationScope::Project {
            library_id: "library:one".to_owned(),
            project_id: "project:one".to_owned(),
        };
        let proof = (0..MAX_AUTHORIZATION_DEPENDENCIES).map(|index| ResourceKey::Page {
            page_id: format!("page:{index:04}"),
        });
        let mut exact = AuthorizationDependencyAccumulator::default();
        exact.extend(proof.clone());
        assert_eq!(exact.finish(&scope).len(), MAX_AUTHORIZATION_DEPENDENCIES);

        let mut overflow = AuthorizationDependencyAccumulator::default();
        overflow.extend(proof);
        overflow.extend([ResourceKey::Page {
            page_id: "page:overflow".to_owned(),
        }]);

        assert_eq!(
            overflow.finish(&scope),
            vec![ResourceKey::Project {
                project_id: "project:one".to_owned(),
            }]
        );
    }
}
