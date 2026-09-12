//! Queue message documents retain their full submission context independently of transcript state.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::BTreeMap;

type State = BTreeMap<String, Vec<Value>>;
pub(super) fn read(connection: &Connection) -> Result<State, StoreError> {
    let json: Option<String> = connection
        .query_row(
            "SELECT state_json FROM codex_queued_message_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match json {
        Some(json) => serde_json::from_str(&json).map_err(|error| {
            StoreError::new(
                StoreErrorCode::StoreCorrupt,
                format!("Invalid queued message state: {error}"),
                false,
            )
        })?,
        None => State::new(),
    })
}
pub(super) fn write(connection: &Connection, state: &State) -> Result<(), StoreError> {
    connection.execute("INSERT INTO codex_queued_message_state(singleton,state_json) VALUES (1,?1) ON CONFLICT(singleton) DO UPDATE SET state_json=excluded.state_json", params![serde_json::to_string(state).map_err(|error| StoreError::new(StoreErrorCode::InvalidInput, format!("Invalid queued message state: {error}"), false))?])?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replaces_full_queue_documents_without_flattening_context() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../schema/migrations/v166_to_v167.sql"))
            .unwrap();
        assert!(read(&connection).unwrap().is_empty());
        let state = BTreeMap::from([(
            "thread-a".into(),
            vec![
                serde_json::json!({"id":"message-a","context":{"commentAttachments":[{"native":"context"}],"model":null},"pausedReason":null}),
            ],
        )]);
        write(&connection, &state).unwrap();
        assert_eq!(read(&connection).unwrap(), state);
        write(&connection, &State::new()).unwrap();
        assert!(read(&connection).unwrap().is_empty());
    }
}
