//! Public SQL runs only against a disposable projection. All source reads retain
//! the caller's authority and the enclosing Database read transaction/snapshot.
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::collection::CollectionWindowRequest;
use nodex_core_contracts::database::*;
use nodex_core_contracts::sql::*;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::limits::Limit;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, params_from_iter};
use serde_json::Value;

const MAX_INPUT_ROWS: usize = 100_000;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESULT_ROWS: usize = 10_000;
// Leave room for column metadata and the Core transport envelope.
const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SQL_BYTES: usize = 64 * 1024;
const TIME_BUDGET: Duration = Duration::from_secs(5);

struct Source {
    table: SqlTable,
    properties: Vec<DatabasePropertyDescriptor>,
}
struct Snapshot<'a> {
    connection: &'a Connection,
    library_id: &'a str,
    commit_head: i64,
    context: &'a BoundModuleContext,
    started: Instant,
}
impl Snapshot<'_> {
    fn read(&self, request: DatabaseRead) -> Result<DatabaseReadValue, StoreError> {
        self.check_budget()?;
        super::read::read_at_commit_head(
            self.connection,
            self.library_id,
            self.commit_head,
            self.context,
            request,
        )
    }
    fn check_budget(&self) -> Result<(), StoreError> {
        if self.started.elapsed() >= TIME_BUDGET {
            return Err(exhausted(
                "SQL snapshot time budget exceeded; no partial result was returned",
            ));
        }
        Ok(())
    }
}

pub(super) fn schema(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    context: &BoundModuleContext,
    scope: SqlScope,
) -> Result<SqlSchema, StoreError> {
    let snapshot = Snapshot {
        connection,
        library_id,
        commit_head,
        context,
        started: Instant::now(),
    };
    Ok(SqlSchema {
        tables: resolve(&snapshot, scope)?
            .into_iter()
            .map(|source| source.table)
            .collect(),
    })
}

pub(super) fn query(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    context: &BoundModuleContext,
    query: SqlQuery,
) -> Result<SqlResult, StoreError> {
    if query.sql.trim().is_empty()
        || query.sql.len() > MAX_SQL_BYTES
        || query.parameters.len() > 100
    {
        return Err(invalid(
            "SQL requires one non-empty statement up to 64 KiB and at most 100 named parameters",
        ));
    }
    let snapshot = Snapshot {
        connection,
        library_id,
        commit_head,
        context,
        started: Instant::now(),
    };
    let sources = resolve(&snapshot, query.scope.clone())?;
    let database = Connection::open_in_memory()?;
    database.execute_batch("PRAGMA temp_store=MEMORY; PRAGMA max_page_count=8192;")?;
    let mut total_rows = 0;
    let mut total_bytes = 0;
    for source in &sources {
        materialize(
            &snapshot,
            &database,
            source,
            &mut total_rows,
            &mut total_bytes,
        )?;
    }
    execute(
        &database,
        &sources
            .iter()
            .map(|source| source.table.table.clone())
            .collect(),
        &query,
        snapshot.started,
    )
}

