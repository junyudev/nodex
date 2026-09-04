//! A desktop lifetime is a retention authority, not a shared Undo stack. Main
//! binds its opaque identity to authenticated Unix peer credentials. There is
//! no inactivity expiry: a sleeping or disconnected live Host keeps history.

use nodex_core_contracts::{
    AdapterKind, BoundEditorHistoryOwner, BoundModuleContext, LocalProjectionScope,
};
use rusqlite::{Connection, OptionalExtension, params};

use super::*;
use crate::infrastructure::local_commit;

const MAX_ACTIVE_RECIPES_PER_OWNER: i64 = 20_000;
const MAX_ACTIVE_OWNERS: i64 = 1_024;
const CLEANUP_RECIPE_LIMIT: usize = 128;
const CLEANUP_ROOT_LIMIT: usize = 1_024;
const CLEANUP_BYTE_LIMIT: usize = 1_048_576;
const CLEANUP_TIME_BUDGET: std::time::Duration = std::time::Duration::from_millis(20);

#[derive(Debug, Default)]
pub(crate) struct CleanupSlice {
    pub recipes: usize,
    pub roots: usize,
    pub local_sets: usize,
    pub bytes: usize,
    pub pending: bool,
}

impl CleanupSlice {
    fn has_budget(&self, started: std::time::Instant) -> bool {
        self.recipes < CLEANUP_RECIPE_LIMIT
            && self.roots < CLEANUP_ROOT_LIMIT
            && self.local_sets < CLEANUP_RECIPE_LIMIT
            && self.bytes < CLEANUP_BYTE_LIMIT
            && started.elapsed() < CLEANUP_TIME_BUDGET
    }
}
// Each MIN performs one indexed seek past the previous Host. DISTINCT would
// still visit every closed generation of a long-lived Host before advancing.
const OWNER_PID_SCAN_SQL: &str = "WITH RECURSIVE hosts(peer_pid) AS (
    SELECT MIN(peer_pid) FROM editor_history_owners WHERE peer_pid > ?1
    UNION ALL
    SELECT (SELECT MIN(peer_pid) FROM editor_history_owners WHERE peer_pid > hosts.peer_pid)
    FROM hosts WHERE peer_pid IS NOT NULL LIMIT 1024
) SELECT peer_pid FROM hosts WHERE peer_pid IS NOT NULL";

pub(super) fn trusted_owner(
    context: &BoundModuleContext,
) -> Result<&BoundEditorHistoryOwner, StoreError> {
    let owner = context
        .editor_history_owner
        .as_ref()
        .ok_or_else(|| invalid("Editor history lifetime is missing"))?;
    if context.adapter != AdapterKind::ElectronHost
        || owner.id.is_empty()
        || owner.id.len() > 512
        || owner.peer_pid == 0
    {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Editor history requires authenticated desktop authority",
            false,
        ));
    }
    Ok(owner)
}

/// The closed marker is retained while the Host lives so a late request can
/// never recreate a lifetime after its window has gone away.
fn bind_owner(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    initial_state: &str,
) -> Result<bool, StoreError> {
    let owner = trusted_owner(context)?;
    let existing = connection.query_row(
        "SELECT library_id, store_epoch, peer_pid, state FROM editor_history_owners WHERE owner_id = ?1",
        [&owner.id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, u32>(2)?, row.get::<_, String>(3)?)),
    ).optional()?;
    if let Some((library_id, epoch, peer_pid, state)) = existing {
        if library_id != context.library_id.0 || epoch != store_epoch || peer_pid != owner.peer_pid
        {
            return Err(StoreError::new(
                StoreErrorCode::Unauthorized,
                "Editor history lifetime belongs to another Host or Store",
                false,
            ));
        }
        return Ok(state == "active");
    }
    let active: i64 = connection.query_row(
        "SELECT count(*) FROM editor_history_owners WHERE state = 'active'",
        [],
        |row| row.get(0),
    )?;
    if initial_state == "active" && active >= MAX_ACTIVE_OWNERS {
        return Err(resource_exhausted(
            "Active editor history lifetime capacity is exhausted",
        ));
    }
    connection.execute(
        "INSERT INTO editor_history_owners(owner_id, library_id, store_epoch, peer_pid, state) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![owner.id, context.library_id.0, store_epoch, owner.peer_pid, initial_state],
    )?;
    Ok(initial_state == "active")
}

pub(crate) fn retain_recipe(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
    token: &LibraryStructuralHistoryToken,
) -> Result<(), StoreError> {
    if context.editor_history_owner.is_none() {
        return Ok(());
    }
    require_active(connection, context, store_epoch)?;
    let owner = trusted_owner(context)?;
    let retained: i64 = connection.query_row(
        "SELECT count(*) FROM editor_history_recipes owned JOIN structural_history_recipes recipe USING(recipe_operation_id) WHERE owned.owner_id = ?1 AND recipe.state = 'available'",
        [&owner.id], |row| row.get(0),
    )?;
    if retained >= MAX_ACTIVE_RECIPES_PER_OWNER {
        return Err(resource_exhausted(
            "Editor history retention capacity is exhausted",
        ));
    }
    connection.execute(
        "INSERT INTO editor_history_recipes(recipe_operation_id, owner_id) VALUES (?1, ?2)",
        params![token.recipe_operation_id, owner.id],
    )?;
    Ok(())
}

