//! Local CRDT history is retained before a Document update can make its
//! identities collectible. Membership is scoped to an authenticated Host
//! lifetime and an immutable surface authority, never a shared Undo stack.

use super::*;
use nodex_core_contracts::library::LibraryLocalHistoryRetention;

struct RetainedSet {
    project_id: String,
    document_id: String,
    generation: i64,
    revision: i64,
    hash: String,
    closed: bool,
    retain_document: bool,
}

pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    retention: &LibraryLocalHistoryRetention,
) -> Result<LibraryApplyOutcome, StoreError> {
    let owner = history_owner::trusted_owner(context)?;
    validate(retention)?;
    // Empty denotes Library authority, not whichever Project currently acts
    // for its receipts. A surface cannot switch between these access scopes.
    let requesting_project_id = context
        .project_id
        .as_ref()
        .map(|id| id.0.as_str())
        .unwrap_or("");
    let current = connection.query_row(
        "SELECT project_id, document_id, generation, revision, membership_hash, closed, retain_document FROM editor_history_local_sets WHERE owner_id = ?1 AND surface_id = ?2",
        params![owner.id, retention.surface_id],
        |row| Ok(RetainedSet { project_id: row.get(0)?, document_id: row.get(1)?, generation: row.get(2)?, revision: row.get(3)?, hash: row.get(4)?, closed: row.get(5)?, retain_document: row.get(6)? }),
    ).optional()?;
    let actor_project_id = if retention.closed {
        context
            .project_id
            .as_ref()
            .map(|id| id.0.clone())
            .or_else(|| current.as_ref().map(|current| current.project_id.clone()))
            .unwrap_or_default()
    } else {
        super::super::mutation::resolve_library_mutation_authority(
            connection,
            context,
            &context.library_id.0,
        )?
        .actor_project_id
    };
    let project_id = actor_project_id.as_str();
    let hash = sha256(
        &serde_json::to_vec(retention)
            .map_err(|_| invalid("History retention cannot be encoded"))?,
    );
    if let Some(current) = &current {
        if current.project_id != requesting_project_id
            || current.document_id != retention.document_id
            || current.generation != retention.generation
        {
            return Err(unauthorized(
                "History surface cannot change its Document authority",
            ));
        }
        if current.revision == retention.revision && current.hash != hash {
            return Err(conflict(
                "History retention revision was reused with different membership",
            ));
        }
        if current.closed && !retention.closed && retention.revision > current.revision {
            return Err(conflict("History surface has already closed"));
        }
    }
    let obsolete = current
        .as_ref()
        .is_some_and(|current| current.revision >= retention.revision);
    let roots = retention.block_ids.iter().cloned().collect::<BTreeSet<_>>();
    let old_roots = connection.prepare(
        "SELECT block_id FROM editor_history_local_roots WHERE owner_id = ?1 AND surface_id = ?2",
    )?.query_map(params![owner.id, retention.surface_id], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<BTreeSet<_>>>()?;
    if !obsolete {
        authorize_change(connection, context, retention, &current, &roots, &old_roots)?;
    }
    // Adding a root must invalidate older GC evidence. Release-only maintenance
    // can only make that evidence over-retain, so it needs no semantic commit.
    let did_mutate = !obsolete
        && (!roots.is_subset(&old_roots)
            || (retention.retain_document
                && !current
                    .as_ref()
                    .is_some_and(|current| current.retain_document)));
    let now = sqlite_now(connection)?;
    let committed = durable_mutation::run(
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
            if !obsolete {
                connection.execute(
                    "INSERT INTO editor_history_local_sets(owner_id, surface_id, project_id, document_id, generation, revision, membership_hash, closed, retain_document) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(owner_id, surface_id) DO UPDATE SET revision = excluded.revision, membership_hash = excluded.membership_hash, closed = excluded.closed, retain_document = excluded.retain_document",
                    params![owner.id, retention.surface_id, requesting_project_id, retention.document_id, retention.generation, retention.revision, hash, retention.closed, retention.retain_document],
                )?;
                for id in old_roots.difference(&roots) {
                    connection.execute("DELETE FROM editor_history_local_roots WHERE owner_id = ?1 AND surface_id = ?2 AND block_id = ?3", params![owner.id, retention.surface_id, id])?;
                }
                for id in roots.difference(&old_roots) {
                    connection.execute("INSERT INTO editor_history_local_roots(owner_id, surface_id, block_id) VALUES (?1, ?2, ?3)", params![owner.id, retention.surface_id, id])?;
                }
            }
            let result = empty_structural_result("set_local_history_retention");
            let mut effects = history_release_effects(project_id, &result, &now);
            effects.operation_kind = "set_local_history_retention";
            effects.did_mutate = did_mutate;
            seal_mutation_with(scope, context, operation_id, effects, |_, _| Ok(()))
        },
    )?;
    library_commit_result(connection, committed)
}

