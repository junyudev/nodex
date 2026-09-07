use super::{Snapshot, exhausted, invalid, provider, schema};
use crate::infrastructure::sqlite::{StoreError, with_query_deadline};
use nodex_core_contracts::sql::{SqlQuery, SqlResult};
use rusqlite::{
    Connection,
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    types::{Value as SqlValue, ValueRef},
};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Instant;

const MAX_RESULT_ROWS: usize = 10_000;
const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SQL_BYTES: usize = 64 * 1024;

pub(super) fn validate(query: &SqlQuery) -> Result<(), StoreError> {
    if query.sql.trim().is_empty()
        || query.sql.len() > MAX_SQL_BYTES
        || query.parameters.len() > 100
    {
        return Err(invalid(
            "SQL requires one statement up to 64 KiB and at most 100 named scalar parameters",
        ));
    }
    if query
        .parameters
        .values()
        .any(|v| v.is_array() || v.is_object())
    {
        return Err(invalid("SQL parameters must be JSON scalars"));
    }
    Ok(())
}

pub(super) fn execute(snapshot: Arc<Snapshot>, query: SqlQuery) -> Result<SqlResult, StoreError> {
    validate(&query)?;
    let tables = provider::tables(&snapshot, query.scope.clone(), false)?;
    let database = Connection::open_in_memory()?;
    database.execute_batch("PRAGMA temp_store=MEMORY; PRAGMA max_page_count=8192;")?;
    database.set_limit(Limit::SQLITE_LIMIT_LENGTH, super::MAX_INPUT_BYTES as i32)?;
    database.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, MAX_SQL_BYTES as i32)?;
    database.set_limit(Limit::SQLITE_LIMIT_COLUMN, 256)?;
    database.set_limit(Limit::SQLITE_LIMIT_EXPR_DEPTH, 100)?;
    database.set_limit(Limit::SQLITE_LIMIT_COMPOUND_SELECT, 20)?;
    database.set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 100)?;
    database.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, 100_000)?;
    for table in &tables {
        nodex_sqlite_query::register(
            &database,
            schema::virtual_table(table),
            Arc::new(provider::Relation::new(table.clone(), snapshot.clone())),
        )?;
        // Connect trusted virtual schemas before restricting user SQL; preparing
        // LIMIT 0 does not execute providers or read content.
        let args = if table.arguments.is_empty() {
            String::new()
        } else {
            format!("({})", vec!["NULL"; table.arguments.len()].join(","))
        };
        let _ = database.prepare(&format!(
            "SELECT * FROM \"{}\"{args} LIMIT 0",
            table.table.replace('"', "\"\"")
        ))?;
    }
    let names: BTreeSet<_> = tables
        .iter()
        .map(|t| t.table.to_ascii_lowercase())
        .collect();
    database.authorizer(Some(move |context: AuthContext<'_>| match context.action {
        AuthAction::Select | AuthAction::Recursive => Authorization::Allow,
        AuthAction::Read { .. } if context.database_name.is_none() => Authorization::Allow,
        AuthAction::Read { table_name, .. }
            if names.contains(&table_name.to_ascii_lowercase())
                || matches!(table_name, "json_each" | "json_tree") =>
        {
            Authorization::Allow
        }
        AuthAction::Function { function_name }
            if !matches!(
                function_name.to_ascii_lowercase().as_str(),
                "load_extension" | "writefile" | "readfile" | "fts3_tokenizer"
            ) =>
        {
            Authorization::Allow
        }
        _ => Authorization::Deny,
    }))?;
    let vm_exhausted = Arc::new(AtomicBool::new(false));
    let result = with_query_deadline(
        &database,
        snapshot.store.deadline,
        &snapshot.store.cancellation,
        |database| {
            let cancellation = snapshot.store.cancellation.clone();
            let deadline = snapshot.store.deadline;
            let exhausted = vm_exhausted.clone();
            let mut ticks = 0u32;
            database.progress_handler(
                1000,
                Some(move || {
                    ticks += 1;
                    if cancellation.is_cancelled() || Instant::now() >= deadline {
                        return true;
                    }
                    if ticks > 20_000 {
                        exhausted.store(true, Ordering::Relaxed);
                        return true;
                    }
                    false
                }),
            )?;
            evaluate(database, &query, &snapshot)
        },
    );
    if let Some(error) = snapshot
        .error
        .lock()
        .map_err(|_| invalid("Query error state unavailable"))?
        .take()
    {
        return Err(error);
    }
    if vm_exhausted.load(Ordering::Relaxed)
        && result
            .as_ref()
            .is_err_and(|e| e.code == crate::infrastructure::sqlite::StoreErrorCode::QueryCancelled)
    {
        return Err(exhausted(
            "SQL VM work budget exceeded; no partial result returned",
        ));
    }
    result
}