pub(crate) fn require_active(
    connection: &Connection,
    context: &BoundModuleContext,
    store_epoch: &str,
) -> Result<(), StoreError> {
    if context.editor_history_owner.is_none() {
        return Ok(());
    }
    if !bind_owner(connection, context, store_epoch, "active")? {
        return Err(conflict("The editor history lifetime has ended"));
    }
    Ok(())
}

/// Closure fences capability execution immediately, before deferred root cleanup.
pub(super) fn recipe_owner_is_closed(
    connection: &Connection,
    recipe_operation_id: &str,
) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM editor_history_recipes recipe \
         JOIN editor_history_owners owner USING(owner_id) \
         WHERE recipe.recipe_operation_id = ?1 AND owner.state = 'closed')",
        [recipe_operation_id],
        |row| row.get(0),
    )?)
}

/// Releases live owner membership and schedules bounded physical root removal.
/// Terminal capability evidence stays in structural_history_recipes; keeping it
/// in the live owner index would make admission scan every historical action.
pub(in crate::library) fn release_terminal_recipe(
    connection: &Connection,
    recipe_operation_id: &str,
) -> Result<(), StoreError> {
    let terminal: bool = connection.query_row(
        "SELECT state <> 'available' FROM structural_history_recipes WHERE recipe_operation_id = ?1",
        [recipe_operation_id], |row| row.get(0),
    )?;
    if !terminal {
        return Err(internal(
            "Available history cannot release its retention membership",
        ));
    }
    connection.execute(
        "INSERT OR IGNORE INTO structural_history_root_cleanup(recipe_operation_id) VALUES (?1)",
        [recipe_operation_id],
    )?;
    connection.execute(
        "DELETE FROM editor_history_recipes WHERE recipe_operation_id = ?1",
        [recipe_operation_id],
    )?;
    Ok(())
}

pub(crate) fn close(
    connection: &Connection,
    context: &BoundModuleContext,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
) -> Result<LibraryApplyOutcome, StoreError> {
    if context.project_id.is_some() {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Only the desktop Host can close an entire editor lifetime",
            false,
        ));
    }
    let owner = trusted_owner(context)?;
    bind_owner(connection, context, store_epoch, "closed")?;
    let project_id = connection
        .query_row(
            "SELECT id FROM projects WHERE library_id = ?1 ORDER BY id LIMIT 1",
            [&context.library_id.0],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_default();
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
            connection.execute(
                "UPDATE editor_history_owners SET state = 'closed' WHERE owner_id = ?1",
                [&owner.id],
            )?;
            connection.execute(
                "INSERT OR IGNORE INTO editor_history_cleanup(owner_id) VALUES (?1)",
                [&owner.id],
            )?;
            let result = empty_structural_result("close_editor_history_owner");
            let mut effects = history_release_effects(&project_id, &result, &now);
            effects.operation_kind = "close_editor_history_owner";
            // The marker immediately fences every capability. Bounded cleanup
            // publishes recipe transitions and removes roots in later commits.
            seal_mutation_with(scope, context, operation_id, effects, |_, _| Ok(()))
        },
    )?;
    library_commit_result(connection, committed)
}

fn owner_has_retention(connection: &Connection, owner_id: &str) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM editor_history_recipes WHERE owner_id = ?1) \
         OR EXISTS(SELECT 1 FROM editor_history_local_sets WHERE owner_id = ?1)",
        [owner_id],
        |row| row.get(0),
    )?)
}

/// One independently committed slice. Remaining rows are the durable cursor:
/// a rollback repeats only this slice, never already released roots.
pub(crate) fn drain_cleanup(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
) -> Result<CleanupSlice, StoreError> {
    let mut slice = CleanupSlice::default();
    let started = std::time::Instant::now();
    drain_terminal_roots(connection, started, &mut slice)?;
    if !slice.has_budget(started) {
        slice.pending = cleanup_is_pending(connection)?;
        return Ok(slice);
    }
    let owner = connection
        .query_row(
            "SELECT pending.owner_id, owner.peer_pid FROM editor_history_cleanup pending \
         JOIN editor_history_owners owner USING(owner_id) \
         WHERE owner.state = 'closed' ORDER BY pending.owner_id LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?)),
        )
        .optional()?;
    let Some((owner_id, peer_pid)) = owner else {
        slice.pending = cleanup_is_pending(connection)?;
        return Ok(slice);
    };
    let context = BoundModuleContext {
        profile_id: nodex_core_contracts::ProfileId(profile_id.to_owned()),
        library_id: nodex_core_contracts::LibraryId(library_id.to_owned()),
        project_id: None,
        connection_id: "editor-history-maintenance".to_owned(),
        adapter: AdapterKind::ElectronHost,
        editor_history_owner: Some(BoundEditorHistoryOwner {
            id: owner_id.clone(),
            peer_pid,
        }),
    };
    let operation_id = crate::domain::identity::random_uuid_v7()
        .map_err(|_| internal("History cleanup operation identity is unavailable"))?;
    let epoch = crate::document::read_store_epoch(connection)?;
    let now = sqlite_now(connection)?;
    let committed = durable_mutation::run(
        connection,
        OperationIdentity {
            module: ModuleName::Library,
            module_name: "library",
            operation_id: &operation_id,
            intent_hash: &sha256(format!("history-cleanup:{owner_id}:{operation_id}").as_bytes()),
            store_epoch: &epoch,
            committed_at: &now,
            context: &context,
        },
        |scope| {
            let projects = drain_recipes(connection, &owner_id, &now, started, &mut slice)?;
            drain_local_roots(connection, &owner_id, started, &mut slice)?;
            if !owner_has_retention(connection, &owner_id)? {
                connection.execute(
                    "DELETE FROM editor_history_cleanup WHERE owner_id = ?1",
                    [&owner_id],
                )?;
            }
            for project_id in &projects {
                local_commit::require_projection_read(
                    connection,
                    scope.evidence(),
                    LocalProjectionScope::StructuralHistory {
                        project_id: project_id.clone(),
                    },
                )?;
            }
            let result = empty_structural_result("release_structural_history");
            let mut effects =
                history_release_effects(projects.first().map_or("", String::as_str), &result, &now);
            effects.did_mutate = !projects.is_empty();
            seal_mutation_with(scope, &context, &operation_id, effects, |_, _| Ok(()))
        },
    )?;
    library_commit_result(connection, committed)?;
    slice.pending = cleanup_is_pending(connection)?;
    Ok(slice)
}

