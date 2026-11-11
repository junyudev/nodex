//! Scheduled messages use the same Page genesis and document edits as captured messages.
use super::*;
use crate::automation::firing;
use nodex_core_contracts::automation::{AutomationDecisionStatus, AutomationExecutionKind};
use nodex_core_contracts::inbox::ProjectWorkspaceInboxChatAgent;

fn now_ms(connection: &Connection, now: &str) -> Result<i64, StoreError> {
    Ok(connection.query_row(
        "SELECT CAST(unixepoch(?1,'subsec')*1000 AS INTEGER)",
        [now],
        |r| r.get(0),
    )?)
}

#[allow(clippy::too_many_arguments)]
pub(in crate::workspace) fn hold_automation_decision(
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
        let completed:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM automation_execution_leases WHERE lease_id=?1 AND purpose='hold' AND status='completed')",[lease_id],|r|r.get(0))?;
        if completed {
            return Ok(simple_effects("inbox_hold_scheduled", &now));
        }
        let lease = firing::hold_lease(connection, lease_id, milliseconds)?;
        let definition = firing::definition(connection, &lease.automation_id)?;
        if let Some(held) = firing::held(connection, &lease.automation_id)? {
            connection.execute("UPDATE automation_decisions SET missed_count=missed_count+1,last_scheduled_for_ms=MAX(last_scheduled_for_ms,?2),updated_at_ms=?3 WHERE dispatch_id=?1",params![held.dispatch_id,lease.scheduled_for_ms,milliseconds])?;
            crate::automation::clock::attach_hold(
                connection,
                &held.dispatch_id,
                &definition,
                lease.scheduled_for_ms,
            )?;
            firing::complete_hold(connection, &lease, milliseconds)?;
            let mut effects = simple_effects("inbox_hold_scheduled", &now);
            effects.page_ids.push(held.page_id);
            return Ok(effects);
        }
        let project = if definition.kind == AutomationExecutionKind::Heartbeat {
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
            kind: "automation",
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
        crate::library::members::initialize_automation_owner(
            connection,
            library_id,
            page_id,
            &definition.owner_member_id,
            &now,
        )?;
        let pages = [page_id.to_owned()];
        let basis = current_basis(connection, &pages)?;
        connection.execute("INSERT INTO automation_decisions(dispatch_id,automation_id,status,waiting_in_inbox,page_id,inbox_project_id,first_scheduled_for_ms,last_scheduled_for_ms,hold_basis_json,created_at_ms,updated_at_ms) VALUES (?1,?2,'held',1,?3,?4,?5,?5,?6,?7,?7)",params![lease.dispatch_id,lease.automation_id,page_id,inbox_project,lease.scheduled_for_ms,serde_json::to_string(&basis[0]).map_err(|_|internal("Cannot encode Automation Page basis"))?,milliseconds])?;
        insert_proposal(
            connection,
            library_id,
            NewProposal {
                proposal_id: &format!(
                    "scheduled-proposal:{}",
                    crate::document::sha256(lease.dispatch_id.as_bytes())
                ),
                origin: ProjectWorkspaceInboxProposalOrigin::Automation,
                page_ids: &pages,
                basis: &basis,
                action: &ProjectWorkspaceInboxDispatchAction::ExecuteDecision {
                    decision_id: lease.dispatch_id.clone(),
                    agent: None,
                },
                entry_kind: Some(ProjectWorkspaceInboxEntryKind::Todo),
                summary: &truncate_chars(&format!("Run {}", definition.name), MAX_SUMMARY_CHARS),
                rationale: None,
                produced_by: None,
            },
            &now,
        )?;
        crate::automation::clock::attach_hold(
            connection,
            &lease.dispatch_id,
            &definition,
            lease.scheduled_for_ms,
        )?;
        firing::complete_hold(connection, &lease, milliseconds)?;
        effects.operation_kind = "inbox_hold_scheduled";
        Ok(effects)
    })
}

