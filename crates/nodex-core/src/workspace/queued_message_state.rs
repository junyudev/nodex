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
/// Full queue replacement admits only newly submitted person-authored identities. Reordering,
/// editing and loading an existing capture cannot cancel a subsequently scheduled reminder.
pub(super) fn accept_user_messages(
    connection: &Connection,
    state: &State,
) -> Result<Vec<String>, StoreError> {
    let previous = read(connection)?;
    let now = super::session_mutation::sqlite_now(connection)?;
    let mut changed = std::collections::BTreeSet::new();
    for (thread_id, messages) in state {
        let session_id = connection
            .query_row(
                "SELECT session_id FROM project_session_threads WHERE thread_id=?1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(session_id) = session_id else {
            continue;
        };
        for message in messages {
            let Some(message_id) = message.get("id").and_then(Value::as_str) else {
                continue;
            };
            if previous.get(thread_id).is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item.get("id").and_then(Value::as_str) == Some(message_id))
            }) {
                continue;
            }
            let Some(prompt) = message.pointer("/context/prompt").and_then(Value::as_str) else {
                continue;
            };
            let prompt = prompt.trim();
            // The native protocol's delegation envelope is the sender provenance of tool input.
            if (prompt.starts_with("<codex_delegation>") && prompt.ends_with("</codex_delegation>"))
                || (prompt.starts_with("<realtime_delegation>")
                    && prompt.ends_with("</realtime_delegation>"))
                || message
                    .pointer("/context/turnTrigger")
                    .is_some_and(|value| !value.is_null())
            {
                continue;
            }
            if super::session_mutation::accept_person_message(
                connection,
                &session_id,
                message_id,
                &connection.query_row(
                    "SELECT member_id FROM local_profile_members LIMIT 1",
                    [],
                    |r| r.get::<_, String>(0),
                )?,
                &now,
            )? {
                changed.insert(session_id.clone());
            }
        }
    }
    Ok(changed.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replaces_full_queue_documents_without_flattening_context() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../schema/migrations/v167_to_v168.sql"))
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