fn cleanup_is_pending(connection: &Connection) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM editor_history_cleanup) \
         OR EXISTS(SELECT 1 FROM structural_history_root_cleanup)",
        [],
        |row| row.get(0),
    )?)
}

fn drain_recipes(
    connection: &Connection,
    owner_id: &str,
    now: &str,
    started: std::time::Instant,
    slice: &mut CleanupSlice,
) -> Result<BTreeSet<String>, StoreError> {
    let mut projects = BTreeSet::new();
    let backfilling: bool = connection.query_row(
        "SELECT complete = 0 FROM structural_history_payload_backfill WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    while slice.has_budget(started) {
        crate::infrastructure::request_execution::check_request_interruption()?;
        let recipe = connection.query_row(
            "SELECT recipe.recipe_operation_id, recipe.project_id, recipe.state, octet_length(recipe.payload_ref_json) \
             FROM editor_history_recipes owned JOIN structural_history_recipes recipe USING(recipe_operation_id) \
             WHERE owned.owner_id = ?1 ORDER BY owned.recipe_operation_id LIMIT 1",
            [owner_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)? as usize)),
        ).optional()?;
        let Some((id, project, state, payload_bytes)) = recipe else {
            break;
        };
        // Moving an old large inline body is a separate cold conversion. Do
        // not rewrite it a second time inside a short lifecycle-cleanup slice.
        if backfilling && !connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM structural_history_payloads WHERE recipe_operation_id = ?1 AND part = 0)",
            [&id], |row| row.get::<_, bool>(0),
        )? {
            break;
        }
        // A pre-existing payload is one indivisible SQLite row. Do not combine
        // it with another transition when it exceeds the normal slice budget.
        if state == "available"
            && slice.bytes != 0
            && slice.bytes + payload_bytes > CLEANUP_BYTE_LIMIT
        {
            break;
        }
        slice.recipes += 1;
        slice.bytes += id.len() + project.len();
        if state == "available" {
            slice.bytes += payload_bytes;
            connection.execute("UPDATE structural_history_recipes SET state = 'consumed', consumed_at = ?1 WHERE recipe_operation_id = ?2", params![now, id])?;
            connection.execute("UPDATE structural_cut_claims SET state = 'revoked', revision = revision + 1, updated_at = ?1 WHERE delete_recipe_operation_id = ?2 AND state = 'available'", params![now, id])?;
            projects.insert(project);
        }
        release_terminal_recipe(connection, &id)?;
    }
    Ok(projects)
}

fn drain_terminal_roots(
    connection: &Connection,
    started: std::time::Instant,
    slice: &mut CleanupSlice,
) -> Result<(), StoreError> {
    let backfilling: bool = connection.query_row(
        "SELECT complete = 0 FROM structural_history_payload_backfill WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    if backfilling {
        // Until all sources are published, these roots also explain unowned
        // Documents to backup validation. Physical release may safely wait.
        return Ok(());
    }
    while slice.has_budget(started) {
        let id = connection.query_row(
            "SELECT recipe_operation_id FROM structural_history_root_cleanup ORDER BY recipe_operation_id LIMIT 1",
            [], |row| row.get::<_, String>(0),
        ).optional()?;
        let Some(id) = id else {
            break;
        };
        slice.recipes += 1;
        let members = connection
            .prepare(
                "SELECT member_kind, member_id FROM structural_retention_members \
             WHERE authority_kind = 'history_recipe' AND authority_id = ?1 \
             ORDER BY member_kind, member_id LIMIT ?2",
            )?
            .query_map(
                params![id, (CLEANUP_ROOT_LIMIT - slice.roots) as i64],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (kind, member) in members {
            if !slice.has_budget(started) {
                break;
            }
            connection.execute("DELETE FROM structural_retention_members WHERE authority_kind = 'history_recipe' AND authority_id = ?1 AND member_kind = ?2 AND member_id = ?3", params![id, kind, member])?;
            slice.roots += 1;
            slice.bytes += kind.len() + member.len();
        }
        let remaining: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM structural_retention_members WHERE authority_kind = 'history_recipe' AND authority_id = ?1)",
            [&id], |row| row.get(0),
        )?;
        if remaining {
            break;
        }
        connection.execute(
            "DELETE FROM structural_history_root_cleanup WHERE recipe_operation_id = ?1",
            [&id],
        )?;
    }
    Ok(())
}