fn resolve(snapshot: &Snapshot<'_>, scope: SqlScope) -> Result<Vec<Source>, StoreError> {
    let mut bindings = scope.bindings;
    if bindings.is_empty() {
        let target = scope
            .database_id
            .map_or(DatabaseIdentityTarget::ProjectDefault, |database_id| {
                DatabaseIdentityTarget::Database { database_id }
            });
        let DatabaseReadValue::Database { value } =
            snapshot.read(DatabaseRead::Database { target })?
        else {
            return Err(invalid("Database identity is unavailable"));
        };
        let DatabaseReadValue::DataSourceWindow { data_sources } =
            snapshot.read(DatabaseRead::DataSourceWindow {
                database_id: value.database.database_id,
                window: CollectionWindowRequest {
                    first: Some(2),
                    after: None,
                },
            })?
        else {
            return Err(invalid("Data Source discovery is unavailable"));
        };
        if data_sources.items.len() != 1 || data_sources.next_cursor.is_some() {
            return Err(StoreError::new(
                StoreErrorCode::InvalidInput,
                "SQL requires exactly one default Data Source; choose --source ID or --bind TABLE=ID",
                false,
            ));
        }
        bindings.push(SqlBinding {
            table: "pages".to_owned(),
            data_source_id: data_sources.items[0].data_source_id.clone(),
        });
    }
    if bindings.len() > 16 {
        return Err(invalid("SQL accepts at most 16 Data Source bindings"));
    }
    let mut aliases = BTreeSet::new();
    let mut sources = Vec::new();
    for binding in bindings {
        if !valid_identifier(&binding.table)
            || binding.table.to_ascii_lowercase().starts_with("sqlite_")
            || matches!(
                binding.table.to_ascii_lowercase().as_str(),
                "json_each" | "json_tree"
            )
            || !aliases.insert(binding.table.to_ascii_lowercase())
        {
            return Err(invalid(
                "SQL table aliases must be unique ASCII identifiers of 1–64 characters, excluding sqlite_*, json_each, and json_tree",
            ));
        }
        let DatabaseReadValue::DataSource { value } = snapshot.read(DatabaseRead::DataSource {
            data_source_id: binding.data_source_id.clone(),
        })?
        else {
            return Err(invalid("Data Source identity is unavailable"));
        };
        if value.data_source.lifecycle != "active" {
            return Err(invalid("SQL requires an active Data Source"));
        }
        let properties = source_properties(snapshot, &binding.data_source_id)?;
        let columns = columns(snapshot, &properties)?;
        sources.push(Source {
            table: SqlTable {
                table: binding.table,
                data_source_id: binding.data_source_id,
                name: value.data_source.name,
                columns,
            },
            properties,
        });
    }
    Ok(sources)
}

fn source_properties(
    snapshot: &Snapshot<'_>,
    data_source_id: &str,
) -> Result<Vec<DatabasePropertyDescriptor>, StoreError> {
    let mut properties = Vec::new();
    let mut after = None;
    loop {
        let DatabaseReadValue::PropertyWindow { properties: window } =
            snapshot.read(DatabaseRead::PropertyWindow {
                data_source_id: data_source_id.to_owned(),
                window: CollectionWindowRequest {
                    after,
                    first: Some(200),
                },
            })?
        else {
            return Err(invalid("Data Source schema is unavailable"));
        };
        properties.extend(
            window
                .items
                .into_iter()
                .filter(|property| property.lifecycle == "active"),
        );
        if properties.len() > 200 {
            return Err(exhausted("SQL Property schema exceeds the supported bound"));
        }
        after = window.next_cursor;
        if after.is_none() {
            break;
        }
    }
    Ok(properties)
}

