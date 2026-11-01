//! Attachment evidence belongs to the Page/File relation, independently of File
//! creation evidence. Only command admission chooses an actor; intents cannot.

use nodex_core_contracts::library::{LibraryPageFileAttachment, LibraryPageFileAttachmentActor};
use nodex_core_contracts::{AdapterKind, BoundModuleContext};

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

/// The single Page File attribution admission seam. An Agent is named only by
/// the attribution its Core-issued credential proved for this request; a Project,
/// an adapter label or caller-supplied Turn metadata proves nothing. The desktop
/// Host acts for the person, and any other unverified caller is external.
pub(super) fn resolve_actor(
    context: &BoundModuleContext,
) -> Result<LibraryPageFileAttachmentActor, StoreError> {
    if let Some(attribution) = &context.agent_attribution {
        return Ok(LibraryPageFileAttachmentActor::Agent {
            session_id: attribution.session_id.clone(),
            backend: attribution.backend,
        });
    }
    Ok(match context.adapter {
        AdapterKind::ElectronHost => LibraryPageFileAttachmentActor::Person,
        _ => LibraryPageFileAttachmentActor::External,
    })
}

pub(super) fn encode(attachment: &LibraryPageFileAttachment) -> Result<String, StoreError> {
    validate(attachment)
        .map_err(|message| StoreError::new(StoreErrorCode::InvalidInput, message, false))?;
    serde_json::to_string(&attachment.attached_by).map_err(|_| {
        StoreError::new(
            StoreErrorCode::Internal,
            "Page File attachment cannot be encoded",
            false,
        )
    })
}

/// Decode at the storage boundary, including the actor/time invariant. Inventory,
/// selected-item reads and structural evidence all use the same decoder.
pub(super) fn from_row(
    row: &rusqlite::Row<'_>,
    actor_column: usize,
    time_column: usize,
) -> rusqlite::Result<LibraryPageFileAttachment> {
    let actor: String = row.get(actor_column)?;
    let invalid = |message: String| {
        rusqlite::Error::FromSqlConversionFailure(
            actor_column,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    };
    let attachment = LibraryPageFileAttachment {
        attached_by: serde_json::from_str(&actor).map_err(|error| invalid(error.to_string()))?,
        attached_at: row.get(time_column)?,
    };
    validate(&attachment).map_err(|message| invalid(message.to_owned()))?;
    // Serde's tagged unit variants ignore extra fields. Storage must retain
    // exactly the typed actor payload, including its captured Backend Binding.
    let stored: serde_json::Value =
        serde_json::from_str(&actor).map_err(|error| invalid(error.to_string()))?;
    let canonical = serde_json::to_value(&attachment.attached_by)
        .map_err(|error| invalid(error.to_string()))?;
    if stored != canonical {
        return Err(invalid(
            "Page File attachment actor has unexpected fields".to_owned(),
        ));
    }
    Ok(attachment)
}

fn validate(attachment: &LibraryPageFileAttachment) -> Result<(), &'static str> {
    if matches!(
        attachment.attached_by,
        LibraryPageFileAttachmentActor::Unknown
    ) {
        return if attachment.attached_at.is_none() {
            Ok(())
        } else {
            Err("Unknown Page File origins have no attachment time")
        };
    }
    if attachment
        .attached_at
        .as_deref()
        .is_none_or(|time| chrono::DateTime::parse_from_rfc3339(time).is_err())
    {
        return Err("Page File attachments require an RFC3339 time");
    }
    if let LibraryPageFileAttachmentActor::Agent { session_id, .. } = &attachment.attached_by
        && crate::domain::files::validate_file_identity(session_id, "Agent identity").is_err()
    {
        return Err("Page File Agent attribution requires a product Session identity");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_actor_payload_and_time_must_be_valid_together() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let decode = |actor: &str, time: Option<&str>| {
            connection.query_row("SELECT ?1, ?2", rusqlite::params![actor, time], |row| {
                from_row(row, 0, 1)
            })
        };
        let time = Some("2026-11-01T00:00:00.000Z");
        for actor in [
            r#"{"kind":"person"}"#,
            r#"{"kind":"external"}"#,
            r#"{"kind":"agent","session_id":"session:product","backend":"codex"}"#,
            r#"{"kind":"agent","session_id":"session:product","backend":"claude"}"#,
            r#"{"kind":"agent","session_id":"session:product","backend":"opencode"}"#,
            r#"{"kind":"agent","session_id":"session:product","backend":"acp"}"#,
        ] {
            let attachment = decode(actor, time).unwrap();
            assert_eq!(
                decode(&encode(&attachment).unwrap(), time).unwrap(),
                attachment
            );
            assert!(decode(actor, None).is_err());
        }
        assert!(decode(r#"{"kind":"unknown"}"#, None).is_ok());
        assert!(decode(r#"{"kind":"unknown"}"#, time).is_err());
        for actor in [
            r#"{"kind":"forged"}"#,
            r#"{"kind":"agent","session_id":"session:product"}"#,
            r#"{"kind":"agent","session_id":"","backend":"codex"}"#,
            r#"{"kind":"agent","session_id":"session:product","backend":{"kind":"claude"}}"#,
            r#"{"kind":"agent","session_id":"session:product","backend":"gemini"}"#,
            r#"{"kind":"person","session_id":"forged"}"#,
        ] {
            assert!(decode(actor, time).is_err(), "invalid actor: {actor}");
        }
        assert!(decode(r#"{"kind":"person"}"#, Some("2026-11-01 10:15:00")).is_err());
    }
}
