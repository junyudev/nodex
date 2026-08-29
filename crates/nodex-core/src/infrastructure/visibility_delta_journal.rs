use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use nodex_core_contracts::events::{DeliveryAuthorizationScope, ResourceKey};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, LibraryId, ProfileId, ProjectId, ResourceRevocation,
    ResourceRevocationReason, RevokedResourceKind,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::durable_mutation::AuthorizedResourceObservation;
use super::local_commit::CommitContext;
use super::resource_authorization::{
    AuthorizationGraphView, CurrentGraphView, authorization_scope_aggregate_root,
};
use super::sqlite::{StoreError, StoreErrorCode};

const MAX_ACTIVE_PROJECT_SCOPES: usize = 200;
const MAX_CANDIDATE_RESOURCES: usize = 512;
const MAX_EXACT_VISIBILITY_CLAIMS: usize = 4_096;

const AUTHORITY_RELATIONS: &[&str] = &[
    "projects",
    "project_database_bindings",
    "project_resource_grants",
    "blocks",
    "documents",
    "block_documents",
    "pages",
    "database_containers",
    "data_sources",
    "database_views",
    "data_source_page_memberships",
    "canvas_owners",
];
#[derive(Debug)]
pub(crate) struct VisibilityDeltaJournal {
    restore_maintenance_context: bool,
    snapshots: RefCell<Option<VisibilitySnapshots>>,
}

#[derive(Clone, Debug)]
struct VisibilitySnapshots {
    pre: BTreeSet<AuthorizedResourceObservation>,
    post: BTreeSet<AuthorizedResourceObservation>,
    conservative_scopes: BTreeSet<DeliveryAuthorizationScope>,
}

#[derive(Clone, Debug)]
struct DirtyFact {
    relation_kind: String,
    operation: String,
    old_row: Option<Value>,
    new_row: Option<Value>,
}

/// Schema migrations may rewrite authority-bearing rows without publishing a
/// product LocalCommit. The enclosing migration transaction owns this mode and
/// removes it before validating or committing the target Store.
pub(crate) fn enter_migration_maintenance_context(
    connection: &Connection,
) -> Result<bool, StoreError> {
    let existing = connection
        .query_row(
            "SELECT mode, store_epoch, commit_seq FROM local_commit_visibility_context WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()?;
    match existing {
        None => {
            connection.execute(
                "INSERT INTO local_commit_visibility_context(id, mode, store_epoch, commit_seq) \
                 VALUES (1, 'maintenance', NULL, NULL)",
                [],
            )?;
            Ok(true)
        }
        Some((mode, None, None)) if mode == "maintenance" => Ok(false),
        Some(_) => Err(corrupt(
            "Store migration cannot borrow an active VisibilityDeltaJournal context",
        )),
    }
}

pub(crate) fn leave_migration_maintenance_context(
    connection: &Connection,
    owned: bool,
) -> Result<(), StoreError> {
    if !owned {
        return Ok(());
    }
    let changed = connection.execute(
        "DELETE FROM local_commit_visibility_context \
         WHERE id = 1 AND mode = 'maintenance' AND store_epoch IS NULL AND commit_seq IS NULL",
        [],
    )?;
    if changed == 1 {
        return Ok(());
    }
    Err(corrupt(
        "Store migration VisibilityDeltaJournal context diverged",
    ))
}

struct PreMutationOverlayGraph<'connection> {
    connection: &'connection Connection,
}

impl AuthorizationGraphView for PreMutationOverlayGraph<'_> {
    fn connection(&self) -> &Connection {
        self.connection
    }
}

#[derive(Serialize)]
struct CanonicalVisibilityDelta<'a> {
    hash_version: u32,
    store_epoch: &'a str,
    commit_seq: i64,
    authorization_scope: &'a DeliveryAuthorizationScope,
    delta_kind: &'a str,
    roots: &'a [ResourceKey],
}

pub(crate) fn validate_seal(
    connection: &Connection,
    context: &CommitContext,
) -> Result<(), StoreError> {
    let active_context: i64 = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM local_commit_visibility_context
           WHERE id = 1 AND mode IN ('active', 'overlay')
             AND store_epoch = ?1 AND commit_seq = ?2
         )",
        params![context.store_epoch(), context.commit_seq()],
        |row| row.get(0),
    )?;
    if active_context != 0 {
        return Err(corrupt(
            "VisibilityDeltaJournal context remained active at LocalCommit seal",
        ));
    }
    let unconsumed: i64 = connection.query_row(
        "SELECT count(*) FROM local_commit_visibility_dirty_facts
         WHERE store_epoch = ?1 AND commit_seq = ?2 AND consumed = 0",
        params![context.store_epoch(), context.commit_seq()],
        |row| row.get(0),
    )?;
    if unconsumed != 0 {
        return Err(corrupt("LocalCommit has unconsumed visibility dirty facts"));
    }
    let facts = read_facts(connection, context)?;
    let mut candidates = candidate_resources(&facts)?;
    expand_direct_authority_resources(connection, &mut candidates)?;
    let candidate_set = candidates.into_iter().collect::<BTreeSet<_>>();
    let rows = connection
        .prepare_cached(
            "SELECT scope_key, authorization_scope_json, delta_kind, roots_json, delta_hash
             FROM local_commit_visibility_deltas
             WHERE store_epoch = ?1 AND commit_seq = ?2
             ORDER BY scope_key, delta_hash",
        )?
        .query_map(
            params![context.store_epoch(), context.commit_seq()],
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
    for (scope_key, scope_json, delta_kind, roots_json, delta_hash) in rows {
        let scope: DeliveryAuthorizationScope = serde_json::from_str(&scope_json)
            .map_err(|_| corrupt("Visibility delta scope is invalid"))?;
        let roots: Vec<ResourceKey> = serde_json::from_str(&roots_json)
            .map_err(|_| corrupt("Visibility delta roots are invalid"))?;
        let conservative_reset = delta_kind == "conservative_reset";
        if conservative_reset != roots.is_empty()
            || roots.windows(2).any(|pair| pair[0] >= pair[1])
            || roots.iter().any(|root| {
                !candidate_set.contains(root) && root != &authorization_scope_aggregate_root(&scope)
            })
        {
            return Err(corrupt(
                "Visibility delta is not traceable to canonical dirty facts",
            ));
        }
        let canonical_scope_key = format!("v1:{:x}", Sha256::digest(scope_json.as_bytes()));
        let encoded = serde_json::to_vec(&CanonicalVisibilityDelta {
            hash_version: 1,
            store_epoch: context.store_epoch(),
            commit_seq: context.commit_seq(),
            authorization_scope: &scope,
            delta_kind: &delta_kind,
            roots: &roots,
        })
        .map_err(|_| corrupt("Visibility delta hash input is invalid"))?;
        if scope_key != canonical_scope_key
            || delta_hash != format!("{:x}", Sha256::digest(encoded))
        {
            return Err(corrupt("Visibility delta evidence is noncanonical"));
        }
    }
    Ok(())
}

