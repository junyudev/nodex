//! The sender's per-message permission to start work.
use super::*;
use crate::infrastructure::durable_mutation::DurableMutationScope;
use crate::workspace::inbox_content::{MessageContentLimit, read_message_content};
use nodex_core_contracts::inbox::ProjectWorkspaceInboxSuggestionMode;
use std::path::Path;

#[allow(clippy::too_many_arguments)]
pub(super) fn admit(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    scope: &DurableMutationScope<'_>,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
    message: &MessagePage,
    project_id: Option<&str>,
    request: &ProjectWorkspaceInboxStartRequest,
    assets_root: &Path,
    now: &str,
) -> Result<Option<WorkspaceMutationEffects>, StoreError> {
    use ProjectWorkspaceInboxStartRequest::*;
    let (selection, preparation_error) = match request {
        Routed {
            suggestions_off: false,
            preparation_error: None,
            ..
        } => {
            // An explicit start request gets its own routing request, even when Main
            // would discard the ordinary automatic-suggestion queue.
            let content = read_message_content(connection, page_id, MessageContentLimit::Message)?;
            connection.execute(
                "INSERT INTO inbox_start_requests(page_id, consent_basis) VALUES (?1, ?2)",
                params![page_id, content.fingerprint()],
            )?;
            if let Err(error) = content.require_suggestion_budget() {
                connection.execute(
                    "UPDATE inbox_entries SET suggestion_state='failed',suggestion_error=?2 WHERE page_id=?1",
                    params![page_id, failure_text(&error.message)],
                )?;
                return Ok(None);
            }
            let request_id = capture_identity()?;
            reliable::create_request(
                connection,
                library_id,
                &request_id,
                ProjectWorkspaceInboxSuggestionMode::Auto,
                &[page_id.to_owned()],
                None,
                None,
                None,
                now,
            )?;
            return Ok(None);
        }
        NewChat {
            execution_selection,
            preparation_error,
        }
        | Routed {
            execution_selection,
            preparation_error,
            ..
        } => (execution_selection, preparation_error),
    };
    let Some(selection) = selection else {
        let reason = preparation_error
            .as_deref()
            .unwrap_or("The Inbox could not resolve the Agent for this chat.");
        connection.execute(
            "INSERT INTO inbox_start_requests(page_id, preparation_error) VALUES (?1, ?2)",
            params![page_id, failure_text(reason)],
        )?;
        // This explicit start already had an outcome. Do not queue ordinary automatic advice.
        connection.execute(
            "UPDATE inbox_entries SET suggestion_state='none' WHERE page_id=?1",
            [page_id],
        )?;
        return Ok(None);
    };

    let blocks = nodex_markdown::read(&message.body_markdown, ReadOptions::EXACT)
        .map_err(|_| corrupt("Captured Inbox message is unreadable"))?;
    let body: Vec<_> = blocks
        .into_iter()
        .filter(|block| !contains_image(block))
        .collect();
    // Images, including an image-only capture, are frozen by the shared dispatch composer.
    let prompt = serialize_markdown(&body);
    let prompt = if prompt.trim().is_empty() {
        "See the attached Inbox message.".to_owned()
    } else {
        prompt
    };
    let action = ProjectWorkspaceInboxDispatchAction::NewChat {
        project_id: project_id.map(str::to_owned),
        prompt,
        additions: Vec::new(),
        skills: Vec::new(),
        agent: None,
    };
    let pages = [page_id.to_owned()];
    let proposal_id = capture_identity()?;
    let session_id = capture_identity()?;
    let (decision, _) = reliable::decide_direct(
        connection,
        library_id,
        context,
        scope,
        operation_id,
        request_hash,
        &proposal_id,
        &pages,
        &current_basis(connection, &pages)?,
        &action,
        Some(&session_id),
        Some(selection),
        assets_root,
        now,
        None,
    )?;
    connection.execute(
        "INSERT INTO inbox_start_requests(page_id, proposal_id) VALUES (?1, ?2)",
        params![page_id, proposal_id],
    )?;
    Ok(Some(decision))
}

// These IDs can appear inside downstream operation identities, which read the UUID's issue time.
fn capture_identity() -> Result<String, StoreError> {
    crate::domain::identity::random_uuid_v7()
        .map_err(|_| internal("Capture identity is unavailable"))
}

pub(crate) fn withdraw(connection: &Connection, page_id: &str) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE inbox_start_requests SET consent_basis=NULL,preparation_error=NULL
         WHERE page_id=?1 AND (consent_basis IS NOT NULL OR preparation_error IS NOT NULL)",
        [page_id],
    )?;
    Ok(())
}

