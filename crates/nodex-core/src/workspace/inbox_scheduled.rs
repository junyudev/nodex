//! Scheduled messages use the same Page genesis and document edits as captured messages.
use super::*;
use crate::automation::firing;
use nodex_core_contracts::automation::{AutomationDefinitionKind, AutomationFiringStatus};
use nodex_core_contracts::inbox::ProjectWorkspaceInboxChatAgent;

fn now_ms(connection: &Connection, now: &str) -> Result<i64, StoreError> {
    Ok(connection.query_row(
        "SELECT CAST(unixepoch(?1,'subsec')*1000 AS INTEGER)",
        [now],
        |r| r.get(0),
    )?)
}

#[allow(clippy::too_many_arguments)]
pub(in crate::workspace) fn hold_scheduled_firing(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    epoch: &str,
    operation: &str,
    hash: &str,
    lease_id: &str,
    page_id: &str,
    document_id: &str,
    title: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_host(context)?;
    validate_id("page_id", page_id)?;
    validate_id("document_id", document_id)?;
    let now = sqlite_now(connection)?;
    run_mutation(connection, context, epoch, operation, hash, &now, |scope| {
        let milliseconds = now_ms(connection, &now)?;
        // A different receipt identity may replay the Host's successful hold after a lost reply.
        let completed:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM core_automation_leases WHERE lease_id=?1 AND purpose='hold' AND status='completed')",[lease_id],|r|r.get(0))?;
        if completed {
            return Ok(simple_effects("inbox_hold_scheduled", &now));
        }
        let lease = firing::hold_lease(connection, lease_id, milliseconds)?;
        let definition = firing::definition(connection, &lease.automation_id)?;
        if let Some(held) = firing::held(connection, &lease.automation_id)? {
            connection.execute("UPDATE core_automation_firings SET missed_count=missed_count+1,last_scheduled_for_ms=MAX(last_scheduled_for_ms,?2),updated_at_ms=?3 WHERE dispatch_id=?1",params![held.dispatch_id,lease.scheduled_for_ms,milliseconds])?;
            firing::complete_hold(connection, &lease, milliseconds)?;
            let mut effects = simple_effects("inbox_hold_scheduled", &now);
            effects.page_ids.push(held.page_id);
            return Ok(effects);
        }
        let project = if definition.kind == AutomationDefinitionKind::Heartbeat {
            connection.query_row(
                "SELECT project_id FROM project_sessions WHERE id=?1",
                [definition.target_session_id.as_deref()],
                |r| r.get::<_, Option<String>>(0),
            )?
        } else {
            definition.project_id.clone()
        };
        let inbox_project = project
            .as_deref()
            .map(|id| {
                project_home(connection, library_id, id).map(|home| home.map(|_| id.to_owned()))
            })
            .transpose()?
            .flatten();
        let source = EntrySource {
            kind: "scheduled_task",
            automation_id: Some(definition.automation_id.clone()),
            dispatch_id: Some(lease.dispatch_id.clone()),
            project_id: definition.project_id.clone(),
            label: Some(definition.name.clone()),
            ..EntrySource::default()
        };
        let message = MessagePage {
            title_markdown: title_markdown(&normalize_given_title(title)?),
            body_markdown: text_paragraphs_markdown(&definition.prompt),
            provisional_title: None,
        };
        let mut effects = capture_message_in_scope(
            connection,
            library_id,
            context,
            epoch,
            operation,
            scope,
            page_id,
            document_id,
            &message,
            &source,
            inbox_project.as_deref(),
            &now,
        )?;
        let pages = [page_id.to_owned()];
        let basis = current_basis(connection, &pages)?;
        connection.execute("INSERT INTO core_automation_firings(dispatch_id,automation_id,status,waiting_in_inbox,page_id,inbox_project_id,first_scheduled_for_ms,last_scheduled_for_ms,hold_basis_json,created_at_ms,updated_at_ms) VALUES (?1,?2,'held',1,?3,?4,?5,?5,?6,?7,?7)",params![lease.dispatch_id,lease.automation_id,page_id,inbox_project,lease.scheduled_for_ms,serde_json::to_string(&basis[0]).map_err(|_|internal("Cannot encode scheduled Page basis"))?,milliseconds])?;
        insert_proposal(
            connection,
            library_id,
            NewProposal {
                proposal_id: &format!(
                    "scheduled-proposal:{}",
                    crate::document::sha256(lease.dispatch_id.as_bytes())
                ),
                origin: ProjectWorkspaceInboxProposalOrigin::Schedule,
                page_ids: &pages,
                basis: &basis,
                action: &ProjectWorkspaceInboxDispatchAction::RunTask {
                    automation_id: lease.automation_id.clone(),
                    dispatch_id: lease.dispatch_id.clone(),
                    agent: None,
                },
                entry_kind: Some(ProjectWorkspaceInboxEntryKind::Todo),
                summary: &truncate_chars(&format!("Run {}", definition.name), MAX_SUMMARY_CHARS),
                rationale: None,
                produced_by: None,
            },
            &now,
        )?;
        firing::complete_hold(connection, &lease, milliseconds)?;
        effects.operation_kind = "inbox_hold_scheduled";
        Ok(effects)
    })
}

