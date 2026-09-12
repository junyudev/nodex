//! Authenticated read-state storage does not require resident or catalogued Threads.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use rusqlite::{Connection, params};
#[cfg(test)]
use std::collections::BTreeMap;

fn validate(name: &str, value: &str) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > 1024 {
        return Err(StoreError::new(
            StoreErrorCode::InvalidInput,
            format!("Invalid {name}"),
            false,
        ));
    }
    Ok(())
}

#[cfg(test)]
fn read(
    connection: &Connection,
    identity_key: &str,
) -> Result<BTreeMap<String, Vec<String>>, StoreError> {
    validate("identity key", identity_key)?;
    let mut statement = connection.prepare("SELECT execution_host_key, thread_id FROM codex_identity_unread_threads WHERE identity_key = ?1 ORDER BY execution_host_key, unread_position")?;
    let rows = statement.query_map([identity_key], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut result: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in rows {
        let (host, thread) = row?;
        result.entry(host).or_default().push(thread);
    }
    Ok(result)
}

pub(super) fn set(
    connection: &Connection,
    identity_key: &str,
    host_key: &str,
    thread_id: &str,
    unread: bool,
) -> Result<(), StoreError> {
    validate("identity key", identity_key)?;
    validate("execution host key", host_key)?;
    validate("Thread ID", thread_id)?;
    if !unread {
        connection.execute("DELETE FROM codex_identity_unread_threads WHERE identity_key = ?1 AND execution_host_key = ?2 AND thread_id = ?3", params![identity_key, host_key, thread_id])?;
        return Ok(());
    }
    connection.execute("INSERT OR IGNORE INTO codex_identity_unread_threads(identity_key,execution_host_key,thread_id,unread_position) SELECT ?1,?2,?3,COALESCE(MAX(unread_position),0)+1 FROM codex_identity_unread_threads WHERE identity_key = ?1 AND execution_host_key = ?2", params![identity_key, host_key, thread_id])?;
    Ok(())
}

pub(super) fn clear(connection: &Connection, identity_key: &str) -> Result<(), StoreError> {
    validate("identity key", identity_key)?;
    connection.execute(
        "DELETE FROM codex_identity_unread_threads WHERE identity_key = ?1",
        [identity_key],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_identity_updates_sidebar_without_touching_other_backends() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../schema/migrations/v165_to_v166.sql"))
            .unwrap();
        connection.execute_batch("CREATE TABLE codex_threads(thread_id TEXT PRIMARY KEY, agent_backend_kind TEXT, execution_host_id TEXT, archived INTEGER); CREATE TABLE codex_unread_threads(thread_id TEXT PRIMARY KEY); CREATE TABLE project_sessions(id TEXT PRIMARY KEY, unread INTEGER); CREATE TABLE project_session_threads(session_id TEXT, thread_id TEXT); INSERT INTO codex_threads VALUES ('a','codex','local',0),('b','acp','local',0); INSERT INTO project_sessions VALUES ('sa',1),('sb',1); INSERT INTO project_session_threads VALUES ('sa','a'),('sb','b'); INSERT INTO codex_unread_threads VALUES ('a'),('b');").unwrap();
        let hosts = [("local".to_string(), "key".to_string())]
            .into_iter()
            .collect();
        set(&connection, "first", "key", "a", true).unwrap();
        project(&connection, Some("second"), &hosts).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT unread FROM project_sessions WHERE id='sa'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT unread FROM project_sessions WHERE id='sb'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        project(&connection, Some("first"), &hosts).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT unread FROM project_sessions WHERE id='sa'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        project(&connection, None, &hosts).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT unread FROM project_sessions WHERE id='sa'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn preserves_identity_host_isolation_and_unread_insertion_order() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../schema/migrations/v165_to_v166.sql"))
            .unwrap();
        set(&connection, "account-a", "host-a", "second", true).unwrap();
        set(&connection, "account-a", "host-a", "first", true).unwrap();
        set(&connection, "account-a", "host-a", "second", true).unwrap();
        set(&connection, "account-a", "host-b", "remote", true).unwrap();
        set(&connection, "account-b", "host-a", "private", true).unwrap();
        assert_eq!(
            read(&connection, "account-a").unwrap()["host-a"],
            vec!["second", "first"]
        );
        set(&connection, "account-a", "host-a", "second", false).unwrap();
        set(&connection, "account-a", "host-a", "second", true).unwrap();
        assert_eq!(
            read(&connection, "account-a").unwrap()["host-a"],
            vec!["first", "second"]
        );
        clear(&connection, "account-a").unwrap();
        assert!(read(&connection, "account-a").unwrap().is_empty());
        assert_eq!(
            read(&connection, "account-b").unwrap()["host-a"],
            vec!["private"]
        );
    }
}

pub(super) fn read_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    identity_key: &str,
    request: &nodex_core_contracts::collection::CollectionWindowRequest,
) -> Result<
    nodex_core_contracts::collection::CollectionWindow<
        nodex_core_contracts::workspace::ThreadUnreadEntry,
    >,
    StoreError,
