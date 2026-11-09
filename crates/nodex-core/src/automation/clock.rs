//! Clock occurrences are immutable evidence; decisions own admission and retries.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::automation::{Automation, AutomationMode};
use rusqlite::{Connection, OptionalExtension, params};

pub(super) fn record_occurrence(
    connection: &Connection,
    automation: &Automation,
    dispatch: &str,
    due: i64,
    now: i64,
) -> Result<(), StoreError> {
    let existing: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM automation_decisions WHERE dispatch_id=?1)",
        [dispatch],
        |r| r.get(0),
    )?;
    if existing {
        connection.execute("UPDATE automation_decisions SET status='admitted',updated_at_ms=?2 WHERE dispatch_id=?1 AND status='failed'",params![dispatch,now])?;
        return Ok(());
    }
    let revision: i64 = connection.query_row(
        "SELECT schedule_revision FROM automations WHERE automation_id=?1",
        [&automation.automation_id],
        |r| r.get(0),
    )?;
    let key = format!("clock:{}:{revision}:{due}", automation.automation_id);
    connection.execute("INSERT OR IGNORE INTO automation_clock_triggers(id,automation_id,schedule_revision,due_at_ms,received_at_ms,semantic_key) VALUES(?1,?2,?3,?4,?5,?1)",params![key,automation.automation_id,revision,due,now])?;
    if automation.mode == AutomationMode::AskFirst {
        // The Hold transaction attaches evidence to the one waiting decision.
        return Ok(());
    }
    record_decision(
        connection,
        automation,
        DecisionRecord {
            dispatch,
            due,
            now,
            reason: "Clock condition matched",
            completed: automation.mode == AutomationMode::DryRun,
    )?;
    connection.execute(
        "INSERT OR IGNORE INTO automation_decision_triggers(dispatch_id,trigger_id) VALUES(?1,?2)",
        params![dispatch, key],
    )?;
    Ok(())
}
/// One decision an Automation records: when it was due and decided, why, and whether it
/// settled at once (a dry run or an unavailable Owner) instead of waiting to run.
struct DecisionRecord<'a> {
    dispatch: &'a str,
    due: i64,
    now: i64,
    reason: &'a str,
    completed: bool,
