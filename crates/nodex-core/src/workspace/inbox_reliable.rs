//! One owner for the decision transaction and its immutable delivery evidence.
use super::*;
use crate::infrastructure::durable_mutation::DurableMutationScope;
use nodex_core_contracts::inbox::*;
use nodex_core_contracts::library::{LibraryBlockTransferUndoToken, LibraryPageWriteDestination};
use nodex_core_contracts::workspace::{
    ProjectWorkspaceIntent, ProjectWorkspaceSessionExecutionRef,
};
use serde::{Deserialize, Serialize};
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
        "target_execution_ref_json" => {
            "SELECT target_execution_ref_json FROM inbox_handoffs WHERE proposal_id=?1"
        }
        "image_sources_json" => {
            "SELECT image_sources_json FROM inbox_handoffs WHERE proposal_id=?1"
        }
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
const MAX_HANDOFF_IMAGES: usize = 20;

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
                ProjectWorkspaceIntent::ConfirmInboxDispatch {
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
                    require_basis(connection, &proposal.page_ids, &proposal.basis)?;
                    require_basis(connection, &proposal.page_ids, &basis)?;
                    decide(
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
                    )
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
                    crate::document::edit_page_in_scope(
                        connection,
                        scope,
                        context,
                        library_id,
                        &page_id,
                        basis.generation,
                        basis.head_seq,
                        edit.body_markdown.as_deref(),
                        edit.title_markdown.as_deref(),
                        operation_id,
                    )?;
                    invalidate(connection, std::slice::from_ref(&page_id), &now)?;
                    if edit.title_markdown.is_some() {
                        connection.execute("UPDATE inbox_entries SET provisional_title=(SELECT title FROM document_materializations WHERE document_id=(SELECT document_id FROM pages WHERE block_id=?1)) WHERE page_id=?1",[&page_id])?;
                    }
                    let mut effects = simple_effects("inbox_edit_message", &now);
                    effects.page_ids.push(page_id);
                    Ok(effects)
                }
                ProjectWorkspaceIntent::PrepareInboxSuggestions { request_id, limit } => {
                    require_host(context)?;
                    reconcile_advice(connection, library_id, &now)?;
                    let pages=connection.prepare("WITH waiting AS (SELECT entry.page_id,entry.seq,entry.scope_project_id FROM inbox_entries entry JOIN blocks block ON block.id=entry.page_id AND block.lifecycle='active' WHERE entry.library_id=?1 AND entry.state='open' AND entry.suggestion_state='pending' AND entry.suggestion_request_id IS NULL), oldest AS (SELECT scope_project_id FROM waiting ORDER BY seq LIMIT 1) SELECT waiting.page_id FROM waiting,oldest WHERE waiting.scope_project_id IS oldest.scope_project_id ORDER BY waiting.seq LIMIT ?2")?.query_map(params![library_id,i64::from(limit.clamp(1,8))],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                    let mut complete = Vec::new();
                    for page in pages {
                        match super::super::inbox_read::suggestion_input(
                            connection, library_id, &page,
                        ) {
                            Ok(_) => complete.push(page),
                            Err(error) => {
                                connection.execute("UPDATE inbox_entries SET suggestion_state='failed',suggestion_error=?2,revision=revision+1,updated_at=?3 WHERE page_id=?1",params![page,failure_text(&error.message),now])?;
                            }
                        }
                    }
                    let pages = complete;
                    if !pages.is_empty() {
                        let basis = current_basis(connection, &pages)?;
                        create_request(
                            connection,
                            library_id,
                            &request_id,
                            ProjectWorkspaceInboxSuggestionMode::Auto,
                            &pages,
                            &basis,
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
                        invalidate(connection, &proposal.page_ids, &now)?;
                    } else {
                        invalidate(connection, &pages, &now)?;
                    }
                    create_request(
                        connection,
                        library_id,
                        &request_id,
                        mode,
                        &pages,
                        &basis,
                        proposal_id.as_deref(),
                        expected_revision,
                        correction.as_deref(),
                        &now,
                    )?;
                    Ok(simple_effects("inbox_request_suggestion", &now))
                }
                ProjectWorkspaceIntent::SettleInboxSuggestion {
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
    let mut tokens = Vec::new();
    if let ProjectWorkspaceInboxDispatchAction::MoveToProject { project_id } = &action {
        let home = project_home(connection, library_id, project_id)?
            .ok_or_else(|| not_found("The Project has no active Database"))?;
        for (position, page_id) in pages.iter().enumerate() {
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
            if let Some(token) = outcome
                .committed
                .value
                .block_transfer
                .and_then(|result| result.undo_token)
            {
                tokens.push(token);
            }
        }
    }
    let effects = apply_confirmation(
        connection,
        library_id,
        proposal_id,
        pages,
        &action,
        session_id,
        now,
    )?;
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
        ProjectWorkspaceInboxDispatchAction::NewChat { prompt, .. }
        | ProjectWorkspaceInboxDispatchAction::SendToChat { prompt, .. } => {
            require_host(context)?;
            let mut text = prompt.trim().to_owned();
            text.push_str("\n\nOriginal Inbox messages:\n");
            let mut images = Vec::new();
            for (index, page_id) in pages.iter().enumerate() {
                super::super::inbox_read::message_image_sources(connection, page_id, &mut images)?;
                let entry =
                    super::super::inbox_read::suggestion_input(connection, library_id, page_id)?;
                text.push_str(&format!(
                    "\n{}. {}",
                    index + 1,
                    entry.title.replace(['\r', '\n'], " ")
                ));
                if let Some(key) = &entry.page_key {
                    text.push_str(&format!(" ({key})"));
                }
                text.push('\n');
                for line in entry.body.split('\n') {
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
            connection.execute("INSERT INTO inbox_handoffs(proposal_id,store_epoch,final_text,launch_id,message_id,execution_selection_json,target_execution_ref_json,image_sources_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",params![proposal_id,scope.store_epoch(),text,handoff_identity(proposal_id,"launch",scope.store_epoch()),handoff_identity(proposal_id,"message",scope.store_epoch()),selection.map(encode).transpose()?,target.as_ref().map(encode).transpose()?,encode(&images)?])?;
        }
        ProjectWorkspaceInboxDispatchAction::MoveToProject { .. } => {
            connection.execute(
                "UPDATE inbox_entries SET outcome='moved' WHERE current_proposal_id=?1",
                [proposal_id],
            )?;
        }
        _ => {}
    }
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
    connection.execute("UPDATE inbox_proposals SET state='superseded',revision=revision+1,updated_at=?2 WHERE proposal_id=?1",params![proposal_id,now])?;
    for page in &recipe.pages {
        connection.execute("UPDATE inbox_entries SET state='open',outcome=NULL,current_proposal_id=NULL,suggestion_state='pending',suggestion_request_id=NULL,revision=revision+1,updated_at=?2 WHERE page_id=?1",params![page,now])?;
    }
    let mut effects = simple_effects("inbox_undo_decision", now);
    effects.page_ids = recipe.pages;
    Ok(effects)
}

/// A change to any member invalidates the whole suggestion/request, never a partial group.
fn invalidate(connection: &Connection, pages: &[String], now: &str) -> Result<(), StoreError> {
    let ids = encode(pages)?;
    connection.execute("UPDATE inbox_suggestion_requests SET state='superseded',generation=generation+1,updated_at=?2 WHERE state IN ('pending','failed') AND request_id IN (SELECT request_id FROM inbox_suggestion_request_pages WHERE page_id IN (SELECT value FROM json_each(?1)))",params![ids,now])?;
    connection.execute("UPDATE inbox_entries SET suggestion_request_id=NULL,suggestion_state='pending',suggestion_error=NULL,current_proposal_id=NULL,revision=revision+1,updated_at=?2 WHERE state='open' AND (page_id IN (SELECT value FROM json_each(?1)) OR suggestion_request_id IN (SELECT request_id FROM inbox_suggestion_requests WHERE state='superseded') OR current_proposal_id IN (SELECT proposal_id FROM inbox_proposal_pages WHERE page_id IN (SELECT value FROM json_each(?1))))",params![ids,now])?;
    supersede_open_proposals(connection, pages, "superseded", now)
}
#[allow(clippy::too_many_arguments)]
fn create_request(
    connection: &Connection,
    library_id: &str,
    id: &str,
    mode: ProjectWorkspaceInboxSuggestionMode,
    pages: &[String],
    basis: &[ProjectWorkspaceInboxPageBasis],
    proposal: Option<&str>,
    revision: Option<i64>,
    correction: Option<&str>,
    now: &str,
) -> Result<(), StoreError> {
    validate_id("request_id", id)?;
    let inbox_scope = require_one_scope(connection, pages)?;
    for page in pages {
        super::super::inbox_read::suggestion_input(connection, library_id, page)?;
    }
    if correction.is_some_and(|s| s.len() > 16_384) {
        return Err(invalid("The correction is too long"));
    }
    let mode = match mode {
        ProjectWorkspaceInboxSuggestionMode::Auto => "auto",
        ProjectWorkspaceInboxSuggestionMode::Grouped => "grouped",
        ProjectWorkspaceInboxSuggestionMode::Refine => "refine",
    };
    connection.execute("INSERT INTO inbox_suggestion_requests(request_id,library_id,scope_project_id,mode,state,basis_json,proposal_id,expected_revision,correction,created_at,updated_at) VALUES (?1,?2,?3,?4,'pending',?5,?6,?7,?8,?9,?9)",params![id,library_id,inbox_scope,mode,encode(basis)?,proposal,revision,correction,now])?;
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
    let pages = request_pages(connection, id)?;
    let basis: Vec<ProjectWorkspaceInboxPageBasis> =
        serde_json::from_str(&json).map_err(|_| corrupt("Suggestion basis is invalid"))?;
    require_open_entries(connection, library_id, &pages)?;
    require_basis(connection, &pages, &basis)?;
    let assigned = connection.query_row(
        "SELECT count(*) FROM inbox_entries WHERE suggestion_request_id=?1",
        [id],
        |r| r.get::<_, i64>(0),
    )?;
    if assigned != pages.len() as i64 {
        return Err(conflict("Suggestion members changed"));
    }
    if let Some(error) = error {
        connection.execute(
            "UPDATE inbox_suggestion_requests SET state='failed',updated_at=?2 WHERE request_id=?1",
            params![id, now],
        )?;
        connection.execute("UPDATE inbox_entries SET suggestion_state='failed',suggestion_error=?2,revision=revision+1,updated_at=?3 WHERE suggestion_request_id=?1",params![id,failure_text(error),now])?;
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
        let entry =
            super::super::inbox_read::suggestion_input(connection, library_id, &title.page_id)?;
        if entry.title_provisional {
            let text = bounded_text("title", &title.title, MAX_GIVEN_TITLE_CHARS)?;
            crate::document::edit_page_in_scope(
                connection,
                scope,
                context,
                library_id,
                &title.page_id,
                entry.basis.generation,
                entry.basis.head_seq,
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
        let action = normalize_action(
            connection,
            library_id,
            inbox_scope.as_deref(),
            &suggestion.action,
        )?;
        let basis = current_basis(connection, &suggestion.page_ids)?;
        insert_proposal(
            connection,
            library_id,
            NewProposal {
                proposal_id: &suggestion.proposal_id,
                origin: ProjectWorkspaceInboxProposalOrigin::Agent,
                page_ids: &suggestion.page_ids,
                basis: &basis,
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
    }
    connection.execute("UPDATE inbox_suggestion_requests SET state='settled',correction=NULL,updated_at=?2 WHERE request_id=?1",params![id,now])?;
    Ok(())
}

pub(in crate::workspace) fn read_requests(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    limit: u32,
) -> Result<Vec<ProjectWorkspaceInboxSuggestionRequest>, StoreError> {
    require_host(context)?;
    let rows=connection.prepare("SELECT request_id,generation,mode,basis_json,proposal_id,expected_revision,correction FROM inbox_suggestion_requests WHERE library_id=?1 AND state='pending' ORDER BY created_at,request_id LIMIT ?2")?.query_map(params![library_id,i64::from(limit.clamp(1,16))],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<i64>>(5)?,r.get::<_,Option<String>>(6)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut output = Vec::new();
    let mut encoded_bytes = 0;
    for request in rows.into_iter().map(
        |(request_id, generation, mode, basis, proposal_id, expected_revision, correction)| {
            let page_ids = request_pages(connection, &request_id)?;
            let mut request_context = super::super::inbox_read::read_dispatch_context(
                connection, context, library_id, &page_ids,
            )?;
            // Refinement retains the exact predecessor even though it is no longer confirmable.
            if let Some(id) = proposal_id.as_deref() {
                let proposal = require_proposal(connection, library_id, id)?;
                let summary: String = connection.query_row(
                    "SELECT summary FROM inbox_proposals WHERE proposal_id=?1",
                    [id],
                    |r| r.get(0),
                )?;
                request_context.open_proposals = vec![ProjectWorkspaceInboxContextProposal {
                    proposal_id: id.into(),
                    page_ids: proposal.page_ids,
                    page_keys: Vec::new(),
                    action: proposal.action,
                    summary,
                }];
            }
            Ok::<_, StoreError>(ProjectWorkspaceInboxSuggestionRequest {
                context: request_context,
                request_id,
                generation,
                mode: serde_json::from_value(serde_json::Value::String(mode))
                    .map_err(|_| corrupt("Suggestion mode is invalid"))?,
                page_ids,
                basis: serde_json::from_str(&basis)
                    .map_err(|_| corrupt("Suggestion basis is invalid"))?,
                correction,
                proposal_id,
                expected_revision,
            })
        },
    ) {
        let request = request?;
        let bytes = encode(&request)?.len();
        if !output.is_empty() && encoded_bytes + bytes > 12 * 1024 * 1024 {
            break;
        }
        encoded_bytes += bytes;
        output.push(request);
    }
    Ok(output)
}

const STALE_ADVICE: &str = "SELECT DISTINCT proposal.proposal_id FROM inbox_proposals proposal,json_each(proposal.basis_json) basis LEFT JOIN pages page ON page.block_id=json_extract(basis.value,'$.page_id') LEFT JOIN documents document ON document.id=page.document_id LEFT JOIN blocks block ON block.id=page.block_id WHERE proposal.library_id=?1 AND proposal.state='open' AND (document.id IS NULL OR document.generation<>json_extract(basis.value,'$.generation') OR document.head_seq<>json_extract(basis.value,'$.head_seq') OR block.placement_revision<>json_extract(basis.value,'$.placement_revision'))";
const STALE_REQUESTS: &str = "SELECT DISTINCT request.request_id FROM inbox_suggestion_requests request,json_each(request.basis_json) basis LEFT JOIN pages page ON page.block_id=json_extract(basis.value,'$.page_id') LEFT JOIN documents document ON document.id=page.document_id LEFT JOIN blocks block ON block.id=page.block_id WHERE request.library_id=?1 AND request.state IN ('pending','failed') AND (document.id IS NULL OR document.generation<>json_extract(basis.value,'$.generation') OR document.head_seq<>json_extract(basis.value,'$.head_seq') OR block.placement_revision<>json_extract(basis.value,'$.placement_revision'))";
fn needs_preparation(connection: &Connection, library_id: &str) -> Result<bool, StoreError> {
    let waiting:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM inbox_entries entry JOIN blocks block ON block.id=entry.page_id AND block.lifecycle='active' WHERE entry.library_id=?1 AND entry.state='open' AND entry.suggestion_state='pending' AND entry.suggestion_request_id IS NULL)",[library_id],|r|r.get(0))?;
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
    Ok(false)
}
fn reconcile_advice(
    connection: &Connection,
    library_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let proposals = connection
        .prepare(STALE_ADVICE)?
        .query_map([library_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in proposals {
        invalidate(connection, &proposal_page_ids(connection, &id)?, now)?;
    }
    let requests = connection
        .prepare(STALE_REQUESTS)?
        .query_map([library_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in requests {
        invalidate(connection, &request_pages(connection, &id)?, now)?;
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
