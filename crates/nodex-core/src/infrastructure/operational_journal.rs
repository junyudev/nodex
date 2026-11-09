use std::time::{Duration, Instant};

use chrono::SecondsFormat;
use nodex_core_contracts::administration::OperationalJournalStatus;
use rusqlite::{Connection, Row, params};

use super::sqlite::{StoreError, StoreErrorCode, with_immediate_transaction};

const POLICY_VERSION: i64 = 1;
const SOFT_RETENTION_MS: i64 = 24 * 60 * 60 * 1_000;
const MAX_RETAINED_COMMITS: i64 = 50_000;
const MAX_RETAINED_BYTES: i64 = 256 * 1_024 * 1_024;
const TARGET_RETAINED_COMMITS: i64 = 40_000;
const TARGET_RETAINED_BYTES: i64 = 192 * 1_024 * 1_024;
const MAX_RETAINED_RECEIPTS: i64 = 100_000;
const MAX_RETAINED_RECEIPT_BYTES: i64 = 128 * 1_024 * 1_024;
const TARGET_RETAINED_RECEIPTS: i64 = 80_000;
const TARGET_RETAINED_RECEIPT_BYTES: i64 = 96 * 1_024 * 1_024;
const MAX_OPERATIONAL_BYTES: i64 = 384 * 1_024 * 1_024;
const TARGET_OPERATIONAL_BYTES: i64 = 288 * 1_024 * 1_024;
const MAX_SLICE_COMMITS: usize = 128;
const MAX_SLICE_BYTES: i64 = 8 * 1_024 * 1_024;
const MAX_SLICE_TIME: Duration = Duration::from_millis(100);
const MAX_VACUUM_PAGES: usize = 256;
const VACUUM_CHUNK_PAGES: usize = 64;
// CROSS JOIN deliberately fixes local_commits as the outer loop. Otherwise
// SQLite may scan and sort the entire epoch-prefixed metadata primary key just
// to return the oldest bounded commit slice.
const DELIVERY_PRUNE_CANDIDATES_SQL: &str = "SELECT commit_row.commit_seq, \
       retention.sealed_at_ms, retention.delivery_bytes \
     FROM local_commits commit_row \
     CROSS JOIN local_commit_retention_metadata retention \
       ON retention.store_epoch = commit_row.store_epoch \
      AND retention.commit_seq = commit_row.commit_seq \
     WHERE commit_row.finalized = 1 AND commit_row.commit_seq < ?1 \
     ORDER BY commit_row.commit_seq LIMIT ?2";
const RECEIPT_PRUNE_CANDIDATES_SQL: &str = "SELECT module_name, operation_id, \
       issued_at_ms, expires_at_ms, receipt_bytes \
     FROM module_receipt_retention_metadata INDEXED BY idx_module_receipt_retention_prune \
     ORDER BY issued_at_ms, module_name, operation_id LIMIT ?1";
// A commit sequence is only globally ordered on local_commits; receipt lookup is
// keyed by (store_epoch, local_commit_seq). Keep the bounded commit set as the
// outer loop so a large receipt journal never becomes the scan side of pruning.
const DETACH_COMMIT_RECEIPTS_SQL: &str = "INSERT INTO detached_module_receipts( \
       module_name, operation_id, profile_id, project_id, adapter_kind, operation_kind, \
       store_epoch, request_hash, result_json, event_sequence, local_commit_seq, \
       commit_manifest_hash, committed_at, detached_at_ms \
     ) SELECT receipt.module_name, receipt.operation_id, receipt.profile_id, \
              receipt.project_id, receipt.adapter_kind, receipt.operation_kind, \
              receipt.store_epoch, receipt.request_hash, receipt.result_json, \
              receipt.event_sequence, receipt.local_commit_seq, commit_row.canonical_hash, \
              receipt.committed_at, ?2 \
         FROM local_commits commit_row \
         CROSS JOIN core_module_receipts receipt \
           INDEXED BY idx_core_module_receipts_local_commit \
        WHERE commit_row.commit_seq IN (SELECT value FROM json_each(?1)) \
          AND receipt.store_epoch = commit_row.store_epoch \
          AND receipt.local_commit_seq = commit_row.commit_seq";
const DELETE_COMMIT_RECEIPTS_SQL: &str = "DELETE FROM core_module_receipts \
     WHERE (store_epoch, local_commit_seq) IN ( \
       SELECT store_epoch, commit_seq FROM local_commits \
       WHERE commit_seq IN (SELECT value FROM json_each(?1)) \
     )";
const DELETE_UNREFERENCED_CHANGE_LOG_SQL: &str = "DELETE FROM change_log \
     WHERE seq IN (SELECT value FROM json_each(?1)) \
       AND NOT EXISTS(SELECT 1 FROM block_mutations WHERE change_log_seq = change_log.seq) \
       AND NOT EXISTS(SELECT 1 FROM block_relocations WHERE change_log_seq = change_log.seq) \
       AND NOT EXISTS(SELECT 1 FROM document_versions WHERE source_change_seq = change_log.seq) \
       AND NOT EXISTS(SELECT 1 FROM database_module_receipts \
                      WHERE change_log_seq = change_log.seq)";
const ACTIVE_RECEIPTS_FROM_START_SQL: &str = "SELECT receipt.module_name, \
       receipt.operation_id, receipt.profile_id, receipt.project_id, receipt.adapter_kind, \
       receipt.operation_kind, receipt.store_epoch, receipt.request_hash, receipt.result_json, \
       receipt.committed_at FROM core_module_receipts receipt \
     WHERE NOT EXISTS (SELECT 1 FROM module_receipt_retention_metadata retention \
       WHERE retention.module_name = receipt.module_name \
         AND retention.operation_id = receipt.operation_id) \
     ORDER BY receipt.module_name, receipt.operation_id LIMIT ?1";
const ACTIVE_RECEIPTS_AFTER_CURSOR_SQL: &str = "SELECT receipt.module_name, \
       receipt.operation_id, receipt.profile_id, receipt.project_id, receipt.adapter_kind, \
       receipt.operation_kind, receipt.store_epoch, receipt.request_hash, receipt.result_json, \
       receipt.committed_at FROM core_module_receipts receipt \
     WHERE (receipt.module_name, receipt.operation_id) > (?1, ?2) \
       AND NOT EXISTS (SELECT 1 FROM module_receipt_retention_metadata retention \
         WHERE retention.module_name = receipt.module_name \
           AND retention.operation_id = receipt.operation_id) \
     ORDER BY receipt.module_name, receipt.operation_id LIMIT ?3";
const DETACHED_RECEIPTS_FROM_START_SQL: &str = "SELECT receipt.module_name, \
       receipt.operation_id, receipt.profile_id, receipt.project_id, receipt.adapter_kind, \
       receipt.operation_kind, receipt.store_epoch, receipt.request_hash, receipt.result_json, \
       receipt.committed_at FROM detached_module_receipts receipt \
     WHERE NOT EXISTS (SELECT 1 FROM module_receipt_retention_metadata retention \
       WHERE retention.module_name = receipt.module_name \
         AND retention.operation_id = receipt.operation_id) \
     ORDER BY receipt.module_name, receipt.operation_id LIMIT ?1";
const DETACHED_RECEIPTS_AFTER_CURSOR_SQL: &str = "SELECT receipt.module_name, \
       receipt.operation_id, receipt.profile_id, receipt.project_id, receipt.adapter_kind, \
       receipt.operation_kind, receipt.store_epoch, receipt.request_hash, receipt.result_json, \
       receipt.committed_at FROM detached_module_receipts receipt \
     WHERE (receipt.module_name, receipt.operation_id) > (?1, ?2) \
       AND NOT EXISTS (SELECT 1 FROM module_receipt_retention_metadata retention \
         WHERE retention.module_name = receipt.module_name \
           AND retention.operation_id = receipt.operation_id) \
     ORDER BY receipt.module_name, receipt.operation_id LIMIT ?3";