fn columns(
    snapshot: &Snapshot<'_>,
    properties: &[DatabasePropertyDescriptor],
) -> Result<Vec<SqlColumn>, StoreError> {
    let mut columns = [
        "page_id",
        "page_key",
        "data_source_id",
        "title",
        "created_at",
        "updated_at",
    ]
    .into_iter()
    .map(|name| SqlColumn {
        name: name.to_owned(),
        storage_type: "TEXT".to_owned(),
        property_id: None,
        options: Vec::new(),
    })
    .collect::<Vec<_>>();
    let mut names = columns
        .iter()
        .map(|column| column.name.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    // Stable IDs disambiguate duplicate/reserved names. Schema discovery is
    // the authority for the actual SQL column spelling.
    for property in properties {
        let unique_name = properties
            .iter()
            .filter(|other| other.name.eq_ignore_ascii_case(&property.name))
            .count()
            == 1;
        let name = if !property.name.is_empty()
            && unique_name
            && !names.contains(&property.name.to_ascii_lowercase())
        {
            property.name.clone()
        } else {
            format!("property_{}", property.property_id)
        };
        if !names.insert(name.to_ascii_lowercase()) {
            return Err(invalid(
                "SQL Property column names collide; rename the conflicting Property",
            ));
        }
        let options = property_options(snapshot, property)?;
        columns.push(SqlColumn {
            name,
            storage_type: storage_type(&property.schema).to_owned(),
            property_id: Some(property.property_id.clone()),
            options,
        });
    }
    Ok(columns)
}

fn property_options(
    snapshot: &Snapshot<'_>,
    property: &DatabasePropertyDescriptor,
) -> Result<Vec<SqlOption>, StoreError> {
    if !matches!(
        property.schema,
        DatabasePropertySchema::Select | DatabasePropertySchema::MultiSelect
    ) {
        return Ok(Vec::new());
    }
    let mut options = Vec::new();
    let mut after = None;
    loop {
        let DatabaseReadValue::OptionWindow { options: window } =
            snapshot.read(DatabaseRead::OptionWindow {
                data_source_id: property.data_source_id.clone(),
                property_id: property.property_id.clone(),
                window: CollectionWindowRequest {
                    after,
                    first: Some(200),
                },
            })?
        else {
            return Err(invalid("SQL option discovery is unavailable"));
        };
        options.extend(window.items.into_iter().map(|option| SqlOption {
            id: option.id,
            name: option.name,
        }));
        if options.len() > super::MAX_PROPERTY_OPTIONS {
            return Err(exhausted(
                "SQL option inventory exceeds the supported bound",
            ));
        }
        after = window.next_cursor;
        if after.is_none() {
            break;
        }
    }
    Ok(options)
}

fn materialize(
    snapshot: &Snapshot<'_>,
    database: &Connection,
    source: &Source,
    total_rows: &mut usize,
    total_bytes: &mut usize,
) -> Result<(), StoreError> {
    let definitions = source
        .table
        .columns
        .iter()
        .map(|column| format!("{} {}", quote(&column.name), column.storage_type))
        .collect::<Vec<_>>()
        .join(",");
    database.execute_batch(&format!(
        "CREATE TABLE {} ({definitions})",
        quote(&source.table.table)
    ))?;
    let placeholders = vec!["?"; source.table.columns.len()].join(",");
    let mut insert = database.prepare(&format!(
        "INSERT INTO {} VALUES ({placeholders})",
        quote(&source.table.table)
    ))?;
    let mut cursor = None;
    loop {
        let DatabaseReadValue::DataSourceQuery { value } =
            snapshot.read(DatabaseRead::DataSourceQuery {
                data_source_id: source.table.data_source_id.clone(),
                query: DatabaseDataSourceQuery {
                    cursor,
                    limit: Some(200),
                    projection_property_ids: Some(
                        source
                            .properties
                            .iter()
                            .map(|property| property.property_id.clone())
                            .collect(),
                    ),
                    filter: DatabaseViewFilter::Group {
                        operator: DatabaseViewFilterGroupOperator::And,
                        children: Vec::new(),
                    },
                    sort: Vec::new(),
                },
            })?
        else {
            return Err(invalid("Data Source rows are unavailable"));
        };
        for row in value.rows.items {
            snapshot.check_budget()?;
            let values = row_values(snapshot, source, row)?;
            charge_input(total_rows, total_bytes, &values)?;
            insert.execute(params_from_iter(
                values
                    .iter()
                    .map(sql_value)
                    .collect::<Result<Vec<_>, _>>()?,
            ))?;
        }
        cursor = value.rows.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(())
}

fn charge_input(
    total_rows: &mut usize,
    total_bytes: &mut usize,
    values: &[Value],
) -> Result<(), StoreError> {
    *total_rows += 1;
    if *total_rows > MAX_INPUT_ROWS {
        return Err(exhausted(
            "SQL input exceeds 100000 rows; no partial result was returned",
        ));
    }
    *total_bytes += serde_json::to_vec(values)
        .map_err(|error| invalid(&error.to_string()))?
        .len();
    if *total_bytes > MAX_BYTES {
        return Err(exhausted(
            "SQL input exceeds 16 MiB; no partial result was returned",
        ));
    }
    Ok(())
}

fn row_values(
    snapshot: &Snapshot<'_>,
    source: &Source,
    row: DatabaseRowSummary,
) -> Result<Vec<Value>, StoreError> {
    let mut values = vec![
        Value::String(row.page_id.clone()),
        row.page_key.map_or(Value::Null, Value::String),
        Value::String(source.table.data_source_id.clone()),
        Value::String(row.title),
        Value::String(row.created_at),
        Value::String(row.updated_at),
    ];
    for property in &source.properties {
        let value = if matches!(property.schema, DatabasePropertySchema::Relation { .. }) {
            relation(
                snapshot,
                &source.table.data_source_id,
                &row.page_id,
                &property.property_id,
            )?
        } else {
            row.database_values
                .get(&property.property_id)
                .cloned()
                .unwrap_or(Value::Null)
        };
        values.push(value);
    }
    Ok(values)
}

fn relation(
    snapshot: &Snapshot<'_>,
    source: &str,
    page: &str,
    property: &str,
) -> Result<Value, StoreError> {
    let mut targets = Vec::new();
    let mut bytes = 0;
    let mut after = None;
    loop {
        let DatabaseReadValue::RelationTargetWindow { value } =
            snapshot.read(DatabaseRead::RelationTargetWindow {
                address: DatabasePagePropertyAddress {
                    data_source_id: source.to_owned(),
                    page_id: page.to_owned(),
                    property_id: property.to_owned(),
                },
                window: CollectionWindowRequest {
                    after,
                    first: Some(super::relation::MAX_RELATION_WINDOW as u32),
                },
            })?
        else {
            return Err(invalid("Relation targets are unavailable"));
        };
        for target in value.targets.items {
            let target = match target {
                DatabaseRelationTargetItem::Visible { page_id, .. } => Value::String(page_id),
                DatabaseRelationTargetItem::Restricted { .. } => Value::Null,
            };
            bytes += target.to_string().len();
            if bytes > MAX_BYTES || targets.len() >= MAX_INPUT_ROWS {
                return Err(exhausted(
                    "SQL Relation exceeds input budget; no partial result was returned",
                ));
            }
            targets.push(target);
        }
        after = value.targets.next_cursor;
        if after.is_none() {
            break;
        }
    }
    Ok(Value::Array(targets))
}

fn execute(
    database: &Connection,
    tables: &BTreeSet<String>,
    query: &SqlQuery,
    started: Instant,
) -> Result<SqlResult, StoreError> {
    if started.elapsed() >= TIME_BUDGET {
        return Err(exhausted(
            "SQL execution time budget exceeded; no partial result was returned",
        ));
    }
    database.set_limit(Limit::SQLITE_LIMIT_LENGTH, MAX_BYTES as i32)?;
    database.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, MAX_SQL_BYTES as i32)?;
    database.set_limit(Limit::SQLITE_LIMIT_COLUMN, 256)?;
    database.set_limit(Limit::SQLITE_LIMIT_EXPR_DEPTH, 100)?;
    database.set_limit(Limit::SQLITE_LIMIT_COMPOUND_SELECT, 20)?;
    database.set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 100)?;
    database.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, 100_000)?;
    let tables = tables
        .iter()
        .map(|table| table.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    database.authorizer(Some(move |context: AuthContext<'_>| match context.action {
        AuthAction::Select | AuthAction::Recursive => Authorization::Allow,
        // SQLite reports count(*) over a CTE as a read without a database.
        // Its actual table dependencies are authorized independently.
        AuthAction::Read { .. } if context.database_name.is_none() => Authorization::Allow,
        AuthAction::Read { table_name, .. }
            if tables.contains(&table_name.to_ascii_lowercase())
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
    let mut ticks = 0u32;
    database.progress_handler(
        1000,
        Some(move || {
            ticks += 1;
            ticks > 20_000 || started.elapsed() >= TIME_BUDGET
        }),
    )?;
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
        if value.is_array() || value.is_object() {
            return Err(invalid("SQL parameters must be JSON scalars"));
        }
        statement
            .raw_bind_parameter(index, sql_value(value)?)
            .map_err(query_error)?;
    }
    if query.parameters.keys().any(|key| !used.contains(key)) {
        return Err(invalid(
            "Unused SQL parameter; names must exactly match statement parameters without their prefix",
        ));
    }
    let columns = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut cursor = statement.raw_query();
    let mut rows = Vec::new();
    let mut bytes = 0;
    while let Some(row) = cursor.next().map_err(query_error)? {
        if rows.len() >= MAX_RESULT_ROWS {
            return Err(exhausted(
                "SQL result exceeds 10000 rows; add LIMIT; no partial result was returned",
            ));
        }
        let values = (0..columns.len())
            .map(|index| json_value(row.get_ref(index).map_err(query_error)?))
            .collect::<Result<Vec<_>, _>>()?;
        bytes += serde_json::to_vec(&values)
            .map_err(|error| invalid(&error.to_string()))?
            .len();
        if bytes > MAX_RESULT_BYTES {
            return Err(exhausted(
                "SQL result exceeds 8 MiB; no partial result was returned",
            ));
        }
        rows.push(values);
    }
    Ok(SqlResult { columns, rows })
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic() || byte == b'_' || (index > 0 && byte.is_ascii_digit())
        })
}
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
fn storage_type(schema: &DatabasePropertySchema) -> &'static str {
    match schema {
        DatabasePropertySchema::Number { .. } => "REAL",
        DatabasePropertySchema::Checkbox => "INTEGER",
        _ => "TEXT",
    }
}
fn sql_value(value: &Value) -> Result<SqlValue, StoreError> {
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
fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn exhausted(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::ResourceExhausted, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn run(
        database: &Connection,
        sql: &str,
        parameters: &[(&str, Value)],
    ) -> Result<SqlResult, StoreError> {
        execute(
            database,
            &BTreeSet::from(["pages".into(), "other".into()]),
            &SqlQuery {
                scope: SqlScope::default(),
                sql: sql.into(),
                parameters: parameters
                    .iter()
                    .map(|(name, value)| ((*name).into(), value.clone()))
                    .collect(),
            },
            Instant::now(),
        )
    }
    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE pages(page_id TEXT, title TEXT, amount REAL, tags TEXT); CREATE TABLE other(page_id TEXT, factor INTEGER); CREATE TABLE private(secret TEXT); INSERT INTO pages VALUES ('p1','beta',2.5,'[\"red\",\"blue\"]'),('p2','Alpha',NULL,'[]'),('p3','alpha',1.5,'[]'); INSERT INTO other VALUES ('p1',2),('p3',3);").unwrap();
        connection
    }
    #[test]
    fn sqlite_semantics_preserve_joins_nulls_collations_parameters_and_json() {
        let db = fixture();
        let result = run(&db, "SELECT p.page_id, p.amount * o.factor AS weighted FROM pages p LEFT JOIN other o USING(page_id) WHERE p.amount IS NULL OR p.amount >= :minimum ORDER BY p.title COLLATE NOCASE, p.page_id", &[("minimum", json!(2))]).unwrap();
        assert_eq!(result.columns, vec!["page_id", "weighted"]);
        assert_eq!(
            result.rows,
            vec![
                vec![json!("p2"), Value::Null],
                vec![json!("p1"), json!(5.0)]
            ]
        );
        let db = fixture();
        assert_eq!(
            run(
                &db,
                "SELECT p.page_id FROM pages p JOIN json_each(p.tags) t ON t.value=:tag",
                &[("tag", json!("red"))]
            )
            .unwrap()
            .rows,
            vec![vec![json!("p1")]]
        );
        let db = fixture();
        assert_eq!(run(&db, "WITH chosen AS (SELECT * FROM pages WHERE amount IS NOT NULL) SELECT count(*), sum(amount) FROM chosen", &[]).unwrap().rows, vec![vec![json!(2), json!(4.0)]]);
    }
    #[test]
    fn deny_writes_private_metadata_files_and_multiple_statements() {
        for sql in [
            "DELETE FROM pages",
            "SELECT * FROM private",
            "WITH pages AS (SELECT * FROM private) SELECT count(*) FROM pages",
            "SELECT * FROM sqlite_master",
            "PRAGMA table_info(pages)",
            "ATTACH DATABASE ':memory:' AS extra",
            "SELECT load_extension('x')",
            "SELECT readfile('/etc/passwd')",
            "CREATE TABLE x(a)",
            "SELECT 1; SELECT 2",
            "SELECT * FROM pragma_table_info('pages')",
        ] {
            let db = fixture();
            assert!(run(&db, sql, &[]).is_err(), "must deny {sql}");
        }
    }
    #[test]
    fn rejects_missing_unused_positional_and_nonscalar_parameters() {
        for (sql, parameters) in [
            ("SELECT :x", vec![]),
            ("SELECT 1", vec![("x", json!(1))]),
            ("SELECT ?1", vec![("x", json!(1))]),
            ("SELECT :x", vec![("x", json!([]))]),
        ] {
            assert!(run(&fixture(), sql, &parameters).is_err(), "{sql}");
        }
    }
    #[test]
    fn rejects_exhausted_results_and_recursive_work_without_partial_counts() {
        let error = run(&fixture(), "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001) SELECT x FROM n", &[]).unwrap_err();
        assert_eq!(error.code, StoreErrorCode::ResourceExhausted, "{error:?}");
        let error = run(
            &fixture(),
            "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT count(*) FROM n",
            &[],
        )
        .unwrap_err();
        assert_eq!(error.code, StoreErrorCode::ResourceExhausted, "{error:?}");
    }
}
