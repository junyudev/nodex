use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use std::{os::unix::ffi::OsStrExt, path::Path};

use rusqlite::limits::Limit;
use rusqlite::{Connection, ErrorCode, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::metrics::{DurationMetric, DurationMetricSnapshot};

pub const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_QUERY_BUDGET: Duration = Duration::from_secs(10);
pub const MAX_SQL_BYTES: i32 = 2 * 1024 * 1024;
pub const MAX_VALUE_BYTES: i32 = 64 * 1024 * 1024;
pub const MIN_SQLITE_VERSION: i32 = 3_045_000;
const PROGRESS_HANDLER_OPS: i32 = 1_000;
const QUERY_INTERRUPTION_NONE: u8 = 0;
const QUERY_INTERRUPTION_CANCELLED: u8 = 1;
const QUERY_INTERRUPTION_DEADLINE: u8 = 2;
static TRANSACTION_DURATION: OnceLock<DurationMetric> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoreErrorCode {
    AlreadyOwned,
    Conflict,
    GenerationConflict,
    HeadConflict,
    PatchNotFound,
    PatchAmbiguous,
    PatchOverlap,
    IdempotencyKeyReused,
    IdempotencyWindowExpired,
    LegacyIdempotencyUnavailable,
    ProtectedOwnerDeletion,
    InvalidInput,
    InvalidProfile,
    MissingDependencies,
    MaterializationStale,
    NotFound,
    RevisionConflict,
    StaleStoreEpoch,
    Unauthorized,
    ResourceExhausted,
    WriterQueueFull,
    WriterClosed,
    ReaderPoolTimeout,
    QueryCancelled,
    DeadlineExceeded,
    SqliteBusy,
    SqliteFailure,
    RuntimeIncompatible,
    UnsupportedSchema,
    StoreCorrupt,
    MaintenanceInProgress,
    Internal,
}

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct StoreError {
    pub code: StoreErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<nodex_core_contracts::CoreErrorRecovery>,
}

impl StoreError {
    pub fn new(code: StoreErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            recovery: None,
        }
    }

    pub fn with_recovery(mut self, recovery: nodex_core_contracts::CoreErrorRecovery) -> Self {
        self.recovery = Some(recovery);
        self
    }

    pub fn from_sqlite(error: rusqlite::Error) -> Self {
        let sqlite_code = error.sqlite_error_code();
        let busy = matches!(
            sqlite_code,
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
        );
        let cancelled = matches!(sqlite_code, Some(ErrorCode::OperationInterrupted));
        if cancelled {
            return Self::new(
                StoreErrorCode::QueryCancelled,
                "SQLite work was interrupted",
                true,
            );
        }
        if busy {
            return Self::new(StoreErrorCode::SqliteBusy, "SQLite store is busy", true);
        }
        Self::new(
            StoreErrorCode::SqliteFailure,
            format!("SQLite operation failed: {error}"),
            false,
        )
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(value: rusqlite::Error) -> Self {
        Self::from_sqlite(value)
    }
}

#[derive(Debug, Clone)]
pub struct QueryCancellation {
    cancelled: Vec<Arc<AtomicBool>>,
}

impl QueryCancellation {
    pub fn new() -> Self {
        Self {
            cancelled: vec![Arc::new(AtomicBool::new(false))],
        }
    }

    pub fn cancel(&self) {
        if let Some(cancelled) = self.cancelled.first() {
            cancelled.store(true, Ordering::Release);
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled
            .iter()
            .any(|cancelled| cancelled.load(Ordering::Acquire))
    }

    pub(crate) fn combined(&self, other: &Self) -> Self {
        let mut cancelled = self.cancelled.clone();
        for flag in &other.cancelled {
            if cancelled
                .iter()
                .any(|candidate| Arc::ptr_eq(candidate, flag))
            {
                continue;
            }
            cancelled.push(Arc::clone(flag));
        }
        Self { cancelled }
    }
}

impl Default for QueryCancellation {
    fn default() -> Self {
        Self::new()
    }
}

pub fn open_writer(path: &std::path::Path) -> Result<Connection, StoreError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = Connection::open_with_flags(path, flags)?;
    configure_empty_store_storage(&connection)?;
    configure_writer(&connection)?;
    Ok(connection)
}

fn configure_empty_store_storage(connection: &Connection) -> Result<(), StoreError> {
    // SQLite can switch from NONE only before the first table is created
    // without a full VACUUM. FULL and INCREMENTAL can switch in place, so do
    // not issue this PRAGMA after an existing Store has installed its schema.
    let has_application_schema = connection.query_row(
        "SELECT EXISTS( \
           SELECT 1 FROM sqlite_schema \
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
         )",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if has_application_schema {
        return Ok(());
    }
    connection.execute_batch("PRAGMA auto_vacuum=INCREMENTAL")?;
    Ok(())
}