type ReceiptBackfillCursor = Option<(String, String)>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RetainedCommit {
    commit_seq: i64,
    sealed_at_ms: i64,
    delivery_bytes: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct OperationalJournalPass {
    pub(crate) backfilled_commits: usize,
    pub(crate) backfilled_receipts: usize,
    pub(crate) pruned_commits: usize,
    pub(crate) pruned_receipts: usize,
}

#[derive(Debug, Clone)]
struct CommitBackfill {
    store_epoch: String,
    commit_seq: i64,
    sealed_at_ms: i64,
    delivery_bytes: i64,
}

#[derive(Debug, Clone)]
struct ReceiptBackfill {
    module_name: String,
    operation_id: String,
    issued_at_ms: i64,
    expires_at_ms: i64,
    receipt_bytes: i64,
}

#[derive(Debug, Clone)]
struct ReceiptBackfillSource {
    module_name: String,
    operation_id: String,
    profile_id: String,
    project_id: Option<String>,
    adapter_kind: String,
    operation_kind: String,
    store_epoch: String,
    request_hash: String,
    result_json: String,
    committed_at: String,
}

/// Payload-heavy legacy measurement is planned on a WAL reader. The writer
/// consumes only this bounded value batch after fencing its durable cursors.
#[derive(Debug, Clone)]
pub(crate) struct OperationalJournalPlan {
    commit_cursor_seq: i64,
    receipt_cursor: ReceiptBackfillCursor,
    commits: Vec<CommitBackfill>,
    receipts: Vec<ReceiptBackfill>,
}

impl OperationalJournalPass {
    pub(crate) fn made_progress(self) -> bool {
        self.backfilled_commits > 0
            || self.backfilled_receipts > 0
            || self.pruned_commits > 0
            || self.pruned_receipts > 0
    }
}

pub(crate) fn read_status(connection: &Connection) -> Result<OperationalJournalStatus, StoreError> {
    let page_size = connection.query_row("PRAGMA page_size", [], |row| row.get::<_, i64>(0))?;
    let freelist_pages =
        connection.query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0))?;
    let status = connection.query_row(
        "SELECT pending_metadata_count > 0 OR pending_receipt_metadata_count > 0 \
                  OR delivery_pressure_active = 1 OR receipt_pressure_active = 1, \
                commit_head_seq, replay_floor_seq, pending_metadata_count, \
                pending_receipt_metadata_count, retained_commit_count, \
                retained_delivery_bytes, retained_receipt_count, retained_receipt_bytes, \
                receipt_floor_at, last_pruned_commit_seq \
         FROM operational_journal_state WHERE id = 1",
        [],
        |row| {
            Ok((
                row.get::<_, bool>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, i64>(10)?,
            ))
        },
    )?;
    let maintenance_due = plan_due_work(connection)?.0;
    let unsigned = |value: i64| {
        u64::try_from(value).map_err(|_| corrupt("Operational Journal status is negative"))
    };
    Ok(OperationalJournalStatus {
        optimizing: status.0 || maintenance_due,
        commit_head_seq: unsigned(status.1)?,
        replay_floor_seq: unsigned(status.2)?,
        pending_commit_metadata: unsigned(status.3)?,
        pending_receipt_metadata: unsigned(status.4)?,
        retained_commit_count: unsigned(status.5)?,
        retained_delivery_bytes: unsigned(status.6)?,
        retained_receipt_count: unsigned(status.7)?,
        retained_receipt_bytes: unsigned(status.8)?,
        receipt_floor_at: status.9,
        last_pruned_commit_seq: unsigned(status.10)?,
        freelist_pages: unsigned(freelist_pages)?,
        reclaimable_bytes: unsigned(freelist_pages.saturating_mul(page_size))?,
    })
}

/// Returns an inexpensive revision token for the maintenance planner. The
/// token advances after every bounded pass without coupling maintenance to a
/// semantic LocalCommit.
pub(crate) fn work_revision(connection: &Connection) -> Result<String, StoreError> {
    let revision = connection.query_row(
        "SELECT maintenance_revision FROM operational_journal_state WHERE id = 1",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(format!("v{POLICY_VERSION}:{revision}"))
}

pub(crate) fn refresh_delivery_pressure(connection: &Connection) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE operational_journal_state \
         SET delivery_pressure_active = CASE \
           WHEN retained_commit_count > ?1 OR retained_delivery_bytes > ?2 \
             OR retained_delivery_bytes + retained_receipt_bytes > ?3 THEN 1 \
           WHEN retained_commit_count <= ?4 AND retained_delivery_bytes <= ?5 \
             AND retained_delivery_bytes + retained_receipt_bytes <= ?6 THEN 0 \
           ELSE delivery_pressure_active END \
         WHERE id = 1",
        params![
            MAX_RETAINED_COMMITS,
            MAX_RETAINED_BYTES,
            MAX_OPERATIONAL_BYTES,
            TARGET_RETAINED_COMMITS,
            TARGET_RETAINED_BYTES,
            TARGET_OPERATIONAL_BYTES,
        ],
    )?;
    Ok(())
}

pub(crate) fn refresh_receipt_pressure(connection: &Connection) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE operational_journal_state \
         SET receipt_pressure_active = CASE \
           WHEN retained_receipt_count > ?1 OR retained_receipt_bytes > ?2 \
             OR retained_delivery_bytes + retained_receipt_bytes > ?3 THEN 1 \
           WHEN retained_receipt_count <= ?4 AND retained_receipt_bytes <= ?5 \
             AND retained_delivery_bytes + retained_receipt_bytes <= ?6 THEN 0 \
           ELSE receipt_pressure_active END \
         WHERE id = 1",
        params![
            MAX_RETAINED_RECEIPTS,
            MAX_RETAINED_RECEIPT_BYTES,
            MAX_OPERATIONAL_BYTES,
            TARGET_RETAINED_RECEIPTS,
            TARGET_RETAINED_RECEIPT_BYTES,
            TARGET_OPERATIONAL_BYTES,
        ],
    )?;
    Ok(())
}

/// Enforces the delivery hard boundary in the same transaction that is about
/// to seal a new evidence group. Background maintenance normally keeps the
/// journal near its low watermark; if it falls behind, one bounded synchronous
/// slice runs and the new mutation is rejected rather than allowing unbounded
/// growth.
pub(crate) fn ensure_capacity_for_seal(
    connection: &Connection,
    incoming_delivery_bytes: i64,
) -> Result<(), StoreError> {
    if incoming_delivery_bytes < 0 {
        return Err(corrupt("Incoming Operational Journal size is invalid"));
    }
    let (count, bytes, receipt_bytes, pending_metadata) = connection.query_row(
        "SELECT retained_commit_count, retained_delivery_bytes, retained_receipt_bytes, \
                pending_metadata_count \
         FROM operational_journal_state WHERE id = 1",
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
    let projected_count = count.saturating_add(1);
    let projected_bytes = bytes.saturating_add(incoming_delivery_bytes);
    if projected_count <= MAX_RETAINED_COMMITS
        && projected_bytes <= MAX_RETAINED_BYTES
        && projected_bytes.saturating_add(receipt_bytes) <= MAX_OPERATIONAL_BYTES
    {
        return Ok(());
    }
    connection.execute(
        "UPDATE operational_journal_state SET delivery_pressure_active = 1 WHERE id = 1",
        [],
    )?;
    // A v136 Store may start above the new envelope. Its legacy rows are
    // already durable and cannot be made bounded in one startup transaction.
    // Admit individually bounded new work while background slices converge;
    // never make migration backlog an availability outage.
    if pending_metadata > 0 && incoming_delivery_bytes <= MAX_RETAINED_BYTES {
        return Ok(());
    }
    let now_ms = now_ms(connection)?;
    let started_at = Instant::now();
    prune_delivery_history(connection, now_ms, started_at)?;
    prune_receipt_history(connection, now_ms, started_at)?;
    let (retained_count, retained_bytes, retained_receipt_bytes) = connection.query_row(
        "SELECT retained_commit_count, retained_delivery_bytes, retained_receipt_bytes \
         FROM operational_journal_state WHERE id = 1",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )?;
    let fits_envelope = retained_count.saturating_add(1) <= MAX_RETAINED_COMMITS
        && retained_bytes.saturating_add(incoming_delivery_bytes) <= MAX_RETAINED_BYTES
        && retained_bytes
            .saturating_add(incoming_delivery_bytes)
            .saturating_add(retained_receipt_bytes)
            <= MAX_OPERATIONAL_BYTES;
    let legacy_overage_converges = (count > MAX_RETAINED_COMMITS
        || bytes > MAX_RETAINED_BYTES
        || bytes.saturating_add(receipt_bytes) > MAX_OPERATIONAL_BYTES)
        && retained_count.saturating_add(1) <= count
        && retained_bytes.saturating_add(incoming_delivery_bytes) <= bytes
        && retained_bytes
            .saturating_add(incoming_delivery_bytes)
            .saturating_add(retained_receipt_bytes)
            <= bytes.saturating_add(receipt_bytes);
    if fits_envelope || legacy_overage_converges {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::ResourceExhausted,
        "Operational Journal is converging to its bounded retention window; retry shortly",
        true,
    ))
}

pub(crate) fn ensure_capacity_for_receipt(
    connection: &Connection,
    incoming_receipt_bytes: i64,
) -> Result<(), StoreError> {
    if incoming_receipt_bytes < 0 {
        return Err(corrupt("Incoming receipt size is invalid"));
    }
    let (initial_count, initial_bytes, initial_delivery_bytes, pending_metadata) = connection
        .query_row(
            "SELECT retained_receipt_count, retained_receipt_bytes, retained_delivery_bytes, \
                pending_receipt_metadata_count \
         FROM operational_journal_state WHERE id = 1",
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
    if initial_count.saturating_add(1) <= MAX_RETAINED_RECEIPTS
        && initial_bytes.saturating_add(incoming_receipt_bytes) <= MAX_RETAINED_RECEIPT_BYTES
        && initial_delivery_bytes
            .saturating_add(initial_bytes)
            .saturating_add(incoming_receipt_bytes)
            <= MAX_OPERATIONAL_BYTES
    {
        return Ok(());
    }
    connection.execute(
        "UPDATE operational_journal_state SET receipt_pressure_active = 1 WHERE id = 1",
        [],
    )?;
    if pending_metadata > 0 && incoming_receipt_bytes <= MAX_RETAINED_RECEIPT_BYTES {
        return Ok(());
    }
    let now_ms = now_ms(connection)?;
    let started_at = Instant::now();
    prune_receipt_history(connection, now_ms, started_at)?;
    prune_delivery_history(connection, now_ms, started_at)?;
    let (count, bytes, delivery_bytes) = connection.query_row(
        "SELECT retained_receipt_count, retained_receipt_bytes, retained_delivery_bytes \
         FROM operational_journal_state WHERE id = 1",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )?;
    let fits_envelope = count.saturating_add(1) <= MAX_RETAINED_RECEIPTS
        && bytes.saturating_add(incoming_receipt_bytes) <= MAX_RETAINED_RECEIPT_BYTES
        && delivery_bytes
            .saturating_add(bytes)
            .saturating_add(incoming_receipt_bytes)
            <= MAX_OPERATIONAL_BYTES;
    let legacy_overage_converges = (initial_count > MAX_RETAINED_RECEIPTS
        || initial_bytes > MAX_RETAINED_RECEIPT_BYTES
        || initial_delivery_bytes.saturating_add(initial_bytes) > MAX_OPERATIONAL_BYTES)
        && count.saturating_add(1) <= initial_count
        && bytes.saturating_add(incoming_receipt_bytes) <= initial_bytes
        && delivery_bytes
            .saturating_add(bytes)
            .saturating_add(incoming_receipt_bytes)
            <= initial_delivery_bytes.saturating_add(initial_bytes);
    if fits_envelope || legacy_overage_converges {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::ResourceExhausted,
        "Operational receipt history is converging to its bounded retention window; retry shortly",
        true,
    ))
}