fn evaluate(
    database: &Connection,
    query: &SqlQuery,
    snapshot: &Snapshot,
) -> Result<SqlResult, StoreError> {
    let mut statement = database.prepare(&query.sql).map_err(query_error)?;
    if !statement.readonly() || statement.column_count() == 0 {
        return Err(invalid("SQL accepts one read-only SELECT statement"));
    }
    let mut used = BTreeSet::new();
    for index in 1..=statement.parameter_count() {
        let name = statement
            .parameter_name(index)
            .ok_or_else(|| invalid("SQL requires named parameters (:name, @name, or $name)"))?;
        if name.starts_with('?') {
            return Err(invalid(
                "SQL positional parameters are unsupported; use :name",
            ));
        }
        let key = &name[1..];
        let value = query
            .parameters
            .get(key)
            .ok_or_else(|| invalid(&format!("Missing SQL parameter '{key}'")))?;
        used.insert(key.to_owned());
        statement
            .raw_bind_parameter(index, sql_value(value)?)
            .map_err(query_error)?;
    }
    if query.parameters.keys().any(|key| !used.contains(key)) {
        return Err(invalid(
            "Unused SQL parameter; names must match statement parameters",
        ));
    }
    let columns = statement
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect::<Vec<_>>();
    let mut bytes: usize = columns.iter().map(String::len).sum();
    let mut cursor = statement.raw_query();
    let mut rows = Vec::new();
    while let Some(row) = cursor.next().map_err(query_error)? {
        if rows.len() >= MAX_RESULT_ROWS {
            return Err(exhausted(
                "SQL result exceeds 10000 rows; add LIMIT; no partial result returned",
            ));
        }
        let values = (0..columns.len())
            .map(|i| json_value(row.get_ref(i).map_err(query_error)?))
            .collect::<Result<Vec<_>, _>>()?;
        bytes += serde_json::to_vec(&values)
            .map_err(|_| invalid("Invalid SQL result"))?
            .len();
        if bytes > MAX_RESULT_BYTES {
            return Err(exhausted(
                "SQL result exceeds 8 MiB; select fewer columns or Pages; no partial result returned",
            ));
        }
        rows.push(values);
    }
    snapshot.check_interruption()?;
    // An observation identifier is intentionally not a mutation guard or a
    // request to keep this read transaction alive after returning its result.
    use sha2::{Digest, Sha256};
    let identity = format!(
        "{}:{}:{}:{}",
        snapshot.store_epoch,
        snapshot.commit_head,
        snapshot.context.library_id.0,
        snapshot
            .context
            .project_id
            .as_ref()
            .map_or("", |id| id.0.as_str())
    );
    let observation = format!("query_{}", hex::encode(Sha256::digest(identity.as_bytes())));
    Ok(SqlResult {
        returned_count: rows.len(),
        snapshot: observation,
        columns,
        rows,
    })
}

pub(super) fn sql_value(value: &Value) -> Result<SqlValue, StoreError> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) => SqlValue::Integer(i64::from(*value)),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                SqlValue::Integer(integer)
            } else {
                SqlValue::Real(
                    value
                        .as_f64()
                        .ok_or_else(|| invalid("SQL number is out of range"))?,
                )
            }
        }
        Value::String(value) => SqlValue::Text(value.clone()),
        _ => SqlValue::Text(value.to_string()),
    })
}
fn json_value(value: ValueRef<'_>) -> Result<Value, StoreError> {
    match value {
        ValueRef::Null => Ok(Value::Null),
        ValueRef::Integer(value) => Ok(Value::from(value)),
        ValueRef::Real(value) => serde_json::Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| invalid("SQL result contains a non-finite number")),
        ValueRef::Text(value) => std::str::from_utf8(value)
            .map(|value| Value::String(value.to_owned()))
            .map_err(|_| invalid("SQL result contains invalid UTF-8")),
        ValueRef::Blob(_) => Err(invalid(
            "SQL BLOB results are unsupported; use hex() to return text",
        )),
    }
}
fn query_error(error: rusqlite::Error) -> StoreError {
    if error.sqlite_error_code() == Some(rusqlite::ErrorCode::OperationInterrupted) {
        return StoreError::from(error);
    }
    if matches!(
        error.sqlite_error_code(),
        Some(
            rusqlite::ErrorCode::OperationInterrupted
                | rusqlite::ErrorCode::OutOfMemory
                | rusqlite::ErrorCode::TooBig
                | rusqlite::ErrorCode::DiskFull
        )
    ) {
        return exhausted("SQL execution budget exceeded; no partial result was returned");
    }
    invalid(&format!("SQL rejected: {error}"))
}