fn drain_local_roots(
    connection: &Connection,
    owner_id: &str,
    started: std::time::Instant,
    slice: &mut CleanupSlice,
) -> Result<(), StoreError> {
    if !slice.has_budget(started) {
        return Ok(());
    }
    let roots = connection.prepare(
        "SELECT surface_id, block_id FROM editor_history_local_roots WHERE owner_id = ?1 ORDER BY surface_id, block_id LIMIT ?2",
    )?.query_map(params![owner_id, (CLEANUP_ROOT_LIMIT - slice.roots) as i64], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (surface, block) in roots {
        if !slice.has_budget(started) {
            break;
        }
        connection.execute("DELETE FROM editor_history_local_roots WHERE owner_id = ?1 AND surface_id = ?2 AND block_id = ?3", params![owner_id, surface, block])?;
        slice.roots += 1;
        slice.bytes += surface.len() + block.len();
    }
    // Never hide an unbounded cascade behind a one-row surface deletion.
    let remaining: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM editor_history_local_roots WHERE owner_id = ?1)",
        [owner_id],
        |row| row.get(0),
    )?;
    if remaining {
        return Ok(());
    }
    let surfaces = connection.prepare("SELECT surface_id FROM editor_history_local_sets WHERE owner_id = ?1 ORDER BY surface_id LIMIT ?2")?
        .query_map(params![owner_id, CLEANUP_RECIPE_LIMIT as i64], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for surface in surfaces {
        if !slice.has_budget(started) {
            break;
        }
        connection.execute(
            "DELETE FROM editor_history_local_sets WHERE owner_id = ?1 AND surface_id = ?2",
            params![owner_id, surface],
        )?;
        slice.local_sets += 1;
        slice.bytes += surface.len();
    }
    Ok(())
}

