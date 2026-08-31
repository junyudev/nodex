use std::collections::BTreeSet;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use nodex_core_contracts::workspace::{
    CodexThreadActiveFlag, CodexThreadStatusType, ProjectWorkspaceSubagentLifecycle,
    ProjectWorkspaceSubagentLifecycleAction, ProjectWorkspaceSubagentLifecycleMember,
    ProjectWorkspaceSubagentLifecycleObservation, ProjectWorkspaceSubagentLifecycleOutcome,
    ProjectWorkspaceSubagentObservation, ProjectWorkspaceSubagentOverview,
    ProjectWorkspaceSubagentOverviewItem, ProjectWorkspaceSubagentStatus,
    ProjectWorkspaceSubagentStatusEvidence, ProjectWorkspaceSubagentStatusEvidenceKind,
    ProjectWorkspaceSubagentStatusEvidencePrecondition, ProjectWorkspaceSubagentUniverse,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::document::sha256;
use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::ProjectWorkspaceApplyOutcome;
use super::mutation::finish_no_op;
use super::session_mutation::sqlite_now;
use super::thread::{self, finish_thread_mutation};

const MAX_DISCOVERY_PAGE_ITEMS: usize = 200;
const MAX_LIFECYCLE_OBSERVATIONS: usize = 100;
const MAX_LIFECYCLE_BATCH_ITEMS: usize = 100;
const MAX_PENDING_STATUS_EVIDENCE: i64 = 4_096;
const MAX_CONTINUATION_BYTES: usize = 512 * 1_024;
const MAX_REASON_BYTES: usize = 4_096;

#[allow(clippy::too_many_arguments)]
pub(super) fn observe_discovery_page(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    universe: &ProjectWorkspaceSubagentUniverse,
    page_identity: &str,
    observations: &[ProjectWorkspaceSubagentObservation],
    continuation: Option<&str>,
    complete: bool,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_universe(universe)?;
    validate_identity("page_identity", page_identity)?;
    validate_continuation(continuation)?;
    if complete && continuation.is_some() {
        return Err(invalid(
            "A complete Subagent discovery page cannot retain a continuation",
        ));
    }
    if observations.len() > MAX_DISCOVERY_PAGE_ITEMS {
        return Err(invalid("Subagent discovery page exceeds its Core bound"));
    }
    require_thread_in_library(connection, library_id, &universe.root_thread_id)?;

    let unique = observations
        .iter()
        .map(|observation| observation.thread_id.as_str())
        .collect::<BTreeSet<_>>();
    if unique.len() != observations.len() {
        return Err(invalid(
            "Subagent discovery page contains duplicate Threads",
        ));
    }
    for observation in observations {
        validate_observation(universe, observation)?;
    }

    let page_payload = serde_json::to_vec(&(
        universe,
        page_identity,
        observations,
        continuation,
        complete,
    ))
    .map_err(|_| internal("Subagent discovery page cannot be fingerprinted"))?;
    let page_hash = sha256(&page_payload);
    let existing_hash = connection
        .query_row(
            "SELECT page_hash FROM workspace_subagent_discovery_pages
             WHERE host_id = ?1 AND source_epoch = ?2 AND generation = ?3
               AND root_thread_id = ?4 AND page_identity = ?5",
            params![
                universe.host_id,
                universe.source_epoch,
                universe.generation,
                universe.root_thread_id,
                page_identity,
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(existing_hash) = existing_hash {
        if existing_hash != page_hash {
            return Err(conflict(
                "Subagent discovery page identity is already bound to another payload",
            ));
        }
        return finish_no_op(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "observe_subagent_discovery_page",
            Vec::new(),
            Vec::new(),
            &sqlite_now(connection)?,
        );
    }

    let now = sqlite_now(connection)?;
    let inserted_universe = connection.execute(
        "INSERT INTO workspace_subagent_universes(
           host_id, source_epoch, generation, root_thread_id,
           discovery_continuation, discovery_complete, observed_page_count, updated_at
         ) VALUES (?1, ?2, ?3, ?4, NULL, 0, 0, ?5)
         ON CONFLICT(host_id, source_epoch, generation, root_thread_id) DO NOTHING",
        params![
            universe.host_id,
            universe.source_epoch,
            universe.generation,
            universe.root_thread_id,
            now,
        ],
    )?;
    if inserted_universe > 0 {
        // Endpoint epochs are fencing coordinates, not graph reset signals. Carry the newest
        // durable positive closure forward before applying fresh observations so a cold root tail
        // plus a stale/empty state DB cannot erase older descendants.
        connection.execute(
            "WITH prior AS (
               SELECT source_epoch, generation
               FROM workspace_subagent_universes
               WHERE host_id = ?1 AND root_thread_id = ?2
                 AND NOT (source_epoch = ?3 AND generation = ?4)
               ORDER BY updated_at DESC, source_epoch DESC, generation DESC LIMIT 1
             )
             INSERT INTO workspace_subagent_descendants(
               host_id, source_epoch, generation, root_thread_id, thread_id,
               parent_thread_id, first_seen_page_identity, observed_at
             )
             SELECT ?1, ?3, ?4, ?2, inherited.thread_id, inherited.parent_thread_id,
               inherited.first_seen_page_identity, ?5
             FROM workspace_subagent_descendants AS inherited
             JOIN prior ON prior.source_epoch = inherited.source_epoch
               AND prior.generation = inherited.generation
             WHERE inherited.host_id = ?1 AND inherited.root_thread_id = ?2",
            params![
                universe.host_id,
                universe.root_thread_id,
                universe.source_epoch,
                universe.generation,
                now,
            ],
        )?;
        connection.execute(
            "WITH prior AS (
               SELECT source_epoch, generation
               FROM workspace_subagent_universes
               WHERE host_id = ?1 AND root_thread_id = ?2
                 AND NOT (source_epoch = ?3 AND generation = ?4)
               ORDER BY updated_at DESC, source_epoch DESC, generation DESC LIMIT 1
             )
             INSERT INTO workspace_subagent_status_evidence(
               host_id, source_epoch, generation, root_thread_id, thread_id, status,
               evidence_kind, source_revision, observed_at_ms, updated_at
             )
             SELECT ?1, ?3, ?4, ?2, inherited.thread_id,
               CASE
                 WHEN evidence.evidence_kind IN ('completion', 'reconciliation')
                   THEN COALESCE(evidence.status, 'done')
                 ELSE 'unknown'
               END,
               CASE
                 WHEN evidence.evidence_kind IN ('completion', 'reconciliation')
                   THEN evidence.evidence_kind
                 ELSE 'metadata'
               END,
               0, 0, ?5
             FROM workspace_subagent_descendants AS inherited
             JOIN prior ON prior.source_epoch = inherited.source_epoch
               AND prior.generation = inherited.generation
             LEFT JOIN workspace_subagent_status_evidence AS evidence
               ON evidence.host_id = inherited.host_id
              AND evidence.source_epoch = inherited.source_epoch
              AND evidence.generation = inherited.generation
              AND evidence.root_thread_id = inherited.root_thread_id
              AND evidence.thread_id = inherited.thread_id
             WHERE inherited.host_id = ?1 AND inherited.root_thread_id = ?2",
            params![
                universe.host_id,
                universe.root_thread_id,
                universe.source_epoch,
                universe.generation,
                now,
            ],
        )?;
    }

    let mut project_ids = BTreeSet::new();
    let mut session_ids = BTreeSet::new();
    let mut session_summary_scopes = Vec::new();
    let mut affected_thread_ids = Vec::with_capacity(observations.len());
    for observation in observations {
        let metadata_status = observation
            .patch
            .status
            .as_ref()
            .map(|status| normalize_metadata_status(status.status_type, &status.active_flags));
        let patch = observational_patch(connection, universe, observation)?;
        let effects =
            thread::upsert_thread_records(connection, library_id, &observation.thread_id, &patch)?;
        project_ids.extend(effects.project_ids);
        session_ids.extend(effects.session_ids);
        for scope in effects.session_summary_scopes {
            if !session_summary_scopes.contains(&scope) {
                session_summary_scopes.push(scope);
            }
        }
        connection.execute(
            "INSERT INTO workspace_subagent_descendants(
               host_id, source_epoch, generation, root_thread_id, thread_id,
               parent_thread_id, first_seen_page_identity, observed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(host_id, source_epoch, generation, root_thread_id, thread_id)
             DO UPDATE SET observed_at = excluded.observed_at
             WHERE workspace_subagent_descendants.parent_thread_id = excluded.parent_thread_id",
            params![
                universe.host_id,
                universe.source_epoch,
                universe.generation,
                universe.root_thread_id,
                observation.thread_id,
                observation.parent_thread_id,
                page_identity,
                now,
            ],
        )?;
        let stored_parent = connection.query_row(
            "SELECT parent_thread_id FROM workspace_subagent_descendants
             WHERE host_id = ?1 AND source_epoch = ?2 AND generation = ?3
               AND root_thread_id = ?4 AND thread_id = ?5",
            params![
                universe.host_id,
                universe.source_epoch,
                universe.generation,
                universe.root_thread_id,
                observation.thread_id,
            ],
            |row| row.get::<_, String>(0),
        )?;
        if stored_parent != observation.parent_thread_id {
            return Err(conflict(
                "A positive Subagent fact cannot change parent within one universe",
            ));
        }
        if let Some(status) = metadata_status {
            observe_status_evidence_records(
                connection,
                universe,
                &observation.thread_id,
                status,
                ProjectWorkspaceSubagentStatusEvidenceKind::Metadata,
                observation.source_revision,
                observation.observed_at_ms,
                &now,
            )?;
        }
        consume_pending_status_evidence(
            connection,
            library_id,
            universe,
            &observation.thread_id,
            &now,
        )?;
        affected_thread_ids.push(observation.thread_id.clone());
    }
    if complete {
        require_complete_reachable_closure(connection, universe)?;
    }

    connection.execute(
        "INSERT INTO workspace_subagent_discovery_pages(
           host_id, source_epoch, generation, root_thread_id, page_identity,
           page_hash, continuation, complete, observed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            universe.host_id,
            universe.source_epoch,
            universe.generation,
            universe.root_thread_id,
            page_identity,
            page_hash,
            continuation,
            i64::from(complete),
            now,
        ],
    )?;
    connection.execute(
        "UPDATE workspace_subagent_universes SET
           discovery_continuation = CASE
             WHEN ?1 IS NULL AND ?2 = 0 AND discovery_complete = 0
               AND discovery_continuation IS NOT NULL
             THEN discovery_continuation
             ELSE ?1
           END,
           discovery_complete = ?2,
           observed_page_count = observed_page_count + 1,
           updated_at = ?3
         WHERE host_id = ?4 AND source_epoch = ?5 AND generation = ?6
           AND root_thread_id = ?7",
        params![
            continuation,
            i64::from(complete),
            now,
            universe.host_id,
            universe.source_epoch,
            universe.generation,
            universe.root_thread_id,
        ],
    )?;
    if complete {
        // A complete universe is the only current authority for one physical host/root pair.
        // Lifecycle closures are copied into their own durable member table, so superseded
        // projection rows can be cascaded away without weakening archive/delete recovery.
        connection.execute(
            "DELETE FROM workspace_subagent_universes
             WHERE host_id = ?1 AND root_thread_id = ?2
               AND NOT (source_epoch = ?3 AND generation = ?4)",
            params![
                universe.host_id,
                universe.root_thread_id,
                universe.source_epoch,
                universe.generation,
            ],
        )?;
    } else {
        // Repeated failed/incomplete scans across fresh Endpoint incarnations must also remain
        // bounded. Keep the current authority plus only the newest prior incomplete universe;
        // lifecycle closures are stored independently and are never pruned here.
        connection.execute(
            "DELETE FROM workspace_subagent_universes AS candidate
             WHERE candidate.host_id = ?1 AND candidate.root_thread_id = ?2
               AND NOT (candidate.source_epoch = ?3 AND candidate.generation = ?4)
               AND NOT EXISTS (
                 SELECT 1 FROM (
                   SELECT retained.source_epoch, retained.generation
                   FROM workspace_subagent_universes AS retained
                   WHERE retained.host_id = ?1 AND retained.root_thread_id = ?2
                     AND NOT (retained.source_epoch = ?3 AND retained.generation = ?4)
                   ORDER BY retained.updated_at DESC, retained.source_epoch DESC,
                     retained.generation DESC
                   LIMIT 1
                 ) AS newest_prior
                 WHERE newest_prior.source_epoch = candidate.source_epoch
                   AND newest_prior.generation = candidate.generation
               )",
            params![
                universe.host_id,
                universe.root_thread_id,
                universe.source_epoch,
                universe.generation,
            ],
        )?;
    }

    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "observe_subagent_discovery_page",
        session_summary_scopes,
        project_ids.into_iter().collect(),
        session_ids.into_iter().collect(),
        affected_thread_ids,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn observe_status_evidence(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    universe: &ProjectWorkspaceSubagentUniverse,
    thread_id: &str,
    status: ProjectWorkspaceSubagentStatus,
    evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind,
    source_revision: i64,
    observed_at_ms: i64,
    precondition: Option<&ProjectWorkspaceSubagentStatusEvidencePrecondition>,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_universe(universe)?;
    validate_identity("thread_id", thread_id)?;
    require_thread_in_library(connection, library_id, &universe.root_thread_id)?;
    require_descendant(connection, universe, thread_id)?;
    let current = connection
        .query_row(
            "SELECT evidence_kind, source_revision, observed_at_ms
             FROM workspace_subagent_status_evidence
             WHERE host_id = ?1 AND source_epoch = ?2 AND generation = ?3
               AND root_thread_id = ?4 AND thread_id = ?5",
            params![
                universe.host_id,
                universe.source_epoch,
                universe.generation,
                universe.root_thread_id,
                thread_id,
            ],
            |row| {
                Ok((
                    parse_evidence_kind_row(&row.get::<_, String>(0)?)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let precondition_matches = precondition.is_none_or(|precondition| match precondition {
        ProjectWorkspaceSubagentStatusEvidencePrecondition::Absent => current.is_none(),
        ProjectWorkspaceSubagentStatusEvidencePrecondition::Exact {
            evidence_kind,
            source_revision,
            observed_at_ms,
        } => current.as_ref() == Some(&(*evidence_kind, *source_revision, *observed_at_ms)),
    });
    if !precondition_matches {
        return finish_no_op(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "observe_subagent_status_evidence",
            Vec::new(),
            Vec::new(),
            &sqlite_now(connection)?,
        );
    }
    let now = sqlite_now(connection)?;
    observe_status_evidence_records(
        connection,
        universe,
        thread_id,
        status,
        evidence_kind,
        source_revision,
        observed_at_ms,
        &now,
    )?;
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "observe_subagent_status_evidence",
        Vec::new(),
        Vec::new(),
        Vec::new(),
        vec![thread_id.to_owned()],
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn buffer_status_evidence(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    host_id: &str,
    source_epoch: &str,
    generation: i64,
    thread_id: &str,
    status: ProjectWorkspaceSubagentStatus,
    evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind,
    source_revision: i64,
    observed_at_ms: i64,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_identity("host_id", host_id)?;
    validate_identity("source_epoch", source_epoch)?;
    validate_identity("thread_id", thread_id)?;
    validate_status_coordinates(status, evidence_kind, source_revision, observed_at_ms)?;
    if generation < 0 {
        return Err(invalid("Subagent evidence generation must be non-negative"));
    }
    if evidence_kind == ProjectWorkspaceSubagentStatusEvidenceKind::Metadata {
        return Err(invalid(
            "Pending Subagent evidence must come from a runtime observation",
        ));
    }

    let existing = connection
        .query_row(
            "SELECT status, evidence_kind, source_revision, observed_at_ms
             FROM workspace_subagent_pending_status_evidence
             WHERE library_id = ?1 AND host_id = ?2 AND source_epoch = ?3
               AND generation = ?4 AND thread_id = ?5",
            params![library_id, host_id, source_epoch, generation, thread_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    let changed = should_replace_status_evidence(
        existing.as_ref(),
        status,
        evidence_kind,
        source_revision,
        observed_at_ms,
    );
    let now = sqlite_now(connection)?;
    if changed {
        connection.execute(
            "INSERT INTO workspace_subagent_pending_status_evidence(
               library_id, host_id, source_epoch, generation, thread_id, status,
               evidence_kind, source_revision, observed_at_ms, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(library_id, host_id, source_epoch, generation, thread_id)
             DO UPDATE SET status = excluded.status, evidence_kind = excluded.evidence_kind,
               source_revision = excluded.source_revision,
               observed_at_ms = excluded.observed_at_ms, updated_at = excluded.updated_at",
            params![
                library_id,
                host_id,
                source_epoch,
                generation,
                thread_id,
                status_literal(status),
                evidence_kind_literal(evidence_kind),
                source_revision,
                observed_at_ms,
                now,
            ],
        )?;
        connection.execute(
            "DELETE FROM workspace_subagent_pending_status_evidence
             WHERE library_id = ?1
               AND (host_id, source_epoch, generation, thread_id) IN (
                 SELECT host_id, source_epoch, generation, thread_id
                 FROM workspace_subagent_pending_status_evidence
                 WHERE library_id = ?1
                 ORDER BY observed_at_ms DESC, source_revision DESC, updated_at DESC,
                   host_id DESC, source_epoch DESC, generation DESC, thread_id DESC
                 LIMIT -1 OFFSET ?2
               )",
            params![library_id, MAX_PENDING_STATUS_EVIDENCE],
        )?;
    }
    finish_no_op(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "buffer_subagent_status_evidence",
        Vec::new(),
        Vec::new(),
        &now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn begin_lifecycle(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    universe: &ProjectWorkspaceSubagentUniverse,
    lifecycle_operation_id: &str,
    action: ProjectWorkspaceSubagentLifecycleAction,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_universe(universe)?;
    validate_identity("lifecycle_operation_id", lifecycle_operation_id)?;
    let action_literal = lifecycle_action_literal(action);
    let existing = connection
        .query_row(
            "SELECT operation.library_id, operation.host_id, operation.root_thread_id,
               operation.action,
               EXISTS(
                 SELECT 1 FROM workspace_subagent_lifecycle_members member
                 WHERE member.lifecycle_operation_id = operation.lifecycle_operation_id
                   AND member.outcome <> 'settled'
               ),
               COALESCE((
                 SELECT thread.archived FROM codex_threads thread
                 WHERE thread.thread_id = operation.root_thread_id
               ), 1)
             FROM workspace_subagent_lifecycle_operations operation
             WHERE operation.lifecycle_operation_id = ?1",
            [lifecycle_operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)? != 0,
                    row.get::<_, i64>(5)? != 0,
                ))
            },
        )
        .optional()?;
    let mut refresh_completed_archive_attempt = false;
    if let Some(existing) = existing {
        let expected = (
            library_id.to_owned(),
            universe.host_id.clone(),
            universe.root_thread_id.clone(),
            action_literal.to_owned(),
        );
        if (existing.0, existing.1, existing.2, existing.3) != expected {
            return Err(conflict(
                "Subagent lifecycle operation identity is already bound to another closure",
            ));
        }
        refresh_completed_archive_attempt = action
            == ProjectWorkspaceSubagentLifecycleAction::Archive
            && !existing.4
            && !existing.5;
        if !refresh_completed_archive_attempt {
            return finish_no_op(
                connection,
                context,
                store_epoch,
                operation_id,
                request_hash,
                "begin_subagent_lifecycle",
                Vec::new(),
                Vec::new(),
                &sqlite_now(connection)?,
            );
        }
    }
    require_thread_in_library(connection, library_id, &universe.root_thread_id)?;
    let discovery_complete = connection
        .query_row(
            "SELECT discovery_complete FROM workspace_subagent_universes
             WHERE host_id = ?1 AND source_epoch = ?2 AND generation = ?3
               AND root_thread_id = ?4",
            params![
                universe.host_id,
                universe.source_epoch,
                universe.generation,
                universe.root_thread_id,
            ],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if discovery_complete != Some(1) {
        return Err(conflict(
            "Subagent lifecycle closure requires a complete discovery universe",
        ));
    }
    let now = sqlite_now(connection)?;
    if refresh_completed_archive_attempt {
        connection.execute(
            "DELETE FROM workspace_subagent_lifecycle_members
             WHERE lifecycle_operation_id = ?1",
            [lifecycle_operation_id],
        )?;
        connection.execute(
            "UPDATE workspace_subagent_lifecycle_operations
             SET source_epoch = ?2, generation = ?3, updated_at = ?4
             WHERE lifecycle_operation_id = ?1",
            params![
                lifecycle_operation_id,
                universe.source_epoch,
                universe.generation,
                now,
            ],
        )?;
    } else {
        connection.execute(
            "INSERT INTO workspace_subagent_lifecycle_operations(
               lifecycle_operation_id, library_id, host_id, source_epoch, generation,
               root_thread_id, action, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                lifecycle_operation_id,
                library_id,
                universe.host_id,
                universe.source_epoch,
                universe.generation,
                universe.root_thread_id,
                action_literal,
                now,
            ],
        )?;
    }
    connection.execute(
        "WITH RECURSIVE reachable(thread_id) AS (
           SELECT ?5
           UNION
           SELECT child.thread_id
           FROM workspace_subagent_descendants child
           JOIN reachable parent ON child.parent_thread_id = parent.thread_id
           WHERE child.host_id = ?1 AND child.source_epoch = ?2
             AND child.generation = ?3 AND child.root_thread_id = ?4
         ), expected(thread_id) AS (
           SELECT thread_id FROM reachable
           UNION
           SELECT member.thread_id
           FROM workspace_subagent_lifecycle_operations prior_operation
           JOIN workspace_subagent_lifecycle_members member
             ON member.lifecycle_operation_id = prior_operation.lifecycle_operation_id
           WHERE ?7 = 'delete' AND prior_operation.library_id = ?8
             AND prior_operation.host_id = ?1 AND prior_operation.root_thread_id = ?4
             AND prior_operation.action = 'archive'
         )
         INSERT INTO workspace_subagent_lifecycle_members(
           lifecycle_operation_id, thread_id, outcome, attempt_count
         )
         SELECT ?6, thread_id, 'pending', 0 FROM expected ORDER BY thread_id",
        params![
            universe.host_id,
            universe.source_epoch,
            universe.generation,
            universe.root_thread_id,
            universe.root_thread_id,
            lifecycle_operation_id,
            action_literal,
            library_id,
        ],
    )?;
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "begin_subagent_lifecycle",
        Vec::new(),
        Vec::new(),
        Vec::new(),
        vec![universe.root_thread_id.clone()],
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn observe_lifecycle_outcomes(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    lifecycle_operation_id: &str,
    observations: &[ProjectWorkspaceSubagentLifecycleObservation],
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_identity("lifecycle_operation_id", lifecycle_operation_id)?;
    if observations.is_empty() || observations.len() > MAX_LIFECYCLE_OBSERVATIONS {
        return Err(invalid(
            "Subagent lifecycle observation batch must contain between 1 and 100 members",
        ));
    }
    let unique = observations
        .iter()
        .map(|observation| observation.thread_id.as_str())
        .collect::<BTreeSet<_>>();
    if unique.len() != observations.len() {
        return Err(invalid(
            "Subagent lifecycle observation batch contains duplicate Threads",
        ));
    }
    connection
        .query_row(
            "SELECT 1 FROM workspace_subagent_lifecycle_operations
             WHERE lifecycle_operation_id = ?1 AND library_id = ?2",
            params![lifecycle_operation_id, library_id],
            |_| Ok(()),
        )
        .optional()?
        .ok_or_else(|| not_found("Subagent lifecycle operation is unavailable"))?;

    let mut affected_thread_ids = Vec::with_capacity(observations.len());
    for observation in observations {
        validate_identity("thread_id", &observation.thread_id)?;
        if observation.outcome == ProjectWorkspaceSubagentLifecycleOutcome::Pending {
            return Err(invalid("Pending is not an observed lifecycle outcome"));
        }
        if observation.observed_at_ms < 0 {
            return Err(invalid("Lifecycle observed_at_ms must be non-negative"));
        }
        if observation
            .reason
            .as_ref()
            .is_some_and(|reason| reason.len() > MAX_REASON_BYTES)
        {
            return Err(invalid("Lifecycle failure reason exceeds its Core bound"));
        }
        let current = connection
            .query_row(
                "SELECT outcome, observed_at_ms
                 FROM workspace_subagent_lifecycle_members
                 WHERE lifecycle_operation_id = ?1 AND thread_id = ?2",
                params![lifecycle_operation_id, observation.thread_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
            )
            .optional()?
            .ok_or_else(|| not_found("Thread is outside the lifecycle expected closure"))?;
        let incoming_is_settled =
            observation.outcome == ProjectWorkspaceSubagentLifecycleOutcome::Settled;
        let should_update = current.0 != "settled"
            && (incoming_is_settled
                || current
                    .1
                    .is_none_or(|observed_at_ms| observation.observed_at_ms >= observed_at_ms));
        if should_update {
            connection.execute(
                "UPDATE workspace_subagent_lifecycle_members SET
                   outcome = ?1, attempt_count = attempt_count + 1,
                   last_reason = ?2, observed_at_ms = ?3
                 WHERE lifecycle_operation_id = ?4 AND thread_id = ?5",
                params![
                    lifecycle_outcome_literal(observation.outcome),
                    observation.reason,
                    observation.observed_at_ms,
                    lifecycle_operation_id,
                    observation.thread_id,
                ],
            )?;
        }
        affected_thread_ids.push(observation.thread_id.clone());
    }
    connection.execute(
        "UPDATE workspace_subagent_lifecycle_operations SET updated_at = ?1
         WHERE lifecycle_operation_id = ?2",
        params![sqlite_now(connection)?, lifecycle_operation_id],
    )?;
    finish_thread_mutation(
        connection,
        library_id,
        context,
        store_epoch,
        operation_id,
        request_hash,
        "observe_subagent_lifecycle_outcomes",
        Vec::new(),
        Vec::new(),
        Vec::new(),
        affected_thread_ids,
    )
}

pub(super) fn read_overview(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    universe: &ProjectWorkspaceSubagentUniverse,
    active_window: &CollectionWindowRequest,
    done_window: &CollectionWindowRequest,
) -> Result<ProjectWorkspaceSubagentOverview, StoreError> {
    validate_universe(universe)?;
    require_thread_in_library(connection, library_id, &universe.root_thread_id)?;
    let discovery = connection
        .query_row(
            "SELECT discovery_complete, discovery_continuation
             FROM workspace_subagent_universes
             WHERE host_id = ?1 AND source_epoch = ?2 AND generation = ?3
               AND root_thread_id = ?4",
            params![
                universe.host_id,
                universe.source_epoch,
                universe.generation,
                universe.root_thread_id,
            ],
            |row| Ok((row.get::<_, i64>(0)? == 1, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?
        .unwrap_or((false, None));
    let (known_active_count, known_done_count) = overview_counts(connection, library_id, universe)?;
    Ok(ProjectWorkspaceSubagentOverview {
        universe: universe.clone(),
        active: read_overview_lane(
            connection,
            library_id,
            commit_head,
            universe,
            "active",
            active_window,
        )?,
        done: read_overview_lane(
            connection,
            library_id,
            commit_head,
            universe,
            "done",
            done_window,
        )?,
        known_active_count,
        known_done_count,
        discovery_complete: discovery.0,
        discovery_continuation: discovery.1,
        projection_revision: commit_head,
    })
}

pub(super) fn read_overview_item(
    connection: &Connection,
    library_id: &str,
    universe: &ProjectWorkspaceSubagentUniverse,
    thread_id: &str,
) -> Result<Option<ProjectWorkspaceSubagentOverviewItem>, StoreError> {
    validate_universe(universe)?;
    validate_identity("thread_id", thread_id)?;
    let sql = format!(
        "SELECT {},
           COALESCE(evidence.status, 'unknown') AS subagent_status,
           evidence.evidence_kind AS subagent_evidence_kind,
           evidence.source_revision AS subagent_source_revision,
           evidence.observed_at_ms AS subagent_observed_at_ms
         FROM workspace_subagent_descendants descendant
         JOIN codex_threads thread ON thread.thread_id = descendant.thread_id
         LEFT JOIN project_session_threads link ON link.thread_id = thread.thread_id
         LEFT JOIN projects project ON project.id = thread.project_id
         LEFT JOIN workspace_subagent_status_evidence evidence
           ON evidence.host_id = descendant.host_id
          AND evidence.source_epoch = descendant.source_epoch
          AND evidence.generation = descendant.generation
          AND evidence.root_thread_id = descendant.root_thread_id
          AND evidence.thread_id = descendant.thread_id
         WHERE descendant.host_id = ?1 AND descendant.source_epoch = ?2
           AND descendant.generation = ?3 AND descendant.root_thread_id = ?4
           AND descendant.thread_id = ?5
           AND (thread.project_id IS NULL OR project.library_id = ?6)",
        super::child_thread_window::THREAD_SUMMARY_COLUMNS,
    );
    connection
        .query_row(
            &sql,
            params![
                universe.host_id,
                universe.source_epoch,
                universe.generation,
                universe.root_thread_id,
                thread_id,
                library_id,
            ],
            |row| {
                let status = parse_status_row(&row.get::<_, String>("subagent_status")?)?;
                let evidence_kind = row.get::<_, Option<String>>("subagent_evidence_kind")?;
                Ok(ProjectWorkspaceSubagentOverviewItem {
                    thread: super::child_thread_window::thread_summary_row(row)?,
                    status,
                    evidence: evidence_kind
                        .map(|kind| -> rusqlite::Result<_> {
                            Ok(ProjectWorkspaceSubagentStatusEvidence {
                                kind: parse_evidence_kind_row(&kind)?,
                                source_revision: row.get("subagent_source_revision")?,
                                observed_at_ms: row.get("subagent_observed_at_ms")?,
                            })
                        })
                        .transpose()?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn read_lifecycle_batch(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    lifecycle_operation_id: &str,
    include_settled: bool,
    request: &CollectionWindowRequest,
) -> Result<ProjectWorkspaceSubagentLifecycle, StoreError> {
    validate_identity("lifecycle_operation_id", lifecycle_operation_id)?;
    let (universe, action) = connection
        .query_row(
            "SELECT host_id, source_epoch, generation, root_thread_id, action
             FROM workspace_subagent_lifecycle_operations
             WHERE lifecycle_operation_id = ?1 AND library_id = ?2",
            params![lifecycle_operation_id, library_id],
            |row| {
                Ok((
                    ProjectWorkspaceSubagentUniverse {
                        host_id: row.get(0)?,
                        source_epoch: row.get(1)?,
                        generation: row.get(2)?,
                        root_thread_id: row.get(3)?,
                    },
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Subagent lifecycle operation is unavailable"))?;
    let action = parse_lifecycle_action(&action)?;
    let normalized = normalize_request(request)?;
    if normalized.first > MAX_LIFECYCLE_BATCH_ITEMS {
        return Err(invalid("Subagent lifecycle batch exceeds 100 members"));
    }
    let fingerprint =
        cursor::query_fingerprint(&("workspace_subagent_lifecycle_v1", lifecycle_operation_id))?;
    let subject = CollectionCursorSubject {
        kind: "workspace_subagent_lifecycle",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || !coordinate.values.is_empty() {
                return Err(invalid("Subagent lifecycle cursor is incompatible"));
            }
            Ok(coordinate.stable_id)
        })
        .transpose()?;
    let rows = connection
        .prepare(
            "SELECT thread_id, outcome, attempt_count, last_reason, observed_at_ms
             FROM workspace_subagent_lifecycle_members
             WHERE lifecycle_operation_id = ?1 AND (?2 OR outcome <> 'settled')
               AND (?3 IS NULL OR thread_id > ?3)
             ORDER BY thread_id LIMIT ?4",
        )?
        .query_map(
            params![
                lifecycle_operation_id,
                include_settled,
                after,
                i64::try_from(normalized.first + 1)
                    .map_err(|_| invalid("Lifecycle batch size is invalid"))?,
            ],
            |row| {
                Ok(ProjectWorkspaceSubagentLifecycleMember {
                    thread_id: row.get(0)?,
                    outcome: parse_lifecycle_outcome_row(&row.get::<_, String>(1)?)?,
                    attempt_count: row.get(2)?,
                    last_reason: row.get(3)?,
                    observed_at_ms: row.get(4)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let members = assemble(
        rows.into_iter().map(|item| WindowCandidate {
            coordinate: KeysetCoordinate {
                values: Vec::new(),
                stable_id: item.thread_id.clone(),
            },
            item,
        }),
        normalized.first,
        CollectionWindowAuthority {
            projection_revision: commit_head,
        },
        |coordinate| {
            cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )
        },
    )?;
    let (expected_count, processed_count, unresolved_count) = connection.query_row(
        "SELECT count(*),
           COALESCE(sum(CASE WHEN outcome <> 'pending' THEN 1 ELSE 0 END), 0),
           COALESCE(sum(CASE WHEN outcome <> 'settled' THEN 1 ELSE 0 END), 0)
         FROM workspace_subagent_lifecycle_members WHERE lifecycle_operation_id = ?1",
        [lifecycle_operation_id],
        |row| {
            Ok((
                count_u32(row.get::<_, i64>(0)?)?,
                count_u32(row.get::<_, i64>(1)?)?,
                count_u32(row.get::<_, i64>(2)?)?,
            ))
        },
    )?;
    Ok(ProjectWorkspaceSubagentLifecycle {
        universe,
        lifecycle_operation_id: lifecycle_operation_id.to_owned(),
        action,
        members,
        expected_count,
        processed_count,
        unresolved_count,
        complete: unresolved_count == 0,
        projection_revision: commit_head,
    })
}

fn read_overview_lane(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    universe: &ProjectWorkspaceSubagentUniverse,
    lane: &'static str,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<ProjectWorkspaceSubagentOverviewItem>, StoreError> {
    let normalized = normalize_request(request)?;
    let fingerprint =
        cursor::query_fingerprint(&("workspace_subagent_overview_v1", universe, lane))?;
    let subject = CollectionCursorSubject {
        kind: "workspace_subagents",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let coordinate = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 1 {
                return Err(invalid("Subagent overview cursor is incompatible"));
            }
            let [KeysetValue::Integer { value: order_key }] = coordinate.values.as_slice() else {
                return Err(invalid("Subagent overview cursor coordinate is invalid"));
            };
            Ok((*order_key, coordinate.stable_id))
        })
        .transpose()?;
    let mut parameters = vec![
        SqlValue::Text(universe.host_id.clone()),
        SqlValue::Text(universe.source_epoch.clone()),
        SqlValue::Integer(universe.generation),
        SqlValue::Text(universe.root_thread_id.clone()),
        SqlValue::Text(library_id.to_owned()),
        SqlValue::Text(lane.to_owned()),
    ];
    let cursor_predicate = coordinate
        .map(|(order_key, stable_id)| {
            parameters.extend([SqlValue::Integer(order_key), SqlValue::Text(stable_id)]);
            "AND (-thread.recency_at > ?7 OR (-thread.recency_at = ?7 AND thread.thread_id > ?8))"
        })
        .unwrap_or_default();
    parameters.push(SqlValue::Integer(
        i64::try_from(normalized.first + 1)
            .map_err(|_| invalid("Subagent overview size is invalid"))?,
    ));
    let limit_parameter = parameters.len();
    let sql = format!(
        "WITH RECURSIVE reachable(thread_id) AS (
           SELECT descendant.thread_id
           FROM workspace_subagent_descendants descendant
           WHERE descendant.host_id = ?1 AND descendant.source_epoch = ?2
             AND descendant.generation = ?3 AND descendant.root_thread_id = ?4
             AND descendant.parent_thread_id = ?4
           UNION
           SELECT child.thread_id
           FROM workspace_subagent_descendants child
           JOIN reachable parent ON child.parent_thread_id = parent.thread_id
           WHERE child.host_id = ?1 AND child.source_epoch = ?2
             AND child.generation = ?3 AND child.root_thread_id = ?4
         )
         SELECT {},
           COALESCE(evidence.status, 'unknown') AS subagent_status,
           evidence.evidence_kind AS subagent_evidence_kind,
           evidence.source_revision AS subagent_source_revision,
           evidence.observed_at_ms AS subagent_observed_at_ms
         FROM reachable
         JOIN codex_threads thread ON thread.thread_id = reachable.thread_id
         LEFT JOIN project_session_threads link ON link.thread_id = thread.thread_id
         LEFT JOIN projects project ON project.id = thread.project_id
         LEFT JOIN workspace_subagent_status_evidence evidence
           ON evidence.host_id = ?1 AND evidence.source_epoch = ?2
          AND evidence.generation = ?3 AND evidence.root_thread_id = ?4
          AND evidence.thread_id = thread.thread_id
         WHERE (thread.project_id IS NULL OR project.library_id = ?5)
           AND thread.archived = 0
           AND ((?6 = 'done' AND COALESCE(evidence.status, 'unknown') = 'done')
             OR (?6 = 'active' AND COALESCE(evidence.status, 'unknown') <> 'done'))
           {cursor_predicate}
         ORDER BY -thread.recency_at, thread.thread_id LIMIT ?{limit_parameter}",
        super::child_thread_window::THREAD_SUMMARY_COLUMNS,
    );
    let rows = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), |row| {
            let status = parse_status_row(&row.get::<_, String>("subagent_status")?)?;
            let evidence_kind = row.get::<_, Option<String>>("subagent_evidence_kind")?;
            Ok(ProjectWorkspaceSubagentOverviewItem {
                thread: super::child_thread_window::thread_summary_row(row)?,
                status,
                evidence: evidence_kind
                    .map(|kind| -> rusqlite::Result<_> {
                        Ok(ProjectWorkspaceSubagentStatusEvidence {
                            kind: parse_evidence_kind_row(&kind)?,
                            source_revision: row.get("subagent_source_revision")?,
                            observed_at_ms: row.get("subagent_observed_at_ms")?,
                        })
                    })
                    .transpose()?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let candidates = rows
        .into_iter()
        .map(|item| {
            let order_key = item
                .thread
                .recency_at
                .checked_neg()
                .ok_or_else(|| corrupt("Subagent recency timestamp is invalid"))?;
            Ok(WindowCandidate {
                coordinate: KeysetCoordinate {
                    values: vec![KeysetValue::Integer { value: order_key }],
                    stable_id: item.thread.thread_id.clone(),
                },
                item,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    assemble(
        candidates,
        normalized.first,
        CollectionWindowAuthority {
            projection_revision: commit_head,
        },
        |coordinate| {
            cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )
        },
    )
}

fn overview_counts(
    connection: &Connection,
    library_id: &str,
    universe: &ProjectWorkspaceSubagentUniverse,
) -> Result<(u32, u32), StoreError> {
    Ok(connection.query_row(
        "WITH RECURSIVE reachable(thread_id) AS (
           SELECT descendant.thread_id
           FROM workspace_subagent_descendants descendant
           WHERE descendant.host_id = ?1 AND descendant.source_epoch = ?2
             AND descendant.generation = ?3 AND descendant.root_thread_id = ?4
             AND descendant.parent_thread_id = ?4
           UNION
           SELECT child.thread_id
           FROM workspace_subagent_descendants child
           JOIN reachable parent ON child.parent_thread_id = parent.thread_id
           WHERE child.host_id = ?1 AND child.source_epoch = ?2
             AND child.generation = ?3 AND child.root_thread_id = ?4
         )
         SELECT
           COALESCE(sum(CASE WHEN COALESCE(evidence.status, 'unknown') <> 'done' THEN 1 ELSE 0 END), 0),
           COALESCE(sum(CASE WHEN evidence.status = 'done' THEN 1 ELSE 0 END), 0)
         FROM reachable
         JOIN codex_threads thread ON thread.thread_id = reachable.thread_id
         LEFT JOIN projects project ON project.id = thread.project_id
         LEFT JOIN workspace_subagent_status_evidence evidence
           ON evidence.host_id = ?1 AND evidence.source_epoch = ?2
          AND evidence.generation = ?3 AND evidence.root_thread_id = ?4
          AND evidence.thread_id = thread.thread_id
         WHERE (thread.project_id IS NULL OR project.library_id = ?5)
           AND thread.archived = 0",
        params![
            universe.host_id,
            universe.source_epoch,
            universe.generation,
            universe.root_thread_id,
            library_id,
        ],
        |row| {
            Ok((
                count_u32(row.get::<_, i64>(0)?)?,
                count_u32(row.get::<_, i64>(1)?)?,
            ))
        },
    )?)
}

#[allow(clippy::too_many_arguments)]
fn observe_status_evidence_records(
    connection: &Connection,
    universe: &ProjectWorkspaceSubagentUniverse,
    thread_id: &str,
    status: ProjectWorkspaceSubagentStatus,
    evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind,
    source_revision: i64,
    observed_at_ms: i64,
    updated_at: &str,
) -> Result<bool, StoreError> {
    validate_status_coordinates(status, evidence_kind, source_revision, observed_at_ms)?;
    require_descendant(connection, universe, thread_id)?;
    let existing = connection
        .query_row(
            "SELECT status, evidence_kind, source_revision, observed_at_ms
             FROM workspace_subagent_status_evidence
             WHERE host_id = ?1 AND source_epoch = ?2 AND generation = ?3
               AND root_thread_id = ?4 AND thread_id = ?5",
            params![
                universe.host_id,
                universe.source_epoch,
                universe.generation,
                universe.root_thread_id,
                thread_id,
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    let should_update = should_replace_status_evidence(
        existing.as_ref(),
        status,
        evidence_kind,
        source_revision,
        observed_at_ms,
    );
    if !should_update {
        return Ok(false);
    }
    let changed =
        if let Some((existing_status, existing_kind, existing_revision, existing_at)) = existing {
            connection.execute(
                "UPDATE workspace_subagent_status_evidence
             SET status = ?6, evidence_kind = ?7, source_revision = ?8,
               observed_at_ms = ?9, updated_at = ?10
             WHERE host_id = ?1 AND source_epoch = ?2 AND generation = ?3
               AND root_thread_id = ?4 AND thread_id = ?5
               AND status = ?11 AND evidence_kind = ?12
               AND source_revision = ?13 AND observed_at_ms = ?14",
                params![
                    universe.host_id,
                    universe.source_epoch,
                    universe.generation,
                    universe.root_thread_id,
                    thread_id,
                    status_literal(status),
                    evidence_kind_literal(evidence_kind),
                    source_revision,
                    observed_at_ms,
                    updated_at,
                    existing_status,
                    existing_kind,
                    existing_revision,
                    existing_at,
                ],
            )?
        } else {
            connection.execute(
                "INSERT INTO workspace_subagent_status_evidence(
               host_id, source_epoch, generation, root_thread_id, thread_id,
               status, evidence_kind, source_revision, observed_at_ms, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(host_id, source_epoch, generation, root_thread_id, thread_id)
             DO NOTHING",
                params![
                    universe.host_id,
                    universe.source_epoch,
                    universe.generation,
                    universe.root_thread_id,
                    thread_id,
                    status_literal(status),
                    evidence_kind_literal(evidence_kind),
                    source_revision,
                    observed_at_ms,
                    updated_at,
                ],
            )?
        };
    Ok(changed > 0)
}

fn consume_pending_status_evidence(
    connection: &Connection,
    library_id: &str,
    universe: &ProjectWorkspaceSubagentUniverse,
    thread_id: &str,
    updated_at: &str,
) -> Result<(), StoreError> {
    let mut statement = connection.prepare(
        "SELECT source_epoch, generation, status, evidence_kind, source_revision, observed_at_ms
         FROM workspace_subagent_pending_status_evidence
         WHERE library_id = ?1 AND host_id = ?2 AND thread_id = ?3
           AND ((source_epoch = ?4 AND generation = ?5) OR evidence_kind = 'completion')",
    )?;
    let rows = statement.query_map(
        params![
            library_id,
            universe.host_id,
            thread_id,
            universe.source_epoch,
            universe.generation,
        ],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                parse_status_row(&row.get::<_, String>(2)?)?,
                parse_evidence_kind_row(&row.get::<_, String>(3)?)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        },
    )?;
    let current_status = connection
        .query_row(
            "SELECT status FROM workspace_subagent_status_evidence
             WHERE host_id = ?1 AND source_epoch = ?2 AND generation = ?3
               AND root_thread_id = ?4 AND thread_id = ?5",
            params![
                universe.host_id,
                universe.source_epoch,
                universe.generation,
                universe.root_thread_id,
                thread_id,
            ],
            |row| parse_status_row(&row.get::<_, String>(0)?),
        )
        .optional()?;
    let mut selected: Option<(
        ProjectWorkspaceSubagentStatus,
        ProjectWorkspaceSubagentStatusEvidenceKind,
        i64,
        i64,
    )> = None;
    for row in rows {
        let (source_epoch, generation, status, kind, revision, observed_at) = row?;
        let crosses_generation =
            source_epoch != universe.source_epoch || generation != universe.generation;
        if crosses_generation
            && kind == ProjectWorkspaceSubagentStatusEvidenceKind::Completion
            && current_status == Some(ProjectWorkspaceSubagentStatus::Active)
        {
            continue;
        }
        let candidate = (status, kind, revision, observed_at);
        let existing = selected
            .as_ref()
            .map(|(status, kind, revision, observed_at)| {
                (
                    status_literal(*status).to_owned(),
                    evidence_kind_literal(*kind).to_owned(),
                    *revision,
                    *observed_at,
                )
            });
        if should_replace_status_evidence(
            existing.as_ref(),
            candidate.0,
            candidate.1,
            candidate.2,
            candidate.3,
        ) {
            selected = Some(candidate);
        }
    }
    drop(statement);
    if let Some((status, kind, source_revision, observed_at_ms)) = selected {
        observe_status_evidence_records(
            connection,
            universe,
            thread_id,
            status,
            kind,
            source_revision,
            observed_at_ms,
            updated_at,
        )?;
    }
    connection.execute(
        "DELETE FROM workspace_subagent_pending_status_evidence
         WHERE library_id = ?1 AND host_id = ?2 AND thread_id = ?3",
        params![library_id, universe.host_id, thread_id],
    )?;
    Ok(())
}

fn validate_status_coordinates(
    status: ProjectWorkspaceSubagentStatus,
    evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind,
    source_revision: i64,
    observed_at_ms: i64,
) -> Result<(), StoreError> {
    if source_revision < 0 || observed_at_ms < 0 {
        return Err(invalid("Subagent status coordinates must be non-negative"));
    }
    if evidence_kind == ProjectWorkspaceSubagentStatusEvidenceKind::Completion
        && status != ProjectWorkspaceSubagentStatus::Done
    {
        return Err(invalid(
            "Completion evidence must settle a Subagent as done",
        ));
    }
    Ok(())
}

fn should_replace_status_evidence(
    existing: Option<&(String, String, i64, i64)>,
    status: ProjectWorkspaceSubagentStatus,
    evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind,
    source_revision: i64,
    observed_at_ms: i64,
) -> bool {
    existing.is_none_or(|(existing_status, kind, revision, observed_at)| {
        let existing_kind = parse_evidence_kind_literal(kind).ok();
        if let Some(existing_kind) = existing_kind {
            let inherited_terminal_baseline = *revision == 0
                && *observed_at == 0
                && existing_status == "done"
                && matches!(
                    existing_kind,
                    ProjectWorkspaceSubagentStatusEvidenceKind::Completion
                        | ProjectWorkspaceSubagentStatusEvidenceKind::Reconciliation
                );
            if inherited_terminal_baseline
                && evidence_kind == ProjectWorkspaceSubagentStatusEvidenceKind::Metadata
                && status == ProjectWorkspaceSubagentStatus::Active
            {
                return true;
            }
            let crosses_metadata_boundary = evidence_kind
                == ProjectWorkspaceSubagentStatusEvidenceKind::Metadata
                || existing_kind == ProjectWorkspaceSubagentStatusEvidenceKind::Metadata;
            if crosses_metadata_boundary && evidence_kind != existing_kind {
                return evidence_strength(evidence_kind) > evidence_strength(existing_kind);
            }
            if evidence_kind == existing_kind {
                return (source_revision, observed_at_ms) > (*revision, *observed_at);
            }
            if evidence_kind == ProjectWorkspaceSubagentStatusEvidenceKind::Reconciliation
                || existing_kind == ProjectWorkspaceSubagentStatusEvidenceKind::Reconciliation
            {
                return true;
            }
        }
        (
            source_revision,
            observed_at_ms,
            evidence_strength(evidence_kind),
        ) > (
            *revision,
            *observed_at,
            existing_kind.map_or(0, evidence_strength),
        )
    })
}

fn observational_patch(
    connection: &Connection,
    universe: &ProjectWorkspaceSubagentUniverse,
    observation: &ProjectWorkspaceSubagentObservation,
) -> Result<nodex_core_contracts::workspace::ProjectWorkspaceThreadPatch, StoreError> {
    let mut patch = observation.patch.as_ref().clone();
    patch.parent_thread_id = Some(Some(observation.parent_thread_id.clone()));
    patch.cwd = None;
    patch.managed_worktree_path = None;
    patch.projectless_output_directory = None;
    patch.projectless_workspace_browser_root = None;
    let strong_status_exists = connection
        .query_row(
            "SELECT 1 FROM workspace_subagent_status_evidence
             WHERE host_id = ?1 AND source_epoch = ?2 AND generation = ?3
               AND root_thread_id = ?4 AND thread_id = ?5
               AND evidence_kind IN ('notification', 'completion', 'reconciliation')",
            params![
                universe.host_id,
                universe.source_epoch,
                universe.generation,
                universe.root_thread_id,
                observation.thread_id,
            ],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if strong_status_exists {
        patch.status = None;
    }
    let exists = connection
        .query_row(
            "SELECT 1 FROM codex_threads WHERE thread_id = ?1",
            [&observation.thread_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    patch.execution_host_id = (!exists).then(|| universe.host_id.clone());
    Ok(patch)
}

fn require_complete_reachable_closure(
    connection: &Connection,
    universe: &ProjectWorkspaceSubagentUniverse,
) -> Result<(), StoreError> {
    let (known, reachable) = connection.query_row(
        "WITH RECURSIVE reachable(thread_id) AS (
           SELECT descendant.thread_id
           FROM workspace_subagent_descendants descendant
           WHERE descendant.host_id = ?1 AND descendant.source_epoch = ?2
             AND descendant.generation = ?3 AND descendant.root_thread_id = ?4
             AND descendant.parent_thread_id = ?4
           UNION
           SELECT child.thread_id
           FROM workspace_subagent_descendants child
           JOIN reachable parent ON child.parent_thread_id = parent.thread_id
           WHERE child.host_id = ?1 AND child.source_epoch = ?2
             AND child.generation = ?3 AND child.root_thread_id = ?4
         )
         SELECT
           (SELECT count(*) FROM workspace_subagent_descendants
             WHERE host_id = ?1 AND source_epoch = ?2 AND generation = ?3
               AND root_thread_id = ?4),
           (SELECT count(*) FROM reachable)",
        params![
            universe.host_id,
            universe.source_epoch,
            universe.generation,
            universe.root_thread_id,
        ],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    if known == reachable {
        return Ok(());
    }
    Err(conflict(
        "A complete Subagent discovery universe contains an unreachable parent cycle or gap",
    ))
}

fn validate_universe(universe: &ProjectWorkspaceSubagentUniverse) -> Result<(), StoreError> {
    validate_identity("host_id", &universe.host_id)?;
    validate_identity("source_epoch", &universe.source_epoch)?;
    validate_identity("root_thread_id", &universe.root_thread_id)?;
    if universe.generation < 0 {
        return Err(invalid("Subagent universe generation must be non-negative"));
    }
    Ok(())
}

fn validate_observation(
    universe: &ProjectWorkspaceSubagentUniverse,
    observation: &ProjectWorkspaceSubagentObservation,
) -> Result<(), StoreError> {
    validate_identity("thread_id", &observation.thread_id)?;
    validate_identity("parent_thread_id", &observation.parent_thread_id)?;
    if observation.thread_id == universe.root_thread_id
        || observation.thread_id == observation.parent_thread_id
    {
        return Err(invalid(
            "Subagent observations must describe a strict descendant",
        ));
    }
    if observation.source_revision < 0 || observation.observed_at_ms < 0 {
        return Err(invalid(
            "Subagent observation status coordinates must be non-negative",
        ));
    }
    Ok(())
}

fn validate_continuation(value: Option<&str>) -> Result<(), StoreError> {
    if value.is_some_and(|value| value.is_empty() || value.len() > MAX_CONTINUATION_BYTES) {
        return Err(invalid("Subagent discovery continuation is malformed"));
    }
    Ok(())
}

fn validate_identity(field: &str, value: &str) -> Result<(), StoreError> {
    if !value.is_empty()
        && value == value.trim()
        && value.len() <= 512
        && !value.chars().any(char::is_control)
    {
        return Ok(());
    }
    Err(invalid(format!("{field} is not a canonical identity")))
}

fn require_thread_in_library(
    connection: &Connection,
    library_id: &str,
    thread_id: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM codex_threads thread
             LEFT JOIN projects project ON project.id = thread.project_id
             WHERE thread.thread_id = ?1
               AND (thread.project_id IS NULL OR project.library_id = ?2)",
            params![thread_id, library_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        return Ok(());
    }
    Err(not_found(
        "Subagent root Thread is unavailable in this Library",
    ))
}

fn require_descendant(
    connection: &Connection,
    universe: &ProjectWorkspaceSubagentUniverse,
    thread_id: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM workspace_subagent_descendants
             WHERE host_id = ?1 AND source_epoch = ?2 AND generation = ?3
               AND root_thread_id = ?4 AND thread_id = ?5",
            params![
                universe.host_id,
                universe.source_epoch,
                universe.generation,
                universe.root_thread_id,
                thread_id,
            ],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        return Ok(());
    }
    Err(not_found(
        "Thread is outside the observed Subagent universe",
    ))
}

fn normalize_metadata_status(
    status_type: CodexThreadStatusType,
    active_flags: &[CodexThreadActiveFlag],
) -> ProjectWorkspaceSubagentStatus {
    match status_type {
        CodexThreadStatusType::Active if !active_flags.is_empty() => {
            ProjectWorkspaceSubagentStatus::Waiting
        }
        CodexThreadStatusType::Active => ProjectWorkspaceSubagentStatus::Active,
        CodexThreadStatusType::Idle | CodexThreadStatusType::SystemError => {
            ProjectWorkspaceSubagentStatus::Done
        }
        CodexThreadStatusType::NotLoaded => ProjectWorkspaceSubagentStatus::Unknown,
    }
}

fn evidence_strength(kind: ProjectWorkspaceSubagentStatusEvidenceKind) -> u8 {
    match kind {
        ProjectWorkspaceSubagentStatusEvidenceKind::Metadata => 1,
        ProjectWorkspaceSubagentStatusEvidenceKind::Notification => 2,
        ProjectWorkspaceSubagentStatusEvidenceKind::Completion => 3,
        ProjectWorkspaceSubagentStatusEvidenceKind::Reconciliation => 4,
    }
}

fn status_literal(status: ProjectWorkspaceSubagentStatus) -> &'static str {
    match status {
        ProjectWorkspaceSubagentStatus::Active => "active",
        ProjectWorkspaceSubagentStatus::Waiting => "waiting",
        ProjectWorkspaceSubagentStatus::Done => "done",
        ProjectWorkspaceSubagentStatus::Unknown => "unknown",
    }
}

fn evidence_kind_literal(kind: ProjectWorkspaceSubagentStatusEvidenceKind) -> &'static str {
    match kind {
        ProjectWorkspaceSubagentStatusEvidenceKind::Metadata => "metadata",
        ProjectWorkspaceSubagentStatusEvidenceKind::Notification => "notification",
        ProjectWorkspaceSubagentStatusEvidenceKind::Completion => "completion",
        ProjectWorkspaceSubagentStatusEvidenceKind::Reconciliation => "reconciliation",
    }
}

fn parse_evidence_kind_literal(
    value: &str,
) -> Result<ProjectWorkspaceSubagentStatusEvidenceKind, StoreError> {
    match value {
        "metadata" => Ok(ProjectWorkspaceSubagentStatusEvidenceKind::Metadata),
        "notification" => Ok(ProjectWorkspaceSubagentStatusEvidenceKind::Notification),
        "completion" => Ok(ProjectWorkspaceSubagentStatusEvidenceKind::Completion),
        "reconciliation" => Ok(ProjectWorkspaceSubagentStatusEvidenceKind::Reconciliation),
        _ => Err(corrupt("Stored Subagent evidence kind is invalid")),
    }
}

fn lifecycle_action_literal(action: ProjectWorkspaceSubagentLifecycleAction) -> &'static str {
    match action {
        ProjectWorkspaceSubagentLifecycleAction::Archive => "archive",
        ProjectWorkspaceSubagentLifecycleAction::Delete => "delete",
    }
}

fn lifecycle_outcome_literal(outcome: ProjectWorkspaceSubagentLifecycleOutcome) -> &'static str {
    match outcome {
        ProjectWorkspaceSubagentLifecycleOutcome::Pending => "pending",
        ProjectWorkspaceSubagentLifecycleOutcome::Unresolved => "unresolved",
        ProjectWorkspaceSubagentLifecycleOutcome::Failed => "failed",
        ProjectWorkspaceSubagentLifecycleOutcome::Settled => "settled",
    }
}

fn parse_lifecycle_action(
    value: &str,
) -> Result<ProjectWorkspaceSubagentLifecycleAction, StoreError> {
    match value {
        "archive" => Ok(ProjectWorkspaceSubagentLifecycleAction::Archive),
        "delete" => Ok(ProjectWorkspaceSubagentLifecycleAction::Delete),
        _ => Err(corrupt("Stored Subagent lifecycle action is invalid")),
    }
}

fn parse_status_row(value: &str) -> rusqlite::Result<ProjectWorkspaceSubagentStatus> {
    match value {
        "active" => Ok(ProjectWorkspaceSubagentStatus::Active),
        "waiting" => Ok(ProjectWorkspaceSubagentStatus::Waiting),
        "done" => Ok(ProjectWorkspaceSubagentStatus::Done),
        "unknown" => Ok(ProjectWorkspaceSubagentStatus::Unknown),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn parse_evidence_kind_row(
    value: &str,
) -> rusqlite::Result<ProjectWorkspaceSubagentStatusEvidenceKind> {
    match value {
        "metadata" => Ok(ProjectWorkspaceSubagentStatusEvidenceKind::Metadata),
        "notification" => Ok(ProjectWorkspaceSubagentStatusEvidenceKind::Notification),
        "completion" => Ok(ProjectWorkspaceSubagentStatusEvidenceKind::Completion),
        "reconciliation" => Ok(ProjectWorkspaceSubagentStatusEvidenceKind::Reconciliation),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn parse_lifecycle_outcome_row(
    value: &str,
) -> rusqlite::Result<ProjectWorkspaceSubagentLifecycleOutcome> {
    match value {
        "pending" => Ok(ProjectWorkspaceSubagentLifecycleOutcome::Pending),
        "unresolved" => Ok(ProjectWorkspaceSubagentLifecycleOutcome::Unresolved),
        "failed" => Ok(ProjectWorkspaceSubagentLifecycleOutcome::Failed),
        "settled" => Ok(ProjectWorkspaceSubagentLifecycleOutcome::Settled),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn count_u32(value: i64) -> rusqlite::Result<u32> {
    u32::try_from(value).map_err(|_| rusqlite::Error::InvalidQuery)
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message.into(), false)
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Conflict, message.into(), true)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message.into(), false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message.into(), false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message.into(), false)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use nodex_core_contracts::collection::CollectionWindowRequest;
    use nodex_core_contracts::workspace::{
        CodexThreadStatusType, ProjectWorkspaceIntent, ProjectWorkspaceRead,
        ProjectWorkspaceReadValue, ProjectWorkspaceSubagentLifecycleAction,
        ProjectWorkspaceSubagentLifecycleObservation, ProjectWorkspaceSubagentLifecycleOutcome,
        ProjectWorkspaceSubagentObservation, ProjectWorkspaceSubagentStatus,
        ProjectWorkspaceSubagentStatusEvidenceKind,
        ProjectWorkspaceSubagentStatusEvidencePrecondition, ProjectWorkspaceSubagentUniverse,
        ProjectWorkspaceThreadPatch, ProjectWorkspaceThreadStatus,
    };

    use super::super::test_support::{apply, read, seeded_workspace};

    fn universe() -> ProjectWorkspaceSubagentUniverse {
        universe_with_epoch("app-server:epoch-1", 1)
    }

    fn universe_with_epoch(
        source_epoch: &str,
        generation: i64,
    ) -> ProjectWorkspaceSubagentUniverse {
        ProjectWorkspaceSubagentUniverse {
            host_id: "local".to_owned(),
            source_epoch: source_epoch.to_owned(),
            generation,
            root_thread_id: "thread:root".to_owned(),
        }
    }

    fn seed_root(module: &super::super::ProjectWorkspaceModule) {
        apply(
            module,
            "seed-subagent-root",
            ProjectWorkspaceIntent::UpsertThread {
                thread_id: "thread:root".to_owned(),
                patch: Box::new(ProjectWorkspaceThreadPatch {
                    thread_name: Some(Some("Root".to_owned())),
                    created_at: Some(1),
                    updated_at: Some(1),
                    recency_at: Some(1),
                    linked_at: Some(super::super::test_support::NOW.to_owned()),
                    ..ProjectWorkspaceThreadPatch::default()
                }),
            },
        );
    }

    fn observation(
        index: usize,
        parent_thread_id: &str,
        status_type: CodexThreadStatusType,
    ) -> ProjectWorkspaceSubagentObservation {
        let timestamp = i64::try_from(index + 2).expect("bounded test index");
        ProjectWorkspaceSubagentObservation {
            thread_id: format!("thread:child:{index:04}"),
            parent_thread_id: parent_thread_id.to_owned(),
            patch: Box::new(ProjectWorkspaceThreadPatch {
                thread_name: Some(Some(format!("Child {index}"))),
                status: Some(ProjectWorkspaceThreadStatus {
                    status_type,
                    active_flags: Vec::new(),
                }),
                created_at: Some(timestamp),
                updated_at: Some(timestamp),
                recency_at: Some(timestamp),
                linked_at: Some(super::super::test_support::NOW.to_owned()),
                ..ProjectWorkspaceThreadPatch::default()
            }),
            source_revision: timestamp,
            observed_at_ms: timestamp,
        }
    }

    fn observe_page(
        module: &super::super::ProjectWorkspaceModule,
        page: usize,
        observations: Vec<ProjectWorkspaceSubagentObservation>,
        complete: bool,
    ) {
        observe_page_in_universe(module, &universe(), page, observations, complete);
    }

    fn observe_page_in_universe(
        module: &super::super::ProjectWorkspaceModule,
        universe: &ProjectWorkspaceSubagentUniverse,
        page: usize,
        observations: Vec<ProjectWorkspaceSubagentObservation>,
        complete: bool,
    ) {
        apply(
            module,
            &format!(
                "observe-subagent-page-{}-{}-{page}",
                universe.source_epoch, universe.generation
            ),
            ProjectWorkspaceIntent::ObserveSubagentDiscoveryPage {
                universe: universe.clone(),
                page_identity: format!("page:{page}"),
                observations,
                continuation: (!complete).then(|| format!("cursor:{page}")),
                complete,
            },
        );
    }

    fn overview(
        module: &super::super::ProjectWorkspaceModule,
        active_first: u32,
        active_after: Option<String>,
    ) -> nodex_core_contracts::workspace::ProjectWorkspaceSubagentOverview {
        overview_in_universe(module, &universe(), active_first, active_after)
    }

    fn overview_in_universe(
        module: &super::super::ProjectWorkspaceModule,
        universe: &ProjectWorkspaceSubagentUniverse,
        active_first: u32,
        active_after: Option<String>,
    ) -> nodex_core_contracts::workspace::ProjectWorkspaceSubagentOverview {
        let ProjectWorkspaceReadValue::SubagentOverviewWindow { overview } = read(
            module,
            ProjectWorkspaceRead::SubagentOverviewWindow {
                universe: universe.clone(),
                active_window: CollectionWindowRequest {
                    after: active_after,
                    first: Some(active_first),
                },
                done_window: CollectionWindowRequest {
                    after: None,
                    first: Some(10),
                },
            },
        ) else {
            panic!("Subagent overview");
        };
        overview
    }

    #[test]
    fn empty_universe_is_a_legal_incomplete_overview() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);

        let snapshot = overview(&workspace.module, 4, None);

        assert!(snapshot.active.items.is_empty());
        assert!(snapshot.done.items.is_empty());
        assert_eq!(snapshot.known_active_count, 0);
        assert_eq!(snapshot.known_done_count, 0);
        assert!(!snapshot.discovery_complete);
        assert_eq!(snapshot.discovery_continuation, None);
    }

    #[test]
    fn one_thousand_descendants_converge_over_bounded_pages_and_keyset_windows() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);
        for page in 0..5 {
            let observations = (page * 200..(page + 1) * 200)
                .map(|index| {
                    let parent = if index % 10 == 0 {
                        "thread:root".to_owned()
                    } else {
                        format!("thread:child:{:04}", index - 1)
                    };
                    observation(
                        index,
                        &parent,
                        if index % 2 == 0 {
                            CodexThreadStatusType::Active
                        } else {
                            CodexThreadStatusType::Idle
                        },
                    )
                })
                .collect();
            observe_page(&workspace.module, page, observations, page == 4);
        }

        let initial = overview(&workspace.module, 4, None);
        assert_eq!(initial.active.items.len(), 4);
        assert_eq!(initial.done.items.len(), 10);
        assert_eq!(initial.known_active_count, 500);
        assert_eq!(initial.known_done_count, 500);
        assert!(initial.discovery_complete);
        assert_eq!(initial.discovery_continuation, None);

        let mut seen = BTreeSet::new();
        let mut after = None;
        loop {
            let page = overview(&workspace.module, 200, after);
            seen.extend(
                page.active
                    .items
                    .iter()
                    .map(|item| item.thread.thread_id.clone()),
            );
            after = page.active.next_cursor;
            if after.is_none() {
                break;
            }
        }
        assert_eq!(seen.len(), 500);
    }

    #[test]
    fn stronger_status_evidence_is_causal_and_metadata_never_regresses_it() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);
        observe_page(
            &workspace.module,
            0,
            vec![observation(0, "thread:root", CodexThreadStatusType::Active)],
            true,
        );
        let child_id = "thread:child:0000";
        for (operation_id, status, evidence_kind, source_revision, observed_at_ms) in [
            (
                "status-complete",
                ProjectWorkspaceSubagentStatus::Done,
                ProjectWorkspaceSubagentStatusEvidenceKind::Completion,
                1,
                100,
            ),
            (
                "status-stale-metadata",
                ProjectWorkspaceSubagentStatus::Active,
                ProjectWorkspaceSubagentStatusEvidenceKind::Metadata,
                99,
                999,
            ),
            (
                "status-stale-notification",
                ProjectWorkspaceSubagentStatus::Active,
                ProjectWorkspaceSubagentStatusEvidenceKind::Notification,
                0,
                99,
            ),
        ] {
            apply(
                &workspace.module,
                operation_id,
                ProjectWorkspaceIntent::ObserveSubagentStatusEvidence {
                    universe: universe(),
                    thread_id: child_id.to_owned(),
                    status,
                    evidence_kind,
                    source_revision,
                    observed_at_ms,
                    precondition: None,
                },
            );
        }
        let completed = overview(&workspace.module, 4, None);
        assert_eq!(completed.known_active_count, 0);
        assert_eq!(completed.known_done_count, 1);
        assert_eq!(
            completed.done.items[0].status,
            ProjectWorkspaceSubagentStatus::Done
        );

        apply(
            &workspace.module,
            "status-new-turn",
            ProjectWorkspaceIntent::ObserveSubagentStatusEvidence {
                universe: universe(),
                thread_id: child_id.to_owned(),
                status: ProjectWorkspaceSubagentStatus::Active,
                evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind::Notification,
                source_revision: 11,
                observed_at_ms: 101,
                precondition: None,
            },
        );
        let active = overview(&workspace.module, 4, None);
        assert_eq!(active.known_active_count, 1);
        assert_eq!(active.known_done_count, 0);
        assert_eq!(
            active.active.items[0]
                .evidence
                .as_ref()
                .map(|value| value.kind),
            Some(ProjectWorkspaceSubagentStatusEvidenceKind::Notification)
        );

        apply(
            &workspace.module,
            "status-higher-token-clock-rollback",
            ProjectWorkspaceIntent::ObserveSubagentStatusEvidence {
                universe: universe(),
                thread_id: child_id.to_owned(),
                status: ProjectWorkspaceSubagentStatus::Done,
                evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind::Completion,
                source_revision: 12,
                observed_at_ms: 1,
                precondition: None,
            },
        );
        let clock_rollback = overview(&workspace.module, 4, None);
        assert_eq!(clock_rollback.known_active_count, 0);
        assert_eq!(clock_rollback.known_done_count, 1);

        apply(
            &workspace.module,
            "status-stop-skeleton",
            ProjectWorkspaceIntent::ObserveSubagentStatusEvidence {
                universe: universe(),
                thread_id: child_id.to_owned(),
                status: ProjectWorkspaceSubagentStatus::Done,
                evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind::Reconciliation,
                source_revision: 0,
                observed_at_ms: 1_785_000_000_000,
                precondition: None,
            },
        );
        apply(
            &workspace.module,
            "status-followup-after-stop-skeleton",
            ProjectWorkspaceIntent::ObserveSubagentStatusEvidence {
                universe: universe(),
                thread_id: child_id.to_owned(),
                status: ProjectWorkspaceSubagentStatus::Active,
                evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind::Notification,
                source_revision: 200,
                observed_at_ms: 1_785_000_001_000,
                precondition: None,
            },
        );
        let reopened_after_skeleton = overview(&workspace.module, 4, None);
        assert_eq!(reopened_after_skeleton.known_active_count, 1);
        assert_eq!(reopened_after_skeleton.known_done_count, 0);

        apply(
            &workspace.module,
            "status-followup-after-slow-read-started",
            ProjectWorkspaceIntent::ObserveSubagentStatusEvidence {
                universe: universe(),
                thread_id: child_id.to_owned(),
                status: ProjectWorkspaceSubagentStatus::Active,
                evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind::Notification,
                source_revision: 201,
                observed_at_ms: 1_785_000_002_000,
                precondition: None,
            },
        );
        apply(
            &workspace.module,
            "status-stale-skeleton-after-followup",
            ProjectWorkspaceIntent::ObserveSubagentStatusEvidence {
                universe: universe(),
                thread_id: child_id.to_owned(),
                status: ProjectWorkspaceSubagentStatus::Done,
                evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind::Reconciliation,
                source_revision: 200,
                observed_at_ms: 1_785_000_003_000,
                precondition: Some(ProjectWorkspaceSubagentStatusEvidencePrecondition::Exact {
                    evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind::Notification,
                    source_revision: 200,
                    observed_at_ms: 1_785_000_001_000,
                }),
            },
        );
        let active_after_stale_reconciliation = overview(&workspace.module, 4, None);
        assert_eq!(active_after_stale_reconciliation.known_active_count, 1);
        assert_eq!(active_after_stale_reconciliation.known_done_count, 0);
        assert_eq!(
            active_after_stale_reconciliation.active.items[0]
                .evidence
                .as_ref()
                .map(|evidence| evidence.source_revision),
            Some(201)
        );
    }

    #[test]
    fn completion_before_identity_survives_restart_coordinates_and_merges_atomically() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);
        apply(
            &workspace.module,
            "buffer-completion-before-identity",
            ProjectWorkspaceIntent::BufferSubagentStatusEvidence {
                host_id: "local".to_owned(),
                source_epoch: "app-server:epoch-1".to_owned(),
                generation: 1,
                thread_id: "thread:child:0000".to_owned(),
                status: ProjectWorkspaceSubagentStatus::Done,
                evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind::Completion,
                source_revision: 41,
                observed_at_ms: 4_100,
            },
        );

        let restarted = universe_with_epoch("app-server:epoch-2", 2);
        observe_page_in_universe(
            &workspace.module,
            &restarted,
            0,
            vec![observation(
                0,
                "thread:root",
                CodexThreadStatusType::NotLoaded,
            )],
            true,
        );

        let result = overview_in_universe(&workspace.module, &restarted, 4, None);
        assert_eq!(result.known_active_count, 0);
        assert_eq!(result.known_done_count, 1);
        assert_eq!(
            result.done.items[0].status,
            ProjectWorkspaceSubagentStatus::Done
        );
        assert_eq!(
            result.done.items[0]
                .evidence
                .as_ref()
                .map(|evidence| (evidence.kind, evidence.source_revision)),
            Some((ProjectWorkspaceSubagentStatusEvidenceKind::Completion, 41))
        );
    }

    #[test]
    fn endpoint_epoch_preserves_completion_strength_against_not_loaded_metadata() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);
        observe_page(
            &workspace.module,
            0,
            vec![observation(0, "thread:root", CodexThreadStatusType::Active)],
            true,
        );
        apply(
            &workspace.module,
            "complete-before-endpoint-restart",
            ProjectWorkspaceIntent::ObserveSubagentStatusEvidence {
                universe: universe(),
                thread_id: "thread:child:0000".to_owned(),
                status: ProjectWorkspaceSubagentStatus::Done,
                evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind::Completion,
                source_revision: 42,
                observed_at_ms: 100,
                precondition: None,
            },
        );

        let restarted = universe_with_epoch("app-server:epoch-2", 1);
        observe_page_in_universe(&workspace.module, &restarted, 0, Vec::new(), false);
        observe_page_in_universe(
            &workspace.module,
            &restarted,
            1,
            vec![observation(
                0,
                "thread:root",
                CodexThreadStatusType::NotLoaded,
            )],
            true,
        );

        let completed = overview_in_universe(&workspace.module, &restarted, 4, None);
        assert_eq!(completed.known_active_count, 0);
        assert_eq!(completed.known_done_count, 1);
        assert_eq!(
            completed.done.items[0]
                .evidence
                .as_ref()
                .map(|evidence| evidence.kind),
            Some(ProjectWorkspaceSubagentStatusEvidenceKind::Completion)
        );
    }

    #[test]
    fn current_active_metadata_reopens_an_inherited_completion_in_a_new_generation() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);
        observe_page(
            &workspace.module,
            0,
            vec![observation(0, "thread:root", CodexThreadStatusType::Active)],
            true,
        );
        apply(
            &workspace.module,
            "complete-before-generation-change",
            ProjectWorkspaceIntent::ObserveSubagentStatusEvidence {
                universe: universe(),
                thread_id: "thread:child:0000".to_owned(),
                status: ProjectWorkspaceSubagentStatus::Done,
                evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind::Completion,
                source_revision: 42,
                observed_at_ms: 100,
                precondition: None,
            },
        );

        let restarted = universe_with_epoch("app-server:epoch-2", 2);
        observe_page_in_universe(
            &workspace.module,
            &restarted,
            0,
            vec![observation(0, "thread:root", CodexThreadStatusType::Active)],
            true,
        );

        let active = overview_in_universe(&workspace.module, &restarted, 4, None);
        assert_eq!(active.known_active_count, 1);
        assert_eq!(active.known_done_count, 0);
        assert_eq!(
            active.active.items[0]
                .evidence
                .as_ref()
                .map(|evidence| evidence.kind),
            Some(ProjectWorkspaceSubagentStatusEvidenceKind::Metadata)
        );
    }

    #[test]
    fn current_active_metadata_fences_a_buffered_completion_from_an_old_generation() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);
        apply(
            &workspace.module,
            "buffer-old-generation-completion",
            ProjectWorkspaceIntent::BufferSubagentStatusEvidence {
                host_id: "local".to_owned(),
                source_epoch: "app-server:epoch-1".to_owned(),
                generation: 1,
                thread_id: "thread:child:0000".to_owned(),
                status: ProjectWorkspaceSubagentStatus::Done,
                evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind::Completion,
                source_revision: 41,
                observed_at_ms: 4_100,
            },
        );

        let restarted = universe_with_epoch("app-server:epoch-2", 2);
        observe_page_in_universe(
            &workspace.module,
            &restarted,
            0,
            vec![observation(0, "thread:root", CodexThreadStatusType::Active)],
            true,
        );

        let active = overview_in_universe(&workspace.module, &restarted, 4, None);
        assert_eq!(active.known_active_count, 1);
        assert_eq!(active.known_done_count, 0);
        assert_eq!(
            active.active.items[0]
                .evidence
                .as_ref()
                .map(|evidence| evidence.kind),
            Some(ProjectWorkspaceSubagentStatusEvidenceKind::Metadata)
        );
    }

    #[test]
    fn endpoint_epoch_does_not_carry_transient_active_strength_across_reconnect() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);
        observe_page(
            &workspace.module,
            0,
            vec![observation(0, "thread:root", CodexThreadStatusType::Active)],
            true,
        );
        apply(
            &workspace.module,
            "active-before-endpoint-restart",
            ProjectWorkspaceIntent::ObserveSubagentStatusEvidence {
                universe: universe(),
                thread_id: "thread:child:0000".to_owned(),
                status: ProjectWorkspaceSubagentStatus::Active,
                evidence_kind: ProjectWorkspaceSubagentStatusEvidenceKind::Notification,
                source_revision: 42,
                observed_at_ms: 100,
                precondition: None,
            },
        );

        let restarted = universe_with_epoch("app-server:epoch-2", 1);
        observe_page_in_universe(
            &workspace.module,
            &restarted,
            0,
            vec![observation(0, "thread:root", CodexThreadStatusType::Idle)],
            true,
        );

        let completed = overview_in_universe(&workspace.module, &restarted, 4, None);
        assert_eq!(completed.known_active_count, 0);
        assert_eq!(completed.known_done_count, 1);
        assert_eq!(
            completed.done.items[0]
                .evidence
                .as_ref()
                .map(|evidence| evidence.kind),
            Some(ProjectWorkspaceSubagentStatusEvidenceKind::Metadata)
        );
    }

    #[test]
    fn notification_observation_preserves_an_in_flight_discovery_cursor() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);
        observe_page(
            &workspace.module,
            0,
            vec![observation(0, "thread:root", CodexThreadStatusType::Active)],
            false,
        );
        apply(
            &workspace.module,
            "late-spawn-during-paginated-discovery",
            ProjectWorkspaceIntent::ObserveSubagentDiscoveryPage {
                universe: universe(),
                page_identity: "notification:late-spawn".to_owned(),
                observations: vec![observation(1, "thread:root", CodexThreadStatusType::Active)],
                continuation: None,
                complete: false,
            },
        );

        let snapshot = overview(&workspace.module, 4, None);
        assert!(!snapshot.discovery_complete);
        assert_eq!(snapshot.discovery_continuation.as_deref(), Some("cursor:0"));
        assert_eq!(snapshot.known_active_count, 2);
    }

    #[test]
    fn complete_discovery_rejects_an_unreachable_positive_fact() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);

        let error = workspace
            .module
            .apply(
                &super::super::test_support::context(),
                super::super::test_support::request(
                    "observe-unreachable-page",
                    ProjectWorkspaceIntent::ObserveSubagentDiscoveryPage {
                        universe: universe(),
                        page_identity: "page:unreachable".to_owned(),
                        observations: vec![observation(
                            0,
                            "thread:missing-parent",
                            CodexThreadStatusType::Active,
                        )],
                        continuation: None,
                        complete: true,
                    },
                ),
            )
            .expect_err("unreachable complete closure");

        assert_eq!(error.code, nodex_core_contracts::CoreErrorCode::Conflict);
        let snapshot = overview(&workspace.module, 4, None);
        assert_eq!(snapshot.known_active_count, 0);
        assert!(!snapshot.discovery_complete);
    }

    #[test]
    fn a_later_spawn_reopens_and_recompletes_the_same_host_generation() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);
        observe_page(
            &workspace.module,
            0,
            vec![observation(0, "thread:root", CodexThreadStatusType::Active)],
            true,
        );
        assert!(overview(&workspace.module, 4, None).discovery_complete);

        apply(
            &workspace.module,
            "observe-later-spawn",
            ProjectWorkspaceIntent::ObserveSubagentDiscoveryPage {
                universe: universe(),
                page_identity: "notification:spawn:1".to_owned(),
                observations: vec![observation(1, "thread:root", CodexThreadStatusType::Active)],
                continuation: None,
                complete: false,
            },
        );
        let reopened = overview(&workspace.module, 4, None);
        assert!(!reopened.discovery_complete);
        assert_eq!(reopened.known_active_count, 2);

        apply(
            &workspace.module,
            "recomplete-after-later-spawn",
            ProjectWorkspaceIntent::ObserveSubagentDiscoveryPage {
                universe: universe(),
                page_identity: "rescan:complete:1".to_owned(),
                observations: Vec::new(),
                continuation: None,
                complete: true,
            },
        );
        let recompleted = overview(&workspace.module, 4, None);
        assert!(recompleted.discovery_complete);
        assert_eq!(recompleted.known_active_count, 2);
    }

    #[test]
    fn endpoint_epochs_inherit_positive_closure_and_gc_incomplete_scans_without_lifecycle_loss() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);
        observe_page(
            &workspace.module,
            0,
            vec![observation(0, "thread:root", CodexThreadStatusType::Active)],
            true,
        );
        apply(
            &workspace.module,
            "begin-epoch-lifecycle",
            ProjectWorkspaceIntent::BeginSubagentLifecycle {
                universe: universe(),
                lifecycle_operation_id: "lifecycle:epoch-fence".to_owned(),
                action: ProjectWorkspaceSubagentLifecycleAction::Archive,
            },
        );

        let epoch_2 = universe_with_epoch("app-server:epoch-2", 1);
        observe_page_in_universe(&workspace.module, &epoch_2, 0, Vec::new(), false);
        let inherited_2 = overview_in_universe(&workspace.module, &epoch_2, 4, None);
        assert_eq!(inherited_2.known_active_count, 1);
        assert!(!inherited_2.discovery_complete);

        let epoch_3 = universe_with_epoch("app-server:epoch-3", 1);
        observe_page_in_universe(&workspace.module, &epoch_3, 0, Vec::new(), false);
        let (universe_count, lifecycle_count) = workspace
            .kernel
            .writer()
            .call(|connection| {
                Ok((
                    connection.query_row(
                        "SELECT COUNT(*) FROM workspace_subagent_universes
                         WHERE host_id = 'local' AND root_thread_id = 'thread:root'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    connection.query_row(
                        "SELECT COUNT(*) FROM workspace_subagent_lifecycle_operations
                         WHERE lifecycle_operation_id = 'lifecycle:epoch-fence'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                ))
            })
            .expect("projection counts");
        assert_eq!(universe_count, 2);
        assert_eq!(lifecycle_count, 1);
        assert_eq!(
            overview_in_universe(&workspace.module, &epoch_3, 4, None).known_active_count,
            1
        );

        observe_page_in_universe(&workspace.module, &epoch_3, 1, Vec::new(), true);
        let (universe_count, descendant_count, lifecycle_count) = workspace
            .kernel
            .writer()
            .call(|connection| {
                Ok((
                    connection.query_row(
                        "SELECT COUNT(*) FROM workspace_subagent_universes
                         WHERE host_id = 'local' AND root_thread_id = 'thread:root'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    connection.query_row(
                        "SELECT COUNT(*) FROM workspace_subagent_descendants
                         WHERE host_id = 'local' AND source_epoch = 'app-server:epoch-3'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    connection.query_row(
                        "SELECT COUNT(*) FROM workspace_subagent_lifecycle_operations
                         WHERE lifecycle_operation_id = 'lifecycle:epoch-fence'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                ))
            })
            .expect("completed projection counts");
        assert_eq!(universe_count, 1);
        assert_eq!(descendant_count, 1);
        assert_eq!(lifecycle_count, 1);
    }

    #[test]
    fn targeted_overview_item_reads_one_descendant_without_scanning_the_window() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);
        observe_page(
            &workspace.module,
            0,
            vec![observation(0, "thread:root", CodexThreadStatusType::Active)],
            true,
        );

        let ProjectWorkspaceReadValue::SubagentOverviewItem {
            item,
            projection_revision,
        } = read(
            &workspace.module,
            ProjectWorkspaceRead::SubagentOverviewItem {
                universe: universe(),
                thread_id: "thread:child:0000".to_owned(),
            },
        )
        else {
            panic!("Subagent overview item");
        };
        let item = item.expect("targeted descendant");
        assert_eq!(item.thread.thread_id, "thread:child:0000");
        assert_eq!(item.status, ProjectWorkspaceSubagentStatus::Active);
        assert!(projection_revision > 0);

        let ProjectWorkspaceReadValue::SubagentOverviewItem { item, .. } = read(
            &workspace.module,
            ProjectWorkspaceRead::SubagentOverviewItem {
                universe: universe(),
                thread_id: "thread:absent".to_owned(),
            },
        ) else {
            panic!("missing Subagent overview item");
        };
        assert!(item.is_none());
    }

    #[test]
    fn lifecycle_closure_survives_partial_failure_until_every_postcondition_settles() {
        let workspace = seeded_workspace();
        seed_root(&workspace.module);
        observe_page(
            &workspace.module,
            0,
            (0..3)
                .map(|index| observation(index, "thread:root", CodexThreadStatusType::Active))
                .collect(),
            true,
        );
        apply(
            &workspace.module,
            "begin-lifecycle",
            ProjectWorkspaceIntent::BeginSubagentLifecycle {
                universe: universe(),
                lifecycle_operation_id: "lifecycle:archive-root".to_owned(),
                action: ProjectWorkspaceSubagentLifecycleAction::Delete,
            },
        );

        let read_lifecycle = |first, after| {
            let ProjectWorkspaceReadValue::SubagentLifecycleBatch { lifecycle } = read(
                &workspace.module,
                ProjectWorkspaceRead::SubagentLifecycleBatch {
                    lifecycle_operation_id: "lifecycle:archive-root".to_owned(),
                    include_settled: false,
                    window: CollectionWindowRequest {
                        after,
                        first: Some(first),
                    },
                },
            ) else {
                panic!("Subagent lifecycle batch");
            };
            lifecycle
        };
        let first = read_lifecycle(2, None);
        assert_eq!(first.expected_count, 4);
        assert_eq!(first.members.items.len(), 2);
        assert!(first.members.next_cursor.is_some());

        apply(
            &workspace.module,
            "delete-root-before-lifecycle-observation",
            ProjectWorkspaceIntent::DeleteThread {
                thread_id: "thread:root".to_owned(),
            },
        );
        apply(
            &workspace.module,
            "resume-existing-lifecycle-after-root-delete",
            ProjectWorkspaceIntent::BeginSubagentLifecycle {
                universe: universe(),
                lifecycle_operation_id: "lifecycle:archive-root".to_owned(),
                action: ProjectWorkspaceSubagentLifecycleAction::Delete,
            },
        );

        workspace
            .kernel
            .writer()
            .call(|connection| {
                connection.execute(
                    "INSERT INTO profiles(id, created_at, updated_at)
                     VALUES ('profile-foreign', ?1, ?1)",
                    [super::super::test_support::NOW],
                )?;
                connection.execute(
                    "INSERT INTO libraries(id, profile_id, created_at, updated_at)
                     VALUES ('library-foreign', 'profile-foreign', ?1, ?1)",
                    [super::super::test_support::NOW],
                )?;
                Ok(())
            })
            .expect("foreign Library");
        let foreign_module = super::super::ProjectWorkspaceModule::new(
            "profile-foreign",
            "library-foreign",
            &workspace.kernel,
        )
        .expect("foreign Workspace module");
        let mut foreign_context = super::super::test_support::context();
        foreign_context.profile_id = nodex_core_contracts::ProfileId("profile-foreign".to_owned());
        foreign_context.library_id = nodex_core_contracts::LibraryId("library-foreign".to_owned());
        foreign_context.project_id = None;
        let foreign_read_error = foreign_module
            .read(
                &foreign_context,
                nodex_core_contracts::ModuleReadRequest {
                    contract_version: nodex_core_contracts::PROJECT_WORKSPACE_CONTRACT_VERSION,
                    read: ProjectWorkspaceRead::SubagentLifecycleBatch {
                        lifecycle_operation_id: "lifecycle:archive-root".to_owned(),
                        include_settled: false,
                        window: CollectionWindowRequest {
                            after: None,
                            first: Some(100),
                        },
                    },
                },
            )
            .expect_err("lifecycle operation remains scoped after root deletion");
        assert_eq!(
            foreign_read_error.code,
            nodex_core_contracts::CoreErrorCode::NotFound
        );

        apply(
            &workspace.module,
            "observe-lifecycle-partial",
            ProjectWorkspaceIntent::ObserveSubagentLifecycleOutcomes {
                lifecycle_operation_id: "lifecycle:archive-root".to_owned(),
                observations: vec![
                    ProjectWorkspaceSubagentLifecycleObservation {
                        thread_id: first.members.items[0].thread_id.clone(),
                        outcome: ProjectWorkspaceSubagentLifecycleOutcome::Settled,
                        reason: None,
                        observed_at_ms: 10,
                    },
                    ProjectWorkspaceSubagentLifecycleObservation {
                        thread_id: first.members.items[1].thread_id.clone(),
                        outcome: ProjectWorkspaceSubagentLifecycleOutcome::Failed,
                        reason: Some("remote archive did not settle".to_owned()),
                        observed_at_ms: 10,
                    },
                ],
            },
        );
        let partial = read_lifecycle(100, None);
        assert_eq!(partial.processed_count, 2);
        assert_eq!(partial.unresolved_count, 3);
        assert!(!partial.complete);
        assert!(partial.members.items.iter().any(|member| {
            member.outcome == ProjectWorkspaceSubagentLifecycleOutcome::Failed
                && member.last_reason.as_deref() == Some("remote archive did not settle")
        }));

        let settle = partial
            .members
            .items
            .iter()
            .map(|member| ProjectWorkspaceSubagentLifecycleObservation {
                thread_id: member.thread_id.clone(),
                outcome: ProjectWorkspaceSubagentLifecycleOutcome::Settled,
                reason: None,
                observed_at_ms: 20,
            })
            .collect();
        apply(
            &workspace.module,
            "observe-lifecycle-complete",
            ProjectWorkspaceIntent::ObserveSubagentLifecycleOutcomes {
                lifecycle_operation_id: "lifecycle:archive-root".to_owned(),
                observations: settle,
            },
        );
        let complete = read_lifecycle(100, None);
        assert_eq!(complete.processed_count, 4);
        assert_eq!(complete.unresolved_count, 0);
        assert!(complete.complete);
        assert!(complete.members.items.is_empty());

        let ProjectWorkspaceReadValue::SubagentLifecycleBatch { lifecycle: cohort } = read(
            &workspace.module,
            ProjectWorkspaceRead::SubagentLifecycleBatch {
                lifecycle_operation_id: "lifecycle:archive-root".to_owned(),
                include_settled: true,
                window: CollectionWindowRequest {
                    after: None,
                    first: Some(100),
                },
            },
        ) else {
            panic!("complete Subagent lifecycle cohort");
        };
        assert_eq!(cohort.members.items.len(), 4);
        assert!(
            cohort.members.items.iter().all(|member| {
                member.outcome == ProjectWorkspaceSubagentLifecycleOutcome::Settled
            })
        );
    }
}