pub fn open_reader(path: &std::path::Path) -> Result<Connection, StoreError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = Connection::open_with_flags(path, flags)?;
    configure_reader(&connection)?;
    Ok(connection)
}

pub fn open_immutable_reader(path: &Path) -> Result<Connection, StoreError> {
    let canonical = path.canonicalize().map_err(|error| {
        StoreError::new(
            StoreErrorCode::InvalidProfile,
            format!("Immutable SQLite path is unavailable: {error}"),
            false,
        )
    })?;
    let encoded = canonical
        .as_os_str()
        .as_bytes()
        .iter()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'.' | b'_' | b'-' => {
                char::from(*byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect::<String>();
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_URI;
    let connection = Connection::open_with_flags(format!("file:{encoded}?immutable=1"), flags)?;
    configure_reader(&connection)?;
    Ok(connection)
}

pub fn configure_writer(connection: &Connection) -> Result<(), StoreError> {
    verify_sqlite_runtime(connection)?;
    connection.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "wal_autocheckpoint", 1_000)?;
    apply_runtime_limits(connection)?;
    Ok(())
}

pub fn configure_reader(connection: &Connection) -> Result<(), StoreError> {
    verify_sqlite_runtime(connection)?;
    connection.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.pragma_update(None, "query_only", true)?;
    apply_runtime_limits(connection)?;
    Ok(())
}

pub fn verify_sqlite_runtime(connection: &Connection) -> Result<(), StoreError> {
    if rusqlite::version_number() < MIN_SQLITE_VERSION {
        return Err(StoreError::new(
            StoreErrorCode::RuntimeIncompatible,
            format!(
                "SQLite {} is older than the required runtime {}",
                rusqlite::version(),
                MIN_SQLITE_VERSION
            ),
            false,
        ));
    }
    let compile_options = connection
        .prepare("PRAGMA compile_options")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !compile_options.iter().any(|option| option == "ENABLE_FTS5") {
        return Err(StoreError::new(
            StoreErrorCode::RuntimeIncompatible,
            "SQLite runtime does not include FTS5",
            false,
        ));
    }
    let json_valid: i64 = connection.query_row("SELECT json_valid('{}')", [], |row| row.get(0))?;
    if json_valid != 1 {
        return Err(StoreError::new(
            StoreErrorCode::RuntimeIncompatible,
            "SQLite runtime does not provide JSON functions",
            false,
        ));
    }
    Ok(())
}

pub fn apply_runtime_limits(connection: &Connection) -> Result<(), StoreError> {
    connection.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, MAX_SQL_BYTES)?;
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, MAX_VALUE_BYTES)?;
    connection.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)?;
    connection.set_limit(Limit::SQLITE_LIMIT_COLUMN, 2_000)?;
    connection.set_limit(Limit::SQLITE_LIMIT_COMPOUND_SELECT, 100)?;
    connection.set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 32_766)?;
    Ok(())
}

/// Gives every newly opened Store planner useful statistics, including Stores
/// created before Nodex began maintaining SQLite's ANALYZE data.
pub(crate) fn optimize_query_planner_on_open(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch("PRAGMA optimize=0x10002")?;
    Ok(())
}

/// Lets SQLite refresh only statistics justified by this writer connection's
/// observed workload. This is normally a no-op.
pub(crate) fn optimize_query_planner_before_close(
    connection: &Connection,
) -> Result<(), StoreError> {
    connection.execute_batch("PRAGMA optimize")?;
    Ok(())
}

pub fn with_query_budget<T>(
    connection: &Connection,
    budget: Duration,
    cancellation: &QueryCancellation,
    operation: impl FnOnce(&Connection) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    with_query_deadline(connection, Instant::now() + budget, cancellation, operation)
}

