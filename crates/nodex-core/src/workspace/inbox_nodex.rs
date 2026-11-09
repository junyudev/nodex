use super::*;

fn coordinator_caller(
    connection: &Connection,
    provenance: Option<&AgentTurnProvenance>,
) -> Result<String, StoreError> {
    let provenance = provenance.ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::Unauthorized,
            false,
        )
    })?;
    let session = match &provenance.authority.runtime {
        Some(runtime) => Some(runtime.session_id.clone()),
        None => connection
            .query_row(
                "SELECT session_id FROM project_session_threads WHERE thread_id=?1",
                [&provenance.authority.root_thread_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?,
    };
    if session.is_none() || session != super::super::coordinator::binding(connection)? {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            false,
        ));
    }
    Ok(session.expect("verified Coordinator"))
}

pub(super) fn require_reply(
    connection: &Connection,
    library: &str,
    reply: Option<&str>,
    project: Option<&str>,
) -> Result<Option<String>, StoreError> {
    let Some(id) = reply else { return Ok(None) };
    validate_id("reply_to_page_id", id)?;
}
pub(super) fn finish_reply(
    connection: &Connection,
    reply: Option<&str>,
    now: &str,
) -> Result<(), StoreError> {
    }
    Ok(())
}
pub(in crate::workspace) fn retire_attention(
    connection: &Connection,
    event_ids: &[String],
    now: &str,
) -> Result<Vec<String>, StoreError> {
    for id in event_ids {
        connection.execute("UPDATE coordinator_event_batches SET invalidated_at=COALESCE(invalidated_at,?2) WHERE batch_id=(SELECT batch_id FROM coordinator_work_events WHERE event_id=?1) AND accepted_at IS NULL AND discarded_at IS NULL",params![id,now])?;
    }
}
pub(in crate::workspace) fn retire_page_start(
    connection: &Connection,
    library: &str,
    page: &str,
    now: &str,
) -> Result<Vec<String>, StoreError> {
    retire_attention(connection, library, &ids, now)
}

#[allow(clippy::too_many_arguments)]
    connection: &Connection,
    library: &str,
    context: &BoundModuleContext,
    epoch: &str,
    operation: &str,
    hash: &str,
    provenance: Option<&AgentTurnProvenance>,
    intent: &ProjectWorkspaceIntent,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let now = sqlite_now(connection)?;
        }
        }
            }
}
