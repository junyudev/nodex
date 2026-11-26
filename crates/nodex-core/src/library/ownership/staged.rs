use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension};

use super::{EdgeDirection, Graph, Kind, NodeId, corrupt, decode_owner, edge_sql};
use crate::infrastructure::sqlite::StoreError;

/// Capture the first owner seen in the LocalCommit. The TEMP ledger and its
/// triggers roll back with the writer transaction (including savepoints).
/// Rebuilding an index or toggling lifecycle without changing the final
/// owner must not make an unrelated old cycle block the commit.
pub(crate) fn begin(connection: &Connection, commit_seq: i64) -> Result<(), StoreError> {
    let installed = connection
        .prepare_cached("SELECT 1 FROM sqlite_temp_master WHERE name = 'staged_ownership_capture'")?
        .exists([])?;
    if !installed {
        install(connection)?;
    }
    connection.execute(
        "INSERT INTO staged_ownership_capture(singleton, commit_seq) VALUES (1, ?1)",
        [commit_seq],
    )?;
    Ok(())
}

pub(crate) fn validate_and_clear(
    connection: &Connection,
    commit_seq: i64,
) -> Result<(), StoreError> {
    let active = connection
        .query_row(
            "SELECT commit_seq FROM staged_ownership_capture WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if active != Some(commit_seq) {
        return Err(corrupt("LocalCommit lost its staged ownership ledger"));
    }
    let mut statement = connection.prepare_cached(
        "SELECT library_id, kind, node_id, owner_kind, owner_id
         FROM staged_ownership_changes",
    )?;
    let mut rows = statement.query([])?;
    let mut changes = BTreeMap::<String, Vec<_>>::new();
    while let Some(row) = rows.next()? {
        let library_id: String = row.get(0)?;
        let kind = Kind::parse(&row.get::<_, String>(1)?)?;
        let id: String = row.get(2)?;
        let owner_kind = row.get(3)?;
        let owner_id = row.get(4)?;
        let previous = match (owner_kind, owner_id) {
            (None, None) => None, // The node was new or deleted.
            (kind, id) => decode_owner(&library_id, kind, id)?,
        };
        changes
            .entry(library_id)
            .or_default()
            .push((NodeId { kind, id }, previous));
    }
    for (library_id, edges) in changes {
        Graph::new(connection, &library_id).validate_changes(edges)?;
    }
    connection.execute_batch(
        "DELETE FROM staged_ownership_changes;
         DELETE FROM staged_ownership_capture;",
    )?;
    Ok(())
}

fn install(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch(
        "CREATE TEMP TABLE staged_ownership_capture (
           singleton INTEGER PRIMARY KEY CHECK (singleton = 1), commit_seq INTEGER NOT NULL
         );
         CREATE TEMP TABLE staged_ownership_changes (
           library_id TEXT NOT NULL, kind TEXT NOT NULL, node_id TEXT NOT NULL,
           owner_kind TEXT, owner_id TEXT, PRIMARY KEY (library_id, kind, node_id)
         ) WITHOUT ROWID;",
    )?;
    for (kind, table, id) in [
        (Kind::Page, "pages", "block_id"),
        (Kind::Database, "database_containers", "block_id"),
        (Kind::Canvas, "canvas_owners", "block_id"),
        (Kind::DataSource, "data_sources", "id"),
    ] {
        install_capture(
            connection,
            kind,
            table,
            "INSERT",
            "NEW.library_id",
            &format!("NEW.{id}"),
            "TRUE",
        )?;
    }
    install_capture(
        connection,
        Kind::Page,
        "pages",
        "UPDATE OF parent_kind, parent_id",
        "OLD.library_id",
        "OLD.block_id",
        "OLD.parent_kind <> NEW.parent_kind OR OLD.parent_id <> NEW.parent_id",
    )?;
    install_capture(
        connection,
        Kind::DataSource,
        "data_sources",
        "UPDATE OF lifecycle, home_database_block_id",
        "OLD.library_id",
        "OLD.id",
        "(OLD.lifecycle = 'deleted') <> (NEW.lifecycle = 'deleted') OR OLD.home_database_block_id <> NEW.home_database_block_id",
    )?;
    install_capture(
        connection,
        Kind::Database,
        "database_containers",
        "UPDATE OF lifecycle",
        "OLD.library_id",
        "OLD.block_id",
        "(OLD.lifecycle = 'deleted') <> (NEW.lifecycle = 'deleted')",
    )?;
    for kind in [Kind::Page, Kind::Database, Kind::Canvas] {
        install_capture(
            connection,
            kind,
            "blocks",
            "UPDATE OF lifecycle",
            "OLD.library_id",
            "OLD.id",
            &format!(
                "OLD.type = '{}' AND (OLD.lifecycle = 'deleted') <> (NEW.lifecycle = 'deleted')",
                kind.as_str()
            ),
        )?;
    }
    for kind in [Kind::Database, Kind::Canvas] {
        for (event, row) in [
            ("DELETE", "OLD"),
            ("INSERT", "NEW"),
            ("UPDATE OF document_id", "OLD"),
        ] {
            install_capture(
                connection,
                kind,
                "document_block_index",
                event,
                &format!("(SELECT library_id FROM blocks WHERE id = {row}.block_id)"),
                &format!("{row}.block_id"),
                &format!(
                    "(SELECT type FROM blocks WHERE id = {row}.block_id) = '{}'",
                    kind.as_str()
                ),
            )?;
        }
    }
    Ok(())
}

// The event names and SQL expressions below are internal schema literals.
// Snapshot the same edge the graph will read at seal, before the first change.
fn install_capture(
    connection: &Connection,
    kind: Kind,
    table: &str,
    event: &str,
    library: &str,
    id: &str,
    condition: &str,
) -> Result<(), StoreError> {
    let edge = edge_sql(kind, EdgeDirection::Identity)
        .replace("?1", library)
        .replace("?2", id);
    let kind = kind.as_str();
    let action = event
        .split_ascii_whitespace()
        .next()
        .expect("capture event");
    connection.execute_batch(&format!(
        "CREATE TEMP TRIGGER staged_ownership_{table}_{kind}_{action}
         BEFORE {event} ON main.{table}
         WHEN EXISTS(SELECT 1 FROM staged_ownership_capture) AND ({condition})
         BEGIN
           INSERT INTO staged_ownership_changes(library_id, kind, node_id, owner_kind, owner_id)
           SELECT {library}, '{kind}', {id}, edge.owner_kind, edge.owner_id
           FROM (SELECT 1) LEFT JOIN ({edge}) edge ON TRUE
           WHERE NOT EXISTS (
             SELECT 1 FROM staged_ownership_changes
             WHERE library_id = {library} AND kind = '{kind}' AND node_id = {id}
           );
         END;"
    ))?;
    Ok(())
}
