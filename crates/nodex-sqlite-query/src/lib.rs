//! Safe, read-only provider boundary for SQLite virtual relations.
//!
//! Providers own their snapshot and enforce authorization, budgets, and domain
//! semantics. This adapter never opens a Store or reads private storage itself.
#![deny(unsafe_code)]

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CStr, CString, c_int};
use std::sync::{Arc, Mutex};

use rusqlite::types::Value;
use rusqlite::vtab::{
    Context, Filters, IndexConstraintOp, IndexInfo, Module, VTab, VTabConnection, VTabCursor,
    sqlite3_vtab, sqlite3_vtab_cursor,
};
use rusqlite::{Connection, Error, Result};

#[derive(Clone, Copy, Debug)]
pub enum Affinity {
    Text,
    Integer,
    Real,
    Blob,
}

impl Affinity {
    fn sql(self) -> &'static str {
        match self {
            Self::Text => "TEXT",
            Self::Integer => "INTEGER",
            Self::Real => "REAL",
            Self::Blob => "BLOB",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Column {
    pub name: String,
    pub affinity: Affinity,
    pub hidden: bool,
}

#[derive(Clone, Debug)]
pub struct Table {
    pub name: String,
    pub columns: Vec<Column>,
    /// Equality on this column is a cheap lookup. SQLite still checks equality.
    pub identity_column: Option<usize>,
    /// Hidden columns bound positionally by relation(arg, ...). Every required
    /// argument must have a usable equality constraint for a legal scan plan.
    pub required_arguments: Vec<usize>,
    pub scan_cost: f64,
    pub estimated_rows: i64,
}

#[derive(Clone, Debug)]
pub struct Equality {
    pub column: usize,
    pub value: Value,
}

#[derive(Clone, Debug)]
pub struct ScanRequest {
    /// Binary-collation equality candidates. Ordinary predicates remain checked
    /// by SQLite; providers must not exclude rows that could satisfy equality
    /// under SQLite's affinity/coercion rules. Ignoring a candidate is valid.
    pub equalities: Vec<Equality>,
    /// Includes filter/order columns as well as output. For SQLite's overflow
    /// bit, every column at index 63 or above is conservatively included.
    pub used_columns: Vec<usize>,
}

/// One provider represents one relation over an owned immutable observation.
/// Row handles must remain valid for the entire query, including concurrent
/// cursors and subsequent scans. Providers should cache expensive row projections
/// and function results; SQLite may request a selected column more than once.
pub trait Provider: Send + Sync + 'static {
    fn scan(&self, request: ScanRequest) -> Result<Vec<String>>;
    fn column(&self, row: &str, column: usize) -> Result<Value>;
}

struct Registration {
    table: Table,
    provider: Arc<dyn Provider>,
    rowids: Mutex<BTreeMap<String, i64>>,
}

/// Registers an eponymous read-only relation. No CREATE TABLE, raw SQL schema,
/// connection pointer, or lifetime-erased callback crosses this boundary.
pub fn register(connection: &Connection, table: Table, provider: Arc<dyn Provider>) -> Result<()> {
    const MODULE: Module<'static, Relation> = Module::<Relation>::eponymous_only_module();
    validate(&table)?;
    let name = table.name.clone();
    connection.create_module(
        name.as_str(),
        &MODULE,
        Some(Arc::new(Registration {
            table,
            provider,
            rowids: Mutex::new(BTreeMap::new()),
        })),
    )
}

fn invalid(message: impl Into<String>) -> Error {
    Error::ModuleError(message.into())
}

fn validate(table: &Table) -> Result<()> {
    if table.name.is_empty() || table.name.contains('\0') || table.columns.is_empty() {
        return Err(invalid("A relation requires a name and columns"));
    }
    if !table.scan_cost.is_finite() || table.scan_cost <= 0.0 || table.estimated_rows < 0 {
        return Err(invalid(
            "Relation scan estimates must be finite and nonnegative",
        ));
    }
    let mut names = BTreeSet::new();
    for column in &table.columns {
        if column.name.is_empty()
            || column.name.contains('\0')
            || !names.insert(column.name.to_ascii_lowercase())
        {
            return Err(invalid("Relation columns require unique nonempty names"));
        }
    }
    if table
        .identity_column
        .is_some_and(|index| index >= table.columns.len())
    {
        return Err(invalid("Relation identity column is out of range"));
    }
    let required = table
        .required_arguments
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    if required.len() != table.required_arguments.len()
        || required.iter().any(|index| {
            table
                .columns
                .get(*index)
                .is_none_or(|column| !column.hidden)
        })
    {
        return Err(invalid(
            "Required arguments must identify distinct hidden columns",
        ));
    }
    Ok(())
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[repr(C)]
struct Relation {
    base: sqlite3_vtab,
    registration: Arc<Registration>,
}

// SAFETY: repr(C) and the first sqlite3_vtab field satisfy rusqlite's layout
// contract. All remaining state is owned; no raw pointer is read or constructed.
#[allow(unsafe_code)]
unsafe impl<'vtab> VTab<'vtab> for Relation {
    type Aux = Arc<Registration>;
    type Cursor = Cursor;

    fn connect(
        _db: &mut VTabConnection,
        aux: Option<&Self::Aux>,
        _module_name: &[u8],
        _database_name: &[u8],
        _table_name: &[u8],
        _args: &[&[u8]],
    ) -> Result<(Cow<'static, CStr>, Self)> {
        let registration = aux
            .cloned()
            .ok_or_else(|| invalid("Missing relation provider"))?;
        let columns = registration
            .table
            .columns
            .iter()
            .map(|column| {
                format!(
                    "{} {}{}",
                    quote(&column.name),
                    column.affinity.sql(),
                    if column.hidden { " HIDDEN" } else { "" }
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let schema = CString::new(format!("CREATE TABLE x({columns})"))
            .map_err(|_| invalid("Invalid relation schema"))?;
        Ok((
            Cow::Owned(schema),
            Self {
                base: sqlite3_vtab::default(),
                registration,
            },
        ))
    }

    fn best_index(&self, info: &mut IndexInfo) -> Result<bool> {
        let table = &self.registration.table;
        let candidates = info
            .constraints()
            .enumerate()
            .filter_map(|(index, constraint)| {
                if !constraint.is_usable()
                    || constraint.column() < 0
                    || constraint.operator() != IndexConstraintOp::SQLITE_INDEX_CONSTRAINT_EQ
                {
                    return None;
                }
                Some((index, constraint.column() as usize))
            })
            .collect::<Vec<_>>();
        let mut selected = Vec::new();
        for (index, column) in candidates {
            // A custom collation could make an otherwise unequal identity match.
            if !info.collation(index)?.eq_ignore_ascii_case("BINARY") {
                continue;
            }
            selected.push((index, column));
        }
        if table
            .required_arguments
            .iter()
            .any(|required| !selected.iter().any(|(_, column)| column == required))
        {
            return Ok(false);
        }
        for (argument, (index, _)) in selected.iter().enumerate() {
            let mut usage = info.constraint_usage(*index);
            usage.set_argv_index((argument + 1) as c_int);
            // Even hidden arguments remain checked: conflicting duplicate
            // argument constraints must not silently select an arbitrary value.
            usage.set_omit(false);
        }
        let mask = info.col_used();
        let columns = selected
            .iter()
            .map(|(_, column)| column.to_string())
            .collect::<Vec<_>>()
            .join(",");
        info.set_idx_str(&format!("{mask}:{columns}"));
        let lookup = table
            .identity_column
            .is_some_and(|identity| selected.iter().any(|(_, column)| *column == identity));
        info.set_estimated_cost(if lookup { 1.0 } else { table.scan_cost });
        info.set_estimated_rows(if lookup { 1 } else { table.estimated_rows });
        Ok(true)
    }

    fn open(&'vtab mut self) -> Result<Self::Cursor> {
        Ok(Cursor {
            base: sqlite3_vtab_cursor::default(),
            registration: Arc::clone(&self.registration),
            rows: Vec::new(),
            position: 0,
            arguments: BTreeMap::new(),
        })
    }
}

#[repr(C)]
struct Cursor {
    base: sqlite3_vtab_cursor,
    registration: Arc<Registration>,
    rows: Vec<String>,
    position: usize,
    arguments: BTreeMap<usize, Value>,
}

// SAFETY: repr(C) and the first sqlite3_vtab_cursor field satisfy rusqlite's
// cursor layout contract. The cursor owns its registration and row handles.
#[allow(unsafe_code)]
unsafe impl VTabCursor for Cursor {
    fn filter(&mut self, _idx_num: c_int, idx_str: Option<&str>, args: &Filters<'_>) -> Result<()> {
        self.rows.clear();
        self.position = 0;
        self.arguments.clear();
        let (mask, columns) = idx_str
            .and_then(|plan| plan.split_once(':'))
            .ok_or_else(|| invalid("Missing relation scan plan"))?;
        let mask = mask
            .parse::<u64>()
            .map_err(|_| invalid("Invalid relation projection"))?;
        let mut equalities = Vec::new();
        for (argument, column) in columns
            .split(',')
            .filter(|column| !column.is_empty())
            .enumerate()
        {
            let column = column
                .parse::<usize>()
                .map_err(|_| invalid("Invalid relation constraint"))?;
            let value = args.get::<Value>(argument)?;
            if self.registration.table.columns[column].hidden {
                self.arguments
                    .entry(column)
                    .or_insert_with(|| value.clone());
            }
            equalities.push(Equality { column, value });
        }
        let used_columns = (0..self.registration.table.columns.len())
            .filter(|column| mask & (1_u64 << (*column).min(63)) != 0)
            .collect();
        self.rows = self.registration.provider.scan(ScanRequest {
            equalities,
            used_columns,
        })?;
        Ok(())
    }

    fn next(&mut self) -> Result<()> {
        self.position += 1;
        Ok(())
    }
    fn eof(&self) -> bool {
        self.position >= self.rows.len()
    }

    fn column(&self, ctx: &mut Context, column: c_int) -> Result<()> {
        let column = usize::try_from(column).map_err(|_| invalid("Invalid relation column"))?;
        if let Some(value) = self.arguments.get(&column) {
            return ctx.set_result(value);
        }
        let row = self
            .rows
            .get(self.position)
            .ok_or_else(|| invalid("Relation cursor is exhausted"))?;
        ctx.set_result(&self.registration.provider.column(row, column)?)
    }

    fn rowid(&self) -> Result<i64> {
        let row = self
            .rows
            .get(self.position)
            .ok_or_else(|| invalid("Relation cursor is exhausted"))?;
        let mut rowids = self
            .registration
            .rowids
            .lock()
            .map_err(|_| invalid("Relation row identity lock failed"))?;
        let next = i64::try_from(rowids.len())
            .map_err(|_| invalid("Relation has too many row identities"))?;
        Ok(*rowids.entry(row.clone()).or_insert(next))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fixture {
        scans: Mutex<Vec<ScanRequest>>,
        reads: Mutex<Vec<(String, usize)>>,
    }
    impl Provider for Fixture {
        fn scan(&self, request: ScanRequest) -> Result<Vec<String>> {
            let identity = request.equalities.iter().find(|item| item.column == 0);
            let rows = match identity.map(|item| &item.value) {
                Some(Value::Text(id)) => vec![id.clone()],
                _ => vec!["a".to_owned(), "b".to_owned(), "c".to_owned()],
            };
            self.scans.lock().unwrap().push(request);
            Ok(rows)
        }
        fn column(&self, row: &str, column: usize) -> Result<Value> {
            self.reads.lock().unwrap().push((row.to_owned(), column));
            Ok(Value::Text(if column == 0 {
                row.to_owned()
            } else {
                format!("body:{row}:{column}")
            }))
        }
    }
    fn table(name: &str) -> Table {
        Table {
            name: name.to_owned(),
            columns: vec![
                Column {
                    name: "page_id".into(),
                    affinity: Affinity::Text,
                    hidden: false,
                },
                Column {
                    name: "body".into(),
                    affinity: Affinity::Text,
                    hidden: false,
                },
            ],
            identity_column: Some(0),
            required_arguments: vec![],
            scan_cost: 100_000.0,
            estimated_rows: 1000,
        }
    }
    fn fixture(connection: &Connection, schema: Table) -> Arc<Fixture> {
        let provider = Arc::new(Fixture::default());
        register(connection, schema, provider.clone()).unwrap();
        provider
    }

    #[test]
    fn identity_and_projection_remain_lazy() {
        let connection = Connection::open_in_memory().unwrap();
        let provider = fixture(&connection, table("pages"));
        let id: String = connection
            .query_row("SELECT page_id FROM pages WHERE page_id = 'b'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(id, "b");
        let scans = provider.scans.lock().unwrap();
        assert_eq!(scans.len(), 1);
        assert_eq!(scans[0].used_columns, vec![0]);
        assert!(matches!(&scans[0].equalities[0].value, Value::Text(id) if id == "b"));
        assert!(
            provider
                .reads
                .lock()
                .unwrap()
                .iter()
                .all(|(id, column)| id == "b" && *column == 0)
        );
    }

    #[test]
    fn join_looks_up_only_selected_documents() {
        let connection = Connection::open_in_memory().unwrap();
        fixture(&connection, table("pages"));
        let documents = fixture(&connection, table("documents"));
        let mut statement = connection.prepare("WITH chosen AS MATERIALIZED (SELECT page_id FROM pages LIMIT 2) SELECT documents.body FROM chosen JOIN documents USING(page_id)").unwrap();
        let bodies = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>>>()
            .unwrap();
        assert_eq!(bodies, vec!["body:a:1", "body:b:1"]);
        let scans = documents.scans.lock().unwrap();
        assert_eq!(scans.len(), 2);
        assert!(
            scans
                .iter()
                .all(|scan| scan.equalities.iter().any(|item| item.column == 0))
        );
        assert!(
            documents
                .reads
                .lock()
                .unwrap()
                .iter()
                .all(|(id, _)| id != "c")
        );
    }

    #[test]
    fn functions_require_arguments_and_recheck_conflicting_constraints() {
        let connection = Connection::open_in_memory().unwrap();
        let mut schema = table("hits");
        schema.columns.push(Column {
            name: "query".into(),
            affinity: Affinity::Text,
            hidden: true,
        });
        schema.columns.push(Column {
            name: "k".into(),
            affinity: Affinity::Integer,
            hidden: true,
        });
        schema.required_arguments = vec![2, 3];
        let provider = fixture(&connection, schema);
        assert!(connection.prepare("SELECT * FROM hits").is_err());
        assert!(connection.prepare("SELECT * FROM hits('needle')").is_err());
        let count: i64 = connection
            .query_row("SELECT count(*) FROM hits('needle', 3)", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 3);
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM hits('needle', 3) WHERE query='other'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        assert!(provider.scans.lock().unwrap().iter().all(|scan| {
            scan.equalities
                .iter()
                .any(|item| item.column == 3 && item.value == Value::Integer(3))
        }));
    }

    #[test]
    fn wide_projection_conservatively_expands_sqlite_overflow_bit() {
        let connection = Connection::open_in_memory().unwrap();
        let mut schema = table("wide");
        for index in 2..70 {
            schema.columns.push(Column {
                name: format!("c{index}"),
                affinity: Affinity::Text,
                hidden: false,
            });
        }
        let provider = fixture(&connection, schema);
        let value: String = connection
            .query_row("SELECT c69 FROM wide LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "body:a:69");
        assert_eq!(
            provider.scans.lock().unwrap()[0].used_columns,
            (63..70).collect::<Vec<_>>()
        );
        assert_eq!(*provider.reads.lock().unwrap(), vec![("a".into(), 69)]);
    }

    #[test]
    fn nonbinary_equality_is_left_to_sqlite_and_rows_have_stable_identity() {
        let connection = Connection::open_in_memory().unwrap();
        let provider = fixture(&connection, table("pages"));
        let (id, first_rowid): (String, i64) = connection
            .query_row(
                "SELECT page_id, rowid FROM pages WHERE page_id = 'B' COLLATE NOCASE",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(id, "b");
        assert!(provider.scans.lock().unwrap()[0].equalities.is_empty());
        let second_rowid: i64 = connection
            .query_row("SELECT rowid FROM pages WHERE page_id = 'b'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(first_rowid, second_rowid);
    }

    #[test]
    fn count_reads_no_values_and_relation_rejects_writes() {
        let connection = Connection::open_in_memory().unwrap();
        let provider = fixture(&connection, table("pages"));
        let count: i64 = connection
            .query_row("SELECT count(*) FROM pages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 3);
        assert!(provider.reads.lock().unwrap().is_empty());
        assert!(connection.execute("DELETE FROM pages", []).is_err());
        assert!(
            connection
                .execute("INSERT INTO pages VALUES ('d', 'body')", [])
                .is_err()
        );
        assert!(
            connection
                .execute("UPDATE pages SET body = 'changed'", [])
                .is_err()
        );
    }

    #[test]
    fn provider_failure_aborts_the_statement() {
        struct Failing;
        impl Provider for Failing {
            fn scan(&self, _request: ScanRequest) -> Result<Vec<String>> {
                Err(invalid("observation budget exceeded"))
            }
            fn column(&self, _row: &str, _column: usize) -> Result<Value> {
                unreachable!()
            }
        }
        let connection = Connection::open_in_memory().unwrap();
        register(&connection, table("pages"), Arc::new(Failing)).unwrap();
        let error = connection
            .query_row("SELECT count(*) FROM pages", [], |row| row.get::<_, i64>(0))
            .unwrap_err();
        assert!(error.to_string().contains("observation budget exceeded"));
    }
}