pub(crate) fn reap(
    connection: &Connection,
    profile_id: &str,
    library_id: &str,
    after_pid: u32,
    is_process_alive: impl Fn(u32) -> bool,
) -> Result<(usize, u32), StoreError> {
    const SCAN_LIMIT: usize = 1024;
    const RELEASE_LIMIT: usize = 100;
    let pids = connection
        .prepare(OWNER_PID_SCAN_SQL)?
        .query_map([after_pid], |row| row.get::<_, u32>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next_pid = if pids.len() == SCAN_LIMIT {
        pids.last().copied().unwrap_or_default()
    } else {
        0
    };
    let epoch = crate::document::read_store_epoch(connection)?;
    let mut released = 0;
    for pid in pids.into_iter().filter(|pid| !is_process_alive(*pid)) {
        let owners = connection
            .prepare("SELECT owner_id FROM editor_history_owners WHERE peer_pid = ?1 LIMIT 100")?
            .query_map([pid], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in owners {
            let context = BoundModuleContext {
                profile_id: nodex_core_contracts::ProfileId(profile_id.to_owned()),
                library_id: nodex_core_contracts::LibraryId(library_id.to_owned()),
                project_id: None,
                connection_id: "editor-history-maintenance".to_owned(),
                adapter: AdapterKind::ElectronHost,
                editor_history_owner: Some(BoundEditorHistoryOwner {
                    id: id.clone(),
                    peer_pid: pid,
                }),
            };
            let operation_id = crate::domain::identity::random_uuid_v7()
                .map_err(|_| internal("History cleanup operation identity is unavailable"))?;
            let hash = sha256(format!("close-editor-history\0{id}\0{epoch}").as_bytes());
            close(connection, &context, &operation_id, &epoch, &hash)?;
            // A dead Host cannot return, but cascading its remaining children
            // here would turn bounded discovery into an unbounded cleanup.
            if !owner_has_retention(connection, &id)? {
                connection.execute(
                    "DELETE FROM editor_history_owners WHERE owner_id = ?1",
                    [&id],
                )?;
            }
            released += 1;
            if released == RELEASE_LIMIT {
                // Visit later Hosts next time, including when this Host still
                // has markers left. Remaining rows are revisited after wrap.
                return Ok((released, pid));
            }
        }
    }
    Ok((released, next_pid))
}

/// Store replacement ends every ephemeral lifetime, including those copied
/// from a backup whose old Host PID still happens to exist.
pub(crate) fn discard_replaced(connection: &Connection) -> Result<(), StoreError> {
    let ready: bool = connection.query_row(
        "SELECT complete FROM structural_history_payload_backfill WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    if !ready {
        return Err(corrupt(
            "History replacement requires complete dormant provenance",
        ));
    }
    let now = sqlite_now(connection)?;
    // Unlike an owner close, a Store epoch replacement ends every old token,
    // including CLI inverses and clipboard capabilities without a Host owner.
    connection.execute("UPDATE structural_history_recipes SET state = 'consumed', consumed_at = ?1 WHERE state = 'available'", [&now])?;
    connection.execute(
        "UPDATE block_transfer_undo_recipes SET consumed_at = ?1 WHERE consumed_at IS NULL",
        [&now],
    )?;
    // Bundle deletion also releases Cut's source-Document foreign key. Merely
    // ending the lease would leave an unusable old clipboard retaining content.
    connection.execute("DELETE FROM structural_clipboard_bundles", [])?;
    connection.execute("DELETE FROM structural_retention_members", [])?;
    connection.execute("DELETE FROM structural_history_root_cleanup", [])?;
    connection.execute("DELETE FROM editor_history_owners", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;
    use nodex_core_contracts::{LibraryId, ProfileId};

    #[test]
    fn replacement_publishes_legacy_provenance_before_ending_every_old_capability() {
        let mut connection = Connection::open_in_memory().expect("Store");
        crate::infrastructure::schema::install_current_schema(&mut connection).unwrap();
        // Historical lifetime metadata only; canonical dormant shape and real
        // structural operations have separate restore and Module coverage.
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        connection
            .execute_batch(
                "INSERT INTO profiles VALUES ('profile', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z');
            INSERT INTO libraries VALUES ('library', 'profile', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z');
            INSERT INTO block_retention_state VALUES (1, 0, 0);
            INSERT INTO editor_history_owners VALUES ('owner', 'library', 'epoch', 42, 'active');
            UPDATE structural_history_payload_backfill SET complete = 0;",
            )
            .unwrap();
        let body = serde_json::json!({"action": {"kind": "restore_turned_selection", "state": {
            "dormantPages": [{"pageId": "page", "documentId": "document", "placeholderBlockId": "placeholder"}]
        }}}).to_string();
        let hash = sha256(body.as_bytes());
        for id in ["owned", "unowned"] {
            connection.execute("INSERT INTO structural_history_recipes(recipe_operation_id, library_id, project_id, store_epoch, recipe_hash, payload_ref_json, state, created_at)
                VALUES (?1, 'library', 'project', 'epoch', ?2, ?3, 'available', '2026-09-05T00:00:00.000Z')", params![id, hash, body]).unwrap();
        }
        connection.execute_batch("INSERT INTO editor_history_recipes VALUES ('owned', 'owner');
            INSERT INTO structural_retention_members VALUES ('history_recipe', 'owned', 'library', 'document', 'document');
            INSERT INTO structural_history_root_cleanup VALUES ('owned');
            INSERT INTO structural_clipboard_leases VALUES ('bundle', 1, 'active', NULL, '2026-09-05T00:00:00.000Z');
            INSERT INTO structural_retention_members VALUES ('clipboard_bundle', 'bundle', 'library', 'document', 'document');
            INSERT INTO structural_cut_claims VALUES ('bundle', 'document', '[\"placeholder\"]', 'unowned', 1, 'available', NULL, '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z');").unwrap();
        connection.execute("INSERT INTO block_transfer_undo_recipes VALUES ('transfer', 'project', 'library', 'epoch', ?1, '{}', NULL, '2026-09-05T00:00:00.000Z')", [&hash]).unwrap();
        connection.execute("INSERT INTO structural_clipboard_bundles VALUES ('bundle', 'capture', 'library', 'epoch', ?1, ?1, '{}', '2026-09-05T00:00:00.000Z')", [&hash]).unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        let mut slice = CleanupSlice::default();
        drain_terminal_roots(&connection, std::time::Instant::now(), &mut slice).unwrap();
        assert_eq!(slice.roots, 0, "sources must precede root release");
        assert!(
            discard_replaced(&connection).is_err(),
            "offline replacement must prepare sources"
        );
        crate::library::prepare_editor_history_replacement(&mut connection).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM structural_dormant_document_sources",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        for _ in 0..2 {
            with_immediate_transaction(&mut connection, |transaction| {
                discard_replaced(transaction)
            })
            .unwrap();
            assert_eq!(
                connection
                    .query_row(
                        "SELECT count(*) FROM structural_history_recipes WHERE state = 'available'",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT count(*) FROM structural_retention_members",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT count(*) FROM structural_clipboard_leases",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            assert_eq!(
                connection
                    .query_row("SELECT count(*) FROM structural_cut_claims", [], |row| row
                        .get::<_, i64>(
                        0
                    ))
                    .unwrap(),
                0,
                "Cut must no longer retain its source Document through a foreign key"
            );
            assert!(
                connection
                    .query_row(
                        "SELECT consumed_at IS NOT NULL FROM block_transfer_undo_recipes",
                        [],
                        |row| row.get::<_, bool>(0)
                    )
                    .unwrap()
            );
            assert_eq!(
                super::super::history_payload::read(&connection, "unowned").unwrap(),
                body,
                "receipt-window bytes remain intact"
            );
        }
    }

    #[test]
    fn cleanup_commits_bounded_slices_and_resumes_after_rollback_and_reopen() {
        let profile = tempfile::tempdir().expect("Profile");
        drop(SqliteStoreKernel::open_test(profile.path()).expect("Store runtime metadata"));
        let path = profile.path().join("nodex.db");
        let mut connection = Connection::open(&path).expect("Store");
        // Storage pressure only: content/authority is covered by Core scenarios.
        // One recipe owns 50,000 members; another 50,000 are local text roots.
        connection
            .pragma_update(None, "foreign_keys", false)
            .expect("pressure fixture");
        connection.execute_batch("BEGIN;
            INSERT INTO profiles VALUES ('profile', 'now', 'now');
            INSERT INTO libraries VALUES ('library', 'profile', 'now', 'now');
            INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) VALUES (1, 'epoch', 'now', 'now');
            INSERT INTO editor_history_owners VALUES ('owner', 'library', 'epoch', 42, 'active');
            WITH RECURSIVE items(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM items WHERE n < 19999)
            INSERT INTO structural_history_recipes(recipe_operation_id, library_id, project_id, store_epoch, recipe_hash, payload_ref_json, state, created_at)
            SELECT printf('recipe-%05d', n), 'library', 'project', 'epoch', printf('%064d', 0), '{}', 'available', 'now' FROM items;
            INSERT INTO editor_history_recipes SELECT recipe_operation_id, 'owner' FROM structural_history_recipes;
            WITH RECURSIVE roots(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM roots WHERE n < 49999)
            INSERT INTO structural_retention_members SELECT 'history_recipe', 'recipe-00000', 'library', 'block', printf('root-%05d', n) FROM roots;
            INSERT INTO editor_history_local_sets VALUES ('owner', 'surface', 'project', 'document', 1, 1, 'hash', 0, 1);
            WITH RECURSIVE roots(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM roots WHERE n < 49999)
            INSERT INTO editor_history_local_roots SELECT 'owner', 'surface', printf('local-%05d', n) FROM roots;
            COMMIT;").expect("large retention closure");
        let context = BoundModuleContext {
            profile_id: ProfileId("profile".into()),
            library_id: LibraryId("library".into()),
            project_id: None,
            connection_id: "closing".into(),
            adapter: AdapterKind::ElectronHost,
            editor_history_owner: Some(BoundEditorHistoryOwner {
                id: "owner".into(),
                peer_pid: 42,
            }),
        };
        let close_id = crate::domain::identity::random_uuid_v7().expect("identity");
        let close_steps = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let measured_steps = std::sync::Arc::clone(&close_steps);
        with_immediate_transaction(&mut connection, |transaction| {
            transaction.progress_handler(
                1,
                Some(move || {
                    measured_steps.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    false
                }),
            )?;
            close(transaction, &context, &close_id, "epoch", &sha256(b"close"))?;
            transaction.progress_handler(0, None::<fn() -> bool>)?;
            assert!(
                close_steps.load(std::sync::atomic::Ordering::Relaxed) < 10_000,
                "closure must not walk the retained history"
            );
            assert!(require_active(transaction, &context, "epoch").is_err());
            assert!(recipe_owner_is_closed(transaction, "recipe-19999")?);
            assert_eq!(
                transaction.query_row(
                    "SELECT count(*) FROM structural_history_recipes WHERE state = 'available'",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                20_000
            );
            Ok(())
        })
        .expect("constant-size close fence");
        let first = with_immediate_transaction(&mut connection, |transaction| {
            drain_cleanup(transaction, "profile", "library")
        })
        .expect("first committed slice");
        assert!(first.pending && first.recipes > 0 && first.recipes <= CLEANUP_RECIPE_LIMIT);
        let first = with_immediate_transaction(&mut connection, |transaction| {
            drain_cleanup(transaction, "profile", "library")
        })
        .expect("first root slice");
        assert!(first.pending && first.roots > 0 && first.roots <= CLEANUP_ROOT_LIMIT);
        let remaining = |connection: &Connection| {
            connection
                .query_row(
                    "SELECT count(*) FROM structural_retention_members",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("remaining roots")
        };
        let after_first = remaining(&connection);
        assert!(
            with_immediate_transaction(&mut connection, |transaction| {
                drain_cleanup(transaction, "profile", "library")?;
                Err::<(), _>(internal("injected interruption before commit"))
            })
            .is_err()
        );
        assert_eq!(remaining(&connection), after_first);
        drop(connection);
        let mut connection = Connection::open(&path).expect("reopen committed progress");
        connection
            .pragma_update(None, "foreign_keys", false)
            .expect("same metadata-only pressure fixture");
        assert_eq!(remaining(&connection), after_first);
        let mut slices = 2;
        let steps = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let measured = std::sync::Arc::clone(&steps);
        connection
            .progress_handler(
                1,
                Some(move || {
                    measured.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    false
                }),
            )
            .expect("VM work measurement");
        let mut max_steps = 0;
        let mut max_bytes = 0;
        let mut max_elapsed = std::time::Duration::ZERO;
        loop {
            let started = std::time::Instant::now();
            let before_steps = steps.load(std::sync::atomic::Ordering::Relaxed);
            let slice = with_immediate_transaction(&mut connection, |transaction| {
                drain_cleanup(transaction, "profile", "library")
            })
            .expect("resumed slice");
            max_steps =
                max_steps.max(steps.load(std::sync::atomic::Ordering::Relaxed) - before_steps);
            max_bytes = max_bytes.max(slice.bytes);
            max_elapsed = max_elapsed.max(started.elapsed());
            assert!(
                slice.roots <= CLEANUP_ROOT_LIMIT
                    && slice.recipes <= CLEANUP_RECIPE_LIMIT
                    && slice.local_sets <= CLEANUP_RECIPE_LIMIT
            );
            assert!(slice.bytes <= CLEANUP_BYTE_LIMIT);
            slices += 1;
            if !slice.pending {
                break;
            }
            assert!(
                slices < 10_000,
                "cleanup did not advance its durable cursor"
            );
        }
        connection
            .progress_handler(0, None::<fn() -> bool>)
            .expect("finish measurement");
        eprintln!(
            "history cleanup: {slices} commits, close {} VM steps, max slice {max_steps} VM steps / {max_bytes} bytes / {max_elapsed:?}",
            close_steps.load(std::sync::atomic::Ordering::Relaxed)
        );
        assert!(slices > 100, "pressure fixture must span many commits");
        assert_eq!(remaining(&connection), 0);
        assert!(!owner_has_retention(&connection, "owner").expect("retention drained"));
        assert!(require_active(&connection, &context, "epoch").is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM structural_history_recipes WHERE state = 'consumed'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .expect("terminal evidence"),
            20_000
        );
    }

    #[test]
    fn terminal_membership_release_keeps_capability_evidence_and_active_roots() {
        let mut connection = Connection::open_in_memory().expect("Store");
        crate::infrastructure::schema::install_current_schema(&mut connection).expect("schema");
        // Storage-only fixture: test the live index independently of content recipes.
        // Authoritative Core scenarios separately exercise the complete content closure.
        connection
            .pragma_update(None, "foreign_keys", false)
            .expect("isolated metadata fixture");
        connection
            .execute_batch(
                "INSERT INTO profiles VALUES ('profile', 'now', 'now');
            INSERT INTO libraries VALUES ('library', 'profile', 'now', 'now');
            INSERT INTO editor_history_owners VALUES ('owner', 'library', 'epoch', 42, 'active');",
            )
            .expect("owner");
        for (id, state, consumed) in [
            ("terminal", "consumed", Some("now")),
            ("active", "available", None),
        ] {
            connection.execute("INSERT INTO structural_history_recipes(recipe_operation_id, library_id, project_id, store_epoch, recipe_hash, payload_ref_json, state, consumed_at, created_at)
                VALUES (?1, 'library', 'project', 'epoch', ?2, '{}', ?3, ?4, 'now')", params![id, "a".repeat(64), state, consumed]).expect("recipe metadata");
            connection
                .execute(
                    "INSERT INTO editor_history_recipes VALUES (?1, 'owner')",
                    [id],
                )
                .expect("live membership");
            connection.execute("INSERT INTO structural_retention_members VALUES ('history_recipe', ?1, 'library', 'block', ?1)", [id]).expect("root");
        }
        assert!(release_terminal_recipe(&connection, "active").is_err());
        release_terminal_recipe(&connection, "terminal").expect("release");
        release_terminal_recipe(&connection, "terminal").expect("idempotent release");
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM structural_retention_members",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .expect("conservative roots before maintenance"),
            2
        );
        drain_terminal_roots(
            &connection,
            std::time::Instant::now(),
            &mut CleanupSlice::default(),
        )
        .expect("bounded terminal release");
        assert_eq!(
            connection
                .query_row(
                    "SELECT recipe_operation_id FROM editor_history_recipes",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .expect("live recipe"),
            "active"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT authority_id FROM structural_retention_members",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .expect("live root"),
            "active"
        );
        assert_eq!(connection.query_row("SELECT state FROM structural_history_recipes WHERE recipe_operation_id = 'terminal'", [], |row| row.get::<_, String>(0)).expect("capability evidence"), "consumed");
    }

    #[test]
    fn pid_discovery_skips_closed_generations_instead_of_scanning_them() {
        let mut connection = Connection::open_in_memory().expect("Store");
        crate::infrastructure::schema::install_current_schema(&mut connection).expect("schema");
        connection.execute_batch("INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile', 'now', 'now');
            INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library', 'profile', 'now', 'now');
            WITH RECURSIVE generations(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM generations WHERE n < 20000)
            INSERT INTO editor_history_owners(owner_id, library_id, store_epoch, peer_pid, state)
            SELECT 'owner-' || n, 'library', 'epoch', CASE WHEN n = 20000 THEN 43 ELSE 42 END, 'closed' FROM generations;
            INSERT INTO editor_history_local_sets(owner_id, surface_id, project_id, document_id, generation, revision, membership_hash, closed, retain_document)
            SELECT 'owner-1', owner_id, '', 'document', 1, 1, 'hash', 1, 0 FROM editor_history_owners;").expect("closed lifetimes");
        let mut statement = connection.prepare(OWNER_PID_SCAN_SQL).expect("scan");
        let pids = statement
            .query_map([0], |row| row.get::<_, u32>(0))
            .expect("query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("PIDs");
        assert_eq!(pids, vec![42, 43]);
        let steps = statement.get_status(rusqlite::StatementStatus::VmStep);
        assert!(
            steps < 1000,
            "PID discovery took {steps} VM steps for only two Hosts"
        );
        for sql in [
            "SELECT count(*) FROM editor_history_owners WHERE state = 'active'",
            "SELECT count(*) FROM editor_history_local_sets WHERE owner_id = 'owner-1' AND closed = 0",
        ] {
            let mut count = connection.prepare(sql).expect("active capacity query");
            assert_eq!(
                count
                    .query_row([], |row| row.get::<_, i64>(0))
                    .expect("active count"),
                0
            );
            let steps = count.get_status(rusqlite::StatementStatus::VmStep);
            assert!(
                steps < 100,
                "Inactive lifetimes added {steps} VM steps to admission"
            );
        }
    }

    #[test]
    fn only_proven_host_death_reaps_a_disconnected_history_lifetime() {
        let profile = tempfile::tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(profile.path()).expect("Store");
        kernel.writer().call(|connection| with_immediate_transaction(connection, |transaction| {
            transaction.execute_batch("INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile', 'now', 'now');
                INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library', 'profile', 'now', 'now');
                INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) VALUES (1, 'epoch', 'now', 'now');")?;
            let context = BoundModuleContext { profile_id: ProfileId("profile".into()), library_id: LibraryId("library".into()), project_id: None,
                connection_id: "temporary-connection".into(), adapter: AdapterKind::ElectronHost,
                editor_history_owner: Some(BoundEditorHistoryOwner { id: "surface".into(), peer_pid: 42 }) };
            require_active(transaction, &context, "epoch")?;
            transaction.execute_batch("INSERT INTO editor_history_local_sets VALUES ('surface', 'local', '', 'former-document', 1, 1, 'hash', 0, 1);
                INSERT INTO editor_history_local_roots VALUES ('surface', 'local', 'retained-block');
                INSERT INTO editor_history_local_sets VALUES ('surface', 'closing-local', '', 'former-document', 1, 1, 'hash', 0, 1);
                INSERT INTO editor_history_local_roots VALUES ('surface', 'closing-local', 'other-retained-block');")?;
            let close_id = crate::domain::identity::random_uuid_v7().expect("close identity");
            let closed = super::super::local_history_retention::apply(transaction, &context, &close_id, "epoch", &sha256(b"close-local"), &nodex_core_contracts::library::LibraryLocalHistoryRetention {
                surface_id: "closing-local".into(), document_id: "former-document".into(), generation: 1, revision: 2, block_ids: vec![], retain_document: false, closed: true,
            })?;
            assert!(!closed.committed.receipt.did_mutate);
            assert_eq!(transaction.query_row("SELECT count(*) FROM editor_history_local_roots", [], |row| row.get::<_, i64>(0))?, 1);
            assert_eq!(reap(transaction, "profile", "library", 0, |_| true)?.0, 0);
            let mut reconnected = context.clone();
            reconnected.connection_id = "new-connection".into();
            require_active(transaction, &reconnected, "epoch")?;
            let mut impostor = context.clone();
            impostor.editor_history_owner.as_mut().unwrap().peer_pid = 43;
            assert!(require_active(transaction, &impostor, "epoch").is_err());
            assert_eq!(reap(transaction, "profile", "library", 0, |_| false)?.0, 1);
            assert!(!drain_cleanup(transaction, "profile", "library")?.pending);
            assert_eq!(reap(transaction, "profile", "library", 0, |_| false)?.0, 1);
            let remaining: i64 = transaction.query_row("SELECT count(*) FROM editor_history_owners", [], |row| row.get(0))?;
            assert_eq!(remaining, 0);
            assert_eq!(transaction.query_row("SELECT count(*) FROM editor_history_local_roots", [], |row| row.get::<_, i64>(0))?, 0);
            Ok(())
        })).expect("liveness contract");
    }

    #[test]
    fn closing_before_the_first_write_fences_late_registration() {
        let mut connection = Connection::open_in_memory().expect("Store");
        crate::infrastructure::schema::install_current_schema(&mut connection).expect("schema");
        connection.execute_batch("INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile', 'now', 'now');
            INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library', 'profile', 'now', 'now');").expect("Library");
        let context = BoundModuleContext {
            profile_id: ProfileId("profile".into()),
            library_id: LibraryId("library".into()),
            project_id: None,
            connection_id: "connection".into(),
            adapter: AdapterKind::ElectronHost,
            editor_history_owner: Some(BoundEditorHistoryOwner {
                id: "closed".into(),
                peer_pid: 42,
            }),
        };
        assert!(!bind_owner(&connection, &context, "epoch", "closed").expect("closed marker"));
        assert!(require_active(&connection, &context, "epoch").is_err());
        assert!(!bind_owner(&connection, &context, "epoch", "closed").expect("idempotent close"));
    }

    #[test]
    fn cleanup_rotates_past_live_hosts_and_bounds_each_release_batch() {
        let profile = tempfile::tempdir().expect("Profile");
        let kernel = SqliteStoreKernel::open_test(profile.path()).expect("Store");
        kernel.writer().call(|connection| with_immediate_transaction(connection, |transaction| {
            transaction.execute_batch("INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile', 'now', 'now');
                INSERT INTO libraries(id, profile_id, created_at, updated_at) VALUES ('library', 'profile', 'now', 'now');
                INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) VALUES (1, 'epoch', 'now', 'now');")?;
            // Closed markers also need collection, and can outnumber active
            // owners. Keep a full scan batch of live Hosts ahead of dead ones.
            for pid in 1..=1026 {
                transaction.execute("INSERT INTO editor_history_owners(owner_id, library_id, store_epoch, peer_pid, state) VALUES (?1, 'library', 'epoch', ?2, 'closed')", params![format!("host-{pid}"), pid])?;
            }
            for index in 0..150 {
                transaction.execute("INSERT INTO editor_history_owners(owner_id, library_id, store_epoch, peer_pid, state) VALUES (?1, 'library', 'epoch', 1025, 'closed')", [format!("extra-{index}")])?;
            }
            let (released, cursor) = reap(transaction, "profile", "library", 0, |pid| pid <= 1024)?;
            assert_eq!((released, cursor), (0, 1024));
            let (released, cursor) = reap(transaction, "profile", "library", cursor, |pid| pid <= 1024)?;
            assert_eq!((released, cursor), (100, 1025));
            let (released, cursor) = reap(transaction, "profile", "library", cursor, |pid| pid <= 1024)?;
            assert_eq!((released, cursor), (1, 0));
            let (_, cursor) = reap(transaction, "profile", "library", cursor, |pid| pid <= 1024)?;
            let (released, _) = reap(transaction, "profile", "library", cursor, |pid| pid <= 1024)?;
            assert_eq!(released, 51);
            assert_eq!(transaction.query_row("SELECT count(*) FROM editor_history_owners WHERE peer_pid > 1024", [], |row| row.get::<_, i64>(0))?, 0);
            Ok(())
        })).expect("fair cleanup");
    }
}
