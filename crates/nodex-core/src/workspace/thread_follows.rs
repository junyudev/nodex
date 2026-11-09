//! Follow routing is decided with ingestion, before any Host or Runtime side effect.
use super::mutation::WorkspaceMutationEffects;
use crate::database::{WorkflowStatusStep, follow_workflow_status, status_person_revision};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{
    BoundModuleContext, agent::AgentTurnProvenance, sources::*,
    workspace::ProjectWorkspaceSessionExecutionRef,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}
fn decode<T: DeserializeOwned>(s: String) -> rusqlite::Result<T> {
    serde_json::from_str(&s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn encode<T: serde::Serialize>(v: &T) -> Result<String, StoreError> {
    serde_json::to_string(v).map_err(|_| invalid("Invalid thread evidence"))
}
pub(super) fn thread(
    c: &Connection,
    library: &str,
    id: &str,
) -> Result<ExternalThread, StoreError> {
    c.query_row(
        "SELECT thread_json FROM external_threads WHERE id=?1 AND library_id=?2",
        params![id, library],
        |r| decode(r.get(0)?),
    )
    .map_err(Into::into)
}
pub(super) fn follows(
    c: &Connection,
    library: &str,
    page: &str,
    after: Option<&str>,
    limit: u32,
) -> Result<Vec<PageThreadFollow>, StoreError> {
    if !(1..=100).contains(&limit) {
        return Err(invalid("Follow windows require a limit from 1 to 100"));
    }
    Ok(c.prepare("SELECT f.page_id,t.thread_json,f.role,f.provenance,f.created_at FROM page_thread_follows f JOIN external_threads t ON t.id=f.external_thread_id JOIN blocks b ON b.id=f.page_id WHERE b.library_id=?1 AND f.page_id=?2 AND (?3 IS NULL OR t.id>?3) ORDER BY t.id LIMIT ?4")?.query_map(params![library,page,after,limit],|r|Ok(PageThreadFollow{page_id:r.get(0)?,thread:decode(r.get(1)?)?,role:decode(format!("\"{}\"",r.get::<_,String>(2)?))?,provenance:r.get(3)?,created_at:r.get(4)?}))?.collect::<rusqlite::Result<Vec<_>>>()?)
}
pub(super) fn add_follow(
    c: &Connection,
    library: &str,
    page: &str,
    thread: &ExternalThread,
    role: &str,
    provenance: &str,
    now: &str,
) -> Result<(), StoreError> {
    let valid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM pages p JOIN blocks b ON b.id=p.block_id WHERE p.block_id=?1 AND b.library_id=?2)",params![page,library],|r|r.get(0))?;
    if !valid {
        return Err(invalid("The followed Page is unavailable"));
    }
    let fence = if role == "own_pr" {
        c.query_row("SELECT link.status_fence FROM page_active_chats a JOIN project_session_pages link ON link.page_id=a.page_id AND link.session_id=a.session_id WHERE a.page_id=?1",[page],|r|r.get::<_,Option<i64>>(0)).optional()?.flatten().unwrap_or(status_person_revision(c,page)?)
    } else {
        status_person_revision(c, page)?
    };
    if role == "own_pr" {
        c.execute("UPDATE page_thread_follows SET role='context' WHERE page_id=?1 AND role='own_pr' AND external_thread_id<>?2",params![page,thread.id])?;
    }
    c.execute("INSERT INTO page_thread_follows(page_id,external_thread_id,role,provenance,created_at,status_fence) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(page_id,external_thread_id) DO UPDATE SET role=excluded.role,provenance=excluded.provenance,status_fence=excluded.status_fence WHERE (excluded.role='own_pr' AND page_thread_follows.role<>'own_pr') OR (excluded.role='origin' AND page_thread_follows.role='context')",params![page,thread.id,role,provenance,now,fence])?;
    Ok(())
}
/// A verified PR link supplies the branch/repository proof; a Source supplies immutable repository identity.
pub(super) fn follow_linked_pr(
    c: &Connection,
    library: &str,
    page: &str,
    now: &str,
) -> Result<(), StoreError> {
    let pr: Option<(String, i64, String, String)> = c
        .query_row(
            "SELECT repository,number,url,state FROM page_pull_requests WHERE page_id=?1",
            [page],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((repository, number, url, state)) = pr else {
        return Ok(());
    };
    let sources = c
        .prepare("SELECT config_json FROM sources WHERE library_id=?1")?
        .query_map([library], |r| decode::<GitHubSourceConfig>(r.get(0)?))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for source in sources {
        for repo in source.repositories {
            if !format!("https://{}/{}", source.host, repo.name).eq_ignore_ascii_case(&repository) {
                continue;
            }
            if url != format!("https://{}/{}/pull/{number}", source.host, repo.name) {
                continue;
            }
            let id = format!("github:{}:{}:{number}", source.host, repo.id);
            let existing = c
                .query_row(
                    "SELECT thread_json FROM external_threads WHERE id=?1 AND library_id=?2",
                    params![id, library],
                    |r| decode::<ExternalThread>(r.get(0)?),
                )
                .optional()?;
            let value = existing.unwrap_or(ExternalThread {
                id: id.clone(),
                host: source.host.clone(),
                repository_id: repo.id.clone(),
                repository: repo.name.clone(),
                number,
                kind: ExternalThreadKind::PullRequest,
                url: url.clone(),
                title: format!("PR #{number}"),
                state: state.to_lowercase(),
                head: None,
                draft: false,
                observation_revision: 0,
                observations: Default::default(),
            });
            c.execute("INSERT OR IGNORE INTO external_threads(id,library_id,provider,host,repository_id,number,thread_json) VALUES(?1,?2,'github',?3,?4,?5,?6)",params![id,library,source.host,repo.id,number,encode(&value)?])?;
            add_follow(
                c,
                library,
                page,
                &value,
                "own_pr",
                "verified_workspace_pr",
                now,
            )?;
        }
    }
    Ok(())
}
pub(super) fn discover_own_pr(
    c: &Connection,
    library: &str,
    t: &ExternalThread,
    now: &str,
) -> Result<Vec<String>, StoreError> {
    if t.kind != ExternalThreadKind::PullRequest {
        return Ok(vec![]);
    }
    let Some(head) = &t.head else {
        return Ok(vec![]);
    };
    if head.repository_id != t.repository_id || !head.repository.eq_ignore_ascii_case(&t.repository)
    {
        return Ok(vec![]);
    }
    let repository = format!("https://{}/{}", t.host, t.repository);
    let matches=c.prepare("SELECT w.page_id,w.workspace_id FROM page_workspaces w JOIN blocks b ON b.id=w.page_id WHERE b.library_id=?1 AND b.lifecycle='active' AND lower(w.repository_url)=lower(?2) AND w.branch_name=?3")?.query_map(params![library,repository,head.branch],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut pages = vec![];
    for (page, workspace) in matches {
        let current: Option<(i64, String)> = c
            .query_row(
                "SELECT number,state FROM page_pull_requests WHERE page_id=?1",
                [&page],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if current.is_some_and(|(number, state)| {
            number != t.number && (state == "OPEN" || t.state != "open" || t.number <= number)
        }) {
            continue;
        }
        let state = match t.state.as_str() {
            "merged" => "MERGED",
            "closed" => "CLOSED",
            _ => "OPEN",
        };
        c.execute("INSERT INTO page_pull_requests(page_id,workspace_id,repository,number,url,state,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(page_id) DO UPDATE SET repository=excluded.repository,number=excluded.number,url=excluded.url,state=excluded.state,observed_at=excluded.observed_at",params![page,workspace,repository,t.number,t.url,state,now])?;
        add_follow(c, library, &page, t, "own_pr", "source_verified_head", now)?;
        pages.push(page);
    }
    Ok(pages)
}
pub(super) fn managed_page(
    c: &Connection,
    library: &str,
    p: &AgentTurnProvenance,
) -> Result<String, StoreError> {
    let runtime = p
        .authority
        .runtime
        .as_ref()
        .ok_or_else(|| invalid("Following requires a managed chat"))?;
    let bound:Option<String>=c.query_row("SELECT a.page_id FROM session_workspaces binding JOIN page_workspaces w USING(workspace_id) JOIN page_active_chats a ON a.page_id=w.page_id AND a.session_id=binding.session_id JOIN blocks b ON b.id=a.page_id AND b.lifecycle='active' JOIN coordinator_managed_sessions m ON m.session_id=a.session_id WHERE binding.session_id=?1 AND b.library_id=?2",params![runtime.session_id,library],|r|r.get(0)).optional()?;
    if let Some(page) = bound {
        return Ok(page);
    }
    let pages=c.prepare("SELECT a.page_id FROM page_active_chats a JOIN blocks b ON b.id=a.page_id JOIN coordinator_managed_sessions m ON m.session_id=a.session_id WHERE a.session_id=?1 AND b.library_id=?2 AND b.lifecycle='active' ORDER BY a.page_id LIMIT 2")?.query_map(params![runtime.session_id,library],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if pages.len() != 1 {
        return Err(invalid(
            "Following requires exactly one active work Page in this managed chat",
        ));
    }
    Ok(pages[0].clone())
}
pub(super) fn origin_on_dispatch(
    c: &Connection,
    library: &str,
    pages: &[String],
    now: &str,
) -> Result<(), StoreError> {
    for page in pages {
        let ids = c
            .prepare("SELECT external_thread_id FROM github_intakes WHERE page_id=?1")?
            .query_map([page], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in ids {
            add_follow(
                c,
                library,
                page,
                &thread(c, library, &id)?,
                "origin",
                "github_intake_dispatch",
                now,
            )?;
        }
    }
    Ok(())
}
fn status(c: &Connection, page: &str) -> Result<Option<String>, StoreError> {
    Ok(c.query_row("SELECT json_extract(v.value_json,'$') FROM pages p JOIN data_source_page_memberships m ON m.page_block_id=p.block_id AND m.data_source_id=p.parent_id AND m.removed_at IS NULL JOIN data_source_property_values v ON v.data_source_id=p.parent_id AND v.membership_id=m.id AND v.property_id='status' WHERE p.block_id=?1 AND p.parent_kind='data_source'",[page],|r|r.get(0)).optional()?.flatten())
}
#[allow(clippy::too_many_arguments)]
pub(super) fn ingest(
    c: &Connection,
    library: &str,
    context: &BoundModuleContext,
    operation: &str,
    id: &str,
    event: &SourceTriggerInput,
    now: &str,
    effects: &mut WorkspaceMutationEffects,
) -> Result<bool, StoreError> {
    let t = thread(c, library, &event.thread_id)?;
    let following=c.prepare("SELECT f.page_id,f.role,COALESCE(link.status_fence,f.status_fence),f.last_fact_at_ms,b.lifecycle FROM page_thread_follows f JOIN blocks b ON b.id=f.page_id LEFT JOIN page_active_chats active ON active.page_id=f.page_id LEFT JOIN project_session_pages link ON link.page_id=active.page_id AND link.session_id=active.session_id WHERE f.external_thread_id=?1 AND b.library_id=?2 ORDER BY f.page_id")?.query_map(params![t.id,library],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (page, role, fence, last, lifecycle) in &following {
        let target:Option<(String,i64,Option<String>,Option<String>)>=c.query_row("SELECT a.session_id,a.revision,e.runtime_id,e.runtime_thread_id FROM page_active_chats a JOIN project_sessions s ON s.id=a.session_id AND s.archived=0 LEFT JOIN project_session_execution_bindings e ON e.session_id=s.id WHERE a.page_id=?1",[page],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        // Eligibility is the Page's stage when this observation enters Core, before its milestone.
        let suppressed = event.actor_class != SourceActorClass::Person
            && matches!(status(c, page)?.as_deref(), Some("done" | "canceled"));
        let execution = target.as_ref().and_then(|(_, _, runtime, thread)| {
            Some(ProjectWorkspaceSessionExecutionRef {
                runtime_id: runtime.clone()?,
                thread_id: thread.clone()?,
            })
        });
        let state = if suppressed {
            "suppressed"
        } else if execution.is_none() || lifecycle != "active" {
            "unresolved"
        } else {
            "pending"
        };
        let reason = if suppressed {
            Some("closed_work")
        } else if lifecycle != "active" {
            Some("page_unavailable")
        } else if target.is_none() {
            Some("missing_active_chat")
        } else if execution.is_none() {
            Some("runtime_unavailable")
        } else {
            None
        };
        let delivery = crate::domain::identity::stable_uuid_v7("thread-delivery", id, page);
        c.execute("INSERT INTO thread_deliveries(id,trigger_id,page_id,session_id,binding_revision,execution_ref_json,state,reason) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![delivery,id,page,target.as_ref().map(|x|&x.0),target.as_ref().map(|x|x.1),execution.as_ref().map(encode).transpose()?,state,reason])?;
        if state == "unresolved" {
            super::problems::fail(
                c,
                super::problems::Failure {
                    library,
                    source: None,
                    page: Some(page),
                    scope: &delivery,
                    kind: "delivery_unresolved",
                    summary: "GitHub update needs an active chat",
                    fix: "open_card",
                    evidence: serde_json::json!({"delivery_id":delivery,"reason":reason,"url":event.url}),
                    immediate: true,
                },
            )?;
        }
        effects.page_ids.push(page.clone());
        if role != "own_pr" {
            continue;
        }
        let transition = match event.kind.as_str() {
            "opened" | "ready_for_review" => Some((&["doing"][..], "review")),
            "merged" => Some((&["review", "doing"][..], "done")),
            "closed" if t.state != "merged" => {
                Some((&["triage", "plan", "doing", "review"][..], "canceled"))
            }
            "review" if event.metadata["state"] == "CHANGES_REQUESTED" && t.state == "open" => {
                Some((&["review"][..], "doing"))
            }
            _ => None,
        };
        let Some((predecessors, to)) = transition else {
            continue;
        };
        let identity = format!(
            "{}@{}",
            event.semantic_key,
            event.metadata["observed_revision"]
                .as_i64()
                .unwrap_or(t.observation_revision)
        );
        let skip = if matches!(event.kind.as_str(), "opened" | "ready_for_review") && t.draft {
            Some("Pull request is a draft")
        } else if event.kind == "review" && event.metadata["effective"] != true {
            Some("Review is no longer effective")
        } else {
            None
        };
        let receipt = if skip.is_none() && event.occurred_at_ms >= *last {
            follow_workflow_status(
                c,
                library,
                context,
                operation,
                &[WorkflowStatusStep {
                    page_id: page,
                    predecessors,
                    to,
                    person_revision: *fence,
                }],
                now,
            )?
        } else {
            None
        };
        let moved = receipt.is_some();
        if let Some(receipt) = receipt {
            effects.absorb_database(receipt);
        }
        c.execute(
            "INSERT OR IGNORE INTO thread_milestones(page_id,trigger_id,fact_identity,destination,status_moved,reason,stage) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![page, id, identity, to, moved, if let Some(reason)=skip {reason} else if moved {"Own PR milestone"} else if event.occurred_at_ms<*last {"A newer milestone already applies"} else if status_person_revision(c,page)? != *fence {"A person moved it"} else {"The card was already in another stage"}, status(c,page)?],
        )?;
        c.execute("UPDATE page_thread_follows SET last_fact_at_ms=max(last_fact_at_ms,?3) WHERE page_id=?1 AND external_thread_id=?2",params![page,t.id,event.occurred_at_ms])?;
    }
    Ok(!following.is_empty())
}
pub(super) fn deliveries(
    c: &Connection,
    library: &str,
    page: Option<&str>,
    state: Option<&str>,
    after: Option<&str>,
    limit: u32,
) -> Result<Vec<ThreadDelivery>, StoreError> {
    if !(1..=100).contains(&limit) {
        return Err(invalid("Delivery windows require a limit from 1 to 100"));
    }
    let mut deliveries=c.prepare("SELECT d.id,t.id,t.source_id,t.received_at_ms,t.disposition,t.event_json,d.page_id,e.thread_json,d.session_id,d.binding_revision,d.execution_ref_json,d.state,d.reason,d.message_id FROM thread_deliveries d JOIN source_triggers t ON t.id=d.trigger_id JOIN trigger_threads tt ON tt.trigger_id=t.id AND tt.role='primary' JOIN external_threads e ON e.id=tt.thread_id WHERE t.library_id=?1 AND (?2 IS NULL OR d.page_id=?2) AND (?3 IS NULL OR d.state=?3) AND (?4 IS NULL OR d.id>?4) ORDER BY d.id LIMIT ?5")?.query_map(params![library,page,state,after,limit],|r|Ok(ThreadDelivery{target_current:true,id:r.get(0)?,trigger:SourceTrigger{id:r.get(1)?,source_id:r.get(2)?,received_at_ms:r.get(3)?,disposition:r.get(4)?,event:decode(r.get(5)?)?},page_id:r.get(6)?,thread:decode(r.get(7)?)?,session_id:r.get(8)?,binding_revision:r.get(9)?,execution_ref:r.get::<_,Option<String>>(10)?.map(decode).transpose()?,state:r.get(11)?,reason:r.get(12)?,message_id:r.get(13)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for d in &mut deliveries {
        d.target_current=c.query_row("SELECT EXISTS(SELECT 1 FROM page_active_chats a JOIN project_sessions s ON s.id=a.session_id AND s.archived=0 JOIN project_session_execution_bindings e ON e.session_id=s.id WHERE a.page_id=?1 AND a.session_id=?2 AND a.revision=?3 AND e.runtime_id=?4 AND e.runtime_thread_id=?5)",params![d.page_id,d.session_id,d.binding_revision,d.execution_ref.as_ref().map(|e|&e.runtime_id),d.execution_ref.as_ref().map(|e|&e.thread_id)],|r|r.get(0))?;
    }
    Ok(deliveries)
}
pub(super) fn batches(
    c: &Connection,
    library: &str,
    after: Option<&str>,
    limit: u32,
) -> Result<Vec<ThreadDeliveryBatch>, StoreError> {
    if !(1..=100).contains(&limit) {
        return Err(invalid("Delivery windows require a limit from 1 to 100"));
    }
    let mut batches=c.prepare("SELECT message_id,session_id,execution_ref_json,body,body_hash,created_at_ms,state,attempts FROM thread_delivery_batches WHERE library_id=?1 AND state='pending' AND consecutive_failures<3 AND retry_at_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) AND (?2 IS NULL OR message_id>?2) ORDER BY message_id LIMIT ?3")?.query_map(params![library,after,limit],batch_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    for batch in &mut batches {
        refresh_batch(c, batch)?;
    }
    Ok(batches)
}
fn batch_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadDeliveryBatch> {
    Ok(ThreadDeliveryBatch {
        attempts: r.get(7)?,
        eligible: true,
        held: false,
        message_id: r.get(0)?,
        session_id: r.get(1)?,
        execution_ref: decode(r.get(2)?)?,
        body: r.get(3)?,
        body_hash: r.get(4)?,
        created_at_ms: r.get(5)?,
        state: r.get(6)?,
    })
}
fn refresh_batch(c: &Connection, batch: &mut ThreadDeliveryBatch) -> Result<(), StoreError> {
    batch.eligible = !c.query_row("SELECT EXISTS(SELECT 1 FROM thread_deliveries d LEFT JOIN page_active_chats a ON a.page_id=d.page_id LEFT JOIN project_sessions s ON s.id=d.session_id LEFT JOIN project_session_execution_bindings e ON e.session_id=s.id WHERE d.message_id=?1 AND (a.session_id IS NOT d.session_id OR a.revision IS NOT d.binding_revision OR s.archived IS NOT 0 OR e.runtime_id IS NOT json_extract(d.execution_ref_json,'$.runtime_id') OR e.runtime_thread_id IS NOT json_extract(d.execution_ref_json,'$.thread_id')))",[&batch.message_id],|r|r.get::<_,bool>(0))?;
    let launch:Option<String>=c.query_row("SELECT launch_id FROM page_work_launches WHERE session_id=?1 ORDER BY created_at DESC,launch_id DESC LIMIT 1",[&batch.session_id],|r|r.get(0)).optional()?;
    let awaiting_automation_start = launch
        .as_deref()
        .map(|id| super::page_work::launch(c, id))
        .transpose()?
        .flatten()
        .is_some_and(|start| start.automation_decision_id.is_some() && start.accepted_at.is_none());
    // A follow cannot provide the first input while the Automation's own launch is unadmitted.
    batch.held = awaiting_automation_start
        || !super::execution_holds::for_session(c, &batch.session_id)?.is_empty();
    Ok(())
}
pub(super) fn begin_batch(c: &Connection, library: &str, message: &str) -> Result<(), StoreError> {
    let mut batch=c.query_row("SELECT message_id,session_id,execution_ref_json,body,body_hash,created_at_ms,state,attempts FROM thread_delivery_batches WHERE message_id=?1 AND library_id=?2 AND state='pending'",params![message,library],batch_row).optional()?.ok_or_else(||conflict("The delivery batch is unavailable"))?;
    refresh_batch(c, &mut batch)?;
    if !batch.eligible || batch.held {
        return Err(conflict("The delivery target changed or is paused"));
    }
    c.execute(
        "UPDATE thread_delivery_batches SET attempts=attempts+1 WHERE message_id=?1",
        [message],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_batch(
    c: &Connection,
    library: &str,
    ids: &[String],
    message: &str,
    body: &str,
    now_ms: i64,
    now: &str,
) -> Result<(), StoreError> {
    if ids.is_empty() || ids.len() > 50 || body.trim().is_empty() || body.len() > 256000 {
        return Err(invalid(
            "A delivery batch requires 1–50 updates and bounded text",
        ));
    }
    let unique = ids.iter().collect::<std::collections::BTreeSet<_>>();
    if unique.len() != ids.len() {
        return Err(invalid("A delivery cannot appear twice in a batch"));
    }
    let mut selected = Vec::new();
    for id in ids {
        let row:Option<(String,String,i64,String)>=c.query_row("SELECT d.id,d.session_id,d.binding_revision,d.execution_ref_json FROM thread_deliveries d JOIN source_triggers t ON t.id=d.trigger_id JOIN page_active_chats a ON a.page_id=d.page_id AND a.session_id=d.session_id AND a.revision=d.binding_revision JOIN project_sessions s ON s.id=a.session_id AND s.archived=0 JOIN project_session_execution_bindings e ON e.session_id=s.id WHERE d.id=?1 AND t.library_id=?2 AND d.state='pending' AND json_extract(d.execution_ref_json,'$.runtime_id')=e.runtime_id AND json_extract(d.execution_ref_json,'$.thread_id')=e.runtime_thread_id",params![id,library],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some(row) = row else {
            return Err(conflict("The frozen active chat changed before delivery"));
        };
        selected.push(row);
    }
    let first = &selected[0];
    if selected
        .iter()
        .any(|row| row.1 != first.1 || row.3 != first.3)
    {
        return Err(invalid("Batch updates must share one frozen chat"));
    }
    if !super::execution_holds::for_session(c, &first.1)?.is_empty() {
        return Err(conflict("This work is paused"));
    }
    let hash = crate::document::sha256(body.as_bytes());
    c.execute("INSERT INTO thread_delivery_batches(message_id,library_id,session_id,execution_ref_json,body,body_hash,created_at_ms,state,receipt) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',NULL)",params![message,library,first.1,first.3,body,hash,now_ms])?;
    for id in ids {
        c.execute(
            "UPDATE thread_deliveries SET state='batched',message_id=?2 WHERE id=?1",
            params![id, message],
        )?;
    }
    let author = super::inbox::github::batch_source(c, library, message)?;
    super::inbox::handback::record(
        c,
        library,
        &nodex_core_contracts::workspace::ProjectWorkspaceIntent::RecordChatDelivery {
            session_id: first.1.clone(),
            delivery_id: message.into(),
            body_hash: hash,
            author,
            attachment_count: 0,
            question_answer_run_id: None,
        },
        now,
    )?;
    Ok(())
}

/// Only an explicit work decision can supply the first destination for missing-chat evidence.
pub(super) fn route_unresolved(
    c: &Connection,
    page: &str,
    session: &str,
) -> Result<(), StoreError> {
    let target:Option<(String,String)>=c.query_row("SELECT runtime_id,runtime_thread_id FROM project_session_execution_bindings WHERE session_id=?1",[session],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((runtime_id, thread_id)) = target else {
        return Ok(());
    };
    let ids=c.prepare("SELECT d.id,t.library_id FROM thread_deliveries d JOIN source_triggers t ON t.id=d.trigger_id WHERE d.page_id=?1 AND d.state='unresolved' AND d.session_id IS NULL AND d.reason='missing_active_chat'")?.query_map([page],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, library) in ids {
        c.execute("UPDATE thread_deliveries SET state='pending',reason=NULL,session_id=?2,binding_revision=(SELECT revision FROM page_active_chats WHERE page_id=?3),execution_ref_json=?4 WHERE id=?1",params![id,session,page,encode(&ProjectWorkspaceSessionExecutionRef{runtime_id:runtime_id.clone(),thread_id:thread_id.clone()})?])?;
        super::problems::resolve(c, &library, &id)?;
    }
    Ok(())
}