pub(crate) fn plan_due_work(connection: &Connection) -> Result<(bool, Option<i64>), StoreError> {
    let now_ms = now_ms(connection)?;
    let auto_vacuum = connection.query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))?;
    let freelist_pages =
        connection.query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0))?;
    let summary = connection.query_row(
        "SELECT \
           state.pending_metadata_count, state.retained_commit_count, \
           state.retained_delivery_bytes, state.delivery_pressure_active, \
           COALESCE((SELECT min(sealed_at_ms) FROM local_commit_retention_metadata), ?1), \
           state.pending_receipt_metadata_count, state.retained_receipt_count, \
           state.retained_receipt_bytes, state.receipt_pressure_active, \
           (SELECT min(expires_at_ms) FROM module_receipt_retention_metadata) \
           FROM operational_journal_state state WHERE state.id = 1",
        [now_ms],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, bool>(8)?,
                row.get::<_, Option<i64>>(9)?,
            ))
        },
    )?;
    let due = summary.0 > 0
        || summary.3
        || summary.1 > MAX_RETAINED_COMMITS
        || summary.2 > MAX_RETAINED_BYTES
        || (summary.1 > 1 && summary.4 <= now_ms - SOFT_RETENTION_MS)
        || summary.5 > 0
        || summary.8
        || summary.6 > MAX_RETAINED_RECEIPTS
        || summary.7 > MAX_RETAINED_RECEIPT_BYTES
        || summary.2.saturating_add(summary.7) > MAX_OPERATIONAL_BYTES
        || summary.9.is_some_and(|expires_at| expires_at <= now_ms)
        || (auto_vacuum == 2 && freelist_pages > 0);
    if due {
        return Ok((true, None));
    }
    let delivery_wake = (summary.1 > 1).then_some(summary.4.saturating_add(SOFT_RETENTION_MS));
    let receipt_wake = summary.9;
    Ok((
        false,
        match (delivery_wake, receipt_wake) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (Some(wake), None) | (None, Some(wake)) => Some(wake),
            (None, None) => None,
        },
    ))
}

/// Performs one bounded writer slice. Delivery evidence and exact receipts are
/// detached atomically before their replay-only parent is removed.
pub(crate) fn run_bounded_pass(
    connection: &mut Connection,
) -> Result<OperationalJournalPass, StoreError> {
    let plan = plan_bounded_pass(connection)?;
    run_bounded_pass_with_plan(connection, &plan)
}

pub(crate) fn run_bounded_pass_with_plan(
    connection: &mut Connection,
    plan: &OperationalJournalPlan,
) -> Result<OperationalJournalPass, StoreError> {
    let started_at = Instant::now();
    let pass = with_immediate_transaction(connection, |transaction| {
        let now_ms = now_ms(transaction)?;
        let backfilled_commits = apply_commit_backfill(transaction, plan, started_at)?;
        let backfilled_receipts = apply_receipt_backfill(transaction, plan, started_at)?;
        refresh_delivery_pressure(transaction)?;
        refresh_receipt_pressure(transaction)?;
        let pending = transaction.query_row(
            "SELECT pending_metadata_count, pending_receipt_metadata_count \
             FROM operational_journal_state WHERE id = 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;
        let backfill_completed = pending == (0, 0);
        if backfill_completed && (backfilled_commits > 0 || backfilled_receipts > 0) {
            reconcile_retention_accounting(transaction)?;
        }
        // Migration backfill is a proof boundary: no evidence is eligible for
        // deletion until every retained row is measured and the incremental
        // counters reconcile in the same transaction.
        let maintenance_revision = transaction.query_row(
            "SELECT maintenance_revision FROM operational_journal_state WHERE id = 1",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        let (pruned_commits, pruned_receipts) = if !backfill_completed {
            (0, 0)
        } else if maintenance_revision % 2 == 0 {
            (
                prune_delivery_history(transaction, now_ms, started_at)?,
                prune_receipt_history(transaction, now_ms, started_at)?,
            )
        } else {
            let receipts = prune_receipt_history(transaction, now_ms, started_at)?;
            let commits = prune_delivery_history(transaction, now_ms, started_at)?;
            (commits, receipts)
        };
        let pass = OperationalJournalPass {
            backfilled_commits,
            backfilled_receipts,
            pruned_commits,
            pruned_receipts,
        };
        if pass.made_progress() {
            transaction.execute(
                "UPDATE operational_journal_state \
                 SET maintenance_revision = maintenance_revision + 1, updated_at = ?1 \
                 WHERE id = 1",
                [timestamp_from_ms(now_ms)?],
            )?;
        }
        Ok(pass)
    })?;
    // Logical deletion and page relocation have different cost shapes. Let
    // pruning converge first; then reclaim small fixed-size page chunks and
    // yield once the same writer-time budget is consumed. SQLite bounds a
    // PRAGMA by page count, not elapsed writer time, so one large call would
    // erase the scheduler boundary.
    if pass.made_progress() {
        return Ok(pass);
    }
    let reclaimed_pages = reclaim_free_pages(connection)?;
    if reclaimed_pages == 0 {
        return Ok(pass);
    }
    connection.execute(
        "UPDATE operational_journal_state \
         SET maintenance_revision = maintenance_revision + 1, updated_at = ?1 \
         WHERE id = 1",
        [timestamp_from_ms(now_ms(connection)?)?],
    )?;
    Ok(pass)
}

fn reclaim_free_pages(connection: &Connection) -> Result<usize, StoreError> {
    let auto_vacuum = connection.query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))?;
    if auto_vacuum != 2 {
        return Ok(0);
    }
    let started_at = Instant::now();
    let initial = connection.query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0))?;
    let mut remaining = initial;
    let mut reclaimed_pages = 0usize;
    while remaining > 0 && reclaimed_pages < MAX_VACUUM_PAGES {
        if reclaimed_pages > 0 && started_at.elapsed() >= MAX_SLICE_TIME {
            break;
        }
        let page_budget = (MAX_VACUUM_PAGES - reclaimed_pages).min(VACUUM_CHUNK_PAGES);
        connection.execute_batch(&format!("PRAGMA incremental_vacuum({page_budget});"))?;
        let next = connection.query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0))?;
        if next >= remaining {
            break;
        }
        let chunk_progress = usize::try_from(remaining - next)
            .map_err(|_| corrupt("Operational Journal vacuum progress is invalid"))?;
        reclaimed_pages = reclaimed_pages.saturating_add(chunk_progress);
        remaining = next;
    }
    debug_assert_eq!(
        reclaimed_pages,
        usize::try_from(initial.saturating_sub(remaining)).unwrap_or(usize::MAX)
    );
    Ok(reclaimed_pages)
}

fn reconcile_retention_accounting(connection: &Connection) -> Result<(), StoreError> {
    let measured = connection.query_row(
        "SELECT \
           (SELECT count(*) FROM local_commits WHERE finalized = 1), \
           (SELECT count(*) FROM local_commit_retention_metadata), \
           COALESCE((SELECT sum(delivery_bytes) FROM local_commit_retention_metadata), 0), \
           ((SELECT count(*) FROM core_module_receipts) \
             + (SELECT count(*) FROM detached_module_receipts)), \
           (SELECT count(*) FROM module_receipt_retention_metadata), \
           COALESCE((SELECT sum(receipt_bytes) FROM module_receipt_retention_metadata), 0), \
           state.retained_commit_count, state.retained_delivery_bytes, \
           state.retained_receipt_count, state.retained_receipt_bytes \
         FROM operational_journal_state state WHERE state.id = 1",
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
            ))
        },
    )?;
    if measured.0 != measured.1
        || measured.0 != measured.6
        || measured.2 != measured.7
        || measured.3 != measured.4
        || measured.3 != measured.8
        || measured.5 != measured.9
    {
        return Err(corrupt(
            "Operational Journal accounting did not reconcile after migration backfill",
        ));
    }
    Ok(())
}

pub(crate) fn plan_bounded_pass(
    connection: &Connection,
) -> Result<OperationalJournalPlan, StoreError> {
    let transaction = connection.unchecked_transaction()?;
    let now_ms = now_ms(&transaction)?;
    let (commit_cursor_seq, commits) = plan_commit_backfill(&transaction, now_ms)?;
    let (receipt_cursor, receipts) = plan_receipt_backfill(&transaction)?;
    transaction.commit()?;
    Ok(OperationalJournalPlan {
        commit_cursor_seq,
        receipt_cursor,
        commits,
        receipts,
    })
}