fn record_decision(
    connection: &Connection,
    automation: &Automation,
    decision: DecisionRecord<'_>,
) -> Result<(), StoreError> {
    let DecisionRecord {
        dispatch,
    let frozen = serde_json::to_string(automation)
        .map_err(|_| invalid("Automation action cannot be frozen"))?;
    let authority = serde_json::json!({"owner_member_id":automation.owner_member_id,"mode":automation.mode,"automation_revision":automation.automation_revision});
    Ok(())
}
pub(super) fn record_manual(
    connection: &Connection,
    automation: &Automation,
    dispatch: &str,
    now: i64,
) -> Result<(), StoreError> {
    record_decision(
        connection,
        automation,
        DecisionRecord {
            dispatch,
            due: now,
            now,
            reason: "Manual run",
            completed: automation.mode == AutomationMode::DryRun,
    )?;
    if automation.mode != AutomationMode::DryRun {
        connection.execute("UPDATE automation_decisions SET due_at_ms=?2,admitted_at_ms=?2,admission_prompt=?3 WHERE dispatch_id=?1 AND status='admitted'",params![dispatch,now,automation.prompt])?;
    }
    Ok(())
}
pub(crate) fn attach_hold(
    connection: &Connection,
    dispatch: &str,
    automation: &Automation,
    due: i64,
) -> Result<(), StoreError> {
    let frozen = serde_json::to_string(automation)
        .map_err(|_| invalid("Automation action cannot be frozen"))?;
    connection.execute("UPDATE automation_decisions SET automation_revision=?2,mode='ask_first',frozen_action_json=?3,frozen_authority_json=?4,automation_name=CASE WHEN automation_name='' THEN ?5 ELSE automation_name END WHERE dispatch_id=?1 AND frozen_action_json='{}'",params![dispatch,automation.automation_revision,frozen,serde_json::json!({"owner_member_id":automation.owner_member_id,"mode":automation.mode,"automation_revision":automation.automation_revision}).to_string(),automation.name])?;
    let revision: i64 = connection.query_row(
        "SELECT schedule_revision FROM automations WHERE automation_id=?1",
        [&automation.automation_id],
        |r| r.get(0),
    )?;
    let key = format!("clock:{}:{revision}:{due}", automation.automation_id);
    connection.execute("INSERT OR IGNORE INTO automation_decision_triggers(dispatch_id,trigger_id) SELECT ?1,id FROM automation_clock_triggers WHERE semantic_key=?2",params![dispatch,key])?;
    Ok(())
}
pub(crate) fn execution_automation(
    connection: &Connection,
    dispatch: &str,
) -> Result<Option<Box<Automation>>, StoreError> {
    let value: Option<String> = connection
        .query_row(
            "SELECT frozen_action_json FROM automation_decisions WHERE dispatch_id=?1",
            [dispatch],
            |r| r.get(0),
        )
        .optional()?;
    value
        .filter(|v| v != "{}")
        .map(|v| {
            serde_json::from_str::<Automation>(&v)
                .map(Box::new)
                .map_err(|_| invalid("Frozen Automation action is invalid"))
        })
        .transpose()
}
pub(crate) fn backfill_snapshots(connection: &Connection) -> Result<(), StoreError> {
    let history=connection.prepare("SELECT run.run_id,run.automation_id,run.dispatch_id,run.status,run.created_at FROM automation_execution_runs run WHERE run.dispatch_id IS NULL OR NOT EXISTS(SELECT 1 FROM automation_decisions decision WHERE decision.dispatch_id=run.dispatch_id) ORDER BY run.run_id")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (run, id, dispatch, status, created) in history {
        let Some(automation) = super::read::read_definition(connection, &id)? else {
            continue;
        };
        let dispatch = dispatch.unwrap_or_else(|| {
            format!(
                "automation-history:{}",
                crate::document::sha256(run.as_bytes())
            )
        });
        record_decision(
            connection,
            &automation,
            DecisionRecord {
                dispatch: &dispatch,
                due: created,
                now: created,
                reason: "Retained execution",
                completed: status != "IN_PROGRESS",
        )?;
        connection.execute(
            "UPDATE automation_execution_runs SET dispatch_id=?2 WHERE run_id=?1 AND dispatch_id IS NULL",
            params![run, dispatch],
        )?;
    }
    let ids = connection
        .prepare("SELECT dispatch_id,automation_id FROM automation_decisions ORDER BY dispatch_id")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (dispatch, id) in ids {
        let Some(mut automation) = super::read::read_definition(connection, &id)? else {
            continue;
        };
        let (revision,prompt,agent):(i64,Option<String>,Option<String>)=connection.query_row("SELECT automation_revision,admission_prompt,admission_agent_json FROM automation_decisions WHERE dispatch_id=?1",[&dispatch],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        if let Some(prompt) = prompt {
            automation.prompt = prompt;
        }
        let mut frozen = serde_json::to_value(&automation)
            .map_err(|_| invalid("Automation action cannot be frozen"))?;
        frozen["snapshot_provenance"] = serde_json::json!("retained_definition");
        frozen["configuration_revision"] = serde_json::json!(automation.automation_revision);
        if let Some(agent) = agent {
            frozen["admission_agent"] = serde_json::from_str(&agent)
                .map_err(|_| invalid("Reviewed Automation Agent is invalid"))?;
        }
        let authority = serde_json::json!({"owner_member_id":automation.owner_member_id,"mode":automation.mode,"automation_revision":revision,"configuration_revision":automation.automation_revision,"snapshot_provenance":"retained_definition"});
        connection.execute(
            "UPDATE automation_decisions SET automation_name=?2 WHERE dispatch_id=?1 AND automation_name=''",
            params![dispatch, automation.name],
        )?;
        connection.execute("UPDATE automation_decisions SET frozen_action_json=?2,frozen_authority_json=?3 WHERE dispatch_id=?1",params![dispatch,frozen.to_string(),authority.to_string()])?;
    }
    let runs=connection.prepare("SELECT run_id,automation_id,dispatch_id FROM automation_execution_runs WHERE dispatch_id IS NOT NULL AND message_id IS NULL ORDER BY run_id")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (run, id, dispatch) in runs {
        let Some(automation) = execution_automation(connection, &dispatch)? else {
            continue;
        };
        for slot in 0..128 {
            let ids = serde_json::json!([id, dispatch, slot]);
            if stable_execution_identity("run", &ids) != run {
                continue;
            }
            let message = if automation.kind
                == nodex_core_contracts::automation::AutomationExecutionKind::Heartbeat
            {
                stable_execution_identity("heartbeat", &serde_json::json!([id, dispatch]))
            } else {
                stable_execution_identity("message", &ids)
            };
            connection.execute("UPDATE automation_execution_runs SET message_id=?2,notification_policy=?3 WHERE run_id=?1",params![run,message,automation.notification_policy.map(|_|"failed_runs_only")])?;
            break;
        }
    }
    Ok(())
}
pub(crate) fn stable_execution_identity(kind: &str, value: &serde_json::Value) -> String {
    format!(
        "automation:{kind}:{}",
        crate::document::sha256(value.to_string().as_bytes())
    )
}
fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

pub(crate) fn agent_selection(
    automation: &Automation,
) -> Result<nodex_core_contracts::library::AgentWorkSelection, StoreError> {
    use base64::Engine;
    use nodex_core_contracts::agent::AgentBackendBinding;
    use sha2::{Digest, Sha256};
    let instance_id = match &automation.backend_binding {
        AgentBackendBinding::Codex => "codex".to_owned(),
        binding => {
            let (kind, id) = match binding {
                AgentBackendBinding::Claude { instance_config_id } => {
                    ("claude", instance_config_id)
                }
                AgentBackendBinding::OpenCode { instance_config_id } => {
                    ("opencode", instance_config_id)
                }
                AgentBackendBinding::Acp {
                    instance_config_id: Some(id),
                    ..
                } => ("acp", id),
                _ => return Err(invalid("Automation Agent instance is unavailable")),
            };
            let identity = serde_json::to_vec(&(kind, id))
                .map_err(|_| invalid("Automation Agent identity is invalid"))?;
            format!(
                "{kind}_{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(identity))
            )
        }
    };
    Ok(nodex_core_contracts::library::AgentWorkSelection {
        instance_id,
        model: automation
            .model
            .clone()
            .ok_or_else(|| invalid("A new-chat Automation needs a model"))?,
        effort: automation.reasoning_effort.clone(),
    })
}

pub(super) fn require_owner_available(
    connection: &Connection,
    automation: &Automation,
) -> Result<(), StoreError> {
    let active: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM members WHERE id=?1 AND lifecycle='active')",
        [&automation.owner_member_id],
        |r| r.get(0),
    )?;
    if active {
        return Ok(());
    }
    Err(StoreError::new(
        StoreErrorCode::Unauthorized,
        "This Automation's Owner is unavailable",
        false,
    ))
}
pub(super) fn record_unavailable_owner(
    connection: &Connection,
    automation: &Automation,
    dispatch: &str,
    due: i64,
    now: i64,
) -> Result<(), StoreError> {
    record_decision(
        connection,
        automation,
        DecisionRecord {
            dispatch,
            due,
            now,
            reason: "Automation Owner is unavailable",
            completed: true,
    )?;
    connection.execute(
        "UPDATE automation_decisions SET status='skipped' WHERE dispatch_id=?1",
        [dispatch],
    )?;
    Ok(())
}