pub fn with_query_deadline<T>(
    connection: &Connection,
    deadline: Instant,
    cancellation: &QueryCancellation,
    operation: impl FnOnce(&Connection) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    if let Some(error) = current_query_interruption(cancellation, deadline) {
        return Err(error);
    }
    let cancellation = cancellation.clone();
    let progress_cancellation = cancellation.clone();
    let interruption = Arc::new(AtomicU8::new(QUERY_INTERRUPTION_NONE));
    let progress_interruption = Arc::clone(&interruption);
    connection.progress_handler(
        PROGRESS_HANDLER_OPS,
        Some(move || {
            record_query_interruption(&progress_cancellation, deadline, &progress_interruption)
        }),
    )?;
    let result = operation(connection);
    connection.progress_handler(0, None::<fn() -> bool>)?;
    classify_query_interruption(
        result,
        &cancellation,
        deadline,
        interruption.load(Ordering::Acquire),
    )
}

pub fn with_mut_query_budget<T>(
    connection: &mut Connection,
    budget: Duration,
    cancellation: &QueryCancellation,
    operation: impl FnOnce(&mut Connection) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    with_mut_query_deadline(connection, Instant::now() + budget, cancellation, operation)
}

pub fn with_mut_query_deadline<T>(
    connection: &mut Connection,
    deadline: Instant,
    cancellation: &QueryCancellation,
    operation: impl FnOnce(&mut Connection) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    if let Some(error) = current_query_interruption(cancellation, deadline) {
        return Err(error);
    }
    let cancellation = cancellation.clone();
    let progress_cancellation = cancellation.clone();
    let interruption = Arc::new(AtomicU8::new(QUERY_INTERRUPTION_NONE));
    let progress_interruption = Arc::clone(&interruption);
    connection.progress_handler(
        PROGRESS_HANDLER_OPS,
        Some(move || {
            record_query_interruption(&progress_cancellation, deadline, &progress_interruption)
        }),
    )?;
    let result = operation(connection);
    connection.progress_handler(0, None::<fn() -> bool>)?;
    classify_query_interruption(
        result,
        &cancellation,
        deadline,
        interruption.load(Ordering::Acquire),
    )
}

fn classify_query_interruption<T>(
    result: Result<T, StoreError>,
    cancellation: &QueryCancellation,
    deadline: Instant,
    recorded_interruption: u8,
) -> Result<T, StoreError> {
    match result {
        Err(error) if error.code == StoreErrorCode::QueryCancelled => {
            Err(recorded_query_interruption(recorded_interruption)
                .or_else(|| current_query_interruption(cancellation, deadline))
                .unwrap_or(error))
        }
        result => result,
    }
}

fn record_query_interruption(
    cancellation: &QueryCancellation,
    deadline: Instant,
    interruption: &AtomicU8,
) -> bool {
    let cause = if cancellation.is_cancelled() {
        QUERY_INTERRUPTION_CANCELLED
    } else if Instant::now() >= deadline {
        QUERY_INTERRUPTION_DEADLINE
    } else {
        return false;
    };
    let _ = interruption.compare_exchange(
        QUERY_INTERRUPTION_NONE,
        cause,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
    true
}

fn recorded_query_interruption(cause: u8) -> Option<StoreError> {
    match cause {
        QUERY_INTERRUPTION_CANCELLED => Some(query_interrupted(true)),
        QUERY_INTERRUPTION_DEADLINE => Some(query_interrupted(false)),
        _ => None,
    }
}

fn current_query_interruption(
    cancellation: &QueryCancellation,
    deadline: Instant,
) -> Option<StoreError> {
    if cancellation.is_cancelled() {
        return Some(query_interrupted(true));
    }
    (Instant::now() >= deadline).then(|| query_interrupted(false))
}

pub(crate) fn query_interrupted(cancelled: bool) -> StoreError {
    if !cancelled {
        return StoreError::new(
            StoreErrorCode::DeadlineExceeded,
            "SQLite work exceeded its request deadline",
            true,
        );
    }
    StoreError::new(
        StoreErrorCode::QueryCancelled,
        "SQLite work was cancelled",
        true,
    )
}

pub fn with_immediate_transaction<T>(
    connection: &mut Connection,
    operation: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let started_at = Instant::now();
    let result = (|| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = operation(&transaction)?;
        transaction.commit()?;
        Ok(value)
    })();
    TRANSACTION_DURATION
        .get_or_init(DurationMetric::default)
        .record(started_at.elapsed());
    let transaction_micros = u64::try_from(started_at.elapsed().as_micros()).unwrap_or(u64::MAX);
    if result.is_ok() {
        tracing::debug!(
            transactionMicros = transaction_micros,
            status = "committed",
            "SQLite immediate transaction completed"
        );
    } else {
        tracing::debug!(
            transactionMicros = transaction_micros,
            status = "rolled_back",
            "SQLite immediate transaction completed"
        );
    }
    result
}

