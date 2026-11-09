//! Event proposals share ordinary intake Pages and the Page-start owner.
use super::*;
use nodex_core_contracts::{automation::*, automation_assessment::*};
use serde_json::json;

pub(in crate::workspace) fn is_event(c: &Connection, dispatch: &str) -> Result<bool, StoreError> {
    Ok(c.query_row(
        "SELECT assessment_json IS NOT NULL FROM automation_decisions WHERE dispatch_id=?1",
        [dispatch],
        |r| r.get(0),
    )
    .optional()?
    .unwrap_or(false))
}
fn decision_id(r: &AutomationAssessmentRequest, id: &str) -> String {
    stable_uuid_v7(
        "automation-assessment-decision",
        &r.request_id,
        &format!("{}:{id}", r.generation),
    )
}
fn same_execution_context(a: &Automation, b: &Automation) -> bool {
    a.cwds == b.cwds
        && a.execution_environment == b.execution_environment
        && a.local_environment_config_path == b.local_environment_config_path
        && a.runbook_page_id == b.runbook_page_id
        && a.service_tier == b.service_tier
}
fn effective_mode(automations: &[&Automation], conflicting: bool) -> AutomationMode {
    if automations.iter().all(|r| r.mode == AutomationMode::DryRun) {
        return AutomationMode::DryRun;
    }
    if conflicting
        || automations
            .iter()
            .any(|r| r.mode == AutomationMode::AskFirst)
    {
        return AutomationMode::AskFirst;
    }
    AutomationMode::Run
}
#[allow(clippy::too_many_arguments)]
pub(in crate::workspace) fn admit(
    c: &Connection,
    library: &str,
    context: &BoundModuleContext,
    epoch: &str,
    operation: &str,
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    r: &AutomationAssessmentRequest,
    assessments: &[AutomationAssessment],
    actions: &[AutomationProposedAction],
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    let at: i64 = c.query_row(
        "SELECT CAST(unixepoch(?1,'subsec')*1000 AS INTEGER)",
        [now],
        |row| row.get(0),
    )?;
    let mut effects = simple_effects("inbox_automation_assessment", now);
    for a in assessments {
        let automation = r
            .automations
            .iter()
            .find(|v| v.automation_id == a.automation_id)
            .ok_or_else(|| invalid("Unknown Automation"))?;
        let id = decision_id(r, &a.automation_id);
        let audit = json!({"request_id":r.request_id,"generation":r.generation,"thread_id":r.thread_id,"matched":a.matched,"evidence_ids":a.evidence_ids});
        c.execute("INSERT INTO automation_decisions(dispatch_id,automation_id,automation_name,status,automation_revision,mode,reason,frozen_action_json,frozen_authority_json,first_scheduled_for_ms,last_scheduled_for_ms,hold_basis_json,created_at_ms,updated_at_ms,assessment_json) VALUES(?1,?2,?3,'completed',?4,?5,?6,?7,?8,?9,?9,'{}',?9,?9,?10)",params![id,automation.automation_id,automation.name,automation.automation_revision,mode_text(automation.mode),a.reason,serde_json::to_string(automation).map_err(|_|invalid("Invalid Automation"))?,json!({"owner_member_id":automation.owner_member_id,"mode":automation.mode,"automation_revision":automation.automation_revision}).to_string(),at,audit.to_string()])?;
        for trigger in &r.trigger_ids {
            c.execute(
                "INSERT INTO automation_decision_source_triggers(dispatch_id,trigger_id) VALUES(?1,?2)",
                params![id, trigger],
            )?;
        }
    }
    crate::automation::firing::record_automation_changes(
        scope,
        context,
        operation,
        &r.automations
            .iter()
            .map(|automation| automation.automation_id.clone())
            .collect::<Vec<_>>(),
    )?;
    // Equivalent proposals share one action. Dry run contributors never strengthen a grant.
    let mut groups: Vec<(AutomationProposedAction, Vec<String>, &Automation)> = Vec::new();
    for (action, id) in actions
        .iter()
        .flat_map(|action| action.automation_ids.iter().map(move |id| (action, id)))
    {
        let automation = r
            .automations
            .iter()
            .find(|automation| &automation.automation_id == id)
            .ok_or_else(|| invalid("Unknown Automation"))?;
        let mut canonical = action.clone();
        canonical.automation_ids.clear();
        if let Some((_, ids, _)) = groups.iter_mut().find(|(value, _, target)| {
            value == &canonical && same_execution_context(target, automation)
        }) {
            ids.push(id.clone());
        } else {
            groups.push((canonical, vec![id.clone()], automation));
        }
    }
    let conflicting = groups
        .iter()
        .filter(|(_, ids, _)| {
            ids.iter().any(|id| {
                r.automations.iter().any(|automation| {
                    automation.automation_id == *id && automation.mode != AutomationMode::DryRun
                })
            })
        })
        .count()
        > 1;
    for (action, mut ids, _) in groups {
        ids.sort_unstable();
        ids.dedup();
        let automations = ids
            .iter()
            .map(|id| {
                r.automations
                    .iter()
                    .find(|v| v.automation_id == *id)
                    .ok_or_else(|| invalid("Unknown Automation"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let active = automations
            .iter()
            .copied()
            .filter(|r| r.mode != AutomationMode::DryRun)
            .collect::<Vec<_>>();
        let owners = active
            .iter()
            .map(|r| r.owner_member_id.as_str())
            .collect::<BTreeSet<_>>();
        let mode = if owners.len() > 1 {
            AutomationMode::AskFirst
        } else {
            effective_mode(&automations, conflicting)
        };
        let leader = active.first().copied().unwrap_or(automations[0]);
        let dispatch = decision_id(r, &leader.automation_id);
        for automation in &automations {
            c.execute("UPDATE automation_decisions SET assessment_json=json_set(assessment_json,'$.action',json(?2),'$.contributing_automation_ids',json(?3),'$.action_decision_id',?4,'$.admission_mode',?5) WHERE dispatch_id=?1",params![decision_id(r,&automation.automation_id),serde_json::to_string(&action).map_err(|_|invalid("Invalid action"))?,serde_json::to_string(&ids).unwrap(),dispatch,mode_text(mode)])?;
        }
        if mode == AutomationMode::DryRun {
            continue;
        }
        let AutomationActionScope::Project { project_id } = &action.scope;
        let page = stable_uuid_v7("automation-assessment-page", &dispatch, "page");
        let document = stable_uuid_v7("automation-assessment-page", &dispatch, "document");
        let captured = capture_message_in_scope(
            c,
            library,
            context,
            epoch,
            &stable_uuid_v7(operation, "automation-action", &dispatch),
            scope,
            &page,
            &document,
            &MessagePage {
                title_markdown: title_markdown(&normalize_given_title(&action.title)?),
                body_markdown: text_paragraphs_markdown(&action.body),
                provisional_title: None,
            },
            &EntrySource {
                kind: "automation",
                automation_id: Some(leader.automation_id.clone()),
                dispatch_id: Some(dispatch.clone()),
                project_id: Some(project_id.clone()),
                label: Some(leader.name.clone()),
                ..Default::default()
            },
            Some(project_id),
            now,
        )?;
        merge(&mut effects, captured);
        crate::library::members::initialize_automation_work(
            c,
            library,
            &page,
            &leader.owner_member_id,
            &action.execution_target,
            now,
        )?;
        let pages = [page.clone()];
        let basis = current_basis(c, &pages)?;
        c.execute("UPDATE automation_decisions SET page_id=?2,inbox_project_id=?3,status=?4,waiting_in_inbox=?5,hold_basis_json=?6,mode=?7 WHERE dispatch_id=?1",params![dispatch,page,project_id,if mode==AutomationMode::AskFirst{"held"}else{"admitted"},mode==AutomationMode::AskFirst,serde_json::to_string(&basis[0]).unwrap(),mode_text(mode)])?;
        if mode == AutomationMode::AskFirst {
            insert_proposal(
                c,
                library,
                NewProposal {
                    proposal_id: &stable_uuid_v7(
                        "automation-assessment-proposal",
                        &dispatch,
                        "proposal",
                    ),
                    origin: ProjectWorkspaceInboxProposalOrigin::Automation,
                    page_ids: &pages,
                    basis: &basis,
                    action: &ProjectWorkspaceInboxDispatchAction::ExecuteDecision {
                        decision_id: dispatch.clone(),
                        agent: None,
                    },
                    entry_kind: Some(ProjectWorkspaceInboxEntryKind::Todo),
                    summary: &action.title,
                    rationale: None,
                    produced_by: None,
                },
                now,
            )?;
            continue;
        }
        merge(
            &mut effects,
            start(
                c,
                library,
                context,
                scope.evidence(),
                operation,
                &dispatch,
                &page,
                &action,
                &leader.owner_member_id,
                now,
            )?,
        );
    }
    Ok(effects)
}
fn mode_text(mode: AutomationMode) -> &'static str {
    match mode {
        AutomationMode::DryRun => "dry_run",
        AutomationMode::AskFirst => "ask_first",
        AutomationMode::Run => "run",
    }
}
fn merge(e: &mut WorkspaceMutationEffects, other: WorkspaceMutationEffects) {
    e.page_ids.extend(other.page_ids);
    e.block_ids.extend(other.block_ids);
    e.document_ids.extend(other.document_ids);
    e.document_heads.extend(other.document_heads);
    e.database_ids.extend(other.database_ids);
    e.data_source_ids.extend(other.data_source_ids);
    e.view_ids.extend(other.view_ids);
    e.session_ids.extend(other.session_ids);
    e.session_detail_ids.extend(other.session_detail_ids);
    e.session_summary_scopes
        .extend(other.session_summary_scopes);
    e.project_ids.extend(other.project_ids);
}
#[allow(clippy::too_many_arguments)]
fn start(
    c: &Connection,
    library: &str,
    context: &BoundModuleContext,
    commit: &crate::infrastructure::local_commit::CommitContext,
    operation: &str,
    dispatch: &str,
    page: &String,
    action: &AutomationProposedAction,
    owner: &str,
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    crate::library::members::initialize_automation_work(
        c,
        library,
        page,
        owner,
        &action.execution_target,
        now,
    )?;
    let thread = super::super::thread_follows::thread(c, library, &action.thread_id)?;
    super::super::thread_follows::add_follow(
        c,
        library,
        page,
        &thread,
        "origin",
        "automation",
        now,
    )?;
    let session = stable_uuid_v7("automation-page-start", dispatch, "session");
    let launch = stable_uuid_v7("automation-page-start", dispatch, "launch");
    let message = stable_uuid_v7("automation-page-start", dispatch, "message");
    let frozen: String = c.query_row(
        "SELECT frozen_action_json FROM automation_decisions WHERE dispatch_id=?1",
        [dispatch],
        |r| r.get(0),
    )?;
    let automation: Automation =
        serde_json::from_str(&frozen).map_err(|_| invalid("Invalid frozen Automation"))?;
    let brief = match &automation.runbook_page_id {
        Some(id) => format!(
            "{}\n\nRead and follow the runbook Page {id}. You may update it with durable findings.",
            action.body
        ),
        None => action.body.clone(),
    };
    let mut effects = super::super::page_work::prepare_start(
        c,
        context,
        commit,
        library,
        operation,
        page,
        Some(&action.execution_target),
        &session,
        &launch,
        &message,
        &brief,
        false,
        None,
        now,
    )?;
    if let Some(id) = automation.runbook_page_id {
        super::super::page_chat::validate_initial_page_ids(c, library, std::slice::from_ref(&id))?;
        super::super::page_chat::link_pages(c, &session, std::slice::from_ref(&id), now)?;
        effects.page_ids.push(id);
    }
    c.execute("UPDATE automation_decisions SET status='admitted',waiting_in_inbox=0,admitted_at_ms=CAST(unixepoch(?2,'subsec')*1000 AS INTEGER),due_at_ms=NULL WHERE dispatch_id=?1",params![dispatch,now])?;
    Ok(effects)
}
/// The waiting Automation decision a person starts: its intake Page, decision and the Agent chosen for this run.
pub(super) struct DecisionConfirmation<'a> {
    pub(super) pages: &'a [String],
    pub(super) dispatch: &'a str,
    pub(super) agent: Option<&'a ProjectWorkspaceInboxChatAgent>,
}

pub(super) fn confirm(
    c: &Connection,
    library: &str,
    context: &BoundModuleContext,
    commit: &crate::infrastructure::local_commit::CommitContext,
    operation: &str,
    decision_confirmation: DecisionConfirmation<'_>,
    now: &str,
) -> Result<WorkspaceMutationEffects, StoreError> {
    let DecisionConfirmation {
        pages,
        dispatch,
        agent,
    } = decision_confirmation;
    if pages.len() != 1 {
        return Err(invalid("Start one Automation decision at a time"));
    }
    let (automation_id, page, audit, status): (String, String, String, String) = c.query_row(
        "SELECT automation_id,page_id,assessment_json,status FROM automation_decisions WHERE dispatch_id=?1",
        [dispatch],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    if page != pages[0] || status != "held" {
        return Err(conflict("Automation decision is no longer waiting"));
    }
    let definition = crate::automation::firing::definition(c, &automation_id)?;
    scheduled::require_automation_owner(c, context, &definition)?;
    let owner:String=c.query_row("SELECT json_extract(frozen_authority_json,'$.owner_member_id') FROM automation_decisions WHERE dispatch_id=?1",[dispatch],|r|r.get(0))?;
    if definition.owner_member_id != owner {
        return Err(conflict("This Automation's Owner changed"));
    }
    c.execute("UPDATE automation_decisions SET assessment_json=json_set(assessment_json,'$.reviewed',json('true')) WHERE dispatch_id=?1",[dispatch])?;
    let audit: serde_json::Value =
        serde_json::from_str(&audit).map_err(|_| invalid("Invalid assessment"))?;
    let mut action: AutomationProposedAction = serde_json::from_value(audit["action"].clone())
        .map_err(|_| invalid("Invalid proposed action"))?;
    action.body = super::super::inbox_read::frozen_message_text(c, &page)?;
    if let Some(agent) = agent {
        action.execution_target = nodex_core_contracts::library::AgentWorkSelection {
            instance_id: agent.instance_id.clone(),
            model: agent
                .model
                .clone()
                .ok_or_else(|| invalid("Choose an exact Agent model for this decision"))?,
            effort: agent.reasoning_effort.clone(),
        };
        c.execute(
            "UPDATE automation_decisions SET admission_agent_json=?2 WHERE dispatch_id=?1",
            params![
                dispatch,
                serde_json::to_string(&action.execution_target)
                    .map_err(|_| invalid("Invalid reviewed Agent"))?
            ],
        )?;
    }
    let mut effects = start(
        c,
        library,
        context,
        commit,
        operation,
        dispatch,
        &page,
        &action,
        &definition.owner_member_id,
        now,
    )?;
    super::super::automation_assessment::flush_followed(
        c,
        library,
        context,
        operation,
        &action.thread_id,
        now,
        &mut effects,
    )?;
    Ok(effects)
}
