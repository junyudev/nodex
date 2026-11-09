//! Frozen origin replies, per-thread sender leases and emission identities.
use super::problems::{invalid, now};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::{agent::AgentTurnProvenance, sources::*};
use rusqlite::{Connection, OptionalExtension, params};

fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}
pub(super) fn enqueue(
    c: &Connection,
    library: &str,
    page: &str,
    body: &str,
    provenance: Option<&AgentTurnProvenance>,
) -> Result<(), StoreError> {
    let caller = provenance
        .and_then(|p| p.authority.runtime.as_ref())
        .map(|r| r.session_id.as_str());
    if caller.is_none() || caller != super::coordinator::binding(c)?.as_deref() {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Only Nodex can reply to an origin",
            false,
        ));
    }
    if body.trim().is_empty() || body.len() > 16384 || body.contains("<!-- nodex:") {
        return Err(invalid(
            "Origin reply is empty, oversized or contains a reserved marker",
        ));
    }
    let target:Option<(String,String)>=c.query_row("SELECT t.id,t.thread_json FROM page_thread_follows f JOIN external_threads t ON t.id=f.external_thread_id JOIN blocks b ON b.id=f.page_id AND b.lifecycle='active' WHERE f.page_id=?1 AND t.library_id=?2 AND f.role='origin' ORDER BY f.created_at,t.id LIMIT 1",params![page,library],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let (thread_id, thread_json) = target.ok_or_else(|| invalid("Page has no origin thread"))?;
    let thread: ExternalThread =
        serde_json::from_str(&thread_json).map_err(|_| invalid("Invalid origin thread"))?;
    let source:Option<Source>=c.query_row("SELECT id FROM sources WHERE library_id=?1 AND enabled=1 AND json_extract(config_json,'$.host')=?2 AND EXISTS(SELECT 1 FROM json_each(config_json,'$.repositories') WHERE json_extract(value,'$.id')=?3 AND json_extract(value,'$.enabled')=1) ORDER BY id LIMIT 1",params![library,thread.host,thread.repository_id],|r|r.get::<_,String>(0)).optional()?.map(|id|super::sources::source(c,library,&id)).transpose()?.flatten();
    let source =
        source.ok_or_else(|| invalid("Enable this origin repository in GitHub settings"))?;
    let episode: String = c
        .query_row(
            "SELECT episode FROM page_turn_episodes WHERE page_id=?1",
            [page],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_else(|| "initial".into());
    let hash = crate::document::sha256(body.as_bytes());
    let id = crate::domain::identity::random_uuid_v7()
        .map_err(|_| invalid("Channel identity unavailable"))?;
    let at = now(c)?;
    c.execute("INSERT INTO channel_outbox(id,library_id,page_id,source_id,external_thread_id,source_json,thread_json,episode,body,body_hash,marker,thread_order,state,created_at_ms,updated_at_ms) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,COALESCE(max(thread_order),0)+1,'pending',?12,?12 FROM channel_outbox WHERE external_thread_id=?5 ON CONFLICT(page_id,body_hash,episode) DO NOTHING",params![id,library,page,source.id,thread_id,serde_json::to_string(&source).map_err(|_|invalid("Invalid sender"))?,thread_json,episode,body,hash,format!("<!-- nodex:{id} -->"),at])?;
    Ok(())
}
pub(super) fn items(
    c: &Connection,
    library: &str,
    include_terminal: bool,
    after: Option<&str>,
    limit: u32,
) -> Result<Vec<ChannelOutboxItem>, StoreError> {
    if !(1..=100).contains(&limit) {
        return Err(invalid("Channel limit must be 1–100"));
    }
    let terminal = if include_terminal {
        ""
    } else {
        " AND state IN ('pending','sending')"
    };
    Ok(c.prepare(&format!("SELECT id,page_id,source_json,thread_json,body,body_hash,marker,episode,thread_order,state,attempts,lease_token,lease_expires_at_ms,retry_at_ms,remote_comment_id,remote_url,terminal_reason FROM channel_outbox WHERE library_id=?1 AND (?2 IS NULL OR id>?2){terminal} ORDER BY id LIMIT ?3"))?.query_map(params![library,after,limit],|r|Ok(ChannelOutboxItem{id:r.get(0)?,page_id:r.get(1)?,source:serde_json::from_str(&r.get::<_,String>(2)?).map_err(|_|rusqlite::Error::InvalidQuery)?,thread:serde_json::from_str(&r.get::<_,String>(3)?).map_err(|_|rusqlite::Error::InvalidQuery)?,body:r.get(4)?,body_hash:r.get(5)?,marker:r.get(6)?,episode:r.get(7)?,thread_order:r.get(8)?,state:r.get(9)?,attempts:r.get(10)?,lease_token:r.get(11)?,lease_expires_at_ms:r.get(12)?,retry_at_ms:r.get(13)?,remote_comment_id:r.get(14)?,remote_url:r.get(15)?,terminal_reason:r.get(16)?}))?.collect::<rusqlite::Result<Vec<_>>>()?)
}
pub(super) fn claim(
    c: &Connection,
    library: &str,
    id: &str,
    token: &str,
    duration: i64,
) -> Result<(), StoreError> {
    if token.is_empty() || token.len() > 512 || !(1000..=120000).contains(&duration) {
        return Err(invalid("Invalid sender lease"));
    }
    let changed=c.execute("UPDATE channel_outbox SET state='sending',lease_token=?3,lease_expires_at_ms=?4+?5,attempts=attempts+1,updated_at_ms=?4 WHERE library_id=?1 AND id=?2 AND state IN ('pending','sending') AND retry_at_ms<=?4 AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms<=?4) AND NOT EXISTS(SELECT 1 FROM channel_outbox earlier WHERE earlier.external_thread_id=channel_outbox.external_thread_id AND earlier.thread_order<channel_outbox.thread_order AND earlier.state NOT IN ('sent','dropped')) AND EXISTS(SELECT 1 FROM sources s WHERE s.id=channel_outbox.source_id AND s.enabled=1 AND json_extract(s.config_json,'$.account_id')=json_extract(channel_outbox.source_json,'$.config.account_id') AND json_extract(s.config_json,'$.account_login')=json_extract(channel_outbox.source_json,'$.config.account_login') AND json_extract(s.config_json,'$.host')=json_extract(channel_outbox.source_json,'$.config.host') AND EXISTS(SELECT 1 FROM json_each(s.config_json,'$.repositories') repo WHERE json_extract(repo.value,'$.id')=json_extract(channel_outbox.thread_json,'$.repository_id') AND json_extract(repo.value,'$.enabled')=1))",params![library,id,token,now(c)?,duration])?;
    if changed == 0 {
        return Err(conflict(
            "Channel is paused, ordered behind another reply or already leased",
        ));
    }
    Ok(())
}
/// How one channel delivery ended: its receipt or failure, and whether a failure is permanent or a credential problem.
pub(super) struct DeliveryOutcome<'a> {
    pub(super) receipt: Option<&'a ChannelReceipt>,
    pub(super) failure: Option<&'a str>,
    pub(super) permanent: bool,
    pub(super) credential: bool,
pub(super) fn settle(
    c: &Connection,
    library: &str,
    id: &str,
    token: &str,
    delivery_outcome: DeliveryOutcome<'_>,
) -> Result<(), StoreError> {
    let DeliveryOutcome {
        permanent,
        credential,
    } = delivery_outcome;
    let (page,source,count):(String,String,i64)=c.query_row("SELECT page_id,source_id,consecutive_failures FROM channel_outbox WHERE id=?1 AND library_id=?2 AND state='sending' AND lease_token=?3 AND lease_expires_at_ms>?4",params![id,library,token,now(c)?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||conflict("Sender lease expired or was replaced"))?;
    if let Some(receipt) = receipt {
        if failure.is_some()
            || receipt.comment_id.is_empty()
            || receipt.comment_id.len() > 512
            || !receipt.url.starts_with("https://")
            || receipt.url.len() > 4096
        {
            return Err(invalid("Invalid channel receipt"));
        }
        c.execute("UPDATE channel_outbox SET state='sent',remote_comment_id=?2,remote_url=?3,terminal_reason=NULL,consecutive_failures=0,lease_token=NULL,lease_expires_at_ms=NULL,updated_at_ms=?4 WHERE id=?1",params![id,receipt.comment_id,receipt.url,now(c)?])?;
        return super::problems::resolve(c, library, id);
    }
    let reason = failure
        .filter(|r| !r.trim().is_empty() && r.len() <= 2000)
        .ok_or_else(|| invalid("Send failure requires a bounded reason"))?;
    let state = if permanent {
        "dropped"
    } else if count + 1 >= 3 {
        "failed"
    } else {
        "pending"
    };
    c.execute("UPDATE channel_outbox SET state=?2,terminal_reason=?3,consecutive_failures=consecutive_failures+1,retry_at_ms=?4+min(3600000,1000*(1<<min(consecutive_failures,12))),lease_token=NULL,lease_expires_at_ms=NULL,updated_at_ms=?4 WHERE id=?1",params![id,state,reason,now(c)?])?;
    super::problems::fail(
        c,
        super::problems::Failure {
            library,
            source: Some(&source),
            page: Some(&page),
            scope: id,
            kind: if credential {
                "credential_invalid"
            } else {
                "channel_failing"
            },
            summary: if permanent {
                "GitHub reply could not be sent"
            } else {
                "GitHub reply is waiting to be retried"
            },
            fix: if permanent || credential {
                "reconnect"
            } else {
                "retry"
            },
            evidence: serde_json::json!({"outbox_id":id,"reason":reason}),
            immediate: credential,
        },
    )
}
/// Match only recorded emissions in their frozen thread. Other comments by the same account survive.
pub(super) fn emitted(
    c: &Connection,
    library: &str,
    event: &SourceTriggerInput,
) -> Result<bool, StoreError> {
    Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM channel_outbox WHERE library_id=?1 AND external_thread_id=?2 AND (instr(COALESCE(?3,''),marker)>0 OR (remote_comment_id IS NOT NULL AND (remote_comment_id=?4 OR remote_url=?5))))",params![library,event.thread_id,event.text,event.metadata.get("comment_id").and_then(|v|v.as_str()),event.url],|r|r.get(0))?)
}