pub(super) fn record_routed_dispatch(
    connection: &Connection,
    pages: &[String],
    proposal_id: &str,
) -> Result<(), StoreError> {
    for page in pages {
        connection.execute(
            "UPDATE inbox_start_requests SET consent_basis=NULL,proposal_id=?2 WHERE page_id=?1
             AND consent_basis = (
                 SELECT json_extract(basis.value,'$.content_hash')
                 FROM inbox_proposals proposal, json_each(proposal.basis_json) basis
                 WHERE proposal.proposal_id=?2 AND json_extract(basis.value,'$.page_id')=?1
             )",
            params![page, proposal_id],
        )?;
    }
    Ok(())
}

pub(super) fn clear_preparation_failure(
    connection: &Connection,
    page_id: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE inbox_start_requests SET preparation_error=NULL WHERE page_id=?1 AND preparation_error IS NOT NULL",
        [page_id],
    )?;
    Ok(())
}

/// Actor binding precedes mutation receipt replay. A recorded routed dispatch binds
/// the original author again on replay, after its consent has been consumed.
pub(crate) fn can_bind_automatic_confirmation(
    connection: &Connection,
    member: &str,
    proposal_id: &str,
) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM member_inbox_preferences WHERE member_id=?1 AND start_my_requests=1)
          OR EXISTS(SELECT 1 FROM inbox_proposal_pages member
            JOIN inbox_entries entry USING(page_id) JOIN inbox_start_requests request USING(page_id)
            WHERE member.proposal_id=?2 AND entry.author_member_id=?1
              AND (request.consent_basis IS NOT NULL OR request.proposal_id=?2))",
        params![member, proposal_id],
        |row| row.get(0),
    )?)
}

/// Every member of the proposal needs their own grant. A routed capture supplies it
/// directly. Standing consent still requires the suggestion to mark an explicit request.
const AUTOMATIC_CONSENT: &str = "
    proposal.origin='agent' AND proposal.state='open'
    AND json_extract(proposal.action_json,'$.type') IN ('new_chat','send_to_chat')
    AND NOT EXISTS (
        SELECT 1 FROM inbox_proposal_pages member JOIN inbox_entries entry USING(page_id)
        LEFT JOIN inbox_start_requests request USING(page_id)
        WHERE member.proposal_id=proposal.proposal_id AND (
            json_extract(entry.actor_json,'$.type') IS NOT 'member'
            OR entry.author_member_id IS NULL
            OR entry.current_proposal_id IS NOT proposal.proposal_id
            OR EXISTS(SELECT 1 FROM chat_message_handback_pages returned WHERE returned.page_id=entry.page_id)
            OR NOT EXISTS(
                SELECT 1 FROM inbox_member_rows row JOIN page_turn_episodes episode ON episode.page_id=row.page_id
                WHERE row.page_id=entry.page_id AND row.member_id=entry.author_member_id
                  AND row.in_inbox=1 AND json_extract(episode.signature,'$[1]')='triage')
            OR EXISTS(
                SELECT 1 FROM inbox_deferrals deferral
                WHERE deferral.page_id=entry.page_id AND deferral.member_id=entry.author_member_id
                  AND deferral.until_at>:now)
            OR NOT (EXISTS (
                SELECT 1 FROM json_each(proposal.basis_json) basis
                WHERE json_extract(basis.value,'$.page_id')=entry.page_id
                  AND json_extract(basis.value,'$.content_hash')=request.consent_basis
            ) OR (
                :standing AND proposal.explicit_request=1 AND EXISTS(
                    SELECT 1 FROM member_inbox_preferences preference
                    WHERE preference.member_id=entry.author_member_id AND preference.start_my_requests=1)))
        )
    )";

pub(super) fn automatic_consent(
    connection: &Connection,
    proposal_id: &str,
    standing: bool,
) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        &format!("SELECT {AUTOMATIC_CONSENT} FROM inbox_proposals proposal WHERE proposal_id=:id"),
        rusqlite::named_params! {":id": proposal_id, ":standing": standing, ":now": snooze::now(connection)?},
        |row| row.get(0),
    )?)
}

pub(in crate::workspace) fn automatic_dispatch_ids(
    connection: &Connection,
    library: &str,
    limit: u32,
) -> Result<Vec<String>, StoreError> {
    Ok(connection.prepare(&format!(
        "SELECT proposal_id FROM inbox_proposals proposal WHERE library_id=:library
         AND auto_confirm_pending=1 AND {AUTOMATIC_CONSENT} ORDER BY created_at,proposal_id LIMIT :limit"
    ))?.query_map(
        rusqlite::named_params! {
            ":library": library, ":limit": i64::from(limit.clamp(1, 100)), ":standing": true, ":now": snooze::now(connection)?,
        },
        |row| row.get(0),
    )?.collect::<rusqlite::Result<_>>()?)
}