impl VisibilityDeltaJournal {
    pub(crate) fn begin(
        connection: &Connection,
        context: &CommitContext,
    ) -> Result<Self, StoreError> {
        let existing = connection
            .query_row(
                "SELECT mode FROM local_commit_visibility_context WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let restore_maintenance_context = existing.as_deref() == Some("maintenance");
        if existing.is_some() && !restore_maintenance_context {
            return Err(corrupt("VisibilityDeltaJournal context is already active"));
        }
        connection.execute(
            "INSERT INTO local_commit_visibility_context(id, mode, store_epoch, commit_seq)
             VALUES (1, 'active', ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET
               mode = excluded.mode,
               store_epoch = excluded.store_epoch,
               commit_seq = excluded.commit_seq",
            params![context.store_epoch(), context.commit_seq()],
        )?;
        Ok(Self {
            restore_maintenance_context,
            snapshots: RefCell::new(None),
        })
    }

    pub(crate) fn authorization_before(
        &self,
        connection: &Connection,
        context: &CommitContext,
    ) -> Result<Vec<AuthorizedResourceObservation>, StoreError> {
        self.ensure_snapshots(connection, context)?;
        Ok(self
            .snapshots
            .borrow()
            .as_ref()
            .ok_or_else(|| corrupt("Visibility snapshots were not retained"))?
            .pre
            .iter()
            .cloned()
            .collect())
    }

    pub(crate) fn finalize(
        &self,
        connection: &Connection,
        context: &CommitContext,
    ) -> Result<(), StoreError> {
        self.ensure_snapshots(connection, context)?;
        let snapshots = self
            .snapshots
            .borrow()
            .as_ref()
            .cloned()
            .ok_or_else(|| corrupt("Visibility snapshots were not retained"))?;
        let facts = read_facts(connection, context)?;
        let reason = revocation_reason(&facts);
        let mut deltas =
            BTreeMap::<(DeliveryAuthorizationScope, &'static str), Vec<ResourceKey>>::new();
        for observation in snapshots.pre.difference(&snapshots.post) {
            let resource = resource_from_observation(observation);
            deltas
                .entry((observation.authorization_scope.clone(), "revoke"))
                .or_default()
                .push(resource);
            super::local_commit::record_revocation(
                connection,
                context,
                &ResourceRevocation {
                    authorization_scope: observation.authorization_scope.clone(),
                    resource_kind: observation.resource_kind,
                    resource_id: observation.resource_id.clone(),
                    reason,
                },
            )?;
        }
        for observation in snapshots.post.difference(&snapshots.pre) {
            let resource = resource_from_observation(observation);
            deltas
                .entry((observation.authorization_scope.clone(), "grant"))
                .or_default()
                .push(resource);
        }
        // A resource can remain readable while the proof that authorizes it
        // changes (for example, adding an overlapping ancestor grant). Mark
        // that root as a targeted repair so registrations using the old proof
        // cannot survive a later change to the new path.
        for observation in snapshots.post.intersection(&snapshots.pre) {
            let resource = resource_from_observation(observation);
            deltas
                .entry((observation.authorization_scope.clone(), "grant"))
                .or_default()
                .push(resource);
        }
        let mut aggregate_scopes = deltas
            .keys()
            .map(|(scope, _)| scope.clone())
            .collect::<BTreeSet<_>>();
        if snapshots.conservative_scopes.is_empty() {
            aggregate_scopes.extend(project_fact_scopes(&facts)?);
        }
        for scope in aggregate_scopes {
            let aggregate_root = authorization_scope_aggregate_root(&scope);
            deltas
                .entry((scope, "revoke"))
                .or_default()
                .push(aggregate_root);
        }
        for ((scope, delta_kind), mut roots) in deltas {
            roots.sort();
            roots.dedup();
            record_delta(connection, context, &scope, delta_kind, &roots)?;
        }
        for scope in snapshots.conservative_scopes {
            record_delta(connection, context, &scope, "conservative_reset", &[])?;
        }
        connection.execute(
            "UPDATE local_commit_visibility_dirty_facts SET consumed = 1
             WHERE store_epoch = ?1 AND commit_seq = ?2 AND consumed = 0",
            params![context.store_epoch(), context.commit_seq()],
        )?;
        self.close_context(connection, context)
    }

    pub(crate) fn finish_no_op(
        &self,
        connection: &Connection,
        context: &CommitContext,
    ) -> Result<(), StoreError> {
        let fact_count: i64 = connection.query_row(
            "SELECT count(*) FROM local_commit_visibility_dirty_facts
             WHERE store_epoch = ?1 AND commit_seq = ?2",
            params![context.store_epoch(), context.commit_seq()],
            |row| row.get(0),
        )?;
        if fact_count != 0 {
            return Err(corrupt(
                "Durable mutation reported no-op after authority-bearing writes",
            ));
        }
        self.close_context(connection, context)
    }

    fn close_context(
        &self,
        connection: &Connection,
        context: &CommitContext,
    ) -> Result<(), StoreError> {
        let changed = if self.restore_maintenance_context {
            connection.execute(
                "UPDATE local_commit_visibility_context
                 SET mode = 'maintenance', store_epoch = NULL, commit_seq = NULL
                 WHERE id = 1 AND mode = 'active' AND store_epoch = ?1 AND commit_seq = ?2",
                params![context.store_epoch(), context.commit_seq()],
            )?
        } else {
            connection.execute(
                "DELETE FROM local_commit_visibility_context
                 WHERE id = 1 AND mode = 'active' AND store_epoch = ?1 AND commit_seq = ?2",
                params![context.store_epoch(), context.commit_seq()],
            )?
        };
        if changed == 1 {
            return Ok(());
        }
        Err(corrupt("VisibilityDeltaJournal context identity diverged"))
    }

    fn ensure_snapshots(
        &self,
        connection: &Connection,
        context: &CommitContext,
    ) -> Result<(), StoreError> {
        if self.snapshots.borrow().is_some() {
            return Ok(());
        }
        let facts = read_facts(connection, context)?;
        if facts.is_empty() {
            self.snapshots.replace(Some(VisibilitySnapshots {
                pre: BTreeSet::new(),
                post: BTreeSet::new(),
                conservative_scopes: BTreeSet::new(),
            }));
            return Ok(());
        }
        let mut candidates = candidate_resources(&facts)?;
        expand_direct_authority_resources(connection, &mut candidates)?;
        if candidates.len() > MAX_CANDIDATE_RESOURCES
            || exceeds_project_scope_budget(connection)?
            || pre_state_may_exceed_project_scope_budget(connection, &facts)?
        {
            self.snapshots.replace(Some(VisibilitySnapshots {
                pre: BTreeSet::new(),
                post: BTreeSet::new(),
                conservative_scopes: bounded_active_scopes(connection, &facts)?,
            }));
            return Ok(());
        }
        let pure_births = pure_resource_births(&facts)?;
        if let Some(born) = pure_births.as_ref() {
            candidates.retain(|resource| born.contains(resource));
        }
        let post = observe_visibility(&CurrentGraphView::new(connection), &candidates)?;
        let pre = match pure_births {
            Some(_) => BTreeSet::new(),
            None => observe_pre_visibility(connection, context, &facts, &candidates)?,
        };
        if pre.len().saturating_add(post.len()) > MAX_EXACT_VISIBILITY_CLAIMS {
            let conservative_scopes = pre
                .iter()
                .chain(&post)
                .map(|observation| observation.authorization_scope.clone())
                .collect();
            self.snapshots.replace(Some(VisibilitySnapshots {
                pre: BTreeSet::new(),
                post: BTreeSet::new(),
                conservative_scopes,
            }));
            return Ok(());
        }
        self.snapshots.replace(Some(VisibilitySnapshots {
            pre,
            post,
            conservative_scopes: BTreeSet::new(),
        }));
        Ok(())
    }
}

fn project_fact_scopes(
    facts: &[DirtyFact],
) -> Result<BTreeSet<DeliveryAuthorizationScope>, StoreError> {
    let mut scopes = BTreeSet::new();
    for fact in facts {
        if fact.relation_kind != "projects" {
            continue;
        }
        for row in [fact.old_row.as_ref(), fact.new_row.as_ref()]
            .into_iter()
            .flatten()
        {
            let Some(library_id) = row.get("library_id").and_then(Value::as_str) else {
                continue;
            };
            scopes.insert(DeliveryAuthorizationScope::Project {
                library_id: library_id.to_owned(),
                project_id: required_string(row, "id")?,
            });
        }
    }
    Ok(scopes)
}

fn exceeds_project_scope_budget(connection: &Connection) -> Result<bool, StoreError> {
    let bound = i64::try_from(MAX_ACTIVE_PROJECT_SCOPES)
        .map_err(|_| corrupt("Project scope budget is invalid"))?;
    Ok(connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM (
             SELECT library_id FROM projects
             WHERE lifecycle = 'active' AND library_id IS NOT NULL
             GROUP BY library_id HAVING count(*) > ?1
           )
         )",
        [bound],
        |row| row.get::<_, i64>(0),
    )? == 1)
}

fn pre_state_may_exceed_project_scope_budget(
    connection: &Connection,
    facts: &[DirtyFact],
) -> Result<bool, StoreError> {
    let mut active_counts = connection
        .prepare(
            "SELECT library_id, count(*) FROM projects
             WHERE lifecycle = 'active' AND library_id IS NOT NULL
             GROUP BY library_id",
        )?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
    for fact in facts {
        if fact.relation_kind != "projects" {
            continue;
        }
        if let Some(old_row) = fact.old_row.as_ref()
            && old_row.get("lifecycle").and_then(Value::as_str) == Some("active")
            && let Some(library_id) = old_row.get("library_id").and_then(Value::as_str)
        {
            *active_counts.entry(library_id.to_owned()).or_default() += 1;
        }
        if let Some(new_row) = fact.new_row.as_ref()
            && new_row.get("lifecycle").and_then(Value::as_str) == Some("active")
            && let Some(library_id) = new_row.get("library_id").and_then(Value::as_str)
        {
            *active_counts.entry(library_id.to_owned()).or_default() -= 1;
        }
    }
    Ok(active_counts
        .values()
        .any(|count| usize::try_from(*count).unwrap_or(usize::MAX) > MAX_ACTIVE_PROJECT_SCOPES))
}

fn bounded_active_scopes(
    connection: &Connection,
    facts: &[DirtyFact],
) -> Result<BTreeSet<DeliveryAuthorizationScope>, StoreError> {
    let libraries = connection
        .prepare("SELECT id FROM libraries ORDER BY id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let project_bound = i64::try_from(MAX_ACTIVE_PROJECT_SCOPES)
        .map_err(|_| corrupt("Project scope budget is invalid"))?;
    let mut explicit_projects = BTreeMap::<String, BTreeSet<String>>::new();
    for fact in facts {
        for row in [fact.old_row.as_ref(), fact.new_row.as_ref()]
            .into_iter()
            .flatten()
        {
            let project_id = if fact.relation_kind == "projects" {
                row.get("id").and_then(Value::as_str)
            } else {
                row.get("project_id").and_then(Value::as_str)
            };
            let Some(project_id) = project_id else {
                continue;
            };
            let library_id = if let Some(library_id) = row.get("library_id").and_then(Value::as_str)
            {
                Some(library_id.to_owned())
            } else {
                connection
                    .query_row(
                        "SELECT library_id FROM projects WHERE id = ?1",
                        [project_id],
                        |query_row| query_row.get::<_, Option<String>>(0),
                    )
                    .optional()?
                    .flatten()
            };
            if let Some(library_id) = library_id {
                explicit_projects
                    .entry(library_id)
                    .or_default()
                    .insert(project_id.to_owned());
            }
        }
    }
    let mut scopes = BTreeSet::new();
    for library_id in libraries {
        scopes.insert(DeliveryAuthorizationScope::Library {
            library_id: library_id.clone(),
        });
        let active_project_ids = connection
            .prepare_cached(
                "SELECT id FROM projects
                 WHERE library_id = ?1 AND lifecycle = 'active'
                 ORDER BY id LIMIT ?2",
            )?
            .query_map(params![library_id, project_bound], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut project_ids = explicit_projects
            .remove(&library_id)
            .unwrap_or_default()
            .into_iter()
            .take(MAX_ACTIVE_PROJECT_SCOPES)
            .collect::<BTreeSet<_>>();
        for project_id in active_project_ids {
            if project_ids.len() >= MAX_ACTIVE_PROJECT_SCOPES {
                break;
            }
            project_ids.insert(project_id);
        }
        scopes.extend(project_ids.into_iter().map(|project_id| {
            DeliveryAuthorizationScope::Project {
                library_id: library_id.clone(),
                project_id,
            }
        }));
    }
    Ok(scopes)
}

fn expand_direct_authority_resources(
    connection: &Connection,
    resources: &mut Vec<ResourceKey>,
) -> Result<(), StoreError> {
    let mut expanded = resources.iter().cloned().collect::<BTreeSet<_>>();
    for resource in resources.iter() {
        let ResourceKey::Page { page_id } = resource else {
            continue;
        };
        let document_id = connection
            .query_row(
                "SELECT document_id FROM pages WHERE block_id = ?1",
                [page_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(document_id) = document_id {
            expanded.insert(ResourceKey::Document { document_id });
        }
    }
    *resources = expanded.into_iter().collect();
    Ok(())
}

fn read_facts(
    connection: &Connection,
    context: &CommitContext,
) -> Result<Vec<DirtyFact>, StoreError> {
    connection
        .prepare(
            "SELECT relation_kind, operation, old_row_json, new_row_json
             FROM local_commit_visibility_dirty_facts
             WHERE store_epoch = ?1 AND commit_seq = ?2 ORDER BY fact_seq",
        )?
        .query_map(
            params![context.store_epoch(), context.commit_seq()],
            |row| {
                let old_row = row.get::<_, Option<String>>(2)?;
                let new_row = row.get::<_, Option<String>>(3)?;
                Ok(DirtyFact {
                    relation_kind: row.get(0)?,
                    operation: row.get(1)?,
                    old_row: old_row
                        .map(|raw| serde_json::from_str(&raw))
                        .transpose()
                        .map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                raw_length(&error),
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?,
                    new_row: new_row
                        .map(|raw| serde_json::from_str(&raw))
                        .transpose()
                        .map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                raw_length(&error),
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)
}

fn raw_length(_: &serde_json::Error) -> usize {
    0
}

fn candidate_resources(facts: &[DirtyFact]) -> Result<Vec<ResourceKey>, StoreError> {
    let mut resources = BTreeSet::new();
    for fact in facts {
        for row in [fact.old_row.as_ref(), fact.new_row.as_ref()]
            .into_iter()
            .flatten()
        {
            match fact.relation_kind.as_str() {
                "projects" => insert_resource(
                    &mut resources,
                    ResourceKey::Project {
                        project_id: required_string(row, "id")?,
                    },
                ),
                "project_database_bindings" => {
                    insert_resource(
                        &mut resources,
                        ResourceKey::Project {
                            project_id: required_string(row, "project_id")?,
                        },
                    );
                    insert_resource(
                        &mut resources,
                        ResourceKey::Database {
                            database_id: required_string(row, "database_block_id")?,
                        },
                    );
                }
                "project_resource_grants" => {
                    insert_resource(
                        &mut resources,
                        ResourceKey::Project {
                            project_id: required_string(row, "project_id")?,
                        },
                    );
                    let root_id = required_string(row, "root_id")?;
                    match required_string(row, "root_kind")?.as_str() {
                        "page" => {
                            insert_resource(&mut resources, ResourceKey::Page { page_id: root_id })
                        }
                        "database" => insert_resource(
                            &mut resources,
                            ResourceKey::Database {
                                database_id: root_id,
                            },
                        ),
                        "canvas" => insert_resource(
                            &mut resources,
                            ResourceKey::Canvas { canvas_id: root_id },
                        ),
                        _ => return Err(corrupt("Visibility grant root kind is invalid")),
                    }
                }
                "blocks" => match required_string(row, "type")?.as_str() {
                    "page" => insert_resource(
                        &mut resources,
                        ResourceKey::Page {
                            page_id: required_string(row, "id")?,
                        },
                    ),
                    "database" => insert_resource(
                        &mut resources,
                        ResourceKey::Database {
                            database_id: required_string(row, "id")?,
                        },
                    ),
                    "canvas" => insert_resource(
                        &mut resources,
                        ResourceKey::Canvas {
                            canvas_id: required_string(row, "id")?,
                        },
                    ),
                    _ => {}
                },
                "documents" => insert_resource(
                    &mut resources,
                    ResourceKey::Document {
                        document_id: required_string(row, "id")?,
                    },
                ),
                "block_documents" => insert_resource(
                    &mut resources,
                    ResourceKey::Document {
                        document_id: required_string(row, "document_id")?,
                    },
                ),
                "pages" => {
                    insert_resource(
                        &mut resources,
                        ResourceKey::Page {
                            page_id: required_string(row, "block_id")?,
                        },
                    );
                    insert_resource(
                        &mut resources,
                        ResourceKey::Document {
                            document_id: required_string(row, "document_id")?,
                        },
                    );
                }
                "database_containers" => insert_resource(
                    &mut resources,
                    ResourceKey::Database {
                        database_id: required_string(row, "block_id")?,
                    },
                ),
                "data_sources" => {
                    insert_resource(
                        &mut resources,
                        ResourceKey::DataSource {
                            data_source_id: required_string(row, "id")?,
                        },
                    );
                    insert_resource(
                        &mut resources,
                        ResourceKey::Database {
                            database_id: required_string(row, "home_database_block_id")?,
                        },
                    );
                }
                "database_views" => {
                    insert_resource(
                        &mut resources,
                        ResourceKey::View {
                            view_id: required_string(row, "id")?,
                        },
                    );
                    insert_resource(
                        &mut resources,
                        ResourceKey::Database {
                            database_id: required_string(row, "database_block_id")?,
                        },
                    );
                }
                "data_source_page_memberships" => {
                    insert_resource(
                        &mut resources,
                        ResourceKey::Page {
                            page_id: required_string(row, "page_block_id")?,
                        },
                    );
                    insert_resource(
                        &mut resources,
                        ResourceKey::DataSource {
                            data_source_id: required_string(row, "data_source_id")?,
                        },
                    );
                }
                "canvas_owners" => insert_resource(
                    &mut resources,
                    ResourceKey::Canvas {
                        canvas_id: required_string(row, "block_id")?,
                    },
                ),
                _ => return Err(corrupt("Visibility dirty fact relation is unsupported")),
            }
        }
    }
    Ok(resources.into_iter().collect())
}

fn insert_resource(resources: &mut BTreeSet<ResourceKey>, resource: ResourceKey) {
    resources.insert(resource);
}

fn required_string(row: &Value, field: &str) -> Result<String, StoreError> {
    row.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| corrupt("Visibility dirty fact is missing a canonical identity"))
}

fn authority_block_resource(row: &Value) -> Result<Option<ResourceKey>, StoreError> {
    let id = required_string(row, "id")?;
    Ok(match required_string(row, "type")?.as_str() {
        "page" => Some(ResourceKey::Page { page_id: id }),
        "database" => Some(ResourceKey::Database { database_id: id }),
        "canvas" => Some(ResourceKey::Canvas { canvas_id: id }),
        _ => None,
    })
}

fn inserted_resource(
    fact: &DirtyFact,
    relation: &str,
    field: &str,
    resource: impl FnOnce(String) -> ResourceKey,
) -> Result<Option<ResourceKey>, StoreError> {
    if fact.relation_kind != relation || fact.operation != "insert" {
        return Ok(None);
    }
    let row = fact
        .new_row
        .as_ref()
        .ok_or_else(|| corrupt("Inserted visibility fact has no new row"))?;
    Ok(Some(resource(required_string(row, field)?)))
}

fn born_resources(facts: &[DirtyFact]) -> Result<BTreeSet<ResourceKey>, StoreError> {
    let mut born = BTreeSet::new();
    for fact in facts {
        if fact.relation_kind == "blocks" {
            let new_resource = fact
                .new_row
                .as_ref()
                .map(authority_block_resource)
                .transpose()?
                .flatten();
            let old_resource = fact
                .old_row
                .as_ref()
                .map(authority_block_resource)
                .transpose()?
                .flatten();
            if matches!(fact.operation.as_str(), "insert" | "update")
                && old_resource.is_none()
                && let Some(resource) = new_resource
            {
                born.insert(resource);
            }
            continue;
        }
        for resource in [
            inserted_resource(fact, "documents", "id", |document_id| {
                ResourceKey::Document { document_id }
            })?,
            inserted_resource(fact, "data_sources", "id", |data_source_id| {
                ResourceKey::DataSource { data_source_id }
            })?,
            inserted_resource(fact, "database_views", "id", |view_id| ResourceKey::View {
                view_id,
            })?,
        ]
        .into_iter()
        .flatten()
        {
            born.insert(resource);
        }
    }
    Ok(born)
}

fn fact_is_resource_birth(
    fact: &DirtyFact,
    born: &BTreeSet<ResourceKey>,
) -> Result<bool, StoreError> {
    if fact.relation_kind == "blocks" {
        let Some(new_row) = fact.new_row.as_ref() else {
            return Ok(false);
        };
        let new_resource = authority_block_resource(new_row)?;
        let old_resource = fact
            .old_row
            .as_ref()
            .map(authority_block_resource)
            .transpose()?
            .flatten();
        return Ok(matches!(fact.operation.as_str(), "insert" | "update")
            && old_resource
                .as_ref()
                .is_none_or(|resource| born.contains(resource))
            && new_resource.is_some_and(|resource| born.contains(&resource)));
    }
    if !matches!(fact.operation.as_str(), "insert" | "update") {
        return Ok(false);
    }
    let Some(row) = fact.new_row.as_ref() else {
        return Ok(false);
    };
    match fact.relation_kind.as_str() {
        "documents" => Ok(born.contains(&ResourceKey::Document {
            document_id: required_string(row, "id")?,
        })),
        "pages" => Ok(born.contains(&ResourceKey::Page {
            page_id: required_string(row, "block_id")?,
        }) && born.contains(&ResourceKey::Document {
            document_id: required_string(row, "document_id")?,
        })),
        "block_documents" => Ok(born.contains(&ResourceKey::Document {
            document_id: required_string(row, "document_id")?,
        })),
        "database_containers" => Ok(born.contains(&ResourceKey::Database {
            database_id: required_string(row, "block_id")?,
        })),
        "data_sources" => Ok(born.contains(&ResourceKey::DataSource {
            data_source_id: required_string(row, "id")?,
        })),
        "database_views" => Ok(born.contains(&ResourceKey::View {
            view_id: required_string(row, "id")?,
        })),
        "data_source_page_memberships" => Ok(born.contains(&ResourceKey::Page {
            page_id: required_string(row, "page_block_id")?,
        })),
        "canvas_owners" => Ok(born.contains(&ResourceKey::Canvas {
            canvas_id: required_string(row, "block_id")?,
        })),
        "project_resource_grants" => {
            let root_id = required_string(row, "root_id")?;
            Ok(match required_string(row, "root_kind")?.as_str() {
                "page" => born.contains(&ResourceKey::Page { page_id: root_id }),
                "database" => born.contains(&ResourceKey::Database {
                    database_id: root_id,
                }),
                "canvas" => born.contains(&ResourceKey::Canvas { canvas_id: root_id }),
                _ => false,
            })
        }
        "project_database_bindings" => Ok(born.contains(&ResourceKey::Database {
            database_id: required_string(row, "database_block_id")?,
        })),
        "projects" if fact.operation == "insert" => {
            let database_id = row.get("database_block_id").and_then(Value::as_str);
            Ok(database_id.is_none_or(|database_id| {
                born.contains(&ResourceKey::Database {
                    database_id: database_id.to_owned(),
                })
            }))
        }
        _ => Ok(false),
    }
}

fn pure_resource_births(facts: &[DirtyFact]) -> Result<Option<BTreeSet<ResourceKey>>, StoreError> {
    let born = born_resources(facts)?;
    if born.is_empty() {
        return Ok(None);
    }
    for fact in facts {
        if !fact_is_resource_birth(fact, &born)? {
            return Ok(None);
        }
    }
    Ok(Some(born))
}

fn observe_pre_visibility(
    connection: &Connection,
    context: &CommitContext,
    facts: &[DirtyFact],
    resources: &[ResourceKey],
) -> Result<BTreeSet<AuthorizedResourceObservation>, StoreError> {
    connection.execute(
        "UPDATE local_commit_visibility_context SET mode = 'overlay'
         WHERE id = 1 AND mode = 'active' AND store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch(), context.commit_seq()],
    )?;
    connection
        .execute_batch("SAVEPOINT visibility_pre_overlay; PRAGMA defer_foreign_keys = ON;")?;
    let observed = (|| {
        suspend_non_journal_triggers(connection)?;
        for fact in facts.iter().rev() {
            apply_inverse_fact(connection, fact)?;
        }
        observe_visibility(&PreMutationOverlayGraph { connection }, resources)
    })();
    let rollback = connection
        .execute_batch("ROLLBACK TO visibility_pre_overlay; RELEASE visibility_pre_overlay;");
    let reactivate = connection.execute(
        "UPDATE local_commit_visibility_context
         SET mode = 'active', store_epoch = ?1, commit_seq = ?2
         WHERE id = 1 AND mode = 'overlay' AND store_epoch = ?1 AND commit_seq = ?2",
        params![context.store_epoch(), context.commit_seq()],
    );
    rollback?;
    if reactivate? != 1 {
        return Err(corrupt(
            "VisibilityDeltaJournal could not restore its active context",
        ));
    }
    observed
}

fn suspend_non_journal_triggers(connection: &Connection) -> Result<(), StoreError> {
    // The overlay is a read adapter over a savepoint, not a second domain
    // mutation. Validation and projection-maintenance triggers describe valid
    // forward writes and can reject an otherwise valid inverse sequence while
    // its intermediate graph is intentionally historical. Drop them only
    // inside the overlay savepoint; the unconditional rollback below restores
    // both the canonical rows and the complete trigger schema before sealing.
    let trigger_names = connection
        .prepare(
            "SELECT name FROM sqlite_schema
             WHERE type = 'trigger' AND name NOT LIKE 'visibility_dirty_%'
             ORDER BY name",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for trigger_name in trigger_names {
        connection.execute_batch(&format!("DROP TRIGGER {}", quote_identifier(&trigger_name)))?;
    }
    Ok(())
}

fn observe_visibility(
    view: &impl AuthorizationGraphView,
    resources: &[ResourceKey],
) -> Result<BTreeSet<AuthorizedResourceObservation>, StoreError> {
    let connection = view.connection();
    let libraries = connection
        .prepare("SELECT id FROM libraries ORDER BY id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut observations = BTreeSet::new();
    for library_id in libraries {
        let library_scope = DeliveryAuthorizationScope::Library {
            library_id: library_id.clone(),
        };
        let library_context = authorization_context(&library_id, None);
        for resource in resources {
            if super::resource_authorization::can_read_in_view(
                view,
                &library_context,
                &library_scope,
                resource,
            )? && let Some(observation) = observation(&library_scope, resource)
            {
                observations.insert(observation);
            }
            let ResourceKey::Document { document_id } = resource else {
                continue;
            };
            let scope = DeliveryAuthorizationScope::Document {
                library_id: library_id.clone(),
                project_id: None,
                document_id: document_id.clone(),
            };
            if super::resource_authorization::can_read_in_view(
                view,
                &library_context,
                &scope,
                resource,
            )? && let Some(observation) = observation(&scope, resource)
            {
                observations.insert(observation);
            }
        }
        let project_ids = connection
            .prepare_cached(
                "SELECT id FROM projects
                 WHERE library_id = ?1 AND lifecycle = 'active' ORDER BY id LIMIT 201",
            )?
            .query_map([&library_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if project_ids.len() > 200 {
            return Err(StoreError::new(
                StoreErrorCode::ResourceExhausted,
                "VisibilityDelta candidate Project count exceeds the active bound",
                false,
            ));
        }
        for project_id in project_ids {
            let project_scope = DeliveryAuthorizationScope::Project {
                library_id: library_id.clone(),
                project_id: project_id.clone(),
            };
            let project_context = authorization_context(&library_id, Some(&project_id));
            for resource in resources {
                if super::resource_authorization::can_read_in_view(
                    view,
                    &project_context,
                    &project_scope,
                    resource,
                )? && let Some(observation) = observation(&project_scope, resource)
                {
                    observations.insert(observation);
                }
                let ResourceKey::Document { document_id } = resource else {
                    continue;
                };
                let scope = DeliveryAuthorizationScope::Document {
                    library_id: library_id.clone(),
                    project_id: Some(project_id.clone()),
                    document_id: document_id.clone(),
                };
                if super::resource_authorization::can_read_in_view(
                    view,
                    &project_context,
                    &scope,
                    resource,
                )? && let Some(observation) = observation(&scope, resource)
                {
                    observations.insert(observation);
                }
            }
        }
    }
    Ok(observations)
}

fn authorization_context(library_id: &str, project_id: Option<&str>) -> BoundModuleContext {
    BoundModuleContext {
        profile_id: ProfileId("profile:visibility-delta-journal".to_owned()),
        library_id: LibraryId(library_id.to_owned()),
        project_id: project_id.map(|id| ProjectId(id.to_owned())),
        connection_id: "connection:visibility-delta-journal".to_owned(),
        adapter: AdapterKind::Test,
    }
}

fn observation(
    scope: &DeliveryAuthorizationScope,
    resource: &ResourceKey,
) -> Option<AuthorizedResourceObservation> {
    let (resource_kind, resource_id) = match resource {
        ResourceKey::Page { page_id } => (RevokedResourceKind::Page, page_id),
        ResourceKey::Document { document_id } => (RevokedResourceKind::Document, document_id),
        ResourceKey::Database { database_id } => (RevokedResourceKind::Database, database_id),
        ResourceKey::DataSource { data_source_id } => {
            (RevokedResourceKind::DataSource, data_source_id)
        }
        ResourceKey::View { view_id } => (RevokedResourceKind::View, view_id),
        ResourceKey::Canvas { canvas_id } => (RevokedResourceKind::Canvas, canvas_id),
        ResourceKey::Library { .. } | ResourceKey::Project { .. } => return None,
    };
    Some(AuthorizedResourceObservation {
        authorization_scope: scope.clone(),
        resource_kind,
        resource_id: resource_id.clone(),
    })
}

fn resource_from_observation(observation: &AuthorizedResourceObservation) -> ResourceKey {
    let resource_id = observation.resource_id.clone();
    match observation.resource_kind {
        RevokedResourceKind::Page => ResourceKey::Page {
            page_id: resource_id,
        },
        RevokedResourceKind::Document => ResourceKey::Document {
            document_id: resource_id,
        },
        RevokedResourceKind::Database => ResourceKey::Database {
            database_id: resource_id,
        },
        RevokedResourceKind::DataSource => ResourceKey::DataSource {
            data_source_id: resource_id,
        },
        RevokedResourceKind::View => ResourceKey::View {
            view_id: resource_id,
        },
        RevokedResourceKind::Canvas => ResourceKey::Canvas {
            canvas_id: resource_id,
        },
    }
}

fn apply_inverse_fact(connection: &Connection, fact: &DirtyFact) -> Result<(), StoreError> {
    let columns = table_columns(connection, &fact.relation_kind)?;
    let primary_key = columns
        .iter()
        .filter(|column| column.primary_key_order > 0)
        .collect::<Vec<_>>();
    if primary_key.is_empty() {
        return Err(corrupt("Authority relation has no primary key"));
    }
    match fact.operation.as_str() {
        "insert" => {
            let new_row = fact
                .new_row
                .as_ref()
                .ok_or_else(|| corrupt("Inserted authority fact has no new row"))?;
            let (where_sql, values) = row_predicate(new_row, &primary_key)?;
            connection.execute(
                &format!(
                    "DELETE FROM {} WHERE {where_sql}",
                    quote_identifier(&fact.relation_kind)
                ),
                params_from_iter(values),
            )?;
        }
        "delete" => {
            let old_row = fact
                .old_row
                .as_ref()
                .ok_or_else(|| corrupt("Deleted authority fact has no old row"))?;
            let names = columns
                .iter()
                .map(|column| quote_identifier(&column.name))
                .collect::<Vec<_>>();
            let placeholders = (1..=columns.len())
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>();
            let values = columns
                .iter()
                .map(|column| sql_value(old_row, column))
                .collect::<Result<Vec<_>, _>>()?;
            connection.execute(
                &format!(
                    "INSERT INTO {}({}) VALUES ({})",
                    quote_identifier(&fact.relation_kind),
                    names.join(", "),
                    placeholders.join(", ")
                ),
                params_from_iter(values),
            )?;
        }
        "update" => {
            let old_row = fact
                .old_row
                .as_ref()
                .ok_or_else(|| corrupt("Updated authority fact has no old row"))?;
            let new_row = fact
                .new_row
                .as_ref()
                .ok_or_else(|| corrupt("Updated authority fact has no new row"))?;
            let assignments = columns
                .iter()
                .enumerate()
                .map(|(index, column)| {
                    format!("{} = ?{}", quote_identifier(&column.name), index + 1)
                })
                .collect::<Vec<_>>();
            let mut values = columns
                .iter()
                .map(|column| sql_value(old_row, column))
                .collect::<Result<Vec<_>, _>>()?;
            let (where_sql, where_values) =
                row_predicate_with_offset(new_row, &primary_key, values.len())?;
            values.extend(where_values);
            connection.execute(
                &format!(
                    "UPDATE {} SET {} WHERE {where_sql}",
                    quote_identifier(&fact.relation_kind),
                    assignments.join(", ")
                ),
                params_from_iter(values),
            )?;
        }
        _ => return Err(corrupt("Visibility dirty fact operation is unsupported")),
    }
    Ok(())
}

struct TableColumn {
    name: String,
    declared_type: String,
    primary_key_order: i64,
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<TableColumn>, StoreError> {
    if !AUTHORITY_RELATIONS.contains(&table) {
        return Err(corrupt("Visibility inverse relation is not inventoried"));
    }
    connection
        .prepare(&format!("PRAGMA table_info({})", quote_identifier(table)))?
        .query_map([], |row| {
            Ok(TableColumn {
                name: row.get(1)?,
                declared_type: row.get(2)?,
                primary_key_order: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)
}

fn row_predicate(
    row: &Value,
    columns: &[&TableColumn],
) -> Result<(String, Vec<SqlValue>), StoreError> {
    row_predicate_with_offset(row, columns, 0)
}

fn row_predicate_with_offset(
    row: &Value,
    columns: &[&TableColumn],
    offset: usize,
) -> Result<(String, Vec<SqlValue>), StoreError> {
    let predicates = columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            format!(
                "{} = ?{}",
                quote_identifier(&column.name),
                offset + index + 1
            )
        })
        .collect::<Vec<_>>();
    let values = columns
        .iter()
        .map(|column| sql_value(row, column))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((predicates.join(" AND "), values))
}

fn sql_value(row: &Value, column: &TableColumn) -> Result<SqlValue, StoreError> {
    let value = row
        .get(&column.name)
        .ok_or_else(|| corrupt("Visibility dirty fact row is missing a column"))?;
    if value.is_null() {
        return Ok(SqlValue::Null);
    }
    if column.declared_type.eq_ignore_ascii_case("BLOB") {
        let encoded = value
            .as_str()
            .ok_or_else(|| corrupt("Visibility dirty fact BLOB is invalid"))?;
        return decode_hex(encoded).map(SqlValue::Blob);
    }
    match value {
        Value::Bool(value) => Ok(SqlValue::Integer(i64::from(*value))),
        Value::Number(value) => value
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| value.as_f64().map(SqlValue::Real))
            .ok_or_else(|| corrupt("Visibility dirty fact number is invalid")),
        Value::String(value) => Ok(SqlValue::Text(value.clone())),
        Value::Null | Value::Array(_) | Value::Object(_) => {
            Err(corrupt("Visibility dirty fact scalar is invalid"))
        }
    }
}

fn decode_hex(encoded: &str) -> Result<Vec<u8>, StoreError> {
    if !encoded.len().is_multiple_of(2) {
        return Err(corrupt("Visibility dirty fact hex value is invalid"));
    }
    encoded
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let value = std::str::from_utf8(pair)
                .ok()
                .and_then(|value| u8::from_str_radix(value, 16).ok())
                .ok_or_else(|| corrupt("Visibility dirty fact hex value is invalid"))?;
            Ok(value)
        })
        .collect()
}

fn record_delta(
    connection: &Connection,
    context: &CommitContext,
    scope: &DeliveryAuthorizationScope,
    delta_kind: &str,
    roots: &[ResourceKey],
) -> Result<(), StoreError> {
    let scope_json =
        serde_json::to_string(scope).map_err(|_| corrupt("Visibility delta scope is invalid"))?;
    let scope_key = format!("v1:{:x}", Sha256::digest(scope_json.as_bytes()));
    let delta_hash = visibility_delta_hash(
        context.store_epoch(),
        context.commit_seq(),
        scope,
        delta_kind,
        roots,
    )?;
    connection.execute(
        "INSERT INTO local_commit_visibility_deltas(
           store_epoch, commit_seq, scope_key, authorization_scope_json,
           delta_kind, roots_json, delta_hash
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            context.store_epoch(),
            context.commit_seq(),
            scope_key,
            scope_json,
            delta_kind,
            serde_json::to_string(roots)
                .map_err(|_| corrupt("Visibility delta roots are invalid"))?,
            delta_hash,
        ],
    )?;
    Ok(())
}

fn visibility_delta_hash(
    store_epoch: &str,
    commit_seq: i64,
    scope: &DeliveryAuthorizationScope,
    delta_kind: &str,
    roots: &[ResourceKey],
) -> Result<String, StoreError> {
    let encoded = serde_json::to_vec(&CanonicalVisibilityDelta {
        hash_version: 1,
        store_epoch,
        commit_seq,
        authorization_scope: scope,
        delta_kind,
        roots,
    })
    .map_err(|_| corrupt("Visibility delta hash input is invalid"))?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn revocation_reason(facts: &[DirtyFact]) -> ResourceRevocationReason {
    if facts
        .iter()
        .any(|fact| fact.relation_kind == "project_resource_grants")
    {
        return ResourceRevocationReason::AccessRevoked;
    }
    for fact in facts {
        let Some(new_row) = fact.new_row.as_ref() else {
            return ResourceRevocationReason::Deleted;
        };
        match new_row.get("lifecycle").and_then(Value::as_str) {
            Some("archived") => return ResourceRevocationReason::Archived,
            Some("deleted" | "revoked") => return ResourceRevocationReason::Deleted,
            _ => {}
        }
    }
    ResourceRevocationReason::OwnershipMoved
}

#[cfg(test)]
pub(crate) fn install_test_maintenance_context(connection: &Connection) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO local_commit_visibility_context(id, mode, store_epoch, commit_seq)
         VALUES (1, 'maintenance', NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET
           mode = excluded.mode, store_epoch = NULL, commit_seq = NULL",
        [],
    )?;
    Ok(())
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::json;
    use tempfile::tempdir;

    use super::*;
    use crate::infrastructure::local_commit;
    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;

    fn overlay_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("overlay SQLite");
        connection
            .execute_batch(
                "CREATE TABLE projects(
                   id TEXT PRIMARY KEY,
                   library_id TEXT,
                   database_block_id TEXT,
                   lifecycle TEXT NOT NULL
                 ) STRICT;",
            )
            .expect("overlay schema");
        connection
    }

    fn project_row(library_id: &str, database_block_id: &str, lifecycle: &str) -> Value {
        json!({
            "id": "project:overlay",
            "library_id": library_id,
            "database_block_id": database_block_id,
            "lifecycle": lifecycle,
        })
    }

    fn fact(operation: &str, old_row: Option<Value>, new_row: Option<Value>) -> DirtyFact {
        DirtyFact {
            relation_kind: "projects".to_owned(),
            operation: operation.to_owned(),
            old_row,
            new_row,
        }
    }

    fn relation_fact(
        relation_kind: &str,
        operation: &str,
        old_row: Option<Value>,
        new_row: Option<Value>,
    ) -> DirtyFact {
        DirtyFact {
            relation_kind: relation_kind.to_owned(),
            operation: operation.to_owned(),
            old_row,
            new_row,
        }
    }

    fn stored_project(connection: &Connection) -> Option<(String, String, String)> {
        connection
            .query_row(
                "SELECT library_id, database_block_id, lifecycle FROM projects
                 WHERE id = 'project:overlay'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .expect("stored overlay project")
    }

    #[test]
    fn reverse_overlay_recovers_multiple_changes_to_the_same_edge() {
        let connection = overlay_connection();
        let initial = project_row("library:initial", "database:initial", "active");
        let middle = project_row("library:middle", "database:middle", "archived");
        let final_row = project_row("library:final", "database:final", "active");
        connection
            .execute(
                "INSERT INTO projects VALUES ('project:overlay', 'library:final',
                 'database:final', 'active')",
                [],
            )
            .expect("current project");
        for dirty in [
            fact("update", Some(middle.clone()), Some(final_row)),
            fact("update", Some(initial), Some(middle)),
        ] {
            apply_inverse_fact(&connection, &dirty).expect("reverse project update");
        }
        assert_eq!(
            stored_project(&connection),
            Some((
                "library:initial".to_owned(),
                "database:initial".to_owned(),
                "active".to_owned(),
            ))
        );
    }

    #[test]
    fn reverse_overlay_recovers_insert_update_delete_and_delete_recreate() {
        let connection = overlay_connection();
        let inserted = project_row("library:inserted", "database:inserted", "active");
        let updated = project_row("library:updated", "database:updated", "archived");
        for dirty in [
            fact("delete", Some(updated.clone()), None),
            fact("update", Some(inserted.clone()), Some(updated)),
            fact("insert", None, Some(inserted)),
        ] {
            apply_inverse_fact(&connection, &dirty).expect("reverse net-zero sequence");
        }
        assert_eq!(stored_project(&connection), None);

        let deleted = project_row("library:old", "database:old", "active");
        let recreated = project_row("library:new", "database:new", "active");
        connection
            .execute(
                "INSERT INTO projects VALUES ('project:overlay', 'library:new',
                 'database:new', 'active')",
                [],
            )
            .expect("recreated project");
        for dirty in [
            fact("insert", None, Some(recreated)),
            fact("delete", Some(deleted), None),
        ] {
            apply_inverse_fact(&connection, &dirty).expect("reverse delete-recreate");
        }
        assert_eq!(
            stored_project(&connection),
            Some((
                "library:old".to_owned(),
                "database:old".to_owned(),
                "active".to_owned(),
            ))
        );
    }

    #[test]
    fn resource_births_derive_pre_visibility_without_replaying_the_schema() {
        let facts = vec![
            relation_fact(
                "blocks",
                "update",
                Some(json!({ "id": "page:born", "type": "paragraph" })),
                Some(json!({ "id": "page:born", "type": "page" })),
            ),
            relation_fact(
                "blocks",
                "update",
                Some(json!({ "id": "page:born", "type": "page" })),
                Some(json!({ "id": "page:born", "type": "page" })),
            ),
            relation_fact(
                "documents",
                "insert",
                None,
                Some(json!({ "id": "document:born" })),
            ),
            relation_fact(
                "documents",
                "update",
                Some(json!({ "id": "document:born" })),
                Some(json!({ "id": "document:born" })),
            ),
            relation_fact(
                "pages",
                "insert",
                None,
                Some(json!({
                    "block_id": "page:born",
                    "document_id": "document:born"
                })),
            ),
            relation_fact(
                "pages",
                "update",
                Some(json!({
                    "block_id": "page:born",
                    "document_id": "document:born"
                })),
                Some(json!({
                    "block_id": "page:born",
                    "document_id": "document:born"
                })),
            ),
            relation_fact(
                "project_resource_grants",
                "insert",
                None,
                Some(json!({ "root_kind": "page", "root_id": "page:born" })),
            ),
            relation_fact(
                "data_source_page_memberships",
                "insert",
                None,
                Some(json!({ "page_block_id": "page:born" })),
            ),
        ];
        let births = pure_resource_births(&facts)
            .expect("birth derivation")
            .expect("birth-only facts");

        assert_eq!(
            births,
            BTreeSet::from([
                ResourceKey::Page {
                    page_id: "page:born".to_owned(),
                },
                ResourceKey::Document {
                    document_id: "document:born".to_owned(),
                },
            ])
        );
    }

    #[test]
    fn existing_resource_grants_still_require_the_reverse_overlay() {
        let facts = vec![relation_fact(
            "project_resource_grants",
            "insert",
            None,
            Some(json!({ "root_kind": "page", "root_id": "page:existing" })),
        )];

        assert_eq!(
            pure_resource_births(&facts).expect("grant classification"),
            None
        );
    }

    #[test]
    fn authority_writes_require_an_active_or_maintenance_context() {
        let directory = tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open(directory.path()).expect("production Core store");
        let error = kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, created, updated)
                     VALUES ('project:unguarded', 'Unguarded', '2026-08-09', '2026-08-09')",
                    [],
                )?;
                Ok(())
            })
            .expect_err("unguarded authority write must fail");
        assert!(error.message.contains("requires VisibilityDeltaJournal"));
    }