#[allow(clippy::too_many_arguments)]
pub(in crate::workspace) fn refresh_scheduled_firing(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    epoch: &str,
    operation: &str,
    hash: &str,
    dispatch: &str,
) -> Result<ProjectWorkspaceApplyOutcome, StoreError> {
    require_host(context)?;
    validate_id("dispatch_id", dispatch)?;
    let now = sqlite_now(connection)?;
    run_mutation(connection, context, epoch, operation, hash, &now, |scope| {
        let row=connection.query_row("SELECT automation_id,page_id,hold_basis_json FROM core_automation_firings WHERE dispatch_id=?1 AND status='held'",[dispatch],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()?;
        let Some((automation, page, basis)) = row else {
            return Ok(simple_effects("inbox_refresh_scheduled", &now));
        };
        let basis: ProjectWorkspaceInboxPageBasis =
            serde_json::from_str(&basis).map_err(|_| corrupt("Invalid scheduled Page basis"))?;
        if current_basis(connection, std::slice::from_ref(&page))? != [basis.clone()] {
            return Ok(simple_effects("inbox_refresh_scheduled", &now));
        }
        let definition = firing::definition(connection, &automation)?;
        let body = text_paragraphs_markdown(&definition.prompt);
        let current_body: String = connection.query_row(
            "SELECT materialization.markdown FROM pages page JOIN document_materializations materialization ON materialization.document_id=page.document_id WHERE page.block_id=?1",
            [&page], |row| row.get(0),
        )?;
        if current_body == body {
            return Ok(simple_effects("inbox_refresh_scheduled", &now));
        }
        let (generation, head_seq) = document_head(connection, &page)?;
        crate::document::edit_page_in_scope(
            connection,
            scope,
            context,
            library_id,
            &page,
            generation,
            head_seq,
            Some(&body),
            None,
            operation,
        )?;
        refence(connection, &page, &now)?;
        let current = current_basis(connection, std::slice::from_ref(&page))?;
        connection.execute("UPDATE core_automation_firings SET hold_basis_json=?2,updated_at_ms=?3 WHERE dispatch_id=?1",params![dispatch,serde_json::to_string(&current[0]).map_err(|_|internal("Cannot encode scheduled Page basis"))?,now_ms(connection, &now)?])?;
        let mut effects = simple_effects("inbox_refresh_scheduled", &now);
        effects.page_ids.push(page);
        Ok(effects)
    })
}

pub(super) fn refence(connection: &Connection, page: &str, now: &str) -> Result<bool, StoreError> {
    let Some(item) = firing::item(connection, page)? else {
        return Ok(false);
    };
    if item.status != AutomationFiringStatus::Held {
        return Ok(false);
    }
    let basis = current_basis(connection, &[page.to_owned()])?;
    connection.execute("UPDATE inbox_proposals SET basis_json=?2,revision=revision+1,updated_at=?3 WHERE proposal_id=(SELECT current_proposal_id FROM inbox_entries WHERE page_id=?1) AND origin='schedule' AND state='open'",params![page,serde_json::to_string(&basis).map_err(|_|internal("Cannot encode scheduled Page basis"))?,now])?;
    connection.execute("UPDATE inbox_entries SET suggestion_state='settled',suggestion_error=NULL,revision=revision+1,updated_at=?2 WHERE page_id=?1",params![page,now])?;
    Ok(true)
}

pub(super) fn admit(
    connection: &Connection,
    library: &str,
    pages: &[String],
    automation: &str,
    dispatch: &str,
    agent: Option<&ProjectWorkspaceInboxChatAgent>,
    now: &str,
) -> Result<(), StoreError> {
    if pages.len() != 1 {
        return Err(invalid("Run one scheduled task at a time"));
    }
    firing::definition(connection, automation)?;
    let item = firing::item(connection, &pages[0])?
        .ok_or_else(|| conflict("This message does not hold a scheduled task"))?;
    if item.status != AutomationFiringStatus::Held
        || item.dispatch_id != dispatch
        || item.automation_id != automation
    {
        return Err(conflict(
            "This scheduled firing is no longer waiting in the Inbox",
        ));
    }
    require_waiting_entry(connection, library, &pages[0])?;
    let prompt = super::super::inbox_read::frozen_message_text(connection, &pages[0])?;
    let milliseconds = now_ms(connection, now)?;
    connection.execute("UPDATE core_automation_firings SET status='admitted',waiting_in_inbox=0,admission_prompt=?2,admission_agent_json=?3,admitted_at_ms=?4,due_at_ms=?4,failure_message=NULL,updated_at_ms=?4 WHERE dispatch_id=?1",params![dispatch,prompt,agent.map(serde_json::to_string).transpose().map_err(|_|invalid("Invalid scheduled Agent choice"))?,milliseconds])?;
    Ok(())
}

pub(super) fn consume(
    connection: &Connection,
    pages: &[String],
    status: &str,
    now: &str,
) -> Result<(), StoreError> {
    for page in pages {
        connection.execute("UPDATE core_automation_firings SET status=?2,waiting_in_inbox=0,due_at_ms=NULL,updated_at_ms=CAST(unixepoch(?3,'subsec')*1000 AS INTEGER) WHERE page_id=?1 AND waiting_in_inbox=1",params![page,status,now])?;
    }
    Ok(())
}
pub(super) fn reopen(
    connection: &Connection,
    pages: &[String],
    now: &str,
) -> Result<(), StoreError> {
    for page in pages {
        let Some(item) = firing::item(connection, page)? else {
            continue;
        };
        if item.status != AutomationFiringStatus::Skipped {
            continue;
        }
        let definition = firing::definition(connection, &item.automation_id)?;
        if firing::held(connection, &item.automation_id)?.is_some() {
            return Err(conflict("This task already has a run waiting in the Inbox"));
        }
        connection.execute("UPDATE core_automation_firings SET status='held',waiting_in_inbox=1,failure_message=NULL,updated_at_ms=CAST(unixepoch(?2,'subsec')*1000 AS INTEGER) WHERE page_id=?1",params![page,now])?;
        connection.execute(
            "UPDATE inbox_entries SET outcome=NULL WHERE page_id=?1",
            [page],
        )?;
        let basis = current_basis(connection, std::slice::from_ref(page))?;
        insert_proposal(
            connection,
            &connection.query_row(
                "SELECT library_id FROM inbox_entries WHERE page_id=?1",
                [page],
                |r| r.get::<_, String>(0),
            )?,
            NewProposal {
                proposal_id: &stable_uuid_v7(now, "scheduled-reopen", &item.dispatch_id),
                origin: ProjectWorkspaceInboxProposalOrigin::Schedule,
                page_ids: std::slice::from_ref(page),
                basis: &basis,
                action: &ProjectWorkspaceInboxDispatchAction::RunTask {
                    automation_id: item.automation_id,
                    dispatch_id: item.dispatch_id,
                    agent: None,
                },
                entry_kind: Some(ProjectWorkspaceInboxEntryKind::Todo),
                summary: &format!("Run {}", definition.name),
                rationale: None,
                produced_by: None,
            },
            now,
        )?;
    }
    Ok(())
}
pub(super) fn retry(
    connection: &Connection,
    library: &str,
    proposal: &StoredProposal,
    id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let ProjectWorkspaceInboxDispatchAction::RunTask {
        automation_id,
        dispatch_id,
        ..
    } = &proposal.action
    else {
        return Err(invalid("A scheduled dispatch is required"));
    };
    firing::definition(connection, automation_id)?;
    if proposal.state != "failed" || proposal.page_ids.len() != 1 {
        return Err(conflict("Only a failed scheduled run can be retried"));
    }
    require_waiting_entry(connection, library, &proposal.page_ids[0])?;
    let item = firing::item(connection, &proposal.page_ids[0])?
        .ok_or_else(|| not_found("Scheduled firing is unavailable"))?;
    if item.status != AutomationFiringStatus::Failed || item.dispatch_id != *dispatch_id {
        return Err(conflict("This scheduled firing cannot be retried"));
    }
    let milliseconds = now_ms(connection, now)?;
    connection.execute("UPDATE core_automation_firings SET status='admitted',waiting_in_inbox=0,due_at_ms=?2,failure_message=NULL,updated_at_ms=?2 WHERE dispatch_id=?1",params![dispatch_id,milliseconds])?;
    connection.execute("UPDATE inbox_proposals SET state='completed',failure_kind=NULL,failure_message=NULL,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE proposal_id=?1",[id])?;
    Ok(())
}

/// Automation settles firings and binds their chats without a second Workspace receipt.
pub(crate) fn record_automation_changes(
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    context: &BoundModuleContext,
    operation: &str,
    automations: &[String],
    runs: &[String],
) -> Result<Vec<String>, StoreError> {
    use crate::infrastructure::{
        event_log::{NewChangeLogEntry, append_change_log},
        projection_impact::expand_database_coordinates,
    };
    use nodex_core_contracts::events::ProjectionImpact;
    let connection = scope.connection();
    let ids = serde_json::to_string(automations)
        .map_err(|_| internal("Cannot encode task identities"))?;
    let run_ids =
        serde_json::to_string(runs).map_err(|_| internal("Cannot encode Run identities"))?;
    let pages=connection.prepare("SELECT page_id FROM core_automation_firings WHERE automation_id IN (SELECT value FROM json_each(?1)) UNION SELECT link.page_id FROM project_session_pages link JOIN core_automation_runs run ON run.session_id=link.session_id WHERE run.run_id IN (SELECT value FROM json_each(?2)) ORDER BY page_id")?.query_map(params![ids,run_ids],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let sessions=connection.prepare("SELECT DISTINCT session_id FROM core_automation_runs WHERE run_id IN (SELECT value FROM json_each(?1)) AND session_id IS NOT NULL ORDER BY session_id")?.query_map([run_ids],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if pages.is_empty() && sessions.is_empty() {
        return Ok(pages);
    }
    let impact = expand_database_coordinates(
        connection,
        ProjectionImpact::Resources {
            page_ids: pages.clone(),
            database_ids: vec![],
            data_source_ids: vec![],
            view_ids: vec![],
            document_heads: vec![],
        },
    )?;
    crate::database::record_local_projection_delta(
        connection,
        scope.evidence(),
        &context.library_id.0,
        &impact,
    )?;
    let payload = serde_json::json!({"module":"project_workspace","operationKind":"inbox_scheduled_firing","kind":"workspace_changed","projectCatalogChange":null,"projectIds":[],"sessionIds":sessions,"threadIds":[],"sessionSummaryScopes":[],"sessionDetailIds":sessions,"inboxChanged":true});
    append_change_log(
        connection,
        NewChangeLogEntry {
            project_id: context.project_id.as_ref().map(|id| id.0.as_str()),
            store_epoch: scope.store_epoch(),
            kind: "project_workspace.changed",
            operation_id: Some(operation),
            block_ids: &pages,
            document_ids: &[],
            database_block_ids: &[],
            payload_json: &payload.to_string(),
            projection_impact: &impact,
            committed_at: scope.committed_at(),
        },
        scope.evidence(),
    )?;
    Ok(pages)
}
