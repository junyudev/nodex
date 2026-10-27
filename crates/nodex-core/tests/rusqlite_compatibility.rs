use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use rusqlite::limits::Limit;
use rusqlite::{Connection, ErrorCode, MAIN_DB, OpenFlags, params};
use tempfile::tempdir;

const PROBE_SCHEMA: &str = r#"
CREATE TABLE parents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE pages (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER NOT NULL REFERENCES parents(id),
  title TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
);
CREATE VIRTUAL TABLE page_search USING fts5(
  title,
  content='pages',
  content_rowid='id'
);
CREATE TRIGGER pages_search_insert AFTER INSERT ON pages BEGIN
  INSERT INTO page_search(rowid, title) VALUES (new.id, new.title);
END;
CREATE TRIGGER pages_search_delete AFTER DELETE ON pages BEGIN
  INSERT INTO page_search(page_search, rowid, title)
  VALUES ('delete', old.id, old.title);
END;
CREATE TRIGGER pages_search_update AFTER UPDATE OF title ON pages BEGIN
  INSERT INTO page_search(page_search, rowid, title)
  VALUES ('delete', old.id, old.title);
  INSERT INTO page_search(rowid, title) VALUES (new.id, new.title);
END;
"#;

fn configure(connection: &Connection) -> rusqlite::Result<()> {
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    Ok(())
}

fn assert_store_is_valid(connection: &Connection) -> rusqlite::Result<()> {
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    assert_eq!(integrity, "ok");
    let foreign_key_violations: i64 =
        connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    assert_eq!(foreign_key_violations, 0);
    Ok(())
}

#[test]
fn bundled_sqlite_supports_the_cutover_feature_set() -> rusqlite::Result<()> {
    let directory = tempdir().expect("disposable probe directory");
    let source_path = directory.path().join("source.db");
    let backup_path = directory.path().join("backup.db");
    let restored_path = directory.path().join("restored.db");

    let mut source = Connection::open(&source_path)?;
    configure(&source)?;
    let journal_mode: String =
        source.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    assert_eq!(journal_mode.to_lowercase(), "wal");

    let compile_options: Vec<String> = source
        .prepare("PRAGMA compile_options")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    assert!(compile_options.iter().any(|option| option == "ENABLE_FTS5"));
    assert!(rusqlite::version_number() >= 3_038_000);

    let original_sql_limit = source.limit(Limit::SQLITE_LIMIT_SQL_LENGTH)?;
    assert!(source.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 1_000_000)? > 0);
    assert_eq!(source.limit(Limit::SQLITE_LIMIT_SQL_LENGTH)?, 1_000_000);
    let _ = source.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, original_sql_limit)?;

    let commit_count = Arc::new(AtomicUsize::new(0));
    let observed_commits = Arc::clone(&commit_count);
    source.commit_hook(Some(move || {
        observed_commits.fetch_add(1, Ordering::SeqCst);
        false
    }))?;

    source.execute_batch(PROBE_SCHEMA)?;
    source.execute("INSERT INTO parents(id, name) VALUES (1, 'Library')", [])?;
    source.execute(
        "INSERT INTO pages(id, parent_id, title, metadata_json) VALUES (?1, ?2, ?3, ?4)",
        params![1, 1, "Native Core", r#"{"kind":"page"}"#],
    )?;
    source.execute(
        "UPDATE pages SET title = 'Native Rust Core' WHERE id = 1",
        [],
    )?;
    assert!(commit_count.load(Ordering::SeqCst) >= 4);

    let search_match: String = source.query_row(
        "SELECT title FROM page_search WHERE page_search MATCH 'Rust'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(search_match, "Native Rust Core");
    let json_kind: String = source.query_row(
        "SELECT json_extract(metadata_json, '$.kind') FROM pages WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(json_kind, "page");
    assert!(
        source
            .execute(
                "INSERT INTO pages(id, parent_id, title, metadata_json) VALUES (2, 1, 'Bad', 'not-json')",
                [],
            )
            .is_err()
    );
    assert!(
        source
            .execute(
                "INSERT INTO pages(id, parent_id, title, metadata_json) VALUES (2, 999, 'Orphan', '{}')",
                [],
            )
            .is_err()
    );

    let writer = Connection::open(&source_path)?;
    configure(&writer)?;
    writer.execute_batch("BEGIN IMMEDIATE")?;
    let contender = Connection::open(&source_path)?;
    contender.busy_timeout(Duration::from_millis(1))?;
    let busy = contender
        .execute_batch("BEGIN IMMEDIATE")
        .expect_err("the second writer must not acquire the lock");
    assert!(matches!(
        busy.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    ));
    writer.execute_batch("ROLLBACK")?;

    source.backup(
        MAIN_DB,
        &backup_path,
        None::<fn(rusqlite::backup::Progress)>,
    )?;
    let backup = Connection::open_with_flags(
        &backup_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    assert_store_is_valid(&backup)?;
    let backed_up_title: String =
        backup.query_row("SELECT title FROM pages WHERE id = 1", [], |row| row.get(0))?;
    assert_eq!(backed_up_title, "Native Rust Core");
    drop(backup);

    let backup_source = Connection::open(&backup_path)?;
    backup_source.backup(
        MAIN_DB,
        &restored_path,
        None::<fn(rusqlite::backup::Progress)>,
    )?;
    let restored = Connection::open(&restored_path)?;
    configure(&restored)?;
    assert_store_is_valid(&restored)?;
    let restored_title: String =
        restored.query_row("SELECT title FROM pages WHERE id = 1", [], |row| row.get(0))?;
    assert_eq!(restored_title, "Native Rust Core");
    Ok(())
}
