//! A device session is not permission to answer another Member's execution request.
use crate::infrastructure::{
    actors, member_admission,
    sqlite::{StoreError, StoreErrorCode},
};
use nodex_core_contracts::{RemotePrincipal, team::PhonePushAudience, workspace::*};
use rusqlite::{Connection, OptionalExtension, params};

fn denied() -> StoreError {
    StoreError::new(
        StoreErrorCode::Unauthorized,
        "This execution request belongs to another Member or is no longer pending",
        false,
    )
}

pub(super) fn authorize(
    connection: &Connection,
    library: &str,
    principal: &RemotePrincipal,
    session: &str,
    run: Option<&str>,
    request: &str,
) -> Result<(), StoreError> {
    member_admission::require_principal(connection, library, principal)?;
    super::session_mutation::validate_id("session_id", session)?;
    super::session_mutation::validate_id("request_id", request)?;
    if let Some(run) = run {
        super::session_mutation::validate_id("run_id", run)?;
    }
    let authority = super::session_mutation::require_session(connection, library, session)?;
    if authority.archived {
        return Err(denied());
    }
    let encoded: Option<String> = connection
        .query_row(
            "SELECT observed_json FROM session_execution_observations WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )
        .optional()?;
    let observation: SessionExecutionObservation = encoded
        .and_then(|encoded| serde_json::from_str(&encoded).ok())
        .ok_or_else(denied)?;
    if observation.run_id.as_deref() != run {
        return Err(denied());
    }
    let pending = observation
        .pending_requests
        .iter()
        .find(|p| p.id == request)
        .ok_or_else(denied)?;
    let member = entitled_member(connection, library, session, run, pending.kind)?;
    if member.as_deref() != Some(&principal.member_id) {
        return Err(denied());
    }
    Ok(())
}

/// Core's one answer-entitlement rule. A Question belongs to its Run's requester and an Approval to
/// the Page Owner, each falling back to the other; a personal Space's only Member owns both.
fn entitled_member(
    connection: &Connection,
    library: &str,
    session: &str,
    run: Option<&str>,
    kind: SessionExecutionRequestKind,
) -> Result<Option<String>, StoreError> {
    let requester = actors::session_requester(connection, session, run)?;
    let owner = crate::library::members::requester_owner_for_session(connection, library, session)?;
    match kind {
        SessionExecutionRequestKind::Question => requester.or(owner),
        SessionExecutionRequestKind::Approval => owner.or(requester),
    }
    .map_or_else(
        || personal_owner(connection, library),
        |member| Ok(Some(member)),
    )
}

pub(super) fn personal_owner(
    connection: &Connection,
    library: &str,
) -> Result<Option<String>, StoreError> {
    let personal: bool = connection
        .query_row(
            "SELECT space_kind='personal' FROM libraries WHERE id=?1",
            [library],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false);
    if !personal {
        return Ok(None);
    }
    match actors::local_member(connection, library) {
        Ok(member) => Ok(Some(member)),
        Err(error) if error.code == StoreErrorCode::Unauthorized => Ok(None),
        Err(error) => Err(error),
    }
}

/// The Member a chat or Page event concerns: whoever may answer its request, whoever requested
/// its Run, whoever set its reminder, or whoever's move a current Page Turn is. Archived or missing
/// chats, and Turns that have moved on, concern no one.
pub(super) fn push_audience(
    connection: &Connection,
    library: &str,
    session: Option<&str>,
    audience: &PhonePushAudience,
) -> Result<Option<String>, StoreError> {
    if let PhonePushAudience::TurnOwner { page_id, episode } = audience {
        super::session_mutation::validate_id("page_id", page_id)?;
        super::session_mutation::validate_id("episode", episode)?;
        return Ok(connection
            .query_row(
                "SELECT intent.member_id FROM page_turn_notification_intents intent \
                 JOIN page_turn_episodes current ON current.page_id=intent.page_id \
                   AND current.episode=intent.episode \
                 JOIN members member ON member.id=intent.member_id AND member.library_id=?3 \
                   AND member.lifecycle='active' \
                 WHERE intent.page_id=?1 AND intent.episode=?2",
                params![page_id, episode, library],
                |r| r.get(0),
            )
            .optional()?);
    }
    if let PhonePushAudience::InboxLaterOwner { id } = audience {
        return super::inbox::later::push_owner(connection, library, id);
    }
    let Some(session) = session else {
        return Ok(None);
    };
    super::session_mutation::validate_id("session_id", session)?;
    let run = match audience {
        PhonePushAudience::Request { run_id, .. } => run_id.as_deref(),
        PhonePushAudience::RunRequester { run_id } => Some(run_id.as_str()),
        PhonePushAudience::ReminderOwner { member_id } => {
            super::session_mutation::validate_id("member_id", member_id)?;
            None
        }
        PhonePushAudience::TurnOwner { .. } | PhonePushAudience::InboxLaterOwner { .. } => None,
    };
    if let Some(run) = run {
        super::session_mutation::validate_id("run_id", run)?;
    }
    match super::session_mutation::require_session(connection, library, session) {
        Ok(authority) if !authority.archived => {}
        Ok(_) => return Ok(None),
        Err(error) if error.code == StoreErrorCode::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    match audience {
        PhonePushAudience::Request { request, .. } => {
            entitled_member(connection, library, session, run, *request)
        }
        PhonePushAudience::RunRequester { .. } => {
            match actors::session_requester(connection, session, run)? {
                Some(member) => Ok(Some(member)),
                None => personal_owner(connection, library),
            }
        }
        PhonePushAudience::ReminderOwner { member_id } => Ok(connection
            .query_row(
                "SELECT id FROM members WHERE id=?1 AND library_id=?2 AND lifecycle='active'",
                [member_id.as_str(), library],
                |r| r.get(0),
            )
            .optional()?),
        PhonePushAudience::TurnOwner { .. } | PhonePushAudience::InboxLaterOwner { .. } => Ok(None),
    }
}
