use super::{Snapshot, invalid, schema};
use crate::infrastructure::sqlite::StoreError;
use nodex_core_contracts::database::DatabasePropertySchema;
use nodex_core_contracts::sql::{SqlSchema, SqlScope, SqlTable};
use nodex_sqlite_query::{Provider, ScanRequest};
use rusqlite::types::Value as SqlValue;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

pub(super) fn tables(
    snapshot: &Arc<Snapshot>,
    scope: SqlScope,
    include_options: bool,
) -> Result<Vec<SqlTable>, StoreError> {
    if scope.bindings.len() > 16 {
        return Err(invalid("SQL accepts at most 16 Source bindings"));
    }
    let mut tables: Vec<_> = schema::RELATIONS
        .iter()
        .filter_map(|name| schema::describe(name))
        .collect();
    let mut names: BTreeSet<_> = schema::RELATIONS.iter().map(|s| s.to_string()).collect();
    names.extend(["json_each".into(), "json_tree".into()]);
    for binding in scope.bindings {
        let alias = binding.table.to_ascii_lowercase();
        if !identifier(&alias) || alias.starts_with("sqlite_") || !names.insert(alias) {
            return Err(invalid(
                "SQL binding must be a unique ASCII identifier, distinct from public and SQLite relations",
            ));
        }
        let table = snapshot.read(|connection| {
            let db = snapshot.database(connection);
            let source = db.source(&binding.data_source_id)?;
            let properties = db.source_properties(&binding.data_source_id)?;
            let mut columns = vec![
                schema::column("page_id", "TEXT", false, "Stable Page identity"),
                schema::column("page_key", "TEXT", true, "Current readable Page key"),
                schema::column("title", "TEXT", false, "Plain title"),
                schema::column("data_source_id", "TEXT", false, "Bound Source identity"),
                schema::column("created_at", "TEXT", false, "Page creation time"),
                schema::column("updated_at", "TEXT", false, "Page update time"),
                schema::column("membership_revision", "INTEGER", false, "Observed member revision for edits"),
                schema::column("value_revisions", "TEXT", false, "JSON object mapping Property IDs to observed revisions; select for prepare-batch"),
            ];
            let mut names: BTreeSet<_> = columns.iter().map(|c| c.name.to_ascii_lowercase()).collect();
            let fallbacks: BTreeMap<_,_> = properties.iter().map(|p| (format!("property_{}",p.property_id).to_ascii_lowercase(),p.property_id.as_str())).collect();
            for property in &properties {
                let unique = fallbacks.get(&property.name.to_ascii_lowercase()).is_none_or(|id| *id == property.property_id) && !property.name.is_empty() && properties.iter().filter(|other| other.name.eq_ignore_ascii_case(&property.name)).count() == 1 && !names.contains(&property.name.to_ascii_lowercase());
                let name = if unique { property.name.clone() } else { format!("property_{}", property.property_id) };
                if !names.insert(name.to_ascii_lowercase()) { return Err(invalid("Property column names collide; rename the conflicting Property")); }
                let storage = match property.schema { DatabasePropertySchema::Number { .. } => "REAL", DatabasePropertySchema::Checkbox => "INTEGER", _ => "TEXT" };
                let mut column = schema::column(&name, storage, true, "Canonical Property value; select uses option IDs, arrays use JSON text");
                column.property_id = Some(property.property_id.clone());
                column.property_schema = Some(property.schema.clone());
                if include_options { column.options = db.property_options(&binding.data_source_id, &property.property_id)?; }
                columns.push(column);
            }
            Ok(SqlTable { table: binding.table.clone(), name: source.data_source.name, data_source_id: Some(binding.data_source_id.clone()),
                description: "One active member Page with lazily selected Properties. No saved View filters apply.".into(), row_identity: vec!["page_id".into()], arguments: Vec::new(), ordering: None,
                examples: vec![format!("SELECT page_id, title FROM {} LIMIT 10", quote(&binding.table))], columns })
        })?;
        snapshot.charge(
            0,
            serde_json::to_vec(&table)
                .map_err(|_| invalid("Invalid query schema"))?
                .len(),
        )?;
        tables.push(table);
    }
    Ok(tables)
}
pub(super) fn describe(
    snapshot: &Arc<Snapshot>,
    scope: SqlScope,
    relation: Option<&str>,
) -> Result<SqlSchema, StoreError> {
    if let Some(database_id) = &scope.database_id {
        snapshot.read(|connection| {
            snapshot.database(connection).rows(
                "databases",
                &BTreeMap::from([("database_id".into(), Value::String(database_id.clone()))]),
            )
        })?;
    }
    let mut tables = tables(snapshot, scope, true)?;
    if let Some(relation) = relation {
        tables.retain(|table| table.table.eq_ignore_ascii_case(relation));
        if tables.is_empty() {
            return Err(invalid(
                "Unknown SQL relation; use sql schema for the catalog or --bind ALIAS=SOURCE_ID for a Source",
            ));
        }
    } else {
        for table in &mut tables {
            table
                .columns
                .retain(|column| table.row_identity.contains(&column.name));
            table.examples.clear();
        }
    }
    Ok(SqlSchema { tables })
}