pub fn transaction_duration_metrics() -> DurationMetricSnapshot {
    TRANSACTION_DURATION
        .get_or_init(DurationMetric::default)
        .snapshot()
}

pub fn validate_store(connection: &Connection) -> Result<(), StoreError> {
    let integrity_started_at = Instant::now();
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(StoreError::new(
            StoreErrorCode::StoreCorrupt,
            format!("SQLite integrity_check failed: {integrity}"),
            false,
        ));
    }
    tracing::info!(
        durationMs = duration_millis(integrity_started_at.elapsed()),
        "SQLite integrity validation completed"
    );
    let foreign_key_started_at = Instant::now();
    let foreign_key_violations = connection
        .prepare(
            "SELECT \"table\", rowid, parent, fkid \
             FROM pragma_foreign_key_check ORDER BY \"table\", rowid, fkid LIMIT 9",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !foreign_key_violations.is_empty() {
        let truncated = foreign_key_violations.len() == 9;
        let details = foreign_key_violations
            .into_iter()
            .take(8)
            .map(|(table, rowid, parent, fkid)| {
                format!(
                    "{table}[rowid={}].fk#{fkid}->{parent}",
                    rowid.map_or_else(|| "without-rowid".to_owned(), |value| value.to_string())
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        return Err(StoreError::new(
            StoreErrorCode::StoreCorrupt,
            format!(
                "SQLite foreign_key_check found violations: {details}{}",
                if truncated { ", …" } else { "" }
            ),
            false,
        ));
    }
    tracing::info!(
        durationMs = duration_millis(foreign_key_started_at.elapsed()),
        "SQLite foreign-key validation completed"
    );
    Ok(())
}

fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn immediate_transactions_record_bounded_duration_metrics() {
        let directory = tempdir().expect("store");
        let mut connection = open_writer(&directory.path().join("metrics.db")).expect("writer");
        let before = transaction_duration_metrics();
        with_immediate_transaction(&mut connection, |transaction| {
            transaction.execute_batch("CREATE TABLE metric_probe(value INTEGER NOT NULL);")?;
            Ok(())
        })
        .expect("transaction");
        let after = transaction_duration_metrics();
        assert!(after.count > before.count);
        assert!(after.total_micros >= before.total_micros);
        assert!(after.max_micros >= after.last_micros);
    }

    #[test]
    fn writer_reader_limits_and_immediate_transactions_are_centralized() {
        let directory = tempdir().expect("store directory");
        let path = directory.path().join("nodex.db");
        let mut writer = open_writer(&path).expect("writer");
        assert_eq!(
            writer.limit(Limit::SQLITE_LIMIT_SQL_LENGTH).unwrap(),
            MAX_SQL_BYTES
        );
        assert_eq!(writer.limit(Limit::SQLITE_LIMIT_ATTACHED).unwrap(), 0);
        with_immediate_transaction(&mut writer, |transaction| {
            transaction.execute_batch(
                "CREATE TABLE values_table(value TEXT NOT NULL);\n\
                 INSERT INTO values_table(value) VALUES ('committed');",
            )?;
            Ok(())
        })
        .expect("immediate transaction");

        let reader = open_reader(&path).expect("reader");
        let query_only: i64 = reader
            .query_row("PRAGMA query_only", [], |row| row.get(0))
            .expect("query_only");
        assert_eq!(query_only, 1);
        assert!(reader.execute("DELETE FROM values_table", []).is_err());
        let value: String = reader
            .query_row("SELECT value FROM values_table", [], |row| row.get(0))
            .expect("read value");
        assert_eq!(value, "committed");
    }

    #[test]
    fn new_writers_enable_incremental_vacuum_without_rewriting_existing_stores() {
        let directory = tempdir().expect("store directory");
        let current_path = directory.path().join("current.db");
        let current = open_writer(&current_path).expect("current writer");
        assert_eq!(
            current
                .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))
                .expect("current auto vacuum"),
            2,
        );
        current
            .execute_batch("CREATE TABLE current_value(value INTEGER NOT NULL);")
            .expect("current schema");
        drop(current);

        let legacy_path = directory.path().join("legacy.db");
        let legacy = Connection::open(&legacy_path).expect("legacy writer");
        legacy
            .execute_batch(
                "PRAGMA auto_vacuum=NONE; \
                 CREATE TABLE legacy_value(value INTEGER NOT NULL);",
            )
            .expect("legacy schema");
        drop(legacy);

        let legacy = open_writer(&legacy_path).expect("reopened legacy writer");
        assert_eq!(
            legacy
                .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))
                .expect("legacy auto vacuum"),
            0,
        );

        let full_path = directory.path().join("full.db");
        let full = Connection::open(&full_path).expect("full writer");
        full.execute_batch(
            "PRAGMA auto_vacuum=FULL; \
             CREATE TABLE full_value(value INTEGER NOT NULL);",
        )
        .expect("full schema");
        drop(full);

        let full = open_writer(&full_path).expect("reopened full writer");
        assert_eq!(
            full.query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))
                .expect("full auto vacuum"),
            1,
        );
    }

    #[test]
    fn progress_budget_supports_explicit_cancellation() {
        let connection = Connection::open_in_memory().expect("memory database");
        let cancellation = QueryCancellation::new();
        cancellation.cancel();
        let error = with_query_budget(
            &connection,
            DEFAULT_QUERY_BUDGET,
            &cancellation,
            |connection| {
                connection.query_row(
                    "WITH RECURSIVE values_cte(value) AS (\
                       SELECT 1 UNION ALL SELECT value + 1 FROM values_cte WHERE value < 100000\
                     ) SELECT sum(value) FROM values_cte",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                Ok(())
            },
        )
        .expect_err("cancelled query");
        assert_eq!(error.code, StoreErrorCode::QueryCancelled);

        let observed = Arc::new(AtomicBool::new(false));
        let observed_by_query = Arc::clone(&observed);
        with_query_budget(
            &connection,
            DEFAULT_QUERY_BUDGET,
            &QueryCancellation::new(),
            move |connection| {
                let value: i64 = connection.query_row("SELECT 1", [], |row| row.get(0))?;
                observed_by_query.store(value == 1, Ordering::Release);
                Ok(())
            },
        )
        .expect("later query");
        assert!(observed.load(Ordering::Acquire));
    }

    #[test]
    fn progress_handler_preserves_deadline_and_cancellation_causes() {
        let connection = Connection::open_in_memory().expect("memory database");
        let long_query = |connection: &Connection| -> Result<(), StoreError> {
            connection.query_row(
                "WITH RECURSIVE values_cte(value) AS (\
                   SELECT 1 UNION ALL SELECT value + 1 FROM values_cte WHERE value < 100000000\
                 ) SELECT sum(value) FROM values_cte",
                [],
                |row| row.get::<_, i64>(0),
            )?;
            Ok(())
        };

        let deadline_error = with_query_budget(
            &connection,
            Duration::from_millis(1),
            &QueryCancellation::new(),
            long_query,
        )
        .expect_err("deadline query");
        assert_eq!(deadline_error.code, StoreErrorCode::DeadlineExceeded);
        assert_eq!(
            deadline_error.message,
            "SQLite work exceeded its request deadline"
        );

        let cancellation = QueryCancellation::new();
        let cancellation_from_thread = cancellation.clone();
        let cancel = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1));
            cancellation_from_thread.cancel();
        });
        let cancelled_error =
            with_query_budget(&connection, DEFAULT_QUERY_BUDGET, &cancellation, long_query)
                .expect_err("cancelled query");
        cancel.join().expect("cancellation thread");
        assert_eq!(cancelled_error.code, StoreErrorCode::QueryCancelled);
        assert_eq!(cancelled_error.message, "SQLite work was cancelled");
    }

    #[test]
    fn query_planner_optimization_creates_statistics_for_existing_indexes() {
        let connection = Connection::open_in_memory().expect("memory database");
        connection
            .execute_batch(
                "CREATE TABLE planner_values(id INTEGER PRIMARY KEY, value TEXT NOT NULL);\
                 CREATE INDEX planner_values_by_value ON planner_values(value);\
                 INSERT INTO planner_values(value) VALUES ('one'), ('two'), ('three');",
            )
            .expect("planner fixture");

        optimize_query_planner_on_open(&connection).expect("planner optimization");

        let statistic_count: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_stat1 WHERE tbl = 'planner_values'",
                [],
                |row| row.get(0),
            )
            .expect("planner statistics");
        assert!(statistic_count > 0);
    }
}