fn validate(retention: &LibraryLocalHistoryRetention) -> Result<(), StoreError> {
    if retention.surface_id.is_empty()
        || retention.surface_id.len() > 512
        || retention.document_id.is_empty()
        || retention.document_id.len() > 512
        || retention.generation <= 0
        || retention.revision <= 0
    {
        return Err(invalid(
            "History retention requires a bounded surface and Document identity",
        ));
    }
    if retention.block_ids.len() > MAX_STRUCTURAL_BLOCKS {
        return Err(resource_exhausted(
            "Local history exceeds its retained identity bound",
        ));
    }
    if (retention.closed && retention.retain_document)
        || (!retention.retain_document && !retention.block_ids.is_empty())
    {
        return Err(invalid(
            "Closed or empty history cannot retain Block identities",
        ));
    }
    let ids = retention.block_ids.iter().collect::<BTreeSet<_>>();
    if ids.len() != retention.block_ids.len()
        || ids.iter().any(|id| id.is_empty() || id.len() > 512)
    {
        return Err(invalid(
            "History retention contains duplicate or invalid Block identities",
        ));
    }
    Ok(())
}

fn authorize_change(
    connection: &Connection,
    context: &BoundModuleContext,
    retention: &LibraryLocalHistoryRetention,
    current: &Option<RetainedSet>,
    roots: &BTreeSet<String>,
    old_roots: &BTreeSet<String>,
) -> Result<(), StoreError> {
    let owner = history_owner::trusted_owner(context)?;
    if current.is_none() && !retention.closed {
        let sets: i64 = connection.query_row(
            "SELECT count(*) FROM editor_history_local_sets WHERE owner_id = ?1 AND closed = 0",
            [&owner.id],
            |row| row.get(0),
        )?;
        if sets >= 128 {
            return Err(resource_exhausted(
                "Editor history surface capacity is exhausted",
            ));
        }
    }
    let adding = roots.difference(old_roots).collect::<Vec<_>>();
    if adding.is_empty()
        && (!retention.retain_document
            || current
                .as_ref()
                .is_some_and(|current| current.retain_document))
    {
        return Ok(());
    }
    let retained: i64 = connection.query_row(
        "SELECT count(*) FROM editor_history_local_roots WHERE owner_id = ?1",
        [&owner.id],
        |row| row.get(0),
    )?;
    if retained - old_roots.len() as i64 + roots.len() as i64 > 100_000 {
        return Err(resource_exhausted(
            "Editor lifetime retained identity capacity is exhausted",
        ));
    }
    let authority = read_document_authority(connection, &retention.document_id)?
        .ok_or_else(|| conflict("History Document no longer exists"))?;
    if authority.head.library_id != context.library_id.0
        || authority.head.generation != retention.generation
    {
        return Err(conflict("History belongs to another Document authority"));
    }
    if let Some(project_id) = &context.project_id {
        super::super::history::require_page_write_access(
            connection,
            &context.library_id.0,
            &project_id.0,
            &authority.owner_block_id,
        )?;
    }
    for id in adding {
        let row = connection.query_row(
            "SELECT b.library_id, i.document_id, t.document_id, t.document_generation FROM blocks b LEFT JOIN document_block_index i ON i.block_id = b.id LEFT JOIN document_block_tombstones t ON t.block_id = b.id WHERE b.id = ?1",
            [id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<i64>>(3)?)),
        ).optional()?;
        if let Some((library, active_doc, tombstone_doc, generation)) = row {
            if library != context.library_id.0
                || !(active_doc.as_deref() == Some(&retention.document_id)
                    || (active_doc.is_none()
                        && tombstone_doc.as_deref() == Some(&retention.document_id)
                        && generation == Some(retention.generation)))
            {
                return Err(unauthorized(
                    "History Block belongs to another Document placement",
                ));
            }
            continue;
        }
        let retired: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM retired_block_identities WHERE block_id = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if retired {
            return Err(conflict("History Block identity has been retired"));
        }
        // No canonical identity exists yet. Keeping its bounded opaque ID does
        // not create a Block or bypass the canonical writer's identity guards.
    }
    Ok(())
}