    #[test]
    fn seal_rejects_an_unconsumed_dirty_fact() {
        let directory = tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("test Core store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    let store_epoch = "epoch:unconsumed-visibility";
                    transaction.execute(
                        "INSERT INTO block_store_metadata(
                           id, store_epoch, created_at, updated_at
                         ) VALUES (1, ?1, '2026-08-09', '2026-08-09')",
                        [store_epoch],
                    )?;
                    let context = local_commit::allocate(
                        transaction,
                        store_epoch,
                        "operation:unconsumed-visibility",
                        &crate::document::sha256(b"unconsumed visibility"),
                        "2026-08-09T00:00:00Z",
                    )?;
                    let journal = VisibilityDeltaJournal::begin(transaction, &context)?;
                    transaction.execute(
                        "INSERT INTO projects(id, name, created, updated)
                         VALUES ('project:dirty', 'Dirty', '2026-08-09', '2026-08-09')",
                        [],
                    )?;
                    journal.close_context(transaction, &context)?;
                    let error = local_commit::finalize(transaction, &context)
                        .expect_err("unconsumed visibility fact must fail seal");
                    assert!(error.message.contains("unconsumed visibility dirty facts"));
                    Ok(())
                })
            })
            .expect("unconsumed seal guard");
    }

    #[test]
    fn maintenance_writes_do_not_emit_visibility_facts() {
        let directory = tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("test Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO projects(id, name, created, updated)
                     VALUES ('project:maintenance', 'Maintenance', '2026-08-09', '2026-08-09')",
                    [],
                )?;
                let fact_count: i64 = connection.query_row(
                    "SELECT count(*) FROM local_commit_visibility_dirty_facts",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(fact_count, 0);
                Ok(())
            })
            .expect("maintenance authority write");
    }

    #[test]
    fn authority_update_statements_ignore_unchanged_watched_values() {
        let directory = tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("test Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "INSERT INTO block_store_metadata(
                       id, store_epoch, created_at, updated_at
                     ) VALUES (1, 'epoch:unchanged-authority', '2026-08-09', '2026-08-09');
                     INSERT INTO projects(id, name, lifecycle, created, updated)
                     VALUES (
                       'project:unchanged-authority', 'Unchanged', 'active',
                       '2026-08-09', '2026-08-09'
                     );",
                )?;
                with_immediate_transaction(connection, |transaction| {
                    let context = local_commit::allocate(
                        transaction,
                        "epoch:unchanged-authority",
                        "operation:unchanged-authority",
                        &crate::document::sha256(b"unchanged authority"),
                        "2026-08-09T00:00:00Z",
                    )?;
                    let journal = VisibilityDeltaJournal::begin(transaction, &context)?;
                    transaction.execute(
                        "UPDATE projects SET lifecycle = 'active', updated = '2026-08-10'
                         WHERE id = 'project:unchanged-authority'",
                        [],
                    )?;
                    let fact_count: i64 = transaction.query_row(
                        "SELECT count(*) FROM local_commit_visibility_dirty_facts
                         WHERE commit_seq = ?1",
                        [context.commit_seq()],
                        |row| row.get(0),
                    )?;
                    assert_eq!(fact_count, 0);
                    journal.finish_no_op(transaction, &context)?;
                    local_commit::abandon(transaction, &context)
                })
            })
            .expect("unchanged authority update");
    }

    #[test]
    fn same_commit_visibility_round_trip_consumes_facts_without_a_delta() {
        let directory = tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("test Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO block_store_metadata(
                       id, store_epoch, created_at, updated_at
                     ) VALUES (1, 'epoch:round-trip', '2026-08-09', '2026-08-09')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO projects(id, name, lifecycle, created, updated)
                     VALUES (
                       'project:round-trip', 'Round trip', 'active',
                       '2026-08-09', '2026-08-09'
                     )",
                    [],
                )?;
                with_immediate_transaction(connection, |transaction| {
                    let context = local_commit::allocate(
                        transaction,
                        "epoch:round-trip",
                        "operation:round-trip",
                        &crate::document::sha256(b"round trip"),
                        "2026-08-09T00:00:00Z",
                    )?;
                    let journal = VisibilityDeltaJournal::begin(transaction, &context)?;
                    transaction.execute(
                        "UPDATE projects SET lifecycle = 'archived'
                         WHERE id = 'project:round-trip'",
                        [],
                    )?;
                    transaction.execute(
                        "UPDATE projects SET lifecycle = 'active'
                         WHERE id = 'project:round-trip'",
                        [],
                    )?;
                    journal.finalize(transaction, &context)?;
                    let evidence: (i64, i64) = transaction.query_row(
                        "SELECT
                           (SELECT count(*) FROM local_commit_visibility_dirty_facts
                            WHERE commit_seq = ?1 AND consumed = 1),
                           (SELECT count(*) FROM local_commit_visibility_deltas
                            WHERE commit_seq = ?1)",
                        [context.commit_seq()],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?;
                    assert_eq!(evidence, (2, 0));
                    local_commit::abandon(transaction, &context)?;
                    Ok(())
                })
            })
            .expect("same-commit visibility round trip");
    }

    #[test]
    fn project_scope_bound_is_exact_at_two_hundred_and_conservative_above_it() {
        let directory = tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(directory.path()).expect("test Core store");
        kernel
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "INSERT INTO block_store_metadata(
                       id, store_epoch, created_at, updated_at
                     ) VALUES (1, 'epoch:project-bound', '2026-08-09', '2026-08-09');
                     INSERT INTO profiles(id, created_at, updated_at)
                     VALUES ('profile:project-bound', '2026-08-09', '2026-08-09');
                     INSERT INTO libraries(id, profile_id, created_at, updated_at)
                     VALUES (
                       'library:project-bound', 'profile:project-bound',
                       '2026-08-09', '2026-08-09'
                     );",
                )?;
                (0..MAX_ACTIVE_PROJECT_SCOPES).try_for_each(|index| {
                    connection.execute(
                        "INSERT INTO projects(
                           id, library_id, name, lifecycle, created, updated
                         ) VALUES (?1, 'library:project-bound', ?1, 'active',
                           '2026-08-09', '2026-08-09')",
                        [format!("project:{index:03}")],
                    )?;
                    Ok::<_, StoreError>(())
                })?;
                with_immediate_transaction(connection, |transaction| {
                    let context = local_commit::allocate(
                        transaction,
                        "epoch:project-bound",
                        "operation:project-bound",
                        &crate::document::sha256(b"project bound"),
                        "2026-08-09T00:00:00Z",
                    )?;
                    let journal = VisibilityDeltaJournal::begin(transaction, &context)?;
                    transaction.execute(
                        "UPDATE projects SET lifecycle = 'archived'
                         WHERE id = 'project:000'",
                        [],
                    )?;
                    transaction.execute(
                        "UPDATE projects SET lifecycle = 'active'
                         WHERE id = 'project:000'",
                        [],
                    )?;
                    journal.finalize(transaction, &context)?;
                    let conservative_count: i64 = transaction.query_row(
                        "SELECT count(*) FROM local_commit_visibility_deltas
                         WHERE commit_seq = ?1 AND delta_kind = 'conservative_reset'",
                        [context.commit_seq()],
                        |row| row.get(0),
                    )?;
                    assert_eq!(conservative_count, 0);
                    validate_seal(transaction, &context)?;
                    local_commit::abandon(transaction, &context)?;
                    Ok(())
                })?;
                connection.execute(
                    "INSERT INTO projects(
                       id, library_id, name, lifecycle, created, updated
                     ) VALUES (
                       'project:200', 'library:project-bound', 'project:200', 'active',
                       '2026-08-09', '2026-08-09'
                     )",
                    [],
                )?;
                with_immediate_transaction(connection, |transaction| {
                    let context = local_commit::allocate(
                        transaction,
                        "epoch:project-bound",
                        "operation:project-overflow",
                        &crate::document::sha256(b"project overflow"),
                        "2026-08-09T00:00:01Z",
                    )?;
                    let journal = VisibilityDeltaJournal::begin(transaction, &context)?;
                    transaction.execute(
                        "UPDATE projects SET lifecycle = 'archived'
                         WHERE id = 'project:000'",
                        [],
                    )?;
                    journal.finalize(transaction, &context)?;
                    let evidence: (i64, i64) = transaction.query_row(
                        "SELECT count(*),
                                sum(CASE WHEN roots_json = '[]' THEN 1 ELSE 0 END)
                         FROM local_commit_visibility_deltas
                         WHERE commit_seq = ?1 AND delta_kind = 'conservative_reset'",
                        [context.commit_seq()],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?;
                    assert_eq!(evidence, (201, 201));
                    validate_seal(transaction, &context)?;
                    local_commit::abandon(transaction, &context)?;
                    Ok(())
                })
            })
            .expect("Project exact and conservative compiler bounds");
    }
}