fn plan_commit_backfill(
    connection: &Connection,
    now_ms: i64,
) -> Result<(i64, Vec<CommitBackfill>), StoreError> {
    let (cursor_seq, pending_count) = connection.query_row(
        "SELECT metadata_backfill_cursor_seq, pending_metadata_count \
         FROM operational_journal_state WHERE id = 1",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    if pending_count == 0 {
        return Ok((cursor_seq, Vec::new()));
    }
    let commits = connection
        .prepare(
            "SELECT commit_row.store_epoch, commit_row.commit_seq, \
                    COALESCE(CAST(unixepoch(commit_row.committed_at) * 1000 AS INTEGER), ?1), \
                    length(commit_row.projection_json) + length(commit_row.audience_json) \
                      + length(commit_row.manifest_json) \
                      + COALESCE(( \
                          SELECT sum(length(effect.resources_json) \
                            + length(effect.projection_impact_json)) \
                          FROM local_commit_effects effect \
                          WHERE effect.store_epoch = commit_row.store_epoch \
                            AND effect.commit_seq = commit_row.commit_seq \
                        ), 0) \
                      + COALESCE(( \
                          SELECT sum(length(atom.required_resources_json) \
                            + length(atom.payload_json)) \
                          FROM local_commit_delivery_atoms atom \
                          WHERE atom.store_epoch = commit_row.store_epoch \
                            AND atom.commit_seq = commit_row.commit_seq \
                        ), 0) \
                      + COALESCE(( \
                          SELECT sum(length(effect.descriptor_json)) \
                          FROM local_commit_sealed_projection_effects effect \
                          WHERE effect.store_epoch = commit_row.store_epoch \
                            AND effect.commit_seq = commit_row.commit_seq \
                        ), 0) \
                      + COALESCE(( \
                          SELECT sum(document.update_byte_length) \
                          FROM local_commit_documents document \
                          WHERE document.store_epoch = commit_row.store_epoch \
                            AND document.commit_seq = commit_row.commit_seq \
                        ), 0) \
             FROM local_commits commit_row \
             LEFT JOIN local_commit_retention_metadata retention \
               ON retention.store_epoch = commit_row.store_epoch \
              AND retention.commit_seq = commit_row.commit_seq \
             WHERE commit_row.finalized = 1 AND retention.commit_seq IS NULL \
               AND commit_row.commit_seq > ?2 \
             ORDER BY commit_row.commit_seq LIMIT ?3",
        )?
        .query_map(
            params![now_ms, cursor_seq, MAX_SLICE_COMMITS as i64],
            |row| {
                Ok(CommitBackfill {
                    store_epoch: row.get(0)?,
                    commit_seq: row.get(1)?,
                    sealed_at_ms: row.get(2)?,
                    delivery_bytes: row.get(3)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if commits.is_empty() {
        return Err(corrupt(
            "Operational Journal commit backfill cursor reached the end before accounting completed",
        ));
    }
    Ok((cursor_seq, commits))
}

fn apply_commit_backfill(
    connection: &Connection,
    plan: &OperationalJournalPlan,
    started_at: Instant,
) -> Result<usize, StoreError> {
    let (cursor_seq, pending_count) = connection.query_row(
        "SELECT metadata_backfill_cursor_seq, pending_metadata_count \
         FROM operational_journal_state WHERE id = 1",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    if cursor_seq != plan.commit_cursor_seq {
        return Err(stale_backfill_plan());
    }
    if pending_count == 0 {
        return Ok(0);
    }
    if plan.commits.is_empty() {
        return Err(corrupt(
            "Operational Journal commit backfill plan ended before accounting completed",
        ));
    }
    let mut backfilled_bytes = 0i64;
    let mut backfilled_count = 0usize;
    for commit in &plan.commits {
        if backfilled_count > 0 && started_at.elapsed() >= MAX_SLICE_TIME {
            break;
        }
        connection.execute(
            "INSERT INTO local_commit_retention_metadata( \
               store_epoch, commit_seq, sealed_at_ms, delivery_bytes \
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                commit.store_epoch,
                commit.commit_seq,
                commit.sealed_at_ms,
                commit.delivery_bytes
            ],
        )?;
        backfilled_bytes = backfilled_bytes
            .checked_add(commit.delivery_bytes)
            .ok_or_else(|| corrupt("Operational Journal byte accounting overflowed"))?;
        backfilled_count += 1;
    }
    if backfilled_count > 0 {
        let backfill_cursor = plan.commits[backfilled_count - 1].commit_seq;
        let changed = connection.execute(
            "UPDATE operational_journal_state \
             SET pending_metadata_count = pending_metadata_count - ?1, \
                 retained_delivery_bytes = retained_delivery_bytes + ?2, \
                 metadata_backfill_cursor_seq = ?3 \
             WHERE id = 1 AND pending_metadata_count >= ?1 \
               AND metadata_backfill_cursor_seq < ?3",
            params![backfilled_count as i64, backfilled_bytes, backfill_cursor],
        )?;
        if changed != 1 {
            return Err(corrupt("Operational Journal metadata accounting diverged"));
        }
    }
    Ok(backfilled_count)
}

fn read_receipt_backfill_source(row: &Row<'_>) -> rusqlite::Result<ReceiptBackfillSource> {
    Ok(ReceiptBackfillSource {
        module_name: row.get(0)?,
        operation_id: row.get(1)?,
        profile_id: row.get(2)?,
        project_id: row.get(3)?,
        adapter_kind: row.get(4)?,
        operation_kind: row.get(5)?,
        store_epoch: row.get(6)?,
        request_hash: row.get(7)?,
        result_json: row.get(8)?,
        committed_at: row.get(9)?,
    })
}

fn query_receipt_backfill_source(
    connection: &Connection,
    from_start_sql: &str,
    after_cursor_sql: &str,
    cursor: Option<&(String, String)>,
) -> Result<Vec<ReceiptBackfillSource>, StoreError> {
    let mut statement = connection.prepare(if cursor.is_some() {
        after_cursor_sql
    } else {
        from_start_sql
    })?;
    let receipts = match cursor {
        Some((module_name, operation_id)) => statement
            .query_map(
                params![module_name, operation_id, MAX_SLICE_COMMITS as i64],
                read_receipt_backfill_source,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        None => statement
            .query_map([MAX_SLICE_COMMITS as i64], read_receipt_backfill_source)?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    };
    Ok(receipts)
}

fn plan_receipt_backfill(
    connection: &Connection,
) -> Result<(ReceiptBackfillCursor, Vec<ReceiptBackfill>), StoreError> {
    let (operation_identity_cutover_ms, cursor_module, cursor_operation, pending_count) =
        connection.query_row(
            "SELECT CAST(unixepoch(operation_identity_cutover_at, 'subsec') * 1000 AS INTEGER), \
                receipt_backfill_cursor_module, receipt_backfill_cursor_operation_id, \
                pending_receipt_metadata_count \
         FROM operational_journal_state WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )?;
    if cursor_module.is_some() != cursor_operation.is_some() {
        return Err(corrupt("Operational receipt backfill cursor is incomplete"));
    }
    if pending_count == 0 {
        return Ok((cursor_module.zip(cursor_operation), Vec::new()));
    }
    let cursor = cursor_module.clone().zip(cursor_operation.clone());
    let mut receipts = query_receipt_backfill_source(
        connection,
        ACTIVE_RECEIPTS_FROM_START_SQL,
        ACTIVE_RECEIPTS_AFTER_CURSOR_SQL,
        cursor.as_ref(),
    )?;
    receipts.extend(query_receipt_backfill_source(
        connection,
        DETACHED_RECEIPTS_FROM_START_SQL,
        DETACHED_RECEIPTS_AFTER_CURSOR_SQL,
        cursor.as_ref(),
    )?);
    receipts.sort_unstable_by(|left, right| {
        left.module_name
            .cmp(&right.module_name)
            .then_with(|| left.operation_id.cmp(&right.operation_id))
    });
    if receipts.windows(2).any(|pair| {
        pair[0].module_name == pair[1].module_name && pair[0].operation_id == pair[1].operation_id
    }) {
        return Err(corrupt(
            "Operational receipt exists in both active and detached storage",
        ));
    }
    receipts.truncate(MAX_SLICE_COMMITS);
    if receipts.is_empty() {
        return Err(corrupt(
            "Operational receipt backfill cursor reached the end before accounting completed",
        ));
    }
    let receipts = receipts
        .into_iter()
        .map(|receipt| {
            let (issued_at_ms, expires_at_ms, receipt_bytes) =
                super::module_receipts::receipt_retention_values(
                    operation_identity_cutover_ms,
                    &receipt.operation_id,
                    &receipt.committed_at,
                    &receipt.module_name,
                    &receipt.profile_id,
                    receipt.project_id.as_deref(),
                    &receipt.adapter_kind,
                    &receipt.operation_kind,
                    &receipt.store_epoch,
                    &receipt.request_hash,
                    &receipt.result_json,
                )?;
            Ok(ReceiptBackfill {
                module_name: receipt.module_name,
                operation_id: receipt.operation_id,
                issued_at_ms,
                expires_at_ms,
                receipt_bytes,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok((cursor_module.zip(cursor_operation), receipts))
}

fn apply_receipt_backfill(
    connection: &Connection,
    plan: &OperationalJournalPlan,
    started_at: Instant,
) -> Result<usize, StoreError> {
    let (cursor_module, cursor_operation, pending_count) = connection.query_row(
        "SELECT receipt_backfill_cursor_module, receipt_backfill_cursor_operation_id, \
                pending_receipt_metadata_count \
         FROM operational_journal_state WHERE id = 1",
        [],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )?;
    let current_cursor = cursor_module.zip(cursor_operation);
    if current_cursor != plan.receipt_cursor {
        return Err(stale_backfill_plan());
    }
    if pending_count == 0 {
        return Ok(0);
    }
    if plan.receipts.is_empty() {
        return Err(corrupt(
            "Operational receipt backfill plan ended before accounting completed",
        ));
    }
    let mut backfilled_bytes = 0i64;
    let mut backfilled_count = 0usize;
    for receipt in &plan.receipts {
        if backfilled_count > 0 && started_at.elapsed() >= MAX_SLICE_TIME {
            break;
        }
        connection.execute(
            "INSERT INTO module_receipt_retention_metadata( \
               module_name, operation_id, issued_at_ms, expires_at_ms, receipt_bytes \
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                receipt.module_name,
                receipt.operation_id,
                receipt.issued_at_ms,
                receipt.expires_at_ms,
                receipt.receipt_bytes,
            ],
        )?;
        backfilled_bytes = backfilled_bytes
            .checked_add(receipt.receipt_bytes)
            .ok_or_else(|| corrupt("Operational receipt byte accounting overflowed"))?;
        backfilled_count += 1;
    }
    if backfilled_count > 0 {
        let backfill_cursor = &plan.receipts[backfilled_count - 1];
        let changed = connection.execute(
            "UPDATE operational_journal_state \
             SET pending_receipt_metadata_count = pending_receipt_metadata_count - ?1, \
                 retained_receipt_bytes = retained_receipt_bytes + ?2, \
                 receipt_backfill_cursor_module = ?3, \
                 receipt_backfill_cursor_operation_id = ?4 \
             WHERE id = 1 AND pending_receipt_metadata_count >= ?1",
            params![
                backfilled_count as i64,
                backfilled_bytes,
                backfill_cursor.module_name,
                backfill_cursor.operation_id,
            ],
        )?;
        if changed != 1 {
            return Err(corrupt("Operational receipt metadata accounting diverged"));
        }
    }
    Ok(backfilled_count)
}

fn prune_delivery_history(
    connection: &Connection,
    now_ms: i64,
    started_at: Instant,
) -> Result<usize, StoreError> {
    if started_at.elapsed() >= MAX_SLICE_TIME {
        return Ok(0);
    }
    let (mut remaining_count, mut remaining_bytes, commit_head, pressure_active) = connection
        .query_row(
            "SELECT retained_commit_count, retained_delivery_bytes, commit_head_seq, \
                delivery_pressure_active \
         FROM operational_journal_state WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )?;
    if remaining_count <= 1 {
        return Ok(0);
    }
    let oldest = connection
        .prepare(DELIVERY_PRUNE_CANDIDATES_SQL)?
        .query_map(params![commit_head, MAX_SLICE_COMMITS as i64], |row| {
            Ok(RetainedCommit {
                commit_seq: row.get(0)?,
                sealed_at_ms: row.get(1)?,
                delivery_bytes: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut candidates = Vec::new();
    let mut slice_bytes = 0i64;
    let mut planned_remaining_count = remaining_count;
    let mut planned_remaining_bytes = remaining_bytes;
    for candidate in oldest {
        let expired = candidate.sealed_at_ms <= now_ms - SOFT_RETENTION_MS;
        let over_count = pressure_active && planned_remaining_count > TARGET_RETAINED_COMMITS;
        let over_bytes = pressure_active && planned_remaining_bytes > TARGET_RETAINED_BYTES;
        if !expired && !over_count && !over_bytes {
            break;
        }
        if !candidates.is_empty()
            && (slice_bytes.saturating_add(candidate.delivery_bytes) > MAX_SLICE_BYTES
                || started_at.elapsed() >= MAX_SLICE_TIME)
        {
            break;
        }
        slice_bytes = slice_bytes.saturating_add(candidate.delivery_bytes);
        planned_remaining_count -= 1;
        planned_remaining_bytes = planned_remaining_bytes.saturating_sub(candidate.delivery_bytes);
        candidates.push(candidate);
    }
    if candidates.is_empty() {
        return Ok(0);
    }
    let pruned_commit_seqs = candidates
        .iter()
        .map(|candidate| candidate.commit_seq)
        .collect::<Vec<_>>();
    let pruned_delivery_bytes = candidates
        .iter()
        .map(|candidate| candidate.delivery_bytes)
        .fold(0i64, i64::saturating_add);
    delete_delivery_candidates(connection, &pruned_commit_seqs, now_ms)?;
    remaining_count = remaining_count.saturating_sub(pruned_commit_seqs.len() as i64);
    remaining_bytes = remaining_bytes.saturating_sub(pruned_delivery_bytes);
    let replay_floor = connection
        .query_row(
            "SELECT min(commit_seq) FROM local_commits WHERE finalized = 1",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )?
        .unwrap_or(commit_head.saturating_add(1));
    connection.execute(
        "UPDATE operational_journal_state \
         SET replay_floor_seq = ?1, last_pruned_commit_seq = ?2, \
             retained_commit_count = ?3, retained_delivery_bytes = ?4, \
             delivery_pressure_active = CASE \
               WHEN ?3 > ?5 OR ?4 > ?6 OR ?4 + retained_receipt_bytes > ?7 \
               THEN 1 ELSE 0 END, \
             policy_version = ?8, updated_at = ?9 WHERE id = 1",
        params![
            replay_floor,
            pruned_commit_seqs.last().copied().unwrap_or_default(),
            remaining_count,
            remaining_bytes,
            TARGET_RETAINED_COMMITS,
            TARGET_RETAINED_BYTES,
            TARGET_OPERATIONAL_BYTES,
            POLICY_VERSION,
            timestamp_from_ms(now_ms)?,
        ],
    )?;
    Ok(pruned_commit_seqs.len())
}

fn detach_commit_receipts(
    connection: &Connection,
    commit_seqs_json: &str,
    now_ms: i64,
) -> Result<(), StoreError> {
    connection.execute(
        DETACH_COMMIT_RECEIPTS_SQL,
        params![commit_seqs_json, now_ms],
    )?;
    connection.execute(DELETE_COMMIT_RECEIPTS_SQL, [commit_seqs_json])?;
    Ok(())
}

fn delete_delivery_candidates(
    connection: &Connection,
    commit_seqs: &[i64],
    now_ms: i64,
) -> Result<(), StoreError> {
    let commit_seqs_json = serde_json::to_string(commit_seqs)
        .map_err(|_| corrupt("Operational commit identities cannot be encoded"))?;
    detach_commit_receipts(connection, &commit_seqs_json, now_ms)?;
    let change_log_seqs = connection
        .prepare(
            "SELECT change_log_seq FROM local_commit_effects \
             WHERE commit_seq IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([&commit_seqs_json], |row| row.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let deleted = connection.execute(
        "DELETE FROM local_commits WHERE finalized = 1 \
         AND commit_seq IN (SELECT value FROM json_each(?1))",
        [&commit_seqs_json],
    )?;
    if deleted != commit_seqs.len() {
        return Err(corrupt("Operational Journal lost a LocalCommit candidate"));
    }
    if change_log_seqs.is_empty() {
        return Ok(());
    }
    let change_log_seqs_json = serde_json::to_string(&change_log_seqs)
        .map_err(|_| corrupt("Operational change identities cannot be encoded"))?;
    connection.execute(DELETE_UNREFERENCED_CHANGE_LOG_SQL, [&change_log_seqs_json])?;
    Ok(())
}

fn prune_receipt_history(
    connection: &Connection,
    now_ms: i64,
    started_at: Instant,
) -> Result<usize, StoreError> {
    if started_at.elapsed() >= MAX_SLICE_TIME {
        return Ok(0);
    }
    let (mut remaining_count, mut remaining_bytes, delivery_bytes, pressure_active) = connection
        .query_row(
            "SELECT retained_receipt_count, retained_receipt_bytes, \
                    retained_delivery_bytes, receipt_pressure_active \
             FROM operational_journal_state WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )?;
    let oldest = connection
        .prepare(RECEIPT_PRUNE_CANDIDATES_SQL)?
        .query_map([MAX_SLICE_COMMITS as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut candidates = Vec::new();
    let mut slice_bytes = 0i64;
    let mut planned_remaining_count = remaining_count;
    let mut planned_remaining_bytes = remaining_bytes;
    for candidate in oldest {
        let expired = candidate.3 <= now_ms;
        let over_count = pressure_active && planned_remaining_count > TARGET_RETAINED_RECEIPTS;
        let over_bytes = pressure_active && planned_remaining_bytes > TARGET_RETAINED_RECEIPT_BYTES;
        let over_global = pressure_active
            && delivery_bytes.saturating_add(planned_remaining_bytes) > TARGET_OPERATIONAL_BYTES;
        if !expired && !over_count && !over_bytes && !over_global {
            break;
        }
        if !candidates.is_empty()
            && (slice_bytes.saturating_add(candidate.4) > MAX_SLICE_BYTES
                || started_at.elapsed() >= MAX_SLICE_TIME)
        {
            break;
        }
        slice_bytes = slice_bytes.saturating_add(candidate.4);
        planned_remaining_count = planned_remaining_count.saturating_sub(1);
        planned_remaining_bytes = planned_remaining_bytes.saturating_sub(candidate.4);
        candidates.push(candidate);
    }
    if candidates.is_empty() {
        return Ok(0);
    }
    let mut receipt_floor = connection.query_row(
        "SELECT CAST(unixepoch(receipt_floor_at, 'subsec') * 1000 AS INTEGER), \
                receipt_floor_module, receipt_floor_operation_id \
         FROM operational_journal_state WHERE id = 1",
        [],
        |row| {
            Ok(
                match (
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ) {
                    (Some(at), Some(module), Some(operation)) => Some((at, module, operation)),
                    (None, None, None) => None,
                    _ => return Err(rusqlite::Error::InvalidQuery),
                },
            )
        },
    )?;
    for (module_name, operation_id, issued_at_ms, _, _) in &candidates {
        let candidate_floor = (*issued_at_ms, module_name.clone(), operation_id.clone());
        if receipt_floor
            .as_ref()
            .is_none_or(|floor| candidate_floor > *floor)
        {
            receipt_floor = Some(candidate_floor);
        }
    }
    delete_receipt_candidates(connection, &candidates)?;
    let pruned_receipts = candidates.len();
    remaining_count = remaining_count.saturating_sub(pruned_receipts as i64);
    remaining_bytes = remaining_bytes.saturating_sub(
        candidates
            .iter()
            .map(|candidate| candidate.4)
            .fold(0i64, i64::saturating_add),
    );
    let (receipt_floor_ms, receipt_floor_module, receipt_floor_operation_id) =
        receipt_floor.ok_or_else(|| corrupt("Operational receipt floor candidate disappeared"))?;
    connection.execute(
        "UPDATE operational_journal_state \
         SET receipt_floor_at = ?1, receipt_floor_module = ?2, \
             receipt_floor_operation_id = ?3, retained_receipt_count = ?4, \
             retained_receipt_bytes = ?5, \
             receipt_pressure_active = CASE \
               WHEN ?4 > ?6 OR ?5 > ?7 OR retained_delivery_bytes + ?5 > ?8 \
               THEN 1 ELSE 0 END, \
             policy_version = ?9, updated_at = ?10 WHERE id = 1",
        params![
            timestamp_from_ms(receipt_floor_ms)?,
            receipt_floor_module,
            receipt_floor_operation_id,
            remaining_count,
            remaining_bytes,
            TARGET_RETAINED_RECEIPTS,
            TARGET_RETAINED_RECEIPT_BYTES,
            TARGET_OPERATIONAL_BYTES,
            POLICY_VERSION,
            timestamp_from_ms(now_ms)?,
        ],
    )?;
    Ok(pruned_receipts)
}

fn delete_receipt_candidates(
    connection: &Connection,
    candidates: &[(String, String, i64, i64, i64)],
) -> Result<(), StoreError> {
    let identities = candidates
        .iter()
        .map(|candidate| [candidate.0.as_str(), candidate.1.as_str()])
        .collect::<Vec<_>>();
    let identities_json = serde_json::to_string(&identities)
        .map_err(|_| corrupt("Operational receipt identities cannot be encoded"))?;
    let active = connection.execute(
        "WITH candidates(module_name, operation_id) AS MATERIALIZED ( \
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') \
           FROM json_each(?1) \
         ) \
         DELETE FROM core_module_receipts \
         WHERE (module_name, operation_id) IN (SELECT module_name, operation_id FROM candidates)",
        [&identities_json],
    )?;
    let detached = connection.execute(
        "WITH candidates(module_name, operation_id) AS MATERIALIZED ( \
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') \
           FROM json_each(?1) \
         ) \
         DELETE FROM detached_module_receipts \
         WHERE (module_name, operation_id) IN (SELECT module_name, operation_id FROM candidates)",
        [&identities_json],
    )?;
    if active.saturating_add(detached) != candidates.len() {
        return Err(corrupt("Operational receipt ownership diverged"));
    }
    let metadata = connection.execute(
        "WITH candidates(module_name, operation_id) AS MATERIALIZED ( \
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') \
           FROM json_each(?1) \
         ) \
         DELETE FROM module_receipt_retention_metadata \
         WHERE (module_name, operation_id) IN (SELECT module_name, operation_id FROM candidates)",
        [&identities_json],
    )?;
    if metadata != candidates.len() {
        return Err(corrupt("Operational receipt metadata disappeared"));
    }
    Ok(())
}

fn now_ms(connection: &Connection) -> Result<i64, StoreError> {
    connection
        .query_row(
            "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(StoreError::from)
}

pub(crate) fn timestamp_from_ms(value: i64) -> Result<String, StoreError> {
    chrono::DateTime::from_timestamp_millis(value)
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| corrupt("Operational Journal timestamp exceeds its supported range"))
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn stale_backfill_plan() -> StoreError {
    StoreError::new(
        StoreErrorCode::Conflict,
        "Operational Journal backfill plan is stale; plan the bounded pass again",
        true,
    )
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rusqlite::params;

    use super::*;
    use crate::infrastructure::migration::prepare_test_current_store;
    use crate::infrastructure::module_receipts::read_module_receipt;
    use crate::infrastructure::sqlite::open_writer;

    fn seed_commit(
        connection: &Connection,
        commit_seq: i64,
        operation_kind: &str,
        committed_at: &str,
    ) {
        let operation_id = format!("operation:{commit_seq}");
        connection
            .execute(
                "INSERT INTO local_commits( \
                   commit_seq, store_epoch, operation_id, committed_at, \
                   projection_impact_json, canonical_hash, actor_json, finalized \
                 ) VALUES (?1, 'epoch:journal', ?2, ?3, '{}', ?4, json_object('type','service','kind','maintenance'), 1)",
                params![
                    commit_seq,
                    operation_id,
                    committed_at,
                    format!("{commit_seq:064x}")
                ],
            )
            .expect("LocalCommit");
        connection
            .execute(
                "INSERT INTO local_commit_retention_metadata( \
                   store_epoch, commit_seq, sealed_at_ms, delivery_bytes \
                 ) VALUES ('epoch:journal', ?1, 1, 100)",
                [commit_seq],
            )
            .expect("retention metadata");
        connection
            .execute(
                "INSERT INTO core_module_receipts( \
                   module_name, operation_id, profile_id, adapter_kind, operation_kind, \
                   store_epoch, request_hash, result_json, local_commit_seq, committed_at \
                 ) VALUES ( \
                   'store_administration', ?1, 'profile:journal', 'test', ?2, \
                   'epoch:journal', ?3, '{\"local_commit\":null}', ?4, ?5 \
                 )",
                params![
                    operation_id,
                    operation_kind,
                    "f".repeat(64),
                    commit_seq,
                    committed_at,
                ],
            )
            .expect("module receipt");
    }

    fn pressure_flags(connection: &Connection) -> (bool, bool) {
        connection
            .query_row(
                "SELECT delivery_pressure_active, receipt_pressure_active \
                 FROM operational_journal_state WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("pressure flags")
    }

    #[test]
    fn receipt_backfill_cursor_uses_each_receipt_primary_key_without_a_union_sort() {
        let directory = nodex_platform::test_support::tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        prepare_test_current_store(&mut connection, Path::new("/__journal_plan_test__"))
            .expect("current Store");

        for query in [
            ACTIVE_RECEIPTS_AFTER_CURSOR_SQL,
            DETACHED_RECEIPTS_AFTER_CURSOR_SQL,
        ] {
            let plan = connection
                .prepare(&format!("EXPLAIN QUERY PLAN {query}"))
                .expect("receipt backfill query")
                .query_map(params!["automation", "operation:cursor", 128], |row| {
                    row.get::<_, String>(3)
                })
                .expect("receipt backfill plan")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("receipt backfill plan rows")
                .join("\n");
            assert!(
                plan.contains("SEARCH receipt USING PRIMARY KEY")
                    && plan.contains("SEARCH retention USING PRIMARY KEY")
                    && !plan.contains("USE TEMP B-TREE"),
                "receipt cursor lost its bounded index plan:\n{plan}",
            );
        }
    }

    #[test]
    fn prune_candidates_use_bounded_ordered_index_plans() {
        let directory = nodex_platform::test_support::tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        prepare_test_current_store(&mut connection, Path::new("/__journal_prune_plan_test__"))
            .expect("current Store");

        let plan = connection
            .prepare(&format!(
                "EXPLAIN QUERY PLAN {DELIVERY_PRUNE_CANDIDATES_SQL}"
            ))
            .expect("delivery prune query")
            .query_map(params![1_000, MAX_SLICE_COMMITS as i64], |row| {
                row.get::<_, String>(3)
            })
            .expect("delivery prune plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("delivery prune plan rows")
            .join("\n");
        assert!(
            plan.contains("SEARCH commit_row USING INTEGER PRIMARY KEY")
                && plan.contains("SEARCH retention USING PRIMARY KEY")
                && !plan.contains("USE TEMP B-TREE"),
            "delivery prune lost its bounded index plan:\n{plan}",
        );

        let receipt_plan = connection
            .prepare(&format!(
                "EXPLAIN QUERY PLAN {RECEIPT_PRUNE_CANDIDATES_SQL}"
            ))
            .expect("receipt prune query")
            .query_map([MAX_SLICE_COMMITS as i64], |row| row.get::<_, String>(3))
            .expect("receipt prune plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("receipt prune plan rows")
            .join("\n");
        assert!(
            receipt_plan.contains("idx_module_receipt_retention_prune")
                && !receipt_plan.contains("USE TEMP B-TREE"),
            "receipt prune lost its bounded index plan:\n{receipt_plan}",
        );

        let commit_seqs_json = "[1,2,3]";
        let detach_plan = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {DETACH_COMMIT_RECEIPTS_SQL}"))
            .expect("receipt detach query")
            .query_map(params![commit_seqs_json, 1], |row| row.get::<_, String>(3))
            .expect("receipt detach plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("receipt detach plan rows")
            .join("\n");
        assert!(
            detach_plan.contains("SEARCH commit_row USING INTEGER PRIMARY KEY")
                && detach_plan
                    .contains("SEARCH receipt USING INDEX idx_core_module_receipts_local_commit")
                && !detach_plan.contains("SCAN receipt"),
            "receipt detach lost its commit-driven lookup plan:\n{detach_plan}",
        );

        let delete_plan = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {DELETE_COMMIT_RECEIPTS_SQL}"))
            .expect("receipt delete query")
            .query_map([commit_seqs_json], |row| row.get::<_, String>(3))
            .expect("receipt delete plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("receipt delete plan rows")
            .join("\n");
        assert!(
            delete_plan.contains("SEARCH core_module_receipts USING")
                && delete_plan.contains("idx_core_module_receipts_local_commit")
                && delete_plan.contains("SEARCH local_commits USING INTEGER PRIMARY KEY")
                && !delete_plan.contains("SCAN core_module_receipts"),
            "receipt delete lost its commit-driven lookup plan:\n{delete_plan}",
        );

        let change_log_plan = connection
            .prepare(&format!(
                "EXPLAIN QUERY PLAN {DELETE_UNREFERENCED_CHANGE_LOG_SQL}"
            ))
            .expect("change-log cleanup query")
            .query_map([commit_seqs_json], |row| row.get::<_, String>(3))
            .expect("change-log cleanup plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("change-log cleanup plan rows")
            .join("\n");
        for index in [
            "idx_document_versions_source_change",
            "idx_database_module_receipts_change_log",
            "idx_core_module_receipts_event_sequence",
        ] {
            assert!(
                change_log_plan.contains(index),
                "change-log cleanup lost {index}:\n{change_log_plan}",
            );
        }
        for table in [
            "document_versions",
            "database_module_receipts",
            "core_module_receipts",
        ] {
            assert!(
                !change_log_plan.contains(&format!("SCAN {table}")),
                "change-log cleanup scans {table}:\n{change_log_plan}",
            );
        }
    }

    #[test]
    fn bounded_pass_detaches_exact_receipts_and_advances_replay_floor() {
        let directory = nodex_platform::test_support::tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        prepare_test_current_store(&mut connection, Path::new("/__journal_test__"))
            .expect("current Store");
        connection
            .execute(
                "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                 VALUES (1, 'epoch:journal', '2026-01-01', '2026-01-01')",
                [],
            )
            .expect("Store identity");
        seed_commit(&connection, 1, "run_maintenance", "2099-01-01T00:00:00Z");
        seed_commit(&connection, 2, "apply_yjs_update", "2099-01-01T00:00:01Z");
        seed_commit(&connection, 3, "apply_yjs_update", "2099-01-01T00:00:02Z");
        connection
            .execute(
                "UPDATE operational_journal_state \
                 SET commit_head_seq = 3, replay_floor_seq = 1, \
                     retained_commit_count = 3, retained_delivery_bytes = 300, \
                     retained_receipt_count = 3, pending_receipt_metadata_count = 3",
                [],
            )
            .expect("journal state");

        assert!(plan_due_work(&connection).expect("due work").0);
        let pass = run_bounded_pass(&mut connection).expect("bounded pass");

        assert_eq!(pass.pruned_commits, 2);
        assert_eq!(pass.backfilled_receipts, 3);
        assert_eq!(pass.pruned_receipts, 0);
        assert_eq!(
            connection
                .query_row(
                    "SELECT replay_floor_seq, commit_head_seq, retained_commit_count, \
                            retained_delivery_bytes FROM operational_journal_state",
                    [],
                    |row| Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?
                    )),
                )
                .expect("journal boundaries"),
            (3, 3, 1, 100),
        );
        let first = read_module_receipt(&connection, "store_administration", "operation:1")
            .expect("first detached receipt")
            .expect("receipt");
        assert!(first.detached);
        let detached = read_module_receipt(&connection, "store_administration", "operation:2")
            .expect("detached receipt")
            .expect("receipt");
        assert!(detached.detached);
        assert_eq!(detached.local_commit_seq, Some(2));
        assert_eq!(detached.commit_manifest_hash, Some(format!("{:064x}", 2)),);
        let active = read_module_receipt(&connection, "store_administration", "operation:3")
            .expect("active receipt")
            .expect("receipt");
        assert!(!active.detached);
    }

    #[test]
    fn migration_backfill_resumes_from_durable_commit_and_receipt_cursors() {
        let directory = nodex_platform::test_support::tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        prepare_test_current_store(&mut connection, Path::new("/__journal_backfill_test__"))
            .expect("current Store");
        connection
            .execute(
                "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                 VALUES (1, 'epoch:backfill', '2026-01-01', '2026-01-01')",
                [],
            )
            .expect("Store identity");
        for commit_seq in 1..=300i64 {
            let operation_id = format!("operation:{commit_seq:04}");
            connection
                .execute(
                    "INSERT INTO local_commits( \
                       commit_seq, store_epoch, operation_id, committed_at, \
                       projection_impact_json, canonical_hash, actor_json, finalized \
                     ) VALUES (?1, 'epoch:backfill', ?2, '2099-01-01T00:00:00Z', \
                       '{}', ?3, json_object('type','service','kind','maintenance'), 1)",
                    params![commit_seq, operation_id, format!("{commit_seq:064x}")],
                )
                .expect("legacy LocalCommit");
            if commit_seq % 2 == 1 {
                connection
                    .execute(
                        "INSERT INTO core_module_receipts( \
                           module_name, operation_id, profile_id, adapter_kind, operation_kind, \
                           store_epoch, request_hash, result_json, local_commit_seq, committed_at \
                         ) VALUES ( \
                           'store_administration', ?1, 'profile:backfill', 'test', 'legacy', \
                           'epoch:backfill', ?2, '{\"local_commit\":null}', ?3, \
                           '2099-01-01T00:00:00Z' \
                         )",
                        params![operation_id, "f".repeat(64), commit_seq],
                    )
                    .expect("active legacy receipt");
            } else {
                connection
                    .execute(
                        "INSERT INTO detached_module_receipts( \
                           module_name, operation_id, profile_id, adapter_kind, operation_kind, \
                           store_epoch, request_hash, result_json, local_commit_seq, \
                           commit_manifest_hash, committed_at, detached_at_ms \
                         ) VALUES ( \
                           'store_administration', ?1, 'profile:backfill', 'test', 'legacy', \
                           'epoch:backfill', ?2, '{\"local_commit\":null}', ?3, ?4, \
                           '2099-01-01T00:00:00Z', 1 \
                         )",
                        params![
                            operation_id,
                            "f".repeat(64),
                            commit_seq,
                            format!("{commit_seq:064x}")
                        ],
                    )
                    .expect("detached legacy receipt");
            }
        }
        connection
            .execute(
                "UPDATE operational_journal_state SET \
                   commit_head_seq = 300, replay_floor_seq = 1, \
                   retained_commit_count = 300, pending_metadata_count = 300, \
                   retained_receipt_count = 300, pending_receipt_metadata_count = 300",
                [],
            )
            .expect("legacy journal state");

        let first = run_bounded_pass(&mut connection).expect("first bounded backfill");
        assert!((1..=MAX_SLICE_COMMITS).contains(&first.backfilled_commits));
        assert!((1..=MAX_SLICE_COMMITS).contains(&first.backfilled_receipts));
        let first_cursors = connection
            .query_row(
                "SELECT metadata_backfill_cursor_seq, receipt_backfill_cursor_module, \
                        receipt_backfill_cursor_operation_id \
                 FROM operational_journal_state WHERE id = 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .expect("first backfill cursors");
        assert!(first_cursors.0 > 0);
        assert_eq!(first_cursors.1.as_deref(), Some("store_administration"));
        assert!(first_cursors.2.is_some());

        for _ in 0..10 {
            let pending = connection
                .query_row(
                    "SELECT pending_metadata_count + pending_receipt_metadata_count \
                     FROM operational_journal_state WHERE id = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("pending backfill");
            if pending == 0 {
                break;
            }
            run_bounded_pass(&mut connection).expect("resumed bounded backfill");
        }
        let completed = connection
            .query_row(
                "SELECT pending_metadata_count, pending_receipt_metadata_count, \
                        metadata_backfill_cursor_seq, \
                        (SELECT count(*) FROM local_commit_retention_metadata), \
                        (SELECT count(*) FROM module_receipt_retention_metadata) \
                 FROM operational_journal_state WHERE id = 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .expect("completed backfill");
        assert_eq!(completed, (0, 0, 300, 300, 300));
    }

    #[test]
    fn pressure_flags_clear_when_the_other_journal_releases_the_global_envelope() {
        let directory = nodex_platform::test_support::tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        prepare_test_current_store(&mut connection, Path::new("/__journal_pressure_test__"))
            .expect("current Store");

        let receipt_bytes = 90 * 1_024 * 1_024;
        let delivery_bytes = TARGET_OPERATIONAL_BYTES - receipt_bytes + 1;
        connection
            .execute(
                "UPDATE operational_journal_state SET \
                   retained_receipt_count = ?1, retained_receipt_bytes = ?2, \
                   retained_delivery_bytes = ?3, receipt_pressure_active = 1 \
                 WHERE id = 1",
                params![TARGET_RETAINED_RECEIPTS, receipt_bytes, delivery_bytes],
            )
            .expect("receipt global pressure");
        refresh_receipt_pressure(&connection).expect("refresh receipt pressure");
        assert!(pressure_flags(&connection).1);

        connection
            .execute(
                "UPDATE operational_journal_state SET retained_delivery_bytes = ?1 WHERE id = 1",
                [delivery_bytes - 1],
            )
            .expect("release receipt global pressure");
        refresh_receipt_pressure(&connection).expect("clear receipt pressure");
        assert!(!pressure_flags(&connection).1);

        let delivery_bytes = 180 * 1_024 * 1_024;
        let receipt_bytes = TARGET_OPERATIONAL_BYTES - delivery_bytes + 1;
        connection
            .execute(
                "UPDATE operational_journal_state SET \
                   retained_commit_count = ?1, retained_delivery_bytes = ?2, \
                   retained_receipt_bytes = ?3, delivery_pressure_active = 1 \
                 WHERE id = 1",
                params![TARGET_RETAINED_COMMITS, delivery_bytes, receipt_bytes],
            )
            .expect("delivery global pressure");
        refresh_delivery_pressure(&connection).expect("refresh delivery pressure");
        assert!(pressure_flags(&connection).0);

        connection
            .execute(
                "UPDATE operational_journal_state SET retained_receipt_bytes = ?1 WHERE id = 1",
                [receipt_bytes - 1],
            )
            .expect("release delivery global pressure");
        refresh_delivery_pressure(&connection).expect("clear delivery pressure");
        assert_eq!(pressure_flags(&connection), (false, false));
        assert!(!plan_due_work(&connection).expect("settled due work").0);
    }

    #[test]
    fn receipt_maintenance_is_due_at_each_time_count_and_byte_horizon() {
        let directory = nodex_platform::test_support::tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        prepare_test_current_store(&mut connection, Path::new("/__receipt_horizons_test__"))
            .expect("current Store");

        connection
            .execute(
                "UPDATE operational_journal_state SET retained_receipt_count = ?1 WHERE id = 1",
                [MAX_RETAINED_RECEIPTS + 1],
            )
            .expect("count pressure");
        assert!(plan_due_work(&connection).expect("count due work").0);

        connection
            .execute(
                "UPDATE operational_journal_state \
                 SET retained_receipt_count = 0, retained_receipt_bytes = ?1 WHERE id = 1",
                [MAX_RETAINED_RECEIPT_BYTES + 1],
            )
            .expect("byte pressure");
        assert!(plan_due_work(&connection).expect("byte due work").0);

        let now_ms = now_ms(&connection).expect("Core time");
        connection
            .execute(
                "UPDATE operational_journal_state SET retained_receipt_bytes = 0 WHERE id = 1",
                [],
            )
            .expect("clear pressure");
        connection
            .execute(
                "INSERT INTO module_receipt_retention_metadata( \
                   module_name, operation_id, issued_at_ms, expires_at_ms, receipt_bytes \
                 ) VALUES ('automation', 'expired', ?1, ?2, 1)",
                params![now_ms - 2, now_ms - 1],
            )
            .expect("expired metadata");
        assert!(plan_due_work(&connection).expect("time due work").0);
        assert!(read_status(&connection).expect("due status").optimizing);
    }

    #[test]
    fn status_exposes_backfill_and_retention_progress_without_scanning_payloads() {
        let directory = nodex_platform::test_support::tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        prepare_test_current_store(&mut connection, Path::new("/__journal_status_test__"))
            .expect("current Store");
        connection
            .execute(
                "UPDATE operational_journal_state \
                 SET commit_head_seq = 40, replay_floor_seq = 10, \
                     pending_metadata_count = 7, pending_receipt_metadata_count = 9, \
                     retained_commit_count = 31, retained_delivery_bytes = 1200, \
                     retained_receipt_count = 12, retained_receipt_bytes = 800, \
                     last_pruned_commit_seq = 9 WHERE id = 1",
                [],
            )
            .expect("status fixture");

        let status = read_status(&connection).expect("journal status");
        assert!(status.optimizing);
        assert_eq!(status.commit_head_seq, 40);
        assert_eq!(status.replay_floor_seq, 10);
        assert_eq!(status.pending_commit_metadata, 7);
        assert_eq!(status.pending_receipt_metadata, 9);
        assert_eq!(status.retained_delivery_bytes, 1200);
        assert_eq!(status.retained_receipt_bytes, 800);
        assert_eq!(status.last_pruned_commit_seq, 9);
    }

    #[test]
    fn physical_reclamation_advances_only_the_maintenance_coordinate() {
        let directory = nodex_platform::test_support::tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        prepare_test_current_store(&mut connection, Path::new("/__journal_vacuum_test__"))
            .expect("current Store");
        assert_eq!(
            connection
                .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))
                .expect("auto vacuum mode"),
            2,
        );
        for _ in 0..10 {
            if !run_bounded_pass(&mut connection)
                .expect("settle initial journal state")
                .made_progress()
            {
                break;
            }
        }
        let revision_before = connection
            .query_row(
                "SELECT maintenance_revision FROM operational_journal_state WHERE id = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("maintenance revision before vacuum");
        connection
            .execute_batch(
                "CREATE TABLE vacuum_pressure(payload BLOB); \
                 INSERT INTO vacuum_pressure(payload) VALUES (zeroblob(4194304)); \
                 DROP TABLE vacuum_pressure;",
            )
            .expect("vacuum pressure");
        let before = connection
            .query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0))
            .expect("freelist before vacuum");
        let work_revision_before = work_revision(&connection).expect("work revision before vacuum");
        assert!(before > 0);
        assert!(plan_due_work(&connection).expect("vacuum due work").0);

        let pass = run_bounded_pass(&mut connection).expect("bounded physical reclaim");
        let after = connection
            .query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0))
            .expect("freelist after vacuum");
        assert!(!pass.made_progress());
        assert!(
            after < before,
            "vacuum did not reclaim a bounded slice: before={before}, after={after}, pass={pass:?}"
        );
        assert!(
            before - after <= MAX_VACUUM_PAGES as i64,
            "vacuum exceeded its page budget: before={before}, after={after}"
        );
        assert_ne!(
            work_revision(&connection).expect("work revision after vacuum"),
            work_revision_before,
            "physical progress must advance the due-work coordinate without journaling itself",
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT maintenance_revision FROM operational_journal_state WHERE id = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("maintenance revision"),
            revision_before + 1,
        );
    }

    #[test]
    fn seal_capacity_prunes_a_bounded_slice_or_applies_backpressure() {
        let directory = nodex_platform::test_support::tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        prepare_test_current_store(&mut connection, Path::new("/__journal_capacity_test__"))
            .expect("current Store");
        connection
            .execute(
                "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                 VALUES (1, 'epoch:journal', '2026-01-01', '2026-01-01')",
                [],
            )
            .expect("Store identity");
        seed_commit(&connection, 1, "apply_yjs_update", "2026-01-01T00:00:00Z");
        seed_commit(&connection, 2, "apply_yjs_update", "2026-01-01T00:00:01Z");
        connection
            .execute(
                "UPDATE operational_journal_state SET commit_head_seq = 2, \
                   replay_floor_seq = 1, retained_commit_count = ?1, \
                   retained_delivery_bytes = 200",
                [MAX_RETAINED_COMMITS],
            )
            .expect("capacity state");

        ensure_capacity_for_seal(&connection, 100).expect("bounded synchronous prune");
        assert!(
            !connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM local_commits WHERE commit_seq = 1)",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .expect("oldest commit")
        );

        seed_commit(&connection, 3, "apply_yjs_update", "2026-01-01T00:00:02Z");
        connection
            .execute(
                "UPDATE operational_journal_state SET commit_head_seq = 3, \
                   retained_commit_count = ?1, retained_delivery_bytes = 200",
                [MAX_RETAINED_COMMITS + 100],
            )
            .expect("legacy overage state");
        ensure_capacity_for_seal(&connection, 100)
            .expect("legacy overage remains available while shrinking");
        assert!(
            !connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM local_commits WHERE commit_seq = 2)",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .expect("legacy oldest commit")
        );

        connection
            .execute(
                "UPDATE operational_journal_state SET retained_commit_count = ?1",
                [MAX_RETAINED_COMMITS],
            )
            .expect("saturated head-only state");
        let error = ensure_capacity_for_seal(&connection, 100).expect_err("hard capacity");
        assert_eq!(error.code, StoreErrorCode::ResourceExhausted);
        assert!(error.retryable);
    }

    #[test]
    fn receipt_capacity_keeps_legacy_overage_available_only_while_it_shrinks() {
        let directory = nodex_platform::test_support::tempdir().expect("Profile");
        let mut connection = open_writer(&directory.path().join("nodex.db")).expect("writer");
        prepare_test_current_store(&mut connection, Path::new("/__receipt_capacity_test__"))
            .expect("current Store");
        connection
            .execute(
                "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at) \
                 VALUES (1, 'epoch:journal', '2026-01-01', '2026-01-01')",
                [],
            )
            .expect("Store identity");
        seed_commit(&connection, 1, "apply_yjs_update", "2026-01-01T00:00:00Z");
        connection
            .execute(
                "INSERT INTO module_receipt_retention_metadata( \
                   module_name, operation_id, issued_at_ms, expires_at_ms, receipt_bytes \
                 ) VALUES ('store_administration', 'operation:1', 1, 4102444800000, 100)",
                [],
            )
            .expect("receipt retention metadata");
        connection
            .execute(
                "UPDATE operational_journal_state SET retained_receipt_count = ?1, \
                   retained_receipt_bytes = 100",
                [MAX_RETAINED_RECEIPTS + 100],
            )
            .expect("legacy receipt overage state");

        ensure_capacity_for_receipt(&connection, 50)
            .expect("legacy receipt overage remains available while shrinking");
        assert!(
            !connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM core_module_receipts \
                     WHERE module_name = 'store_administration' \
                       AND operation_id = 'operation:1')",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .expect("oldest receipt")
        );

        connection
            .execute(
                "UPDATE operational_journal_state SET retained_receipt_count = ?1, \
                   retained_receipt_bytes = 0",
                [MAX_RETAINED_RECEIPTS],
            )
            .expect("saturated receipt state");
        let error =
            ensure_capacity_for_receipt(&connection, 50).expect_err("hard receipt capacity");
        assert_eq!(error.code, StoreErrorCode::ResourceExhausted);
        assert!(error.retryable);
    }
}