#[derive(Default)]
struct Cache {
    scans: BTreeMap<String, Vec<String>>,
    rows: BTreeMap<String, Value>,
    cells: BTreeMap<(String, usize), SqlValue>,
}
pub(super) struct Relation {
    pub table: SqlTable,
    snapshot: Arc<Snapshot>,
    cache: Mutex<Cache>,
}
impl Relation {
    pub fn new(table: SqlTable, snapshot: Arc<Snapshot>) -> Self {
        Self {
            table,
            snapshot,
            cache: Mutex::new(Cache::default()),
        }
    }
    fn scan_inner(&self, request: ScanRequest) -> Result<Vec<String>, StoreError> {
        self.snapshot.check_interruption()?;
        // Push only text equalities: SQLite rechecks every ordinary constraint.
        // Numeric coercion, collations and unsupported predicates remain its job.
        let mut equalities = BTreeMap::new();
        for eq in request.equalities {
            let Some(name) = self
                .table
                .columns
                .get(eq.column)
                .map(|c| c.name.as_str())
                .or_else(|| {
                    self.table
                        .arguments
                        .get(eq.column.saturating_sub(self.table.columns.len()))
                        .map(String::as_str)
                })
            else {
                continue;
            };
            let value = match eq.value {
                SqlValue::Text(value) => Some(Value::String(value)),
                SqlValue::Integer(value) if name == "k" => Some(Value::from(value)),
                _ => None,
            };
            if let Some(value) = value {
                equalities.entry(name.to_owned()).or_insert(value);
            }
        }
        if !self.table.arguments.is_empty() {
            equalities.retain(|name, _| self.table.arguments.contains(name));
        }
        let key =
            serde_json::to_string(&equalities).map_err(|_| invalid("Invalid query constraints"))?;
        if let Some(ids) = self
            .cache
            .lock()
            .map_err(|_| invalid("Query cache unavailable"))?
            .scans
            .get(&key)
        {
            return Ok(ids.clone());
        }
        let id = equalities.get("page_id").and_then(Value::as_str);
        let (ids, rows) = self.snapshot.read(|connection| {
            if let Some(source) = &self.table.data_source_id {
                let ids = self.snapshot.database(connection).source_ids(source, id)?;
                #[cfg(test)]
                {
                    self.snapshot.stats.lock().unwrap().source_rows += ids.len();
                }
                return Ok((ids, Vec::new()));
            }
            if matches!(self.table.table.as_str(), "pages" | "page_documents") {
                return Ok((self.snapshot.library(connection).page_ids(id)?, Vec::new()));
            }
            let rows = match self.table.table.as_str() {
                "search_hits" => {
                    let query =
                        equalities
                            .get("query")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                invalid("search_hits requires a text query and integer K")
                            })?;
                    let k = equalities
                        .get("k")
                        .and_then(Value::as_u64)
                        .filter(|k| *k >= 1 && *k <= 100)
                        .ok_or_else(|| invalid("search_hits K must be an integer from 1 to 100"))?;
                    #[cfg(test)]
                    {
                        self.snapshot.stats.lock().unwrap().search_calls += 1;
                    }
                    self.snapshot.library(connection).search(query, k as u32)?
                }
                "view_rows" => {
                    let id = equalities
                        .get("view_id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid("view_rows requires a View ID"))?;
                    self.snapshot.database(connection).view_rows(id)?
                }
                "databases" | "data_sources" | "properties" | "property_options" | "views"
                | "property_values" | "page_relations" => self
                    .snapshot
                    .database(connection)
                    .rows(&self.table.table, &equalities)?,
                _ => self
                    .snapshot
                    .library(connection)
                    .rows(&self.table.table, &equalities)?,
            };
            Ok((Vec::new(), rows))
        })?;
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| invalid("Query cache unavailable"))?;
        let ids = if rows.is_empty() {
            ids
        } else {
            let mut ids = Vec::with_capacity(rows.len());
            for row in rows {
                let identity: Vec<_> = self
                    .table
                    .row_identity
                    .iter()
                    .map(|field| row.get(field).cloned().unwrap_or(Value::Null))
                    .collect();
                let identity = format!("{key}:{}", Value::Array(identity));
                if !cache.rows.contains_key(&identity) {
                    self.snapshot.charge(
                        0,
                        serde_json::to_vec(&row)
                            .map_err(|_| invalid("Invalid query row"))?
                            .len(),
                    )?;
                    cache.rows.insert(identity.clone(), row);
                }
                ids.push(identity);
            }
            ids
        };
        self.snapshot
            .charge(ids.len(), ids.iter().map(String::len).sum())?;
        cache.scans.insert(key, ids.clone());
        Ok(ids)
    }
    fn column_inner(&self, row: &str, index: usize) -> Result<SqlValue, StoreError> {
        self.snapshot.check_interruption()?;
        let column = self
            .table
            .columns
            .get(index)
            .ok_or_else(|| invalid("Invalid SQL column"))?;
        if let Some(value) = self
            .cache
            .lock()
            .map_err(|_| invalid("Query cache unavailable"))?
            .cells
            .get(&(row.to_owned(), index))
        {
            return Ok(value.clone());
        }
        let projected = self
            .cache
            .lock()
            .map_err(|_| invalid("Query cache unavailable"))?
            .rows
            .get(row)
            .cloned();
        let value = if let Some(value) = projected
            .filter(|_| column.property_id.is_none())
            .and_then(|value| value.get(&column.name).cloned())
        {
            value
        } else if column.name == "page_id" {
            Value::String(row.to_owned())
        } else {
            let projected = self.snapshot.read(|connection| {
                if self.table.table == "pages" && column.name == "intrinsic_properties" {
                    return self
                        .snapshot
                        .library(connection)
                        .page_intrinsic_properties(row)
                        .map(|value| (None, value));
                }
                if let Some(source) = &self.table.data_source_id {
                    if let Some(property) = &column.property_id {
                        return self
                            .snapshot
                            .database(connection)
                            .source_value(source, row, property)
                            .map(|value| (None, value));
                    }
                    if column.name == "data_source_id" {
                        return Ok((None, Value::String(source.clone())));
                    }
                    if matches!(
                        column.name.as_str(),
                        "membership_revision" | "value_revisions"
                    ) {
                        let value = self
                            .snapshot
                            .database(connection)
                            .source_versions(source, row)?;
                        let cell = value.get(&column.name).cloned().unwrap_or(Value::Null);
                        return Ok((Some(value), cell));
                    }
                }
                #[cfg(test)]
                {
                    let mut stats = self.snapshot.stats.lock().unwrap();
                    if self.table.table == "page_documents" {
                        stats.document_loads += 1;
                    } else {
                        stats.metadata_loads += 1;
                    }
                }
                let value = if self.table.table == "page_documents" {
                    self.snapshot.library(connection).page_document(row)?
                } else {
                    self.snapshot.library(connection).page_metadata(row)?
                };
                let cell = value.get(&column.name).cloned().unwrap_or(Value::Null);
                Ok((Some(value), cell))
            })?;
            // Cache partial projections by field; unselected Properties remain lazy.
            if let Some(value) = projected.0 {
                self.snapshot.charge(
                    0,
                    serde_json::to_vec(&value)
                        .map_err(|_| invalid("Invalid Page projection"))?
                        .len(),
                )?;
                let mut cache = self
                    .cache
                    .lock()
                    .map_err(|_| invalid("Query cache unavailable"))?;
                let entry = cache
                    .rows
                    .entry(row.to_owned())
                    .or_insert_with(|| Value::Object(Default::default()));
                if let (Some(target), Some(fields)) = (entry.as_object_mut(), value.as_object()) {
                    target.extend(fields.clone());
                }
            }
            projected.1
        };
        let value = super::engine::sql_value(&value)?;
        self.snapshot.charge(
            0,
            match &value {
                SqlValue::Text(s) => s.len(),
                SqlValue::Blob(b) => b.len(),
                _ => 8,
            },
        )?;
        self.cache
            .lock()
            .map_err(|_| invalid("Query cache unavailable"))?
            .cells
            .insert((row.to_owned(), index), value.clone());
        Ok(value)
    }
}
impl Provider for Relation {
    fn scan(&self, request: ScanRequest) -> rusqlite::Result<Vec<String>> {
        self.scan_inner(request)
            .map_err(|error| self.snapshot.callback_error(error))
    }
    fn column(&self, row: &str, column: usize) -> rusqlite::Result<SqlValue> {
        self.column_inner(row, column)
            .map_err(|error| self.snapshot.callback_error(error))
    }
}
fn identifier(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_alphabetic() || b == b'_' || (i > 0 && b.is_ascii_digit()))
}
fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
