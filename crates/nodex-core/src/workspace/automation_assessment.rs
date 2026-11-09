//! Serialized per-thread judgement. Network, model execution, and sleeping belong to Main.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, agent::AgentTurnProvenance, automation::*,
    automation_assessment::*, sources::*, workspace::*,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::GenerationConflict, message, true)
}
fn denied() -> StoreError {
    StoreError::new(
        StoreErrorCode::Unauthorized,
        "Automation judgement belongs to the current Coordinator",
        false,
    )
}
fn encode<T: serde::Serialize>(v: &T) -> Result<String, StoreError> {
    serde_json::to_string(v).map_err(|_| invalid("Invalid assessment value"))
}
fn decode<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, StoreError> {
    serde_json::from_str(s).map_err(|_| invalid("Invalid retained assessment"))
}
fn now(c: &Connection) -> Result<i64, StoreError> {
    Ok(c.query_row(
        "SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)",
        [],
        |r| r.get(0),
    )?)
}
fn coordinator(
    c: &Connection,
    library: &str,
    context: &BoundModuleContext,
    p: &AgentTurnProvenance,
) -> Result<String, StoreError> {
    super::agent_command::admit_read_caller(c, library, context, p)?;
    let session = p
        .authority
        .runtime
        .as_ref()
        .map(|v| v.session_id.clone())
        .ok_or_else(denied)?;
    if super::coordinator::binding(c)?.as_deref() != Some(&session) {
        return Err(denied());
    }
    Ok(session)
}
pub(super) fn authorize(
    c: &Connection,
    library: &str,
    context: &BoundModuleContext,
    intent: &ProjectWorkspaceIntent,
) -> Result<(), StoreError> {
    let (command, provenance) = match intent {
        ProjectWorkspaceIntent::AutomationAssessment { command } => (command, None),
        ProjectWorkspaceIntent::AgentCommand { provenance, intent } => match intent.as_ref() {
            ProjectWorkspaceIntent::AutomationAssessment { command } => (command, Some(provenance)),
            _ => return Ok(()),
        },
        _ => return Ok(()),
    };
    if let AutomationAssessmentCommand::Submit { request_id, .. } = command {
        let session = coordinator(c, library, context, provenance.ok_or_else(denied)?)?;
        if let Some(r) = request(c, library, request_id)?
            && r.coordinator_session_id.as_deref() != Some(&session)
        {
            return Err(denied());
        }
        return Ok(());
    }
    if provenance.is_some()
        || context.agent_attribution.is_some()
        || !matches!(
            context.adapter,
            AdapterKind::ElectronHost | AdapterKind::Test
        )
    {
        return Err(denied());
    }
    Ok(())
}
fn triggers(
    c: &Connection,
    request: &str,
    generation: i64,
) -> Result<Vec<SourceTrigger>, StoreError> {
    let rows=c.prepare("SELECT t.id,t.source_id,t.received_at_ms,t.disposition,t.event_json FROM automation_assessment_triggers a JOIN source_triggers t ON t.id=a.trigger_id WHERE a.request_id=?1 AND a.generation=?2 ORDER BY t.id LIMIT 100")?.query_map(params![request,generation],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, source_id, received_at_ms, disposition, event)| {
            Ok(SourceTrigger {
                id,
                source_id,
                received_at_ms,
                disposition,
                event: decode(&event)?,
            })
        })
        .collect()
}
fn applicable(
    c: &Connection,
    library: &str,
    thread: &ExternalThread,
    events: &[SourceTrigger],
) -> Result<Vec<Automation>, StoreError> {
    let ids=c.prepare("SELECT r.automation_id FROM automations r JOIN automation_event_filters f ON f.automation_id=r.automation_id JOIN members m ON m.id=r.owner_member_id WHERE m.library_id=?1 AND m.lifecycle='active' AND r.status='ACTIVE' ORDER BY r.automation_id LIMIT 200")?.query_map([library],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut automations = Vec::new();
    for id in ids {
        let automation = crate::automation::firing::definition(c, &id)?;
        if let Some(AutomationCondition::Source { filters }) = &automation.typed_condition
            && events.iter().any(|e| {
                crate::automation::event_filter::matches(filters, &e.source_id, thread, &e.event)
            })
        {
            automations.push(automation);
        }
    }
    Ok(automations)
}
fn hash(automations: &[Automation]) -> Result<String, StoreError> {
    let policy=automations.iter().map(|r|json!({"automation_id":r.automation_id,"revision":r.automation_revision,"owner":r.owner_member_id,"condition":r.condition_text,"action":r.prompt,"mode":r.mode,"filter":r.typed_condition,"scope":r.scope,"project":r.project_id,"target":r.backend_binding,"model":r.model,"effort":r.reasoning_effort,"environment":r.execution_environment,"cwds":r.cwds,"runbook":r.runbook_page_id})).collect::<Vec<_>>();
    Ok(crate::document::sha256(encode(&policy)?.as_bytes()))
}
pub(crate) fn refresh_pending(c: &Connection, library: &str) -> Result<(), StoreError> {
    let ids=c.prepare("SELECT request_id FROM automation_assessment_requests WHERE library_id=?1 AND state='pending' ORDER BY request_id LIMIT 1000")?.query_map([library],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for id in ids {
        if let Some(r) = request(c, library, &id)? {
            refresh(c, library, &r)?;
        }
    }
    Ok(())
}
pub(super) fn request(
    c: &Connection,
    library: &str,
    id: &str,
) -> Result<Option<AutomationAssessmentRequest>, StoreError> {
    let raw=c.query_row("SELECT generation,thread_id,policy_hash,automations_json,coordinator_session_id,handed_over_at_ms,run_started_at_ms FROM automation_assessment_requests WHERE request_id=?1 AND library_id=?2 AND state='pending'",params![id,library],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get::<_,String>(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
    raw.map(
        |(
            generation,
            thread_id,
            policy_hash,
            automations,
            coordinator_session_id,
            handed_over_at_ms,
            run_started_at_ms,
        )| {
            Ok(AutomationAssessmentRequest {
                request_id: id.into(),
                generation,
                thread_id,
                policy_hash,
                automations: decode(&automations)?,
                trigger_ids: triggers(c, id, generation)?
                    .into_iter()
                    .map(|t| t.id)
                    .collect(),
                coordinator_session_id,
                handed_over_at_ms,
                run_started_at_ms,
            })
        },
    )
    .transpose()
}
fn followed(c: &Connection, thread: &str) -> Result<bool, StoreError> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM page_thread_follows WHERE external_thread_id=?1)",
        [thread],
        |r| r.get(0),
    )?)
}
/// Ingestion has already excluded followed threads. New evidence cannot mutate a delivered batch.
pub(super) fn enqueue(
    c: &Connection,
    library: &str,
    trigger_id: &str,
    source: &str,
    event: &SourceTriggerInput,
) -> Result<bool, StoreError> {
    if followed(c, &event.thread_id)? {
        return Ok(false);
    }
    let thread = super::thread_follows::thread(c, library, &event.thread_id)?;
    let evidence = SourceTrigger {
        id: trigger_id.into(),
        source_id: source.into(),
        received_at_ms: now(c)?,
        disposition: "recorded".into(),
        event: event.clone(),
    };
    if applicable(c, library, &thread, std::slice::from_ref(&evidence))?.is_empty() {
        return Ok(false);
    }
    c.execute(
        "INSERT INTO automation_assessment_triggers(trigger_id,thread_id) VALUES(?1,?2)",
        params![trigger_id, event.thread_id],
    )?;
    let pending:Option<String>=c.query_row("SELECT request_id FROM automation_assessment_requests WHERE thread_id=?1 AND state='pending'",[&event.thread_id],|r|r.get(0)).optional()?;
    if let Some(id) = pending {
        let r = request(c, library, &id)?.ok_or_else(|| invalid("Missing assessment"))?;
        if r.coordinator_session_id.is_none() {
            let count:i64=c.query_row("SELECT count(*) FROM automation_assessment_triggers WHERE request_id=?1 AND generation=?2",params![id,r.generation],|r|r.get(0))?;
            if count < 100 {
                c.execute("UPDATE automation_assessment_triggers SET request_id=?1,generation=?2 WHERE trigger_id=?3",params![id,r.generation,trigger_id])?;
                refresh(c, library, &r)?;
            }
        }
        return Ok(true);
    }
    next(c, library, &event.thread_id)?;
    Ok(true)
}
/// A new origin follow receives updates that arrived while its judgement was in flight.
pub(super) fn flush_followed(
    c: &Connection,
    library: &str,
    context: &BoundModuleContext,
    operation: &str,
    thread: &str,
    at: &str,
    effects: &mut super::mutation::WorkspaceMutationEffects,
) -> Result<(), StoreError> {
    if !followed(c, thread)? {
        return Ok(());
    }
    let rows=c.prepare("SELECT t.id,t.event_json FROM automation_assessment_triggers q JOIN source_triggers t ON t.id=q.trigger_id LEFT JOIN automation_assessment_requests r ON r.request_id=q.request_id WHERE q.thread_id=?1 AND (q.request_id IS NULL OR r.state='pending') ORDER BY t.id LIMIT 2001")?.query_map([thread],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() > 2000 {
        return Err(invalid(
            "The thread update backlog exceeds one delivery batch",
        ));
    }
    for (id, event) in rows {
        super::thread_follows::ingest(
            c,
            library,
            context,
            operation,
            &id,
            &decode::<SourceTriggerInput>(&event)?,
            at,
            effects,
        )?;
        c.execute(
            "DELETE FROM automation_assessment_triggers WHERE trigger_id=?1",
            [&id],
        )?;
    }
    c.execute("UPDATE automation_assessment_requests SET state='followed',updated_at_ms=?2 WHERE thread_id=?1 AND state='pending'",params![thread,now(c)?])?;
    Ok(())
}
fn next(c: &Connection, library: &str, thread: &str) -> Result<(), StoreError> {
    if followed(c, thread)? {
        return Ok(());
    }
    let ids=c.prepare("SELECT trigger_id FROM automation_assessment_triggers WHERE thread_id=?1 AND request_id IS NULL ORDER BY trigger_id LIMIT 100")?.query_map([thread],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if ids.is_empty() {
        return Ok(());
    }
    let id = crate::domain::identity::random_uuid_v7()
        .map_err(|_| invalid("Assessment identity unavailable"))?;
    let at = now(c)?;
    c.execute("INSERT INTO automation_assessment_requests(request_id,library_id,thread_id,policy_hash,automations_json,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,'','[]',?4,?4)",params![id,library,thread,at])?;
    for trigger in ids {
        c.execute(
            "UPDATE automation_assessment_triggers SET request_id=?1,generation=1 WHERE trigger_id=?2",
            params![id, trigger],
        )?;
    }
    refresh(c, library, &request(c, library, &id)?.unwrap())?;
    Ok(())
}
/// Policy changes retire the old generation in the same transaction that requeues its evidence.
fn refresh(
    c: &Connection,
    library: &str,
    r: &AutomationAssessmentRequest,
) -> Result<bool, StoreError> {
    let thread = super::thread_follows::thread(c, library, &r.thread_id)?;
    let automations = applicable(
        c,
        library,
        &thread,
        &triggers(c, &r.request_id, r.generation)?,
    )?;
    let policy = hash(&automations)?;
    if policy == r.policy_hash {
        return Ok(false);
    }
    let generation = r.generation + i64::from(!r.policy_hash.is_empty());
    c.execute("UPDATE automation_assessment_requests SET generation=?2,policy_hash=?3,automations_json=?4,coordinator_session_id=NULL,handed_over_at_ms=NULL,run_started_at_ms=NULL,updated_at_ms=?5 WHERE request_id=?1",params![r.request_id,generation,policy,encode(&automations)?,now(c)?])?;
    c.execute(
        "UPDATE automation_assessment_triggers SET generation=?2 WHERE request_id=?1 AND generation=?3",
        params![r.request_id, generation, r.generation],
    )?;
    Ok(true)
}
fn require(
    c: &Connection,
    library: &str,
    id: &str,
    generation: i64,
) -> Result<AutomationAssessmentRequest, StoreError> {
    let r = request(c, library, id)?.ok_or_else(|| conflict("Assessment is no longer pending"))?;
    if r.generation != generation {
        return Err(conflict("Assessment generation changed"));
    }
    Ok(r)
}
fn bounded_metadata(value: &Value) -> Value {
    // Retain arbitrary provider facts without letting one long item escape the read bound.
    fn bounded(value: &Value, depth: usize) -> Value {
        if depth > 4 {
            return json!({"truncated": true});
        }
        match value {
            Value::String(text) if text.chars().count() > 4000 => cut(text),
            Value::Array(items) => {
                json!({"items": items.iter().take(100).map(|v| bounded(v, depth + 1)).collect::<Vec<_>>(), "count": items.len(), "truncated": items.len() > 100})
            }
            Value::Object(fields) => fields
                .iter()
                .take(30)
                .map(|(k, v)| (k.clone(), bounded(v, depth + 1)))
                .collect(),
            _ => value.clone(),
        }
    }
    let result = bounded(value, 0);
    let encoded = serde_json::to_string(&result).unwrap_or_default();
    if encoded.len() > 32768 {
        return cut(&serde_json::to_string(value).unwrap_or_default());
    }
    result
}
fn cut(s: &str) -> Value {
    let text = s.chars().take(4000).collect::<String>();
    json!({"text":text,"chars":s.chars().count(),"truncated":text.len()<s.len()})
}
pub(super) fn read(
    c: &Connection,
    context: &BoundModuleContext,
    library: &str,
    read: AutomationAssessmentRead,
) -> Result<AutomationAssessmentReadValue, StoreError> {
    match read {
        AutomationAssessmentRead::LaunchAuthority { decision_id } => {
            if !matches!(
                context.adapter,
                AdapterKind::ElectronHost | AdapterKind::Test
            ) || context.agent_attribution.is_some()
            {
                return Err(denied());
            }
            let raw:Option<(String,String,String)>=c.query_row("SELECT assessment_json,frozen_authority_json,frozen_action_json FROM automation_decisions WHERE dispatch_id=?1 AND status='admitted'",[&decision_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let Some((audit, authority, target)) = raw else {
                return Ok(AutomationAssessmentReadValue::LaunchAuthority {
                    valid: false,
                    target: None,
                });
            };
            let audit: Value = decode(&audit)?;
            let authority: Value = decode(&authority)?;
            let active:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM members WHERE id=?1 AND library_id=?2 AND lifecycle='active')",params![authority["owner_member_id"].as_str(),library],|r|r.get(0))?;
            if !active {
                return Ok(AutomationAssessmentReadValue::LaunchAuthority {
                    valid: false,
                    target: None,
                });
            }
            if audit["reviewed"] == true {
                return Ok(AutomationAssessmentReadValue::LaunchAuthority {
                    valid: true,
                    target: Some(Box::new(decode(&target)?)),
                });
            }
            let valid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM automation_decisions d JOIN automations r ON r.automation_id=d.automation_id JOIN members m ON m.id=r.owner_member_id WHERE d.dispatch_id=?1 AND r.status='ACTIVE' AND r.mode='run' AND r.automation_revision=d.automation_revision AND r.owner_member_id=json_extract(d.frozen_authority_json,'$.owner_member_id') AND m.library_id=?2 AND m.lifecycle='active')",params![decision_id,library],|r|r.get(0))?;
            Ok(AutomationAssessmentReadValue::LaunchAuthority {
                valid,
                target: if valid {
                    Some(Box::new(decode(&target)?))
                } else {
                    None
                },
            })
        }

        AutomationAssessmentRead::Pending { limit } => {
            if !(1..=8).contains(&limit)
                || !matches!(
                    context.adapter,
                    AdapterKind::ElectronHost | AdapterKind::Test
                )
                || context.agent_attribution.is_some()
            {
                return Err(denied());
            }
            let ids=c.prepare("SELECT request_id FROM automation_assessment_requests WHERE library_id=?1 AND state='pending' ORDER BY created_at_ms,request_id LIMIT ?2")?.query_map(params![library,limit],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut requests = Vec::new();
            let mut bytes = 0;
            for id in ids {
                let Some(request) = request(c, library, &id)? else {
                    continue;
                };
                let size = encode(&request)?.len();
                if bytes + size > 12 * 1024 * 1024 && !requests.is_empty() {
                    break;
                }
                bytes += size;
                requests.push(request);
            }
            Ok(AutomationAssessmentReadValue::Pending { requests })
        }
        AutomationAssessmentRead::Request { request_id } => {
            if !matches!(
                context.adapter,
                AdapterKind::ElectronHost | AdapterKind::Test
            ) || context.agent_attribution.is_some()
            {
                return Err(denied());
            }
            Ok(AutomationAssessmentReadValue::Request {
                request: request(c, library, &request_id)?,
            })
        }
        AutomationAssessmentRead::Resource {
            request_id,
            generation,
            resource,
            cursor,
            provenance,
        } => {
            let session = coordinator(c, library, context, &provenance)?;
            let r = require(c, library, &request_id, generation)?;
            if r.coordinator_session_id.as_deref() != Some(&session) {
                return Err(denied());
            }
            let offset = cursor
                .as_deref()
                .unwrap_or("0")
                .parse::<usize>()
                .map_err(|_| invalid("Invalid assessment cursor"))?;
            if offset > 10000 {
                return Err(invalid("Assessment read limit exceeded"));
            }
            let events = triggers(c, &request_id, generation)?;
            let items:Vec<Value>=match resource {
                AutomationAssessmentResource::Automations=>r.automations.iter().map(|automation|json!({"automation_id":automation.automation_id,"revision":automation.automation_revision,"condition":automation.condition_text,"action":automation.prompt,"mode":automation.mode,"scope":automation.scope,"execution_project_id":automation.project_id,"execution_target":crate::automation::clock::agent_selection(automation).ok()})).collect(),
                AutomationAssessmentResource::Triggers=>events.iter().map(|t|json!({"id":t.id,"kind":t.event.kind,"actor":t.event.actor_login,"actor_class":t.event.actor_class,"at_ms":t.event.occurred_at_ms,"content":cut(t.event.text.as_deref().unwrap_or("")),"metadata":bounded_metadata(&t.event.metadata)})).collect(),
                AutomationAssessmentResource::Thread=>{
                    let first=events.first().map(|e|e.id.as_str()).unwrap_or("");let last=events.last().map(|e|e.id.as_str()).unwrap_or("");
                    let rows=c.prepare("SELECT id,event_json FROM source_triggers WHERE id IN (SELECT t.id FROM source_triggers t JOIN trigger_threads l ON l.trigger_id=t.id WHERE l.thread_id=?1 ORDER BY t.id LIMIT 5) OR id IN (SELECT t.id FROM source_triggers t JOIN trigger_threads l ON l.trigger_id=t.id WHERE l.thread_id=?1 AND t.id<=?2 ORDER BY t.id DESC LIMIT 5) OR id IN (SELECT t.id FROM source_triggers t JOIN trigger_threads l ON l.trigger_id=t.id WHERE l.thread_id=?1 AND t.id>=?3 ORDER BY t.id LIMIT 5) ORDER BY id")?.query_map(params![r.thread_id,first,last],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                    rows.into_iter().map(|(id,raw)|{let e:SourceTriggerInput=decode(&raw)?;Ok(json!({"id":id,"actor":e.actor_login,"actor_class":e.actor_class,"kind":e.kind,"content":cut(e.text.as_deref().unwrap_or(""))}))}).collect::<Result<_,StoreError>>()?
                }
                AutomationAssessmentResource::Pages|AutomationAssessmentResource::Follows=>{
                    let related=matches!(resource,AutomationAssessmentResource::Pages);
                    c.prepare("SELECT b.id,substr(m.title,1,512),b.lifecycle,f.role,json_extract(m.database_values_json,'$.status'),substr(m.description_preview,1,4000),m.description_length FROM blocks b JOIN pages p ON p.block_id=b.id LEFT JOIN page_read_model m ON m.page_block_id=b.id LEFT JOIN page_thread_follows f ON f.page_id=b.id AND f.external_thread_id=?1 WHERE b.library_id=?2 AND (f.external_thread_id IS NOT NULL OR (?3 AND (b.id IN(SELECT page_id FROM automation_decisions WHERE json_extract(assessment_json,'$.thread_id')=?1) OR b.id IN(SELECT page_id FROM github_entry_provenance WHERE json_extract(provenance_json,'$.external_thread_id')=?1)))) ORDER BY b.id LIMIT 100")?.query_map(params![r.thread_id,library,related],|row|Ok(json!({"page_id":row.get::<_,String>(0)?,"title":row.get::<_,Option<String>>(1)?,"lifecycle":row.get::<_,String>(2)?,"role":row.get::<_,Option<String>>(3)?,"status":row.get::<_,Option<String>>(4)?,"body_preview":row.get::<_,Option<String>>(5)?,"body_chars":row.get::<_,Option<i64>>(6)?})))?.collect::<rusqlite::Result<Vec<_>>>()?
                }
                AutomationAssessmentResource::Decisions=>c.prepare("SELECT d.dispatch_id,d.automation_id,d.reason,d.assessment_json,d.page_id,d.status,d.mode FROM automation_decisions d WHERE json_extract(d.assessment_json,'$.thread_id')=?1 ORDER BY d.created_at_ms DESC,d.dispatch_id LIMIT 100")?.query_map([&r.thread_id],|row|Ok(json!({"decision_id":row.get::<_,String>(0)?,"automation_id":row.get::<_,String>(1)?,"reason":row.get::<_,String>(2)?,"assessment":row.get::<_,String>(3)?,"page_id":row.get::<_,Option<String>>(4)?,"status":row.get::<_,String>(5)?,"mode":row.get::<_,String>(6)?})))?.collect::<rusqlite::Result<Vec<_>>>()?,
            };
            let page = items
                .iter()
                .skip(offset)
                .take(5)
                .cloned()
                .collect::<Vec<_>>();
            let thread = super::thread_follows::thread(c, library, &r.thread_id)?;
            // Polling checkpoints are internal state, not assessment evidence.
            let thread = json!({"id":thread.id,"host":thread.host,"repository_id":thread.repository_id,"repository":thread.repository,"number":thread.number,"kind":thread.kind,"url":thread.url,"title":cut(&thread.title),"state":thread.state,"draft":thread.draft,"head":thread.head});
            Ok(AutomationAssessmentReadValue::Resource {
                next_cursor: (offset + page.len() < items.len())
                    .then(|| (offset + page.len()).to_string()),
                value: json!({"request_id":request_id,"generation":generation,"policy_hash":r.policy_hash,"thread":thread,"items":page,"retained_evidence_only":true}),
            })
        }
    }
}
#[allow(clippy::too_many_arguments)]
pub(super) fn apply(
    c: &Connection,
    context: &BoundModuleContext,
    library: &str,
    epoch: &str,
    operation: &str,
    request_hash: &str,
    command: &AutomationAssessmentCommand,
) -> Result<super::ProjectWorkspaceApplyOutcome, StoreError> {
    let (id, generation) = match command {
        AutomationAssessmentCommand::Begin {
            request_id,
            generation,
            ..
        }
        | AutomationAssessmentCommand::StartRun {
            request_id,
            generation,
            ..
        }
        | AutomationAssessmentCommand::Fail {
            request_id,
            generation,
            ..
        }
        | AutomationAssessmentCommand::Submit {
            request_id,
            generation,
            ..
        } => (request_id, *generation),
    };
    let r = require(c, library, id, generation)?;
    let at = super::session_mutation::sqlite_now(c)?;
    super::mutation::run_mutation(c, context, epoch, operation, request_hash, &at, |scope| {
        let mut effects = super::inbox::simple_effects("inbox_automation_assessment", &at);
        if followed(c, &r.thread_id)? {
            flush_followed(
                c,
                library,
                context,
                operation,
                &r.thread_id,
                &at,
                &mut effects,
            )?;
            return Ok(effects);
        }
        match command {
            AutomationAssessmentCommand::Begin {
                coordinator_session_id,
                ..
            } => {
                if refresh(c, library, &r)? {
                    return Ok(effects);
                }
                if super::coordinator::binding(c)?.as_deref() != Some(coordinator_session_id)
                    || r.coordinator_session_id
                        .as_ref()
                        .is_some_and(|id| id != coordinator_session_id)
                {
                    return Err(denied());
                }
                c.execute("UPDATE automation_assessment_requests SET coordinator_session_id=?2,handed_over_at_ms=COALESCE(handed_over_at_ms,?3) WHERE request_id=?1",params![id,coordinator_session_id,now(c)?])?;
            }
            AutomationAssessmentCommand::StartRun {
                coordinator_session_id,
                started_at_ms,
                ..
            } => {
                if r.coordinator_session_id.as_ref() != Some(coordinator_session_id)
                    || *started_at_ms < 0
                    || *started_at_ms > now(c)? + 5000
                {
                    return Err(invalid("Invalid carrying Run"));
                }
                c.execute("UPDATE automation_assessment_requests SET run_started_at_ms=COALESCE(run_started_at_ms,?2) WHERE request_id=?1",params![id,started_at_ms])?;
            }
            AutomationAssessmentCommand::Fail { reason, .. } => {
                if reason.trim().is_empty() || reason.len() > 2000 {
                    return Err(invalid("Invalid assessment failure"));
                }
                let failed = r
                    .automations
                    .iter()
                    .map(|automation| AutomationAssessment {
                        automation_id: automation.automation_id.clone(),
                        revision: automation.automation_revision,
                        matched: false,
                        reason: format!("Assessment unavailable: {reason}"),
                        evidence_ids: vec![],
                    })
                    .collect::<Vec<_>>();
                effects = super::inbox::event_automation::admit(
                    c,
                    library,
                    context,
                    epoch,
                    operation,
                    scope,
                    &r,
                    &failed,
                    &[],
                    &at,
                )?;
                c.execute("UPDATE automation_decisions SET status='failed',assessment_json=json_set(json_remove(assessment_json,'$.matched'),'$.error',?2) WHERE json_extract(assessment_json,'$.request_id')=?1",params![id,reason])?;
                c.execute("UPDATE automation_assessment_requests SET state='failed',failure=?2,updated_at_ms=?3 WHERE request_id=?1",params![id,reason,now(c)?])?;
                next(c, library, &r.thread_id)?;
            }
            AutomationAssessmentCommand::Submit {
                policy_hash,
                automation_assessments,
                proposed_actions,
                ..
            } => {
                if refresh(c, library, &r)? {
                    return Ok(effects);
                }
                if policy_hash != &r.policy_hash {
                    return Err(conflict("Assessment policy changed"));
                }
                let start = r
                    .run_started_at_ms
                    .ok_or_else(|| conflict("Assessment Run has not started"))?;
                if now(c)? > start + 120000 {
                    return Err(conflict("Assessment deadline expired"));
                }
                validate_submission(c, &r, automation_assessments, proposed_actions)?;
                effects = super::inbox::event_automation::admit(
                    c,
                    library,
                    context,
                    epoch,
                    operation,
                    scope,
                    &r,
                    automation_assessments,
                    proposed_actions,
                    &at,
                )?;
                c.execute("UPDATE automation_assessment_requests SET state='settled',updated_at_ms=?2 WHERE request_id=?1",params![id,now(c)?])?;
                flush_followed(
                    c,
                    library,
                    context,
                    operation,
                    &r.thread_id,
                    &at,
                    &mut effects,
                )?;
                next(c, library, &r.thread_id)?;
            }
        }
        Ok(effects)
    })
}
fn validate_submission(
    c: &Connection,
    r: &AutomationAssessmentRequest,
    assessments: &[AutomationAssessment],
    actions: &[AutomationProposedAction],
) -> Result<(), StoreError> {
    let automations = r
        .automations
        .iter()
        .map(|automation| (automation.automation_id.as_str(), automation))
        .collect::<BTreeMap<_, _>>();
    let ids = assessments
        .iter()
        .map(|a| a.automation_id.as_str())
        .collect::<BTreeSet<_>>();
    if ids.len() != assessments.len()
        || ids.len() != automations.len()
        || ids.iter().any(|id| !automations.contains_key(id))
    {
        return Err(invalid(
            "Assess every applicable enabled Automation exactly once, including negative judgements",
        ));
    }
    if actions.len() > 200 {
        return Err(invalid("Too many proposed actions"));
    }
    for a in assessments {
        if automations[a.automation_id.as_str()].automation_revision != a.revision
            || a.reason.trim().is_empty()
            || a.reason.len() > 2000
            || a.evidence_ids.len() > 30
            || (a.matched && a.evidence_ids.is_empty())
        {
            return Err(invalid(
                "Invalid Automation judgement, revision, reason, or evidence",
            ));
        }
        for evidence in &a.evidence_ids {
            let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM source_triggers t JOIN trigger_threads l ON l.trigger_id=t.id WHERE t.id=?1 AND l.thread_id=?2)",params![evidence,r.thread_id],|r|r.get(0))?;
            if !exists {
                return Err(invalid("Evidence is outside this assessment thread"));
            }
        }
    }
    let mut covered = BTreeSet::new();
    for a in actions {
        if a.automation_ids.is_empty()
            || a.title.trim().is_empty()
            || a.title.chars().count() > 200
            || a.body.trim().is_empty()
            || a.body.len() > 32000
            || a.thread_id != r.thread_id
        {
            return Err(invalid("Invalid proposed Page or thread"));
        }
        let AutomationActionScope::Project { project_id } = &a.scope;
        for id in &a.automation_ids {
            let automation = automations
                .get(id.as_str())
                .ok_or_else(|| invalid("Action names an unknown Automation"))?;
            if !covered.insert(id)
                || !assessments
                    .iter()
                    .any(|v| v.automation_id == *id && v.matched)
                || automation.project_id.as_ref() != Some(project_id)
                || crate::automation::clock::agent_selection(automation)? != a.execution_target
            {
                return Err(invalid(
                    "Action must use its matched Automation's Project and exact Agent target",
                ));
            }
        }
    }
    if assessments
        .iter()
        .any(|a| a.matched && !covered.contains(&a.automation_id))
    {
        return Err(invalid(
            "Every matched Automation requires a proposed action",
        ));
    }
    Ok(())
}