#[allow(clippy::too_many_arguments)]
pub(in crate::workspace) fn refresh_automation_decision(
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
        let row=connection.query_row("SELECT automation_id,page_id,hold_basis_json FROM automation_decisions WHERE dispatch_id=?1 AND status='held' AND assessment_json IS NULL",[dispatch],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()?;
        let Some((automation, page, basis)) = row else {
            return Ok(simple_effects("inbox_refresh_scheduled", &now));
        };
        let basis: ProjectWorkspaceInboxPageBasis =
            serde_json::from_str(&basis).map_err(|_| corrupt("Invalid Automation Page basis"))?;
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
        connection.execute(
            "UPDATE automation_decisions SET hold_basis_json=?2,updated_at_ms=?3 WHERE dispatch_id=?1",
            params![
                dispatch,
                serde_json::to_string(&current[0])
                    .map_err(|_| internal("Cannot encode Automation Page basis"))?,
                now_ms(connection, &now)?
            ],
        )?;
        let mut effects = simple_effects("inbox_refresh_scheduled", &now);
        effects.page_ids.push(page);
        Ok(effects)
    })
}

pub(super) fn refence(connection: &Connection, page: &str, now: &str) -> Result<bool, StoreError> {
    let Some(item) = firing::item(connection, page)? else {
        return Ok(false);
    };
    if item.status != AutomationDecisionStatus::Held {
        return Ok(false);
    }
    let basis = current_basis(connection, &[page.to_owned()])?;
    connection.execute("UPDATE inbox_proposals SET basis_json=?2,revision=revision+1,updated_at=?3 WHERE proposal_id=(SELECT current_proposal_id FROM inbox_entries WHERE page_id=?1) AND origin='automation' AND state='open'",params![page,serde_json::to_string(&basis).map_err(|_|internal("Cannot encode Automation Page basis"))?,now])?;
    connection.execute("UPDATE inbox_entries SET suggestion_state='settled',suggestion_error=NULL,revision=revision+1,updated_at=?2 WHERE page_id=?1",params![page,now])?;
    Ok(true)
}

pub(super) fn decision_automation_id(
    connection: &Connection,
    decision_id: &str,
) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT automation_id FROM automation_decisions WHERE dispatch_id=?1",
            [decision_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Decision is unavailable"))
}

pub(super) fn admit(
    connection: &Connection,
    context: &BoundModuleContext,
    library: &str,
    pages: &[String],
    dispatch: &str,
    agent: Option<&ProjectWorkspaceInboxChatAgent>,
    now: &str,
) -> Result<(), StoreError> {
    if pages.len() != 1 {
        return Err(invalid("Run one Automation at a time"));
    }
    let automation_id = decision_automation_id(connection, dispatch)?;
    let definition = firing::definition(connection, &automation_id)?;
    require_automation_owner(connection, context, &definition)?;
    let item = firing::item(connection, &pages[0])?
        .ok_or_else(|| conflict("This message does not hold an Automation"))?;
    if item.status != AutomationDecisionStatus::Held
        || item.dispatch_id != dispatch
        || item.automation_id != automation_id
    {
        return Err(conflict(
            "This Automation decision is no longer waiting in the Inbox",
        ));
    }
    require_waiting_entry(connection, library, &pages[0])?;
    let prompt = super::super::inbox_read::frozen_message_text(connection, &pages[0])?;
    let milliseconds = now_ms(connection, now)?;
    let mut frozen = definition;
    frozen.prompt = prompt.clone();
    if frozen.kind == AutomationExecutionKind::Cron {
        let selection = match agent.and_then(|a| a.model.as_ref().map(|model| (a, model))) {
            Some((agent, model)) => Some(nodex_core_contracts::library::AgentWorkSelection {
                instance_id: agent.instance_id.clone(),
                model: model.clone(),
                effort: agent.reasoning_effort.clone(),
            }),
            None => {
                if frozen.model.is_some() {
                    Some(crate::automation::clock::agent_selection(&frozen)?)
                } else {
                    None
                }
            }
        };
        if let Some(selection) = selection {
            crate::library::members::initialize_automation_work(
                connection,
                library,
                &pages[0],
                &frozen.owner_member_id,
                &selection,
                now,
            )?;
        }
    }
    let mut frozen_value =
        serde_json::to_value(&frozen).map_err(|_| invalid("Automation action cannot be frozen"))?;
    if let Some(agent) = agent {
        frozen_value["admission_agent"] = serde_json::to_value(agent)
            .map_err(|_| invalid("Automation Agent cannot be frozen"))?;
    }
    connection.execute("UPDATE automation_decisions SET frozen_action_json=?2,frozen_authority_json=?3,automation_revision=?4 WHERE dispatch_id=?1",params![dispatch,frozen_value.to_string(),serde_json::json!({"owner_member_id":frozen.owner_member_id,"mode":frozen.mode,"automation_revision":frozen.automation_revision}).to_string(),frozen.automation_revision])?;
    connection.execute("UPDATE automation_decisions SET status='admitted',waiting_in_inbox=0,admission_prompt=?2,admission_agent_json=?3,admitted_at_ms=?4,due_at_ms=?4,failure_message=NULL,updated_at_ms=?4 WHERE dispatch_id=?1",params![dispatch,prompt,agent.map(serde_json::to_string).transpose().map_err(|_|invalid("Invalid Automation Agent choice"))?,milliseconds])?;
    Ok(())
}

