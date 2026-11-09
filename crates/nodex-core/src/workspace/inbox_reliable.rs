//! One owner for the decision transaction and its immutable delivery evidence.
use super::*;
use crate::infrastructure::durable_mutation::DurableMutationScope;
use crate::workspace::inbox_content::{
    MAX_SUGGESTION_IMAGES, MessageContentLimit, agent_markdown, read_message_content,
};
use nodex_core_contracts::inbox::*;
use nodex_core_contracts::library::{LibraryBlockTransferUndoToken, LibraryPageWriteDestination};
use nodex_core_contracts::workspace::{
    ProjectWorkspaceIntent, ProjectWorkspaceSessionExecutionRef,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

pub(in crate::workspace) fn handoff_identity(
    proposal_id: &str,
    role: &str,
    store_epoch: &str,
) -> String {
    stable_uuid_v7(proposal_id, &format!("inbox-{role}"), store_epoch)
}
pub(in crate::workspace) fn stored_handoff_identity(
    connection: &Connection,
    proposal_id: &str,
    role: &str,
) -> Result<String, StoreError> {
    let sql = match role {
        "launch" => "SELECT launch_id FROM inbox_handoffs WHERE proposal_id=?1",
        "message" => "SELECT message_id FROM inbox_handoffs WHERE proposal_id=?1",
        _ => return Err(internal("Unknown delivery identity")),
    };
    Ok(connection
        .query_row(sql, [proposal_id], |row| row.get::<_, String>(0))
        .optional()?
        .unwrap_or(handoff_identity(
            proposal_id,
            role,
            &crate::document::read_store_epoch(connection)?,
        )))
}
pub(in crate::workspace) fn read_handoff_json<T: serde::de::DeserializeOwned>(
    connection: &Connection,
    proposal_id: &str,
    column: &str,
) -> Result<Option<T>, StoreError> {
    let sql = match column {
        "execution_selection_json" => {
            "SELECT execution_selection_json FROM inbox_handoffs WHERE proposal_id=?1"
        }
        "question_response_json" => {
            "SELECT question_response_json FROM inbox_handoffs WHERE proposal_id=?1"
        }
        "target_execution_ref_json" => {
            "SELECT target_execution_ref_json FROM inbox_handoffs WHERE proposal_id=?1"
        }
        "images_json" => "SELECT images_json FROM inbox_handoffs WHERE proposal_id=?1",
        _ => return Err(internal("Unknown handoff field")),
    };
    let json: Option<String> = connection
        .query_row(sql, [proposal_id], |r| r.get(0))
        .optional()?
        .flatten();
    json.map(|j| serde_json::from_str(&j).map_err(|_| corrupt("Stored Inbox handoff is invalid")))
        .transpose()
}

/// An Agent takes at most this many images with one message; the rest stay on their Pages.
const MAX_HANDOFF_IMAGES: usize = MAX_SUGGESTION_IMAGES;

fn encode<T: Serialize + ?Sized>(value: &T) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|_| internal("Inbox value cannot be encoded"))
}
fn revision(proposal: &StoredProposal, expected: i64) -> Result<(), StoreError> {
    if proposal.revision != expected {
        return Err(StoreError::new(
            StoreErrorCode::RevisionConflict,
            "The Inbox decision changed; review it again",
            true,
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(in crate::workspace) fn apply_reliable(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    intent: ProjectWorkspaceIntent,
    assets_root: &Path,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    let now = sqlite_now(connection)?;
    if matches!(
        intent,
        ProjectWorkspaceIntent::PrepareInboxSuggestions { .. }
    ) {
        require_host(context)?;
    }
    if matches!(
        intent,
        ProjectWorkspaceIntent::PrepareInboxSuggestions { .. }
    ) && !needs_preparation(connection, library_id)?
    {
        return super::super::mutation::finish_no_op(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "inbox_prepare_suggestions",
            Vec::new(),
            Vec::new(),
            &now,
        );
    }
    if let ProjectWorkspaceIntent::EditInboxMessage {
        page_id,
        basis,
        original_body,
        body,
    } = &intent
    {
        require_basis(
            connection,
            std::slice::from_ref(page_id),
            std::slice::from_ref(basis),
        )?;
        let edit = super::super::inbox_read::read_message_edit(
            connection,
            context,
            library_id,
            page_id,
            original_body,
            body,
        )?;
        if edit.body_markdown.is_none() && edit.title_markdown.is_none() {
            return super::super::mutation::finish_no_op(
                connection,
                context,
                store_epoch,
                operation_id,
                request_hash,
                "inbox_edit_message",
                Vec::new(),
                Vec::new(),
                &now,
            );
        }
    }
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |scope| {
            match intent {
                ProjectWorkspaceIntent::BeginInboxRouting {
                    request_id,
                    generation,
                    coordinator_session_id,
                } => {
                    require_host(context)?;
                    if super::super::execution_holds::routing_held(connection, &request_id)? {
                        return Err(conflict("Routing work is paused"));
                    }
                    if read_request(connection, context, library_id, &request_id)?
                        .is_none_or(|request| request.generation != generation)
                    {
                        return Err(conflict("This request is no longer pending"));
                    }
                    if super::super::coordinator::binding(connection)?.as_deref()
                        != Some(&coordinator_session_id)
                    {
                        return Err(invalid("Routing requires the current Coordinator"));
                    }
                    let count: i64 = connection.query_row("SELECT count(*) FROM inbox_routing_deliveries delivery JOIN inbox_suggestion_requests request USING(request_id) WHERE request.state='pending' AND request.generation=delivery.generation", [], |r|r.get(0))?;
                    if count >= 16 {
                        return Err(conflict("Too many routing requests are already pending"));
                    }
                    connection.execute("INSERT INTO inbox_routing_deliveries(request_id,generation,coordinator_session_id,handed_over_at_ms) VALUES(?1,?2,?3,CAST(unixepoch('subsec')*1000 AS INTEGER))",params![request_id,generation,coordinator_session_id])?;
                    Ok(simple_effects("inbox_begin_routing", &now))
                }
                ProjectWorkspaceIntent::RecordInboxRoutingRefusal {
                    request_id,
                    generation,
                    coordinator_session_id,
                    reason,
                } => {
                    require_host(context)?;
                    if reason.is_empty() || reason.chars().count() > 2048 {
                        return Err(invalid("A routing refusal must contain 1–2048 characters"));
                    }
                    if read_request(connection, context, library_id, &request_id)?
                        .is_none_or(|request| request.generation != generation)
                    {
                        return Err(conflict("This routing request is no longer pending"));
                    }
                    let changed = connection.execute("UPDATE inbox_routing_deliveries SET last_refusal=?4 WHERE request_id=?1 AND generation=?2 AND coordinator_session_id=?3", params![request_id,generation,coordinator_session_id,reason])?;
                    if changed == 0 {
                        return Err(conflict("The routing delivery changed"));
                    }
                    Ok(simple_effects("inbox_routing_refusal", &now))
                }
                ProjectWorkspaceIntent::StartInboxRoutingRun {
                    request_id,
                    generation,
                    coordinator_session_id,
                    run_started_at_ms,
                } => {
                    require_host(context)?;
                    if run_started_at_ms < 0
                        || read_request(connection, context, library_id, &request_id)?
                            .is_none_or(|request| request.generation != generation)
                    {
                        return Err(conflict("This routing request is no longer pending"));
                    }
                    let changed = connection.execute("UPDATE inbox_routing_deliveries SET run_started_at_ms=COALESCE(run_started_at_ms,?4) WHERE request_id=?1 AND generation=?2 AND coordinator_session_id=?3", params![request_id,generation,coordinator_session_id,run_started_at_ms])?;
                    if changed == 0 {
                        return Err(conflict("The routing delivery changed"));
                    }
                    Ok(simple_effects("inbox_start_routing_run", &now))
                }
                ProjectWorkspaceIntent::ConfirmInboxDispatch {
                    confirmed_by,
                    expected_store_epoch,
                    proposal_id,
                    expected_revision,
                    action,
                    session_id,
                    basis,
                    execution_selection,
                } => {
                    require_epoch(store_epoch, &expected_store_epoch)?;
                    let proposal = require_proposal(connection, library_id, &proposal_id)?;
                    revision(&proposal, expected_revision)?;
                    if proposal.state != "open" {
                        return Err(conflict("This Inbox suggestion is no longer open"));
                    }
                    require_open_entries(connection, library_id, &proposal.page_ids)?;
                    let assigned: i64 = connection.query_row(
                        "SELECT count(*) FROM inbox_entries WHERE current_proposal_id=?1",
                        [&proposal_id],
                        |row| row.get(0),
                    )?;
                    if assigned != proposal.page_ids.len() as i64 {
                        return Err(conflict("The suggestion membership changed"));
                    }
                    require_basis(connection, &proposal.page_ids, &basis)?;
                    if confirmed_by == InboxConfirmedBy::Nodex {
                        if let Some(ProjectWorkspaceInboxDispatchAction::NewChat {
                            project_id: Some(project_id),
                            ..
                        }) = &action
                            && connection.query_row("SELECT EXISTS(SELECT 1 FROM execution_holds WHERE scope_kind='project' AND scope_id=?1)",[project_id],|r|r.get::<_,bool>(0))? {return Err(conflict("Project work is paused"));}

                        for page in &proposal.page_ids {
                            if !super::super::execution_holds::for_page(connection, page)?
                                .is_empty()
                            {
                                return Err(conflict("Work is paused"));
                            }
                        }
                        if let Some(ProjectWorkspaceInboxDispatchAction::SendToChat {
                            session_id,
                            ..
                        }) = &action
                            && !super::super::execution_holds::for_session(connection, session_id)?
                                .is_empty()
                        {
                            return Err(conflict("The chat is paused"));
                        }

                        if matches!(
                            proposal.action,
                            ProjectWorkspaceInboxDispatchAction::Plan { .. }
                        ) || matches!(
                            action,
                            Some(ProjectWorkspaceInboxDispatchAction::Plan { .. })
                        ) {
                            return Err(invalid("Only the user may confirm a plan"));
                        }
                        require_host(context)?;
                        require_automatic_confirmation(
                            connection,
                            &proposal_id,
                            &proposal,
                            action.as_ref(),
                        )?;
                    }
                    let effects = decide(
                        connection,
                        library_id,
                        context,
                        scope,
                        operation_id,
                        request_hash,
                        &proposal_id,
                        &proposal.page_ids,
                        action.as_ref().unwrap_or(&proposal.action),
                        session_id.as_deref(),
                        execution_selection.as_ref(),
                        assets_root,
                        &now,
                    )?;
                    connection.execute("UPDATE inbox_proposals SET confirmed_by=?2,auto_confirm_pending=0 WHERE proposal_id=?1", params![proposal_id, if confirmed_by==InboxConfirmedBy::Nodex { "nodex" } else { "user" }])?;
                    Ok(effects)
                }
                ProjectWorkspaceIntent::DispatchInboxEntries {
                    expected_store_epoch,
                    proposal_id,
                    page_ids,
                    action,
                    session_id,
                    basis,
                    execution_selection,
                } => {
                    require_epoch(store_epoch, &expected_store_epoch)?;
                    let pages = unique_page_ids(&page_ids, MAX_PROPOSAL_PAGES)?;
                    require_live_entries(connection, library_id, &pages)?;
                    require_basis(connection, &pages, &basis)?;
                    let inbox_scope = require_one_scope(connection, &pages)?;
                    let action =
                        normalize_action(connection, library_id, inbox_scope.as_deref(), &action)?;
                    let unknown = connection.prepare("SELECT DISTINCT proposal.proposal_id FROM inbox_proposals proposal JOIN inbox_proposal_pages member USING(proposal_id) WHERE proposal.state='dispatching' AND proposal.failure_kind='unknown' AND member.page_id IN (SELECT value FROM json_each(?1))")?.query_map([encode(&pages)?], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                    for previous in &unknown {
                        if proposal_page_ids(connection, previous)?
                            .iter()
                            .any(|page| !pages.contains(page))
                        {
                            return Err(conflict(
                                "Review all messages in the previous delivery together",
                            ));
                        }
                    }
                    connection.execute("UPDATE inbox_proposals SET state='superseded',revision=revision+1,updated_at=?2 WHERE proposal_id IN (SELECT value FROM json_each(?1))",params![encode(&unknown)?,now])?;
                    insert_proposal(
                        connection,
                        library_id,
                        NewProposal {
                            proposal_id: &proposal_id,
                            origin: ProjectWorkspaceInboxProposalOrigin::User,
                            page_ids: &pages,
                            basis: &basis,
                            action: &action,
                            entry_kind: None,
                            summary: &user_summary(&action),
                            rationale: None,
                            produced_by: None,
                        },
                        &now,
                    )?;
                    decide(
                        connection,
                        library_id,
                        context,
                        scope,
                        operation_id,
                        request_hash,
                        &proposal_id,
                        &pages,
                        &action,
                        session_id.as_deref(),
                        execution_selection.as_ref(),
                        assets_root,
                        &now,
                    )
                }
                ProjectWorkspaceIntent::EditInboxMessage {
                    page_id,
                    basis,
                    original_body,
                    body,
                } => {
                    require_basis(
                        connection,
                        std::slice::from_ref(&page_id),
                        std::slice::from_ref(&basis),
                    )?;
                    let edit = super::super::inbox_read::read_message_edit(
                        connection,
                        context,
                        library_id,
                        &page_id,
                        &original_body,
                        &body,
                    )?;
                    let (generation, head_seq) = document_head(connection, &page_id)?;
                    crate::document::edit_page_in_scope(
                        connection,
                        scope,
                        context,
                        library_id,
                        &page_id,
                        generation,
                        head_seq,
                        edit.body_markdown.as_deref(),
                        edit.title_markdown.as_deref(),
                        operation_id,
                    )?;
                    if !scheduled::refence(connection, &page_id, &now)? {
                        connection.execute("UPDATE inbox_entries SET suggestion_state=CASE WHEN source_kind='nodex' THEN 'none' ELSE 'waiting' END,suggestion_error=NULL,revision=revision+1,updated_at=?2 WHERE page_id=?1",params![page_id,now])?;
                    }
                    if edit.title_markdown.is_some() {
                        connection.execute("UPDATE inbox_entries SET provisional_title=(SELECT title FROM document_materializations WHERE document_id=(SELECT document_id FROM pages WHERE block_id=?1)) WHERE page_id=?1",[&page_id])?;
                    }
                    let mut effects = simple_effects("inbox_edit_message", &now);
                    effects.page_ids.push(page_id);
                    Ok(effects)
                }
                ProjectWorkspaceIntent::PrepareInboxSuggestions {
                    request_id,
                    limit,
                    automatic,
                } => {
                    require_host(context)?;
                    reconcile_advice(connection, library_id, &now)?;
                    if !automatic {
                        connection.execute("UPDATE inbox_entries SET suggestion_state='none',revision=revision+1,updated_at=?2 WHERE library_id=?1 AND suggestion_state='waiting' AND source_kind NOT IN ('automation','nodex')",params![library_id,now])?;
                        return Ok(simple_effects("inbox_prepare_suggestions", &now));
                    }
                    let pages=connection.prepare("WITH waiting AS (SELECT entry.page_id,entry.seq,entry.scope_project_id FROM inbox_entries entry JOIN blocks block ON block.id=entry.page_id AND block.lifecycle='active' WHERE entry.library_id=?1 AND entry.state='open' AND entry.suggestion_state='waiting' AND entry.source_kind<>'scheduled_task'), oldest AS (SELECT scope_project_id FROM waiting ORDER BY seq LIMIT 1) SELECT waiting.page_id FROM waiting,oldest WHERE waiting.scope_project_id IS oldest.scope_project_id ORDER BY waiting.seq LIMIT ?2")?.query_map(params![library_id,i64::from(limit.clamp(1,8))],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                    let mut complete = Vec::new();
                    let mut image_count = 0;
                    for page in pages {
                        match read_message_content(connection, &page, MessageContentLimit::Message)
                            .and_then(|content| {
                                content.require_suggestion_budget()?;
                                Ok(content)
                            }) {
                            Ok(content) => {
                                if image_count + content.images.len() > MAX_SUGGESTION_IMAGES {
                                    break;
                                }
                                image_count += content.images.len();
                                complete.push(page);
                            }
                            Err(error) => {
                                connection.execute("UPDATE inbox_entries SET suggestion_state='failed',suggestion_error=?2,revision=revision+1,updated_at=?3 WHERE page_id=?1",params![page,failure_text(&error.message),now])?;
                            }
                        }
                    }
                    let pages = complete;
                    if !pages.is_empty() {
                        create_request(
                            connection,
                            library_id,
                            &request_id,
                            ProjectWorkspaceInboxSuggestionMode::Auto,
                            &pages,
                            None,
                            None,
                            None,
                            &now,
                        )?;
                    }
                    Ok(simple_effects("inbox_prepare_suggestions", &now))
                }
                ProjectWorkspaceIntent::RequestInboxSuggestion {
                    request_id,
                    mode,
                    page_ids,
                    basis,
                    proposal_id,
                    expected_revision,
                    correction,
                } => {
                    let pages = unique_page_ids(&page_ids, MAX_PROPOSAL_PAGES)?;
                    require_live_entries(connection, library_id, &pages)?;
                    require_basis(connection, &pages, &basis)?;
                    if has_in_flight_dispatch(connection, &pages)? {
                        return Err(conflict("Wait for the current dispatch to finish"));
                    }
                    for page in &pages {
                        if connection.query_row(
                            "SELECT source_kind='nodex' FROM inbox_entries WHERE page_id=?1",
                            [page],
                            |r| r.get::<_, bool>(0),
                        )? {
                            return Err(invalid("Nodex posts do not receive routing suggestions"));
                        }
                        if crate::automation::firing::item(connection, page)?.is_some() {
                            return Err(conflict("An Automation decision uses its saved action."));
                        }
                    }
                    if mode == ProjectWorkspaceInboxSuggestionMode::Refine {
                        let id = proposal_id
                            .as_deref()
                            .ok_or_else(|| invalid("Refine requires a suggestion"))?;
                        let proposal = require_proposal(connection, library_id, id)?;
                        revision(
                            &proposal,
                            expected_revision
                                .ok_or_else(|| invalid("Refine requires a suggestion revision"))?,
                        )?;
                        if proposal.state != "open"
                            || pages.iter().any(|p| !proposal.page_ids.contains(p))
                        {
                            return Err(conflict("The suggestion membership changed"));
                        }
                    }
                    create_request(
                        connection,
                        library_id,
                        &request_id,
                        mode,
                        &pages,
                        proposal_id.as_deref(),
                        expected_revision,
                        correction.as_deref(),
                        &now,
                    )?;
                    Ok(simple_effects("inbox_request_suggestion", &now))
                }
                ProjectWorkspaceIntent::SettleInboxSuggestion {
                    automatic_dispatch,
                    request_id,
                    generation,
                    titles,
                    suggestions,
                    produced_by,
                    error,
                } => {
                    require_host(context)?;
                    settle_request(
                        connection,
                        library_id,
                        scope,
                        context,
                        operation_id,
                        &request_id,
                        generation,
                        &titles,
                        &suggestions,
                        produced_by.as_deref(),
                        error.as_deref(),
                        &now,
                    )?;
                    if automatic_dispatch && error.is_none() {
                        for suggestion in &suggestions {
                        }
                    }
                    Ok(simple_effects("inbox_settle_suggestion", &now))
                }
                ProjectWorkspaceIntent::BeginInboxDispatch {
                    proposal_id,
                    expected_revision,
                    message_id,
                } => {
                    require_host(context)?;
                    dispatch_fence(
                        connection,
                        library_id,
                        store_epoch,
                        &proposal_id,
                        expected_revision,
                        &message_id,
                    )?;
                    connection.execute("UPDATE inbox_proposals SET failure_kind='unknown',failure_message='Delivery is awaiting confirmation',revision=revision+1,updated_at=?2 WHERE proposal_id=?1",params![proposal_id,now])?;
                    Ok(simple_effects("inbox_begin_dispatch", &now))
                }
                ProjectWorkspaceIntent::CompleteInboxDispatch {
                    proposal_id,
                    expected_revision,
                    message_id,
                    dispatched_thread_id,
                } => {
                    require_host(context)?;
                    let proposal = dispatch_fence(
                        connection,
                        library_id,
                        store_epoch,
                        &proposal_id,
                        expected_revision,
                        &message_id,
                    )?;
                    let thread = dispatched_thread_id
                        .as_deref()
                        .ok_or_else(|| invalid("Accepted delivery requires a Thread identity"))?;
                    validate_id("thread_id", thread)?;
                    connection.execute("UPDATE inbox_proposals SET state='completed',dispatch_thread_id=?2,failure_kind=NULL,failure_message=NULL,revision=revision+1,updated_at=?3 WHERE proposal_id=?1",params![proposal_id,thread,now])?;
                    for page in proposal.page_ids {
                        connection.execute("UPDATE inbox_entries SET outcome='chat',suggestion_state='settled',suggestion_request_id=NULL,revision=revision+1,updated_at=?2 WHERE page_id=?1",params![page,now])?;
                    }
                    // Accepted transcript belongs to Agent Runtime; Core retains only its receipt identity.
                    connection.execute(
                        "UPDATE inbox_handoffs SET final_text='' WHERE proposal_id=?1",
                        [proposal_id],
                    )?;
                    Ok(simple_effects("inbox_complete_dispatch", &now))
                }
                ProjectWorkspaceIntent::FailInboxDispatch {
                    proposal_id,
                    expected_revision,
                    message_id,
                    failure_kind,
                    message,
                } => {
                    require_host(context)?;
                    dispatch_fence(
                        connection,
                        library_id,
                        store_epoch,
                        &proposal_id,
                        expected_revision,
                        &message_id,
                    )?;
                    let kind = match failure_kind {
                        ProjectWorkspaceInboxFailureKind::Rejected => "rejected",
                        ProjectWorkspaceInboxFailureKind::Unavailable => "unavailable",
                        ProjectWorkspaceInboxFailureKind::Unknown => "unknown",
                    };
                    let state = if failure_kind == ProjectWorkspaceInboxFailureKind::Unknown {
                        "dispatching"
                    } else {
                        "failed"
                    };
                    connection.execute("UPDATE inbox_proposals SET state=?2,failure_kind=?3,failure_message=?4,revision=revision+1,updated_at=?5 WHERE proposal_id=?1",params![proposal_id,state,kind,failure_text(&message),now])?;
                    Ok(simple_effects("inbox_fail_dispatch", &now))
                }
                ProjectWorkspaceIntent::UndoInboxDecision { undo_token } => undo_decision(
                    connection,
                    library_id,
                    context,
                    scope,
                    operation_id,
                    request_hash,
                    &undo_token,
                    assets_root,
                    &now,
                ),
                _ => Err(internal("Unsupported reliable Inbox mutation")),
            }
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn decide(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    scope: &DurableMutationScope<'_>,
    operation_id: &str,
    request_hash: &str,
    proposal_id: &str,
    pages: &[String],
    action: &ProjectWorkspaceInboxDispatchAction,
    session_id: Option<&str>,
    selection: Option<&ProjectWorkspaceInboxExecutionSelection>,
    assets_root: &Path,
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    require_live_entries(connection, library_id, pages)?;
    let inbox_scope = require_one_scope(connection, pages)?;
    let action = normalize_action(connection, library_id, inbox_scope.as_deref(), action)?;
    if let ProjectWorkspaceInboxDispatchAction::Plan { summary, steps } = &action {
        if context.agent_attribution.is_some() {
            return Err(invalid("Only the user may confirm a plan"));
        }
        return super::plan::confirm(
            connection,
            library_id,
            context,
            scope,
            operation_id,
            proposal_id,
            pages,
            summary,
            steps,
            selection,
            now,
        );
    }
    let statuses = ImpliedStatuses::read(connection, pages)?;
    if let Some(selection) = selection
        && (selection.model_selection.instance_id.trim().is_empty()
            || selection.model_selection.model.trim().is_empty()
            || encode(selection)?.len() > 16_384)
    {
        return Err(invalid("The resolved Agent selection is invalid"));
    }
    if matches!(action, ProjectWorkspaceInboxDispatchAction::NewChat { .. }) && selection.is_none()
    {
        return Err(invalid("A new chat requires its resolved Agent selection"));
    }
    let relocation_project = match &action {
        ProjectWorkspaceInboxDispatchAction::MoveToProject { project_id } => {
            Some(project_id.clone())
        }
        ProjectWorkspaceInboxDispatchAction::NewChat { project_id, .. } => project_id.clone(),
        ProjectWorkspaceInboxDispatchAction::SendToChat { session_id, .. } => {
            super::super::session_mutation::require_session(connection, library_id, session_id)?
                .project_id
        }
        _ => None,
    };
    let only_library_inbox = matches!(
        action,
        ProjectWorkspaceInboxDispatchAction::SendToChat { .. }
    );
    let library_home = if only_library_inbox {
        read_registry(connection, library_id)?.map(|home| home.data_source_id)
    } else {
        None
    };
    let mut tokens = Vec::new();
    if let Some(project_id) = relocation_project {
        let home = project_home(connection, library_id, &project_id)?
            .ok_or_else(|| not_found("The Project has no active Database"))?;
        for (position, page_id) in pages.iter().enumerate() {
            let current_source = connection.query_row(
                "SELECT data_source_id FROM data_source_page_memberships WHERE page_block_id=?1 AND removed_at IS NULL",
                [page_id], |row| row.get::<_, String>(0),
            ).optional()?;
            if current_source.as_deref() == Some(home.data_source_id.as_str()) {
                continue;
            }
            if only_library_inbox && (library_home.is_none() || current_source != library_home) {
                continue;
            }
            let move_id = format!("{operation_id}:inbox-move:{position}");
            let outcome = crate::library::move_inbox_page_in_scope(
                connection,
                context,
                scope.store_epoch(),
                library_id,
                &move_id,
                &crate::document::sha256(format!("{request_hash}:{position}").as_bytes()),
                page_id,
                &LibraryPageWriteDestination::DataSource {
                    data_source_id: home.data_source_id.clone(),
                    view_id: Some(home.view_id.clone()),
                    group: None,
                    at: None,
                },
                None,
                assets_root,
                Some(scope),
            )?;
            if matches!(
                action,
                ProjectWorkspaceInboxDispatchAction::MoveToProject { .. }
            ) && let Some(token) = outcome
                .committed
                .value
                .block_transfer
                .and_then(|result| result.undo_token)
            {
                tokens.push(token);
            }
        }
    }
    // A reviewed decision consumes outstanding advice work, including a queued rewrite.
    supersede_requests(connection, pages, now)?;
    let mut effects = apply_confirmation(
        connection,
        context,
        scope.evidence(),
        library_id,
        ConfirmedProposal {
            proposal_id,
            page_ids: pages,
            action: &action,
            session_id,
        now,
    )?;
    let receiving_agent = match &action {
        ProjectWorkspaceInboxDispatchAction::NewChat { .. } => Some(
            selection
                .ok_or_else(|| invalid("A new chat requires its resolved Agent selection"))?
                .model_selection
                .agent_selection(),
        ),
        ProjectWorkspaceInboxDispatchAction::SendToChat { session_id, .. } => {
            super::super::page_chat::session_agent_selection(connection, session_id)?
        }
        _ => None,
    };
    if let Some(agent) = receiving_agent {
        for page in pages {
            crate::library::members::assign_agent_if_unassigned(
                connection,
                library_id,
                context,
                scope.evidence(),
                page,
                &agent,
            )?;
        }
    }
    for page in pages {
        connection.execute("UPDATE inbox_entries SET suggestion_state='settled',suggestion_request_id=NULL,suggestion_error=NULL WHERE page_id=?1",[page])?;
    }
    if !tokens.is_empty() {
        let token = stable_uuid_v7(operation_id, "inbox-decision-undo", proposal_id);
        let proposal = require_proposal(connection, library_id, proposal_id)?;
        let recipe = DecisionUndo {
            tokens,
            pages: pages.to_vec(),
            proposal_revision: proposal.revision,
            entry_revisions: entry_revisions(connection, pages)?,
        };
        connection.execute("INSERT INTO inbox_decision_undo(token,operation_id,library_id,store_epoch,proposal_id,recipe_json) VALUES (?1,?2,?3,?4,?5,?6)",params![token,operation_id,library_id,scope.store_epoch(),proposal_id,encode(&recipe)?])?;
    }
    match &action {
        ProjectWorkspaceInboxDispatchAction::NewChat {
            prompt, additions, ..
        }
        | ProjectWorkspaceInboxDispatchAction::SendToChat {
            prompt, additions, ..
        } => {
            require_host(context)?;
            let mut text = prompt.trim().to_owned();
            for addition in additions {
                text.push_str("\n\n");
                text.push_str(addition);
            }
            text.push_str("\n\nOriginal Inbox messages:\n");
            let mut images = Vec::new();
            let mut numbers = HashMap::new();
            for (index, page_id) in pages.iter().enumerate() {
                let content =
                    read_message_content(connection, page_id, MessageContentLimit::Message)?;
                for image in &content.images {
                    if numbers.contains_key(&image.source) {
                        continue;
                    }
                    images.push(image.clone());
                    numbers.insert(image.source.clone(), images.len());
                }
                let body = agent_markdown(&content, &numbers, MAX_HANDOFF_IMAGES)?;
                let title: String = connection.query_row(
                    "SELECT COALESCE(body.title,'') FROM pages page LEFT JOIN document_materializations body ON body.document_id=page.document_id WHERE page.block_id=?1",
                    [page_id], |row| row.get(0),
                )?;
                text.push_str(&format!(
                    "\n{}. {}",
                    index + 1,
                    title.replace(['\r', '\n'], " ")
                ));
                if let Some(key) =
                    crate::database::current_page_key_for_page(connection, library_id, page_id)?
                {
                    text.push_str(&format!(" ({key})"));
                }
                text.push('\n');
                for line in body.split('\n') {
                    text.push_str("> ");
                    text.push_str(line);
                    text.push('\n');
                }
            }
            if text.len() > 1_179_648 {
                return Err(invalid(
                    "The complete dispatch exceeds the delivery size limit",
                ));
            }
            let target=match &action{
                ProjectWorkspaceInboxDispatchAction::SendToChat{session_id,..}=>connection.query_row("SELECT runtime_id,runtime_thread_id FROM project_session_execution_bindings WHERE session_id=?1",[session_id],|r|Ok(ProjectWorkspaceSessionExecutionRef{runtime_id:r.get(0)?,thread_id:r.get(1)?})).optional()?,
                _=>None,
            };
            images.truncate(MAX_HANDOFF_IMAGES);
            connection.execute("INSERT INTO inbox_handoffs(proposal_id,store_epoch,final_text,launch_id,message_id,execution_selection_json,target_execution_ref_json,images_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",params![proposal_id,scope.store_epoch(),text,handoff_identity(proposal_id,"launch",scope.store_epoch()),handoff_identity(proposal_id,"message",scope.store_epoch()),selection.map(encode).transpose()?,target.as_ref().map(encode).transpose()?,encode(&images)?])?;
        }
        ProjectWorkspaceInboxDispatchAction::MoveToProject { .. } => {
            connection.execute(
                "UPDATE inbox_entries SET outcome='moved' WHERE current_proposal_id=?1",
                [proposal_id],
            )?;
        }
        _ => {}
    }
    for page in pages {
        if !effects.page_ids.contains(page) {
            effects.page_ids.push(page.clone());
        }
    }
    statuses.follow(
        connection,
        library_id,
        context,
        operation_id,
        matches!(
            action,
            ProjectWorkspaceInboxDispatchAction::NewChat { .. }
                | ProjectWorkspaceInboxDispatchAction::SendToChat { .. }
        ),
        &mut effects,
    )?;
    Ok(effects)
}
fn dispatch_fence(
    connection: &Connection,
    library_id: &str,
    _epoch: &str,
    id: &str,
    expected: i64,
    message: &str,
) -> Result<StoredProposal, StoreError> {
    let proposal = require_proposal(connection, library_id, id)?;
    revision(&proposal, expected)?;
    if proposal.state != "dispatching" {
        return Err(conflict("This dispatch is no longer in flight"));
    }
    if stored_handoff_identity(connection, id, "message")? != message {
        return Err(conflict(
            "Delivery identity does not match the confirmed dispatch",
        ));
    }
    Ok(proposal)
}

#[derive(Serialize, Deserialize)]
struct DecisionUndo {
    tokens: Vec<LibraryBlockTransferUndoToken>,
    pages: Vec<String>,
    proposal_revision: i64,
    entry_revisions: Vec<i64>,
}
fn entry_revisions(connection: &Connection, pages: &[String]) -> Result<Vec<i64>, StoreError> {
    pages
        .iter()
        .map(|page| {
            Ok(connection.query_row(
                "SELECT revision FROM inbox_entries WHERE page_id=?1",
                [page],
                |r| r.get(0),
            )?)
        })
        .collect()
}
#[allow(clippy::too_many_arguments)]
fn undo_decision(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    scope: &DurableMutationScope<'_>,
    operation_id: &str,
    request_hash: &str,
    token: &str,
    assets_root: &Path,
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    let (proposal_id,epoch,json,consumed):(String,String,String,bool)=connection.query_row("SELECT proposal_id,store_epoch,recipe_json,consumed FROM inbox_decision_undo WHERE token=?1 AND library_id=?2",params![token,library_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.ok_or_else(||not_found("Inbox Undo is unavailable"))?;
    if epoch != scope.store_epoch() || consumed {
        return Err(conflict("Inbox Undo is no longer available"));
    }
    let recipe: DecisionUndo =
        serde_json::from_str(&json).map_err(|_| corrupt("Inbox Undo is invalid"))?;
    let proposal = require_proposal(connection, library_id, &proposal_id)?;
    revision(&proposal, recipe.proposal_revision)?;
    if entry_revisions(connection, &recipe.pages)? != recipe.entry_revisions {
        return Err(conflict("An Inbox message changed after this decision"));
    }
    let statuses = ImpliedStatuses::read(connection, &recipe.pages)?;
    for (index, token) in recipe.tokens.iter().rev().enumerate() {
        crate::library::undo_inbox_page_in_scope(
            connection,
            context,
            library_id,
            &format!("{operation_id}:inbox-undo:{index}"),
            scope.store_epoch(),
            &crate::document::sha256(format!("{request_hash}:{index}").as_bytes()),
            token,
            assets_root,
            Some(scope),
        )?;
    }
    connection.execute(
        "UPDATE inbox_decision_undo SET consumed=1 WHERE token=?1",
        [token],
    )?;
    let restore = connection.query_row(
        "SELECT origin IN ('agent','user') FROM inbox_proposals WHERE proposal_id=?1",
        [&proposal_id],
        |row| row.get::<_, bool>(0),
    )?;
    connection.execute("UPDATE inbox_proposals SET state=?3,revision=revision+1,updated_at=?2 WHERE proposal_id=?1",params![proposal_id,now,if restore { "open" } else { "superseded" }])?;
    connection.execute(
        "DELETE FROM inbox_handoffs WHERE proposal_id=?1",
        [&proposal_id],
    )?;
    for page in &recipe.pages {
        connection.execute("UPDATE inbox_entries SET state='open',outcome=NULL,current_proposal_id=?3,suggestion_state=?4,suggestion_request_id=NULL,suggestion_error=NULL,revision=revision+1,updated_at=?2 WHERE page_id=?1",params![page,now,restore.then_some(&proposal_id),if restore { "settled" } else { "none" }])?;
    }
    let mut effects = simple_effects("inbox_undo_decision", now);
    effects.page_ids = recipe.pages;
    statuses.follow(
        connection,
        library_id,
        context,
        operation_id,
        false,
        &mut effects,
    )?;
    Ok(effects)
}

/// Losing a member withdraws the entire suggestion/request without asking for more advice.
fn invalidate(connection: &Connection, pages: &[String], now: &str) -> Result<(), StoreError> {
    let pages = pages
        .iter()
        .filter_map(|page| match scheduled::refence(connection, page, now) {
            Ok(true) => None,
            Ok(false) => Some(Ok(page.clone())),
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let pages = pages.as_slice();
    let ids = encode(pages)?;
    connection.execute("UPDATE inbox_suggestion_requests SET state='superseded',generation=generation+1,updated_at=?2 WHERE state IN ('pending','failed') AND request_id IN (SELECT request_id FROM inbox_suggestion_request_pages WHERE page_id IN (SELECT value FROM json_each(?1)))",params![ids,now])?;
    connection.execute("UPDATE inbox_entries SET suggestion_request_id=NULL,suggestion_state='none',suggestion_error=NULL,current_proposal_id=NULL,revision=revision+1,updated_at=?2 WHERE state='open' AND (page_id IN (SELECT value FROM json_each(?1)) OR suggestion_request_id IN (SELECT request_id FROM inbox_suggestion_requests WHERE state='superseded') OR current_proposal_id IN (SELECT proposal_id FROM inbox_proposal_pages WHERE page_id IN (SELECT value FROM json_each(?1))))",params![ids,now])?;
    supersede_open_proposals(connection, pages, "superseded", now)
}
fn supersede_request(connection: &Connection, id: &str, now: &str) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE inbox_suggestion_requests SET state='superseded',generation=generation+1,updated_at=?2
         WHERE request_id=?1 AND state IN ('pending','failed')",
        params![id, now],
    )?;
    Ok(())
}

pub(in crate::workspace) fn stop_suggestion(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    store_epoch: &str,
    operation_id: &str,
    request_hash: &str,
    page_id: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    validate_id("page_id", page_id)?;
    require_live_entries(connection, library_id, &[page_id.to_owned()])?;
    let now = sqlite_now(connection)?;
    let target: Option<(Option<String>, bool)> = connection
        .query_row(
            "SELECT request.request_id, COALESCE(request.mode='auto', FALSE)
             FROM inbox_entries entry
             LEFT JOIN inbox_suggestion_requests request
               ON request.request_id=entry.suggestion_request_id
               AND request.library_id=entry.library_id AND request.state='pending'
             WHERE entry.library_id=?1 AND entry.page_id=?2 AND entry.state='open'
               AND entry.suggestion_state IN ('waiting','pending')",
            params![library_id, page_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((request_id, automatic)) = target else {
        return super::super::mutation::finish_no_op(
            connection,
            context,
            store_epoch,
            operation_id,
            request_hash,
            "inbox_stop_suggestion",
            Vec::new(),
            Vec::new(),
            &now,
        );
    };
    run_mutation(
        connection,
        context,
        store_epoch,
        operation_id,
        request_hash,
        &now,
        |_| {
            if let Some(id) = &request_id {
                supersede_request(connection, id, &now)?;
            }
            let mut effects = simple_effects("inbox_stop_suggestion", &now);
            effects.page_ids = connection
                .prepare(
                    "UPDATE inbox_entries AS entry SET
               suggestion_request_id=NULL, suggestion_error=NULL,
               suggestion_state=CASE
                 WHEN page_id<>?2 AND ?4 AND state='open' AND EXISTS (
                   SELECT 1 FROM blocks WHERE id=entry.page_id AND lifecycle='active'
                 ) THEN 'waiting'
                 WHEN suggestion_state='pending' AND EXISTS (
                   SELECT 1 FROM inbox_proposals
                   WHERE proposal_id=entry.current_proposal_id AND state='open'
                 ) THEN 'settled'
                 ELSE 'none'
               END,
               revision=revision+1, updated_at=?5
             WHERE library_id=?1 AND (page_id=?2 OR suggestion_request_id=?3)
             RETURNING page_id",
                )?
                .query_map(
                    params![library_id, page_id, request_id, automatic, now],
                    |row| row.get(0),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            effects.page_ids.sort();
            Ok(effects)
        },
    )
}

/// A new request replaces prior work, while each member keeps its last visible advice.
pub(super) fn supersede_requests(
    connection: &Connection,
    pages: &[String],
    now: &str,
) -> Result<(), StoreError> {
    let ids = encode(pages)?;
    connection.execute("UPDATE inbox_suggestion_requests SET state='superseded',generation=generation+1,updated_at=?2 WHERE state IN ('pending','failed') AND request_id IN (SELECT request_id FROM inbox_suggestion_request_pages WHERE page_id IN (SELECT value FROM json_each(?1)))",params![ids,now])?;
    connection.execute("UPDATE inbox_entries SET suggestion_request_id=NULL,suggestion_state='none',suggestion_error=NULL,revision=revision+1,updated_at=?1 WHERE suggestion_request_id IN (SELECT request_id FROM inbox_suggestion_requests WHERE state='superseded')",[now])?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn create_request(
    connection: &Connection,
    library_id: &str,
    id: &str,
    mode: ProjectWorkspaceInboxSuggestionMode,
    pages: &[String],
    proposal: Option<&str>,
    revision: Option<i64>,
    correction: Option<&str>,
    now: &str,
) -> Result<(), StoreError> {
    validate_id("request_id", id)?;
    let inbox_scope = require_one_scope(connection, pages)?;
    let inputs = super::super::inbox_read::frozen_suggestion_inputs(connection, library_id, pages)?;
    if inputs
        .iter()
        .map(|frozen| frozen.content.images.len())
        .sum::<usize>()
        > MAX_SUGGESTION_IMAGES
    {
        return Err(conflict("Select messages with at most 20 images in all"));
    }
    let basis = inputs
        .iter()
        .map(|frozen| frozen.input.basis.clone())
        .collect::<Vec<_>>();
    if correction.is_some_and(|s| s.len() > 16_384) {
        return Err(invalid("The correction is too long"));
    }
    let mode = match mode {
        ProjectWorkspaceInboxSuggestionMode::Auto => "auto",
        ProjectWorkspaceInboxSuggestionMode::Grouped => "grouped",
        ProjectWorkspaceInboxSuggestionMode::Refine => "refine",
    };
    supersede_requests(connection, pages, now)?;
    connection.execute("INSERT INTO inbox_suggestion_requests(request_id,library_id,scope_project_id,mode,state,basis_json,proposal_id,expected_revision,correction,created_at,updated_at,inputs_json) VALUES (?1,?2,?3,?4,'pending',?5,?6,?7,?8,?9,?9,?10)",params![id,library_id,inbox_scope,mode,encode(&basis)?,proposal,revision,correction,now,encode(&inputs)?])?;
    for (position, page) in pages.iter().enumerate() {
        connection.execute("INSERT INTO inbox_suggestion_request_pages(request_id,page_id,position) VALUES (?1,?2,?3)",params![id,page,position as i64])?;
        connection.execute("UPDATE inbox_entries SET state='open',outcome=NULL,suggestion_state='pending',suggestion_request_id=?2,suggestion_error=NULL,revision=revision+1,updated_at=?3 WHERE page_id=?1",params![page,id,now])?;
    }
    Ok(())
}
fn request_pages(connection: &Connection, id: &str) -> Result<Vec<String>, StoreError> {
    Ok(connection.prepare("SELECT page_id FROM inbox_suggestion_request_pages WHERE request_id=?1 ORDER BY position")?.query_map([id],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
}
#[allow(clippy::too_many_arguments)]
fn settle_request(
    connection: &Connection,
    library_id: &str,
    scope: &DurableMutationScope<'_>,
    context: &BoundModuleContext,
    operation_id: &str,
    id: &str,
    generation: i64,
    titles: &[ProjectWorkspaceInboxSuggestionTitle],
    suggestions: &[ProjectWorkspaceInboxSuggestedDispatch],
    produced_by: Option<&str>,
    error: Option<&str>,
    now: &str,
) -> Result<(), StoreError> {
    let (state,actual,mode,json):(String,i64,String,String)=connection.query_row("SELECT state,generation,mode,basis_json FROM inbox_suggestion_requests WHERE request_id=?1 AND library_id=?2",params![id,library_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.ok_or_else(||not_found("Suggestion request is unavailable"))?;
    if state != "pending" || actual != generation {
        return Err(conflict("This suggestion request has been replaced"));
    }
    let stale = connection.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM ({STALE_REQUESTS}) WHERE request_id=?2)"),
        params![library_id, id],
        |row| row.get::<_, bool>(0),
    )?;
    if stale {
        return Err(conflict("This suggestion request is no longer current"));
    }
    let pages = request_pages(connection, id)?;
    let basis: Vec<ProjectWorkspaceInboxPageBasis> =
        serde_json::from_str(&json).map_err(|_| corrupt("Suggestion basis is invalid"))?;
    require_open_entries(connection, library_id, &pages)?;
    let assigned = connection.query_row(
        "SELECT count(*) FROM inbox_entries WHERE suggestion_request_id=?1",
        [id],
        |r| r.get::<_, i64>(0),
    )?;
    if assigned != pages.len() as i64 {
        return Err(conflict("Suggestion members changed"));
    }
    if let Some(error) = error {
        fail_request(connection, id, error, now)?;
        return Ok(());
    }
    if mode != "auto" && suggestions.len() != 1 {
        return Err(invalid(
            "A grouped request requires one suggestion for all selected messages",
        ));
    }
    let mut covered = BTreeSet::new();
    for suggestion in suggestions {
        unique_page_ids(&suggestion.page_ids, MAX_PROPOSAL_PAGES)?;
        for page in &suggestion.page_ids {
            if !pages.contains(page) || !covered.insert(page.clone()) {
                return Err(invalid("Suggestion memberships must partition the request"));
            }
        }
    }
    if covered.len() != pages.len() {
        return Err(invalid(
            "Every requested message needs a concrete suggestion",
        ));
    }
    let mut named = BTreeSet::new();
    for title in titles {
        if !pages.contains(&title.page_id) || !named.insert(&title.page_id) {
            return Err(invalid("Title result does not belong to this request"));
        }
        let current = super::super::inbox_read::message_basis(connection, &title.page_id)?;
        if !basis.contains(&current) {
            continue;
        }
        let entry =
            super::super::inbox_read::suggestion_input(connection, library_id, &title.page_id)?;
        if entry.title_provisional {
            let (generation, head_seq) = document_head(connection, &title.page_id)?;
            let text = bounded_text("title", &title.title, MAX_GIVEN_TITLE_CHARS)?;
            crate::document::edit_page_in_scope(
                connection,
                scope,
                context,
                library_id,
                &title.page_id,
                generation,
                head_seq,
                None,
                Some(&title_markdown(&text)),
                operation_id,
            )?;
            connection.execute(
                "UPDATE inbox_entries SET provisional_title=NULL WHERE page_id=?1",
                [&title.page_id],
            )?;
        }
    }
    let inbox_scope = require_one_scope(connection, &pages)?;
    for suggestion in suggestions {
        if suggestion.explicit_request {
            for page in &suggestion.page_ids {
                if super::handback::context(connection, library_id, page)?.is_some()
                    || connection.query_row(
                        "SELECT source_kind='github' FROM inbox_entries WHERE page_id=?1",
                        [page],
                        |r| r.get::<_, bool>(0),
                    )?
                {
                    return Err(invalid(
                        "External and handed-back messages require a new decision from the person; explicit_request must be false",
                    ));
                }
            }
        }
        if suggestion.explicit_request
            && matches!(
                suggestion.action,
                ProjectWorkspaceInboxDispatchAction::Plan { .. }
            )
        {
            return Err(invalid("A plan always requires user confirmation"));
        }
        let action = normalize_action(
            connection,
            library_id,
            inbox_scope.as_deref(),
            &suggestion.action,
        )?;
        let written_basis = basis
            .iter()
            .filter(|member| suggestion.page_ids.contains(&member.page_id))
            .cloned()
            .collect::<Vec<_>>();
        insert_proposal(
            connection,
            library_id,
            NewProposal {
                proposal_id: &suggestion.proposal_id,
                origin: ProjectWorkspaceInboxProposalOrigin::Agent,
                page_ids: &suggestion.page_ids,
                basis: &written_basis,
                action: &action,
                entry_kind: suggestion.entry_kind,
                summary: &bounded_text("summary", &suggestion.summary, MAX_SUMMARY_CHARS)?,
                rationale: suggestion.rationale.as_deref(),
                produced_by: produced_by
                    .map(|s| truncate_chars(s, MAX_PRODUCED_BY_CHARS))
                    .as_deref(),
            },
            now,
        )?;
        connection.execute(
            "UPDATE inbox_proposals SET explicit_request=?2 WHERE proposal_id=?1",
            params![suggestion.proposal_id, suggestion.explicit_request],
        )?;
    }
    connection.execute("UPDATE inbox_suggestion_requests SET state='settled',correction=NULL,updated_at=?2 WHERE request_id=?1",params![id,now])?;
    Ok(())
}

fn fail_request(
    connection: &Connection,
    id: &str,
    error: &str,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute("UPDATE inbox_suggestion_requests SET state='failed',updated_at=?2 WHERE request_id=?1 AND state='pending'",params![id,now])?;
    connection.execute("UPDATE inbox_entries SET suggestion_state='failed',suggestion_error=?2,revision=revision+1,updated_at=?3 WHERE suggestion_request_id=?1",params![id,failure_text(error),now])?;
    Ok(())
}

struct PendingRequest {
    id: String,
    generation: i64,
    mode: String,
    basis: String,
    proposal_id: Option<String>,
    expected_revision: Option<i64>,
    correction: Option<String>,
}

fn pending_requests(
    connection: &Connection,
    library_id: &str,
) -> Result<Vec<PendingRequest>, StoreError> {
    // Filter lifecycle changes before windowing; bad inputs are handled per request below.
    let live = pending_request_filter();
    Ok(connection.prepare(&format!("SELECT request_id,generation,mode,basis_json,proposal_id,expected_revision,correction FROM inbox_suggestion_requests WHERE {live} ORDER BY created_at,request_id"))?.query_map([library_id],|row|Ok(PendingRequest {
        id:row.get(0)?,generation:row.get(1)?,mode:row.get(2)?,basis:row.get(3)?,proposal_id:row.get(4)?,expected_revision:row.get(5)?,correction:row.get(6)?,
    }))?.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn pending_request_filter() -> String {
    format!("library_id=?1 AND state='pending' AND request_id NOT IN ({STALE_REQUESTS})")
}

pub(in crate::workspace) fn read_pending_request_ids(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    request_ids: &[String],
) -> Result<(Vec<String>, Vec<InboxRoutingCancellation>), StoreError> {
    require_host(context)?;
    if request_ids.len() > 16 {
        return Err(invalid(
            "At most 16 suggestion requests can be checked at once",
        ));
    }
    for id in request_ids {
        validate_id("request_id", id)?;
    }
    let ids = encode(request_ids)?;
    let stale = format!("request_id IN ({STALE_REQUESTS})");
    let mut statement = connection.prepare(&format!(
        "SELECT request_id, state='pending' AND NOT ({stale}), delivery.generation, coordinator_session_id
         FROM inbox_suggestion_requests
         LEFT JOIN inbox_routing_deliveries delivery USING (request_id)
         WHERE library_id=?1 AND state IN ('pending','superseded')
           AND request_id IN (SELECT value FROM json_each(?2))
         ORDER BY created_at,request_id"
    ))?;
    let mut rows = statement.query(params![library_id, ids])?;
    let mut pending = Vec::new();
    let mut cancelled = Vec::new();
    while let Some(row) = rows.next()? {
        let request_id = row.get(0)?;
        if row.get::<_, bool>(1)? {
            pending.push(request_id);
        } else if let Some(coordinator_session_id) = row.get::<_, Option<String>>(3)? {
            cancelled.push(InboxRoutingCancellation {
                request_id,
                generation: row.get(2)?,
                coordinator_session_id,
            });
        }
    }
    Ok((pending, cancelled))
}

fn pickup_request(
    connection: &Connection,
    library_id: &str,
    row: &PendingRequest,
) -> Result<ProjectWorkspaceInboxSuggestionRequest, StoreError> {
    let page_ids = request_pages(connection, &row.id)?;
    // Load one bounded frozen payload at a time, even when many requests are queued.
    let saved_inputs: String = connection.query_row(
        "SELECT inputs_json FROM inbox_suggestion_requests WHERE request_id=?1",
        [&row.id],
        |row| row.get(0),
    )?;
    let inputs: Vec<super::super::inbox_read::FrozenSuggestionInput> =
        serde_json::from_str(&saved_inputs)
            .map_err(|_| corrupt("Saved suggestion inputs are unreadable"))?;
    let basis: Vec<ProjectWorkspaceInboxPageBasis> = serde_json::from_str(&row.basis)
        .map_err(|_| corrupt("Saved suggestion basis is unreadable"))?;
    if page_ids.is_empty()
        || inputs.len() != page_ids.len()
        || basis.len() != page_ids.len()
        || inputs.len() > MAX_PROPOSAL_PAGES
    {
        return Err(corrupt(
            "Saved suggestion inputs do not cover every message",
        ));
    }
    let mut image_offset = 0;
    for ((frozen, page), written) in inputs.iter().zip(&page_ids).zip(&basis) {
        let input = &frozen.input;
        let projected = agent_markdown(
            &frozen.content,
            &super::super::inbox_read::image_numbers(&frozen.content, image_offset),
            usize::MAX,
        )?;
        image_offset += frozen.content.images.len();
        if input.page_id != *page
            || input.basis != *written
            || written.page_id != *page
            || frozen.content.markdown.len() > MAX_MESSAGE_BYTES
            || image_offset > MAX_SUGGESTION_IMAGES
            || input.images != frozen.content.images
            || input.body != projected
            || frozen.content.fingerprint() != written.content_hash
        {
            return Err(corrupt(
                "Saved suggestion input does not match its content fingerprint",
            ));
        }
    }
    let mut context = super::super::inbox_read::dispatch_context_for_inputs(
        connection,
        library_id,
        inputs.into_iter().map(|frozen| frozen.input).collect(),
    )?;
    if let Some(id) = row.proposal_id.as_deref() {
        let proposal = require_proposal(connection, library_id, id)?;
        let summary: String = connection.query_row(
            "SELECT summary FROM inbox_proposals WHERE proposal_id=?1",
            [id],
            |row| row.get(0),
        )?;
        context.open_proposals = vec![ProjectWorkspaceInboxContextProposal {
            proposal_id: id.into(),
            page_ids: proposal.page_ids,
            page_keys: Vec::new(),
            action: proposal.action,
            summary,
        }];
    }
    Ok(ProjectWorkspaceInboxSuggestionRequest {
        delivery: connection.query_row("SELECT coordinator_session_id,handed_over_at_ms,run_started_at_ms,last_refusal FROM inbox_routing_deliveries WHERE request_id=?1 AND generation=?2",params![row.id,row.generation],|r|Ok(InboxRoutingDelivery {paused_ms:connection.query_row("SELECT elapsed_ms + CASE WHEN paused_at_ms IS NULL THEN 0 ELSE MAX(0,CAST(unixepoch('subsec')*1000 AS INTEGER)-paused_at_ms) END FROM execution_hold_routing_clocks WHERE request_id=?1 AND generation=?2",params![row.id,row.generation],|clock|clock.get(0)).optional()?,coordinator_session_id:r.get(0)?,handed_over_at_ms:r.get(1)?,run_started_at_ms:r.get(2)?,last_refusal:r.get(3)?})).optional()?,
        context,
        request_id: row.id.clone(),
        generation: row.generation,
        mode: serde_json::from_value(serde_json::Value::String(row.mode.clone()))
            .map_err(|_| corrupt("Saved suggestion mode is unreadable"))?,
        page_ids,
        basis,
        proposal_id: row.proposal_id.clone(),
        expected_revision: row.expected_revision,
        correction: row.correction.clone(),
    })
}

pub(in crate::workspace) fn read_request(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    id: &str,
) -> Result<Option<ProjectWorkspaceInboxSuggestionRequest>, StoreError> {
    require_host(context)?;
    validate_id("request_id", id)?;
    let row = connection.query_row(&format!("SELECT request_id,generation,mode,basis_json,proposal_id,expected_revision,correction FROM inbox_suggestion_requests WHERE library_id=?1 AND request_id=?2 AND state='pending' AND request_id NOT IN ({STALE_REQUESTS})"),params![library_id,id],|r| Ok(PendingRequest { id:r.get(0)?, generation:r.get(1)?, mode:r.get(2)?, basis:r.get(3)?, proposal_id:r.get(4)?, expected_revision:r.get(5)?, correction:r.get(6)? })).optional()?;
    row.map(|row| pickup_request(connection, library_id, &row))
        .transpose()
}

fn require_automatic_confirmation(
    connection: &Connection,
    id: &str,
    proposal: &StoredProposal,
    supplied: Option<&ProjectWorkspaceInboxDispatchAction>,
) -> Result<(), StoreError> {
    if !eligible {
        return Err(invalid(
            "Nodex may only act on the user's explicit requests",
        ));
    }
    require_basis(connection, &proposal.page_ids, &proposal.basis)?;
    let mut expected = proposal.action.clone();
    match &mut expected {
        ProjectWorkspaceInboxDispatchAction::NewChat { additions, .. }
        | ProjectWorkspaceInboxDispatchAction::SendToChat { additions, .. } => additions.clear(),
        _ => {
            return Err(invalid(
                "Nodex may only confirm a new chat or a chat follow-up",
            ));
        }
    }
    if supplied != Some(&expected) {
        return Err(invalid(
            "Automatic dispatch must preserve the request and omit additions",
        ));
    }
    Ok(())
}

/// Preparation records durable failures; reads skip the same bad requests, including a
/// failure that appears after preparation, so it can never hide later eligible work.
fn unreadable_requests(
    connection: &Connection,
    library_id: &str,
) -> Result<Vec<(String, String)>, StoreError> {
    let mut failures = Vec::new();
    for row in pending_requests(connection, library_id)? {
        match pickup_request(connection, library_id, &row) {
            Ok(_) => {}
            Err(error) if error.retryable => return Err(error),
            Err(error) => failures.push((
                row.id,
                format!("Cannot read this suggestion request: {}", error.message),
            )),
        }
    }
    Ok(failures)
}

pub(in crate::workspace) fn read_requests(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    limit: u32,
) -> Result<Vec<ProjectWorkspaceInboxSuggestionRequest>, StoreError> {
    require_host(context)?;
    let mut output = Vec::new();
    let mut encoded_bytes = 0;
    for row in pending_requests(connection, library_id)? {
        if super::super::execution_holds::routing_held(connection, &row.id)? {
            continue;
        }
        let request = match pickup_request(connection, library_id, &row) {
            Ok(request) => request,
            Err(error) if error.retryable => return Err(error),
            Err(_) => continue,
        };
        let bytes = encode(&request)?.len();
        if !output.is_empty() && encoded_bytes + bytes > 12 * 1024 * 1024 {
            break;
        }
        encoded_bytes += bytes;
        output.push(request);
        if output.len() >= limit.clamp(1, 16) as usize {
            break;
        }
    }
    Ok(output)
}

// Workspace owns suggestion eligibility, including changes made through Library and
// Document. A group is current only while every member is available and still owns
// the same advice/request. Preparation retires stale groups atomically; reads and
// settlement use the same request fence without making Library write Inbox state.
const STALE_ADVICE: &str = "
    SELECT DISTINCT proposal.proposal_id
    FROM inbox_proposals proposal
    LEFT JOIN json_each(proposal.basis_json) basis
    LEFT JOIN inbox_proposal_pages member
      ON member.proposal_id=proposal.proposal_id
      AND member.page_id=json_extract(basis.value,'$.page_id')
    LEFT JOIN inbox_entries entry ON entry.page_id=member.page_id
    LEFT JOIN pages page ON page.block_id=member.page_id
    LEFT JOIN documents document ON document.id=page.document_id
    LEFT JOIN blocks block ON block.id=member.page_id
    WHERE proposal.library_id=?1 AND proposal.state='open' AND (
        entry.library_id IS NOT proposal.library_id
        OR entry.state IS NOT 'open'
        OR entry.current_proposal_id IS NOT proposal.proposal_id
        OR block.lifecycle IS NOT 'active'
        OR document.id IS NULL
    )";
const STALE_REQUESTS: &str = "
    SELECT DISTINCT request.request_id
    FROM inbox_suggestion_requests request
    LEFT JOIN json_each(request.basis_json) basis
    LEFT JOIN inbox_suggestion_request_pages member
      ON member.request_id=request.request_id
      AND member.page_id=json_extract(basis.value,'$.page_id')
    LEFT JOIN inbox_entries entry ON entry.page_id=member.page_id
    LEFT JOIN pages page ON page.block_id=member.page_id
    LEFT JOIN documents document ON document.id=page.document_id
    LEFT JOIN blocks block ON block.id=member.page_id
    WHERE request.library_id=?1 AND request.state IN ('pending','failed') AND (
        entry.library_id IS NOT request.library_id
        OR entry.state IS NOT 'open'
        OR entry.suggestion_request_id IS NOT request.request_id
        OR block.lifecycle IS NOT 'active'
        OR document.id IS NULL
    )";
fn needs_preparation(connection: &Connection, library_id: &str) -> Result<bool, StoreError> {
    let waiting:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM inbox_entries entry WHERE entry.library_id=?1 AND entry.suggestion_state='waiting' AND entry.source_kind NOT IN ('automation','nodex'))",[library_id],|r|r.get(0))?;
    if waiting {
        return Ok(true);
    }
    for sql in [STALE_ADVICE, STALE_REQUESTS] {
        if connection
            .query_row(sql, [library_id], |_| Ok(()))
            .optional()?
            .is_some()
        {
            return Ok(true);
        }
    }
    Ok(!unreadable_requests(connection, library_id)?.is_empty())
}
fn reconcile_advice(
    connection: &Connection,
    library_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    connection.execute("UPDATE inbox_entries SET suggestion_state='none',suggestion_error=NULL,revision=revision+1,updated_at=?2 WHERE library_id=?1 AND suggestion_state='waiting' AND (state<>'open' OR NOT EXISTS (SELECT 1 FROM blocks WHERE id=inbox_entries.page_id AND lifecycle='active'))",params![library_id,now])?;
    let proposals = connection
        .prepare(STALE_ADVICE)?
        .query_map([library_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in proposals {
        invalidate(connection, &proposal_page_ids(connection, &id)?, now)?;
        if connection.query_row(
            "SELECT origin='automation' FROM inbox_proposals WHERE proposal_id=?1",
            [&id],
            |r| r.get::<_, bool>(0),
        )? {
            continue;
        }
        // Page collection can already have removed every member through foreign keys.
        connection.execute(
            "UPDATE inbox_proposals SET state='superseded',revision=revision+1,updated_at=?2 \
             WHERE proposal_id=?1 AND state='open'",
            params![id, now],
        )?;
    }
    let requests = connection
        .prepare(STALE_REQUESTS)?
        .query_map([library_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in requests {
        invalidate(connection, &request_pages(connection, &id)?, now)?;
        supersede_request(connection, &id, now)?;
    }
    for (id, reason) in unreadable_requests(connection, library_id)? {
        fail_request(connection, &id, &reason, now)?;
    }
    Ok(())
}

fn require_epoch(actual: &str, expected: &str) -> Result<(), StoreError> {
    if actual != expected {
        return Err(StoreError::new(
            StoreErrorCode::StaleStoreEpoch,
            "The Store changed; review this decision again",
            true,
        ));
    }
    Ok(())
}

/// A replaced Store cannot authorize another delivery with old confirmation evidence.
pub(crate) fn discard_replaced_dispatches(connection: &Connection) -> Result<(), StoreError> {
    connection.execute("UPDATE inbox_proposals SET state='failed',failure_kind='rejected',failure_message='The Store was restored; review this decision again',revision=revision+1 WHERE state='dispatching'",[])?;
    connection.execute("DELETE FROM inbox_handoffs WHERE proposal_id IN (SELECT proposal_id FROM inbox_proposals WHERE state='failed' AND failure_kind='rejected')",[])?;
    connection.execute("DELETE FROM inbox_decision_undo", [])?;
    Ok(())
}