> {
    use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
    use crate::infrastructure::cursor::{
        self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
    };
    use nodex_core_contracts::collection::CollectionWindowAuthority;
    use nodex_core_contracts::workspace::ThreadUnreadEntry;
    validate("identity key", identity_key)?;
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&("identity_thread_read_state", identity_key))?;
    let subject = CollectionCursorSubject {
        kind: "identity_thread_read_state",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let mut after_host = String::new();
    let mut after_position = -1;
    if let Some(encoded) = normalized.after {
        let (direction, coordinate) = cursor::decode(connection, encoded, subject)?;
        match (direction, coordinate.values.as_slice()) {
            (
                CursorDirection::Forward,
                [
                    KeysetValue::Text { value: host },
                    KeysetValue::Integer { value: position },
                ],
            ) => {
                after_host = host.clone();
                after_position = *position;
            }
            _ => {
                return Err(StoreError::new(
                    StoreErrorCode::InvalidInput,
                    "Invalid read-state cursor",
                    false,
                ));
            }
        }
    }
    let mut statement = connection.prepare("SELECT execution_host_key, thread_id, unread_position FROM codex_identity_unread_threads WHERE identity_key = ?1 AND (execution_host_key > ?2 OR (execution_host_key = ?2 AND unread_position > ?3)) ORDER BY execution_host_key, unread_position LIMIT ?4")?;
    let candidates = statement
        .query_map(
            params![
                identity_key,
                after_host,
                after_position,
                (normalized.first + 1) as i64
            ],
            |row| {
                let host: String = row.get(0)?;
                let thread: String = row.get(1)?;
                let position: i64 = row.get(2)?;
                Ok(WindowCandidate {
                    coordinate: KeysetCoordinate {
                        values: vec![
                            KeysetValue::Text {
                                value: host.clone(),
                            },
                            KeysetValue::Integer { value: position },
                        ],
                        stable_id: thread.clone(),
                    },
                    item: ThreadUnreadEntry {
                        execution_host_key: host,
                        thread_id: thread,
                    },
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
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

pub(super) fn project(
    connection: &Connection,
    identity_key: Option<&str>,
    hosts: &std::collections::BTreeMap<String, String>,
) -> Result<(), StoreError> {
    if let Some(key) = identity_key {
        validate("identity key", key)?;
    }
    connection.execute("DELETE FROM codex_unread_threads WHERE thread_id IN (SELECT thread_id FROM codex_threads WHERE agent_backend_kind = 'codex')", [])?;
    if let Some(key) = identity_key {
        for (host_id, host_key) in hosts {
            validate("execution host key", host_key)?;
            connection.execute("INSERT OR IGNORE INTO codex_unread_threads(thread_id) SELECT unread.thread_id FROM codex_identity_unread_threads unread JOIN codex_threads thread ON thread.thread_id = unread.thread_id WHERE unread.identity_key = ?1 AND unread.execution_host_key = ?2 AND thread.execution_host_id = ?3 AND thread.agent_backend_kind = 'codex' AND thread.archived = 0", params![key, host_key, host_id])?;
        }
    }
    connection.execute("UPDATE project_sessions SET unread = EXISTS(SELECT 1 FROM codex_unread_threads unread JOIN project_session_threads link ON link.thread_id = unread.thread_id WHERE link.session_id = project_sessions.id) WHERE id IN (SELECT link.session_id FROM project_session_threads link JOIN codex_threads thread ON thread.thread_id = link.thread_id WHERE thread.agent_backend_kind = 'codex')", [])?;
    Ok(())
}
