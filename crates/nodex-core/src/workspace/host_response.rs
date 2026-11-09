//! A device session is not permission to answer another Member's execution request.
use crate::infrastructure::{
    actors, member_admission,
    sqlite::{StoreError, StoreErrorCode},
};

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
    let requester = actors::session_requester(connection, session, run)?;
    let owner = crate::library::members::requester_owner_for_session(connection, library, session)?;
        SessionExecutionRequestKind::Question => requester.or(owner),
        SessionExecutionRequestKind::Approval => owner.or(requester),
pub(super) fn personal_owner(
    connection: &Connection,
    library: &str,
) -> Result<Option<String>, StoreError> {
    };
    }
}