pub(super) fn consume(
    connection: &Connection,
    pages: &[String],
    status: &str,
    now: &str,
) -> Result<(), StoreError> {
    for page in pages {
        connection.execute("UPDATE automation_decisions SET status=?2,waiting_in_inbox=0,due_at_ms=NULL,updated_at_ms=CAST(unixepoch(?3,'subsec')*1000 AS INTEGER) WHERE page_id=?1 AND waiting_in_inbox=1",params![page,status,now])?;
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
        if item.status != AutomationDecisionStatus::Skipped {
            continue;
        }
        let definition = firing::definition(connection, &item.automation_id)?;
        if firing::held(connection, &item.automation_id)?.is_some() {
            return Err(conflict(
                "This Automation already has a decision waiting in the Inbox",
            ));
        }
        connection.execute("UPDATE automation_decisions SET status='held',waiting_in_inbox=1,failure_message=NULL,updated_at_ms=CAST(unixepoch(?2,'subsec')*1000 AS INTEGER) WHERE page_id=?1",params![page,now])?;
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
                origin: ProjectWorkspaceInboxProposalOrigin::Automation,
                page_ids: std::slice::from_ref(page),
                basis: &basis,
                action: &ProjectWorkspaceInboxDispatchAction::ExecuteDecision {
                    decision_id: item.dispatch_id,
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
    context: &BoundModuleContext,
    library: &str,
    proposal: &StoredProposal,
    id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let ProjectWorkspaceInboxDispatchAction::ExecuteDecision {
        decision_id: dispatch_id,
        ..
    } = &proposal.action
    else {
        return Err(invalid("A decision is required"));
    };
    let automation_id = decision_automation_id(connection, dispatch_id)?;
    let definition = firing::definition(connection, &automation_id)?;
    require_automation_owner(connection, context, &definition)?;
    if proposal.state != "failed" || proposal.page_ids.len() != 1 {
        return Err(conflict("Only a failed decision can be retried"));
    }
    require_waiting_entry(connection, library, &proposal.page_ids[0])?;
    let item = firing::item(connection, &proposal.page_ids[0])?
        .ok_or_else(|| not_found("Automation decision is unavailable"))?;
    if item.status != AutomationDecisionStatus::Failed || item.dispatch_id != *dispatch_id {
        return Err(conflict("This Automation decision cannot be retried"));
    }
    let milliseconds = now_ms(connection, now)?;
    connection.execute("UPDATE automation_decisions SET status='admitted',waiting_in_inbox=0,due_at_ms=?2,failure_message=NULL,updated_at_ms=?2 WHERE dispatch_id=?1",params![dispatch_id,milliseconds])?;
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
    let pages=connection.prepare("SELECT page_id FROM automation_decisions WHERE page_id IS NOT NULL AND automation_id IN (SELECT value FROM json_each(?1)) UNION SELECT link.page_id FROM project_session_pages link JOIN automation_execution_runs run ON run.session_id=link.session_id WHERE run.run_id IN (SELECT value FROM json_each(?2)) ORDER BY page_id")?.query_map(params![ids,run_ids],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let sessions=connection.prepare("SELECT DISTINCT session_id FROM automation_execution_runs WHERE run_id IN (SELECT value FROM json_each(?1)) AND session_id IS NOT NULL ORDER BY session_id")?.query_map([run_ids],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
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

/// The Pages, Documents and Databases that allocating Automation run Pages changed.
pub(crate) struct PreparedRunPages {
    pub(crate) pages: Vec<String>,
    pub(crate) documents: Vec<String>,
    pub(crate) databases: Vec<String>,
}

/// New-chat Automation runs allocate their work Page beside the admitted Run. Ask first
/// decisions reuse the reviewed intake Page; runbooks remain ordinary links.
pub(crate) fn prepare_automation_run_pages(
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    context: &BoundModuleContext,
    runs: &mut [nodex_core_contracts::automation::AutomationRun],
) -> Result<PreparedRunPages, StoreError> {
    let connection = scope.connection();
    let mut pages = Vec::new();
    let mut documents = Vec::new();
    let mut databases = Vec::new();
    for run in runs {
        if run.page_id.is_some() {
            continue;
        }
        let Some(dispatch) = &run.dispatch_id else {
            continue;
        };
        let Some(automation) =
            crate::automation::clock::execution_automation(connection, dispatch)?
        else {
            continue;
        };
        if automation.kind != AutomationExecutionKind::Cron {
            continue;
        }
        let admission = firing::admission(connection, dispatch)?;
        let selection = if let Some(selection) = &run.agent_selection {
            selection.clone()
        } else {
            match admission
                .as_ref()
                .and_then(|a| a.agent.as_ref())
                .and_then(|agent| agent.model.as_ref().map(|model| (agent, model)))
            {
                Some((agent, model)) => nodex_core_contracts::library::AgentWorkSelection {
                    instance_id: agent.instance_id.clone(),
                    model: model.clone(),
                    effort: agent.reasoning_effort.clone(),
                },
                None => crate::automation::clock::agent_selection(&automation)?,
            }
        };
        let held: Option<String> = connection.query_row(
            "SELECT page_id FROM automation_decisions WHERE dispatch_id=?1",
            [dispatch],
            |r| r.get(0),
        )?;
        if let Some(page) = held {
            let used: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM automation_execution_runs WHERE page_id=?1 AND run_id<>?2)",
                params![page, run.run_id],
                |r| r.get(0),
            )?;
            if !used {
                crate::library::members::initialize_automation_work(
                    connection,
                    &context.library_id.0,
                    &page,
                    &automation.owner_member_id,
                    &selection,
                    scope.committed_at(),
                )?;
                connection.execute(
                    "UPDATE automation_execution_runs SET page_id=?2 WHERE run_id=?1",
                    params![run.run_id, page],
                )?;
                run.page_id = Some(page);
                continue;
            }
        }
        let page = stable_uuid_v7(&run.run_id, "automation-page", dispatch);
        let document = stable_uuid_v7(&run.run_id, "automation-document", dispatch);
        let title = title_markdown(&automation.name);
        let body = text_paragraphs_markdown(&automation.prompt);
        let input = crate::library::page_genesis::PageGenesisInput {
            context,
            commit_context: scope.evidence(),
            library_id: &context.library_id.0,
            actor_project_id: automation.project_id.as_deref(),
            operation_id: &run.run_id,
            store_epoch: scope.store_epoch(),
            page_id: &page,
            document_id: &document,
            title_markdown: &title,
            markdown: &body,
            now: scope.committed_at(),
        };
        let home = automation
            .project_id
            .as_deref()
            .map(|project| project_home(connection, &context.library_id.0, project))
            .transpose()?
            .flatten();
        if let Some(home) = home {
            let destination = resolve_page_transfer_data_source_destination(
                connection,
                &context.library_id.0,
                automation.project_id.as_deref(),
                &home.data_source_id,
                &home.view_id,
                Some(Some("doing")),
                None,
            )?;
            crate::library::page_genesis::create_page_in_data_source(
                connection,
                input,
                &destination,
            )?;
            databases.push(home.database_id);
        } else {
            crate::library::page_genesis::create_page_at_library_start(connection, input)?;
        }
        crate::library::members::initialize_automation_work(
            connection,
            &context.library_id.0,
            &page,
            &automation.owner_member_id,
            &selection,
            scope.committed_at(),
        )?;
        connection.execute(
            "UPDATE automation_execution_runs SET page_id=?2 WHERE run_id=?1",
            params![run.run_id, page],
        )?;
        run.page_id = Some(page.clone());
        pages.push(page);
        documents.push(document);
    }
    Ok(PreparedRunPages {
        pages,
        documents,
        databases,
    })
}

/// A held decision is its Automation Owner's to start or retry: the person, or an Agent
/// acting for them. `context` is bound, so its Actor names that Member.
pub(super) fn require_automation_owner(
    connection: &Connection,
    context: &BoundModuleContext,
    automation: &nodex_core_contracts::automation::Automation,
) -> Result<(), StoreError> {
    let actor = crate::infrastructure::actors::requesting_member(connection, context)?;
    if actor != automation.owner_member_id {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Only the Automation Owner can confirm this decision",
            false,
        ));
    }
    Ok(())
}

/// The Automation command owns one receipt for Run now, whether it confirms a waiting
/// decision or creates a new manual decision. Workspace joins that same commit.
pub(crate) fn run_held_automation_now(
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    context: &BoundModuleContext,
    automation_id: &str,
    operation: &str,
) -> Result<(), StoreError> {
    let connection = scope.connection();
    let automation = firing::definition(connection, automation_id)?;
    require_automation_owner(connection, context, &automation)?;
    let held = firing::held(connection, automation_id)?
        .ok_or_else(|| conflict("This Automation no longer has a waiting decision"))?;
    let proposal_id: String = connection.query_row(
        "SELECT current_proposal_id FROM inbox_entries WHERE page_id=?1",
        [&held.page_id],
        |r| r.get(0),
    )?;
    let proposal = require_proposal(connection, &context.library_id.0, &proposal_id)?;
    if proposal.state == "failed" {
        return retry(
            connection,
            context,
            &context.library_id.0,
            &proposal,
            &proposal_id,
            scope.committed_at(),
        );
    }
    if proposal.state != "open" {
        return Err(conflict("This Automation decision is no longer waiting"));
    }
    require_basis(connection, &proposal.page_ids, &proposal.basis)?;
    let mut effects = apply_confirmation(
        connection,
        context,
        scope.evidence(),
        &context.library_id.0,
        ConfirmedProposal {
            proposal_id: &proposal_id,
            page_ids: &proposal.page_ids,
            action: &proposal.action,
            session_id: None,
        },
        scope.committed_at(),
    )?;
    move_message_status(
        connection,
        &context.library_id.0,
        context,
        operation,
        &proposal.page_ids,
        "doing",
        false,
        &mut effects,
    )?;
    Ok(())
}

/// An execution owns its work Page's active chat. Origin intake and runbook
/// references remain context links when another slot owns their execution.
pub(crate) fn bind_automation_run_pages(
    connection: &Connection,
    session: &str,
    related: &[String],
    owned: &[String],
    now: &str,
) -> Result<(), StoreError> {
    super::super::page_chat::link_pages(connection, session, related, now)?;
    super::super::page_chat::set_active_chats(connection, session, owned, now)
}
