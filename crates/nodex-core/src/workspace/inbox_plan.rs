//! A reviewed plan creates its complete work graph inside the Inbox decision scope.
use super::*;
use crate::infrastructure::durable_mutation::DurableMutationScope;
use nodex_core_contracts::inbox::{InboxPlanStep, ProjectWorkspaceInboxExecutionSelection};
use nodex_core_contracts::library::AgentWorkSelection;
use std::collections::BTreeMap;

pub(super) fn validate(
    connection: &Connection,
    library_id: &str,
    scope: Option<&str>,
    summary: &str,
    steps: &[InboxPlanStep],
) -> Result<(), StoreError> {
    if summary.trim().is_empty() || summary.chars().count() > 200 || !(2..=8).contains(&steps.len())
    {
        return Err(invalid("A plan requires a summary and 2–8 steps"));
    }
    let mut keys = BTreeSet::new();
    for step in steps {
        validate_id("plan step key", &step.key)?;
        if !keys.insert(step.key.as_str()) {
            return Err(invalid("Plan step keys must be unique"));
        }
        if scope.is_some_and(|project| project != step.project_id) {
            return Err(invalid("A Project Inbox can only plan in its own Project"));
        }
        super::super::session_lifecycle::require_project(
            connection,
            library_id,
            &step.project_id,
            true,
        )?;
        project_data_source(connection, library_id, &step.project_id)?;
        if step.title.trim().is_empty()
            || step.title.chars().count() > 120
            || step.body.chars().count() > 4000
        {
            return Err(invalid(
                "Plan step title/body exceeds its bound or title is empty",
            ));
        }
        if let Some(agent) = &step.agent {
            crate::library::validate_agent_selection(&AgentWorkSelection {
                instance_id: agent.instance_id.clone(),
                model: agent.model.clone(),
                effort: agent.effort.clone(),
            })?;
        }
    }
    for step in steps {
        let blockers = step.blocked_by.iter().collect::<BTreeSet<_>>();
        if blockers.len() != step.blocked_by.len()
            || step
                .blocked_by
                .iter()
                .any(|key| key == &step.key || !keys.contains(key.as_str()))
        {
            return Err(invalid(
                "Plan prerequisite keys must name other steps exactly once",
            ));
        }
    }
    let mut complete = BTreeSet::new();
    while complete.len() < steps.len() {
        let previous = complete.len();
        for step in steps {
            if step
                .blocked_by
                .iter()
                .all(|key| complete.contains(key.as_str()))
            {
                complete.insert(step.key.as_str());
            }
        }
        if previous == complete.len() {
            return Err(invalid("Plan prerequisites contain a cycle"));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn confirm(
    connection: &Connection,
    library_id: &str,
    context: &BoundModuleContext,
    scope: &DurableMutationScope<'_>,
    operation_id: &str,
    proposal_id: &str,
    members: &[String],
    summary: &str,
    steps: &[InboxPlanStep],
    default: Option<&ProjectWorkspaceInboxExecutionSelection>,
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    let mut effects = simple_effects("inbox_confirm_plan", now);
    let ids = steps
        .iter()
        .map(|step| {
            (
                step.key.as_str(),
                stable_uuid_v7(proposal_id, "plan-page", &step.key),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for step in steps {
        let selection = match &step.agent {
            Some(agent) => AgentWorkSelection {
                instance_id: agent.instance_id.clone(),
                model: agent.model.clone(),
                effort: agent.effort.clone(),
            },
            None => {
                let model = &default
                    .ok_or_else(|| invalid("A plan requires its resolved Inbox chat default"))?
                    .model_selection;
                model.agent_selection()
            }
        };
        let home = project_home(connection, library_id, &step.project_id)?
            .ok_or_else(|| not_found("The Project has no active Database"))?;
        let destination = resolve_page_transfer_data_source_destination(
            connection,
            library_id,
            Some(&step.project_id),
            &home.data_source_id,
            &home.view_id,
            Some("plan"),
            None,
        )?;
        let page_id = &ids[step.key.as_str()];
        let document_id = stable_uuid_v7(proposal_id, "plan-document", &step.key);
        // Genesis allocates body Blocks from its operation identity, so each card needs a namespace.
        let genesis_id = stable_uuid_v7(operation_id, "plan-step", &step.key);
        let created = crate::library::page_genesis::create_page_in_data_source(
            connection,
            crate::library::page_genesis::PageGenesisInput {
                context,
                commit_context: scope.evidence(),
                library_id,
                actor_project_id: Some(&step.project_id),
                operation_id: &genesis_id,
                store_epoch: scope.store_epoch(),
                page_id,
                document_id: &document_id,
                title_markdown: &title_markdown(&step.title),
                markdown: &step.body,
                now,
            },
            &destination,
        )?;
        crate::library::members::initialize_owner(
            connection,
            context,
            page_id,
            members.first().map(String::as_str),
        )?;
        crate::library::initialize_agent_work(connection, context, page_id, &selection, now)?;
        effects.project_ids.push(step.project_id.clone());
        effects.page_ids.push(page_id.clone());
        effects.block_ids.push(page_id.clone());
        effects.block_ids.extend(created.page_create.block_ids);
        effects.document_ids.push(document_id);
        effects.document_heads.push(created.document_head);
        effects.database_ids.push(home.database_id);
        effects.data_source_ids.push(home.data_source_id);
        effects.view_ids.extend(created.affected_view_ids);
    }
    for step in steps {
        let blockers = step
            .blocked_by
            .iter()
            .map(|key| ids[key.as_str()].clone())
            .collect::<Vec<_>>();
        crate::database::work_graph::initialize_prerequisites(
            connection,
            library_id,
            &ids[step.key.as_str()],
            &blockers,
            now,
        )?;
    }
    crate::database::work_graph::validate_graph(connection, StoreErrorCode::InvalidInput)?;
    let page_ids = steps
        .iter()
        .map(|step| ids[step.key.as_str()].clone())
        .collect::<Vec<_>>();
    connection.execute(
        "INSERT INTO inbox_plan_results(proposal_id,operation_id,page_ids_json) VALUES (?1,?2,?3)",
        params![
            proposal_id,
            operation_id,
            serde_json::to_string(&page_ids).map_err(|_| internal("Plan result cannot encode"))?
        ],
    )?;
    super::reliable::supersede_requests(connection, members, now)?;
    let action = ProjectWorkspaceInboxDispatchAction::Plan {
        summary: summary.to_owned(),
        steps: steps.to_vec(),
    };
    finish_proposal(connection, proposal_id, &action_json(&action)?, now)?;
    connection.execute(
        "UPDATE inbox_proposals SET summary=?2 WHERE proposal_id=?1",
        params![proposal_id, format!("Planned {} cards", steps.len())],
    )?;
    set_entries_state(connection, library_id, members, "done", now)?;
    for page in members {
        connection.execute("UPDATE inbox_entries SET suggestion_state='settled',suggestion_request_id=NULL,suggestion_error=NULL WHERE page_id=?1",[page])?;
    }
    effects.page_ids.extend_from_slice(members);
    effects.project_ids.sort();
    effects.project_ids.dedup();
    Ok(effects)
}
