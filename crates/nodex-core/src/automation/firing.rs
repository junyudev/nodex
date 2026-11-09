//! Automation-owned Inbox firing lifecycle. Workspace participates in this state inside
//! its own LocalCommit; admission never advances a recurring definition's schedule.
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};
use nodex_core_contracts::automation::{
    AutomationAdmission, AutomationHeldDecision, AutomationLease, AutomationLeasePurpose,
    AutomationLeaseStatus,
};
use nodex_core_contracts::inbox::AutomationInboxDecision;
use rusqlite::{Connection, OptionalExtension, params};

pub(crate) fn definition(
    connection: &Connection,
    id: &str,
) -> Result<nodex_core_contracts::automation::Automation, StoreError> {
    super::read::read_definition(connection, id)?
        .filter(|d| d.status != nodex_core_contracts::automation::AutomationStatus::Deleted)
        .ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::Conflict,
                "This Automation no longer exists",
                false,
            )
        })
}
/// The task's one waiting message includes a pre-chat failure awaiting Retry.
pub(crate) fn held(
    connection: &Connection,
    id: &str,
) -> Result<Option<AutomationHeldDecision>, StoreError> {
    let event_contract: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='automation_event_filters')",
        [],
        |r| r.get(0),
    )?;
    let sql = if event_contract {
        "SELECT dispatch_id,page_id,inbox_project_id,first_scheduled_for_ms,last_scheduled_for_ms,missed_count FROM automation_decisions firing JOIN blocks block ON block.id=firing.page_id AND block.lifecycle='active' WHERE automation_id=?1 AND waiting_in_inbox=1 AND ((assessment_json IS NOT NULL)=EXISTS(SELECT 1 FROM automation_event_filters WHERE automation_id=?1)) ORDER BY created_at_ms,dispatch_id LIMIT 1"
    } else {
        "SELECT dispatch_id,page_id,inbox_project_id,first_scheduled_for_ms,last_scheduled_for_ms,missed_count FROM automation_decisions firing JOIN blocks block ON block.id=firing.page_id AND block.lifecycle='active' WHERE automation_id=?1 AND waiting_in_inbox=1"
    };
    Ok(connection
        .query_row(sql, [id], |r| {
            Ok(AutomationHeldDecision {
                dispatch_id: r.get(0)?,
                page_id: r.get(1)?,
                inbox_project_id: r.get(2)?,
                first_scheduled_for_ms: r.get(3)?,
                last_scheduled_for_ms: r.get(4)?,
                missed_count: r.get(5)?,
            })
        })
        .optional()?)
}
pub(crate) fn item(
    connection: &Connection,
    page: &str,
) -> Result<Option<AutomationInboxDecision>, StoreError> {
    let row=connection.query_row("SELECT automation_id,dispatch_id,status,first_scheduled_for_ms,last_scheduled_for_ms,missed_count,failure_message FROM automation_decisions WHERE page_id=?1",[page],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
    row.map(
        |(
            automation_id,
            dispatch_id,
            status,
            first_scheduled_for_ms,
            last_scheduled_for_ms,
            missed_count,
            failure_message,
        )| {
            Ok(AutomationInboxDecision {
                automation_id,
                dispatch_id,
                status: serde_json::from_value(serde_json::Value::String(status)).map_err(
                    |_| {
                        StoreError::new(
                            StoreErrorCode::StoreCorrupt,
                            "Invalid Automation decision state",
                            false,
                        )
                    },
                )?,
                first_scheduled_for_ms,
                last_scheduled_for_ms,
                missed_count,
                failure_message,
            })
        },
    )
    .transpose()
}
pub(crate) fn exists(connection: &Connection, dispatch: &str) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM automation_decisions WHERE dispatch_id=?1 AND (page_id IS NOT NULL OR admitted_at_ms IS NOT NULL))",
        [dispatch],
        |row| row.get(0),
    )?)
}

pub(crate) fn require_admitted(connection: &Connection, dispatch: &str) -> Result<(), StoreError> {
    let status: Option<String> = connection
        .query_row(
            "SELECT status FROM automation_decisions WHERE dispatch_id=?1",
            [dispatch],
            |row| row.get(0),
        )
        .optional()?;
    if status.is_some_and(|status| status != "admitted") {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "This Automation decision is no longer admitted to run",
            false,
        ));
    }
    Ok(())
}

pub(crate) fn admission(
    connection: &Connection,
    dispatch: &str,
) -> Result<Option<AutomationAdmission>, StoreError> {
    let row=connection.query_row("SELECT page_id,admission_prompt,admission_agent_json,admitted_at_ms FROM automation_decisions WHERE dispatch_id=?1 AND admitted_at_ms IS NOT NULL",[dispatch],|r|Ok((r.get(0)?,r.get(1)?,r.get::<_,Option<String>>(2)?,r.get(3)?))).optional()?;
    row.map(|(page_id, prompt, agent, admitted_at_ms)| {
        Ok(AutomationAdmission {
            page_id,
            prompt,
            agent: agent
                .map(|json| serde_json::from_str(&json))
                .transpose()
                .map_err(|_| {
                    StoreError::new(
                        StoreErrorCode::StoreCorrupt,
                        "Invalid firing Agent selection",
                        false,
                    )
                })?,
            admitted_at_ms,
        })
    })
    .transpose()
}
pub(crate) fn hold_lease(
    connection: &Connection,
    id: &str,
    now: i64,
) -> Result<AutomationLease, StoreError> {
    let lease = super::read::read_lease(connection, id)?.ok_or_else(|| {
        StoreError::new(
            StoreErrorCode::NotFound,
            "Automation decision lease is unavailable",
            false,
        )
    })?;
    if lease.purpose != AutomationLeasePurpose::Hold
        || lease.status != AutomationLeaseStatus::Claimed
        || lease.expires_at_ms <= now
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "A claimed, unexpired Hold lease is required",
            false,
        ));
    }
    Ok(lease)
}
pub(crate) fn complete_hold(
    connection: &Connection,
    lease: &AutomationLease,
    now: i64,
) -> Result<(), StoreError> {
    let definition = definition(connection, &lease.automation_id)?;
    let next = if definition.status == nodex_core_contracts::automation::AutomationStatus::Active {
        super::mutation::scheduled_next_for_stored(connection, &definition, now)?
    } else {
        None
    };
    connection.execute(
        "UPDATE automation_execution_leases SET status='completed',settled_at_ms=?2 WHERE lease_id=?1",
        params![lease.lease_id, now],
    )?;
    connection.execute(
        "UPDATE automations SET next_run_at=?2,last_run_at=?3,updated_at=?3 WHERE automation_id=?1",
        params![lease.automation_id, next, now],
    )?;
    Ok(())
}
pub(crate) fn claim_admitted(
    connection: &Connection,
    operation: &str,
    now: i64,
    expiry: i64,
    limit: u32,
) -> Result<(Vec<AutomationLease>, Vec<String>), StoreError> {
    let ids=connection.prepare("SELECT firing.dispatch_id,firing.automation_id,firing.first_scheduled_for_ms,firing.automation_revision FROM automation_decisions firing JOIN automations definition USING(automation_id) WHERE firing.status='admitted' AND firing.due_at_ms<=?1 AND definition.status<>'DELETED' AND NOT EXISTS (SELECT 1 FROM automation_execution_leases lease WHERE lease.dispatch_id=firing.dispatch_id AND lease.status='claimed' AND lease.expires_at_ms>?1) ORDER BY firing.due_at_ms,firing.dispatch_id LIMIT ?2")?
        .query_map(params![now,limit],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut leases = Vec::new();
    let mut expired = Vec::new();
    for (dispatch, automation, scheduled, revision) in ids {
        expired.extend(connection.prepare("SELECT lease_id FROM automation_execution_leases WHERE dispatch_id=?1 AND status='claimed'")?.query_map([&dispatch],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
        connection.execute("UPDATE automation_execution_leases SET status='failed',settled_at_ms=?2,retry_at_ms=?2,reason_code='lease_expired' WHERE dispatch_id=?1 AND status='claimed'",params![dispatch,now])?;
        let attempt: i64 = connection.query_row(
            "SELECT COALESCE(MAX(attempt),0)+1 FROM automation_execution_leases WHERE dispatch_id=?1",
            [&dispatch],
            |r| r.get(0),
        )?;
        let id = format!(
            "automation-lease:{}",
            crate::document::sha256(format!("{operation}:{dispatch}:{attempt}").as_bytes())
        );
        connection.execute("INSERT INTO automation_execution_leases(lease_id,automation_id,dispatch_id,automation_revision,scheduled_for_ms,attempt,status,claimed_at_ms,expires_at_ms,purpose) VALUES (?1,?2,?3,?4,?5,?6,'claimed',?7,?8,'run')",params![id,automation,dispatch,revision,scheduled,attempt,now,expiry])?;
        leases.push(super::read::read_lease(connection, &id)?.expect("inserted lease"));
    }
    Ok((leases, expired))
}
pub(super) fn settle(
    connection: &Connection,
    dispatch: &str,
    failed: bool,
    retry: Option<i64>,
    reason: Option<&str>,
    now: i64,
    iso: &str,
) -> Result<(), StoreError> {
    let status = if !failed {
        "completed"
    } else if retry.is_some() {
        "admitted"
    } else {
        "failed"
    };
    let waiting: bool = failed && retry.is_none() && connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM automation_decisions firing \
         JOIN blocks block ON block.id=firing.page_id AND block.lifecycle='active' \
         JOIN inbox_entries entry ON entry.page_id=firing.page_id AND entry.state='open' \
         WHERE firing.dispatch_id=?1 AND firing.status='admitted' \
           AND NOT EXISTS(SELECT 1 FROM automation_execution_runs run WHERE run.dispatch_id=?1 AND run.session_id IS NOT NULL))",
        [dispatch], |row| row.get(0),
    )?;
    // An earlier admission may fail after a successor has already been held.
    // Preserve the reviewed failed run and absorb the successor's due times.
    if waiting {
        let automation: String = connection.query_row(
            "SELECT automation_id FROM automation_decisions WHERE dispatch_id=?1",
            [dispatch],
            |row| row.get(0),
        )?;
        if let Some(successor) = held(connection, &automation)? {
            connection.execute("UPDATE automation_decisions SET waiting_in_inbox=0,status='withdrawn',due_at_ms=NULL,updated_at_ms=?2 WHERE dispatch_id=?1", params![successor.dispatch_id,now])?;
            connection.execute("UPDATE inbox_proposals SET state='dismissed',revision=revision+1,updated_at=?2 WHERE proposal_id=(SELECT current_proposal_id FROM inbox_entries WHERE page_id=?1)", params![successor.page_id,iso])?;
            connection.execute("UPDATE inbox_entries SET state='done',outcome='done',revision=revision+1,updated_at=?2 WHERE page_id=?1", params![successor.page_id,iso])?;
            connection.execute("UPDATE automation_decisions SET missed_count=missed_count+?2+1,last_scheduled_for_ms=MAX(last_scheduled_for_ms,?3) WHERE dispatch_id=?1",params![dispatch,successor.missed_count,successor.last_scheduled_for_ms])?;
        }
    }
    let changed = connection.execute("UPDATE automation_decisions SET status=?2,waiting_in_inbox=?6,due_at_ms=?3,failure_message=?4,updated_at_ms=?5 WHERE dispatch_id=?1 AND status='admitted'",params![dispatch,status,retry,reason,now,waiting])?;
    if changed == 0 || !waiting {
        return Ok(());
    }
    connection.execute("UPDATE inbox_proposals SET state='failed',failure_kind='rejected',failure_message=?2,revision=revision+1,updated_at=?3 WHERE proposal_id IN (SELECT current_proposal_id FROM inbox_entries WHERE page_id=(SELECT page_id FROM automation_decisions WHERE dispatch_id=?1))",params![dispatch,reason.unwrap_or("The scheduled run could not start"),iso])?;
    Ok(())
}
pub(crate) fn withdraw_definition(
    connection: &Connection,
    id: &str,
    now: i64,
) -> Result<(), StoreError> {
    connection.execute("UPDATE automation_decisions SET status='withdrawn',waiting_in_inbox=0,due_at_ms=NULL,updated_at_ms=?2 WHERE automation_id=?1 AND (waiting_in_inbox=1 OR (status='admitted' AND NOT EXISTS (SELECT 1 FROM automation_execution_runs run WHERE run.dispatch_id=automation_decisions.dispatch_id)))",params![id,now])?;
    Ok(())
}

/// Publish withdrawals caused by the shared Page lifecycle triggers in the same commit.
pub(crate) fn record_page_lifecycle_changes(
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    context: &nodex_core_contracts::BoundModuleContext,
    operation: &str,
    pages: &[String],
) -> Result<(), StoreError> {
    if pages.is_empty() {
        return Ok(());
    }
    let pages = serde_json::to_string(pages).map_err(|_| {
        StoreError::new(
            StoreErrorCode::Internal,
            "Cannot encode Page identities",
            false,
        )
    })?;
    let withdrawn = scope.connection().prepare(
        "SELECT page_id FROM automation_decisions firing WHERE page_id IN (SELECT value FROM json_each(?1)) \
         AND status='withdrawn' AND updated_at_ms=CAST(unixepoch(?2,'subsec')*1000 AS INTEGER) \
         AND NOT EXISTS(SELECT 1 FROM blocks block WHERE block.id=firing.page_id AND block.lifecycle='active')"
    )?.query_map(params![pages,scope.committed_at()], |row| row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    record_inbox_changes(scope, context, operation, &withdrawn)
}

/// Publish Automation invalidations beside an Inbox decision, in its LocalCommit.
pub(crate) fn record_inbox_changes(
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    context: &nodex_core_contracts::BoundModuleContext,
    operation: &str,
    pages: &[String],
) -> Result<(), StoreError> {
    let connection = scope.connection();
    if pages.is_empty() {
        return Ok(());
    }
    let pages = serde_json::to_string(pages).map_err(|_| {
        StoreError::new(
            StoreErrorCode::Internal,
            "Cannot encode firing Page identities",
            false,
        )
    })?;
    let ids = connection.prepare("SELECT DISTINCT automation_id FROM automation_decisions WHERE page_id IN (SELECT value FROM json_each(?1)) ORDER BY automation_id")?.query_map([pages],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if ids.is_empty() {
        return Ok(());
    }
    record_automation_changes(scope, context, operation, &ids)
}

/// Judgements without Pages still invalidate the Automation history and its current definition.
pub(crate) fn record_automation_changes(
    scope: &crate::infrastructure::durable_mutation::DurableMutationScope<'_>,
    context: &nodex_core_contracts::BoundModuleContext,
    operation: &str,
    ids: &[String],
) -> Result<(), StoreError> {
    use crate::infrastructure::{
        event_log::{NewChangeLogEntry, append_change_log},
        projection_impact::{expand_database_coordinates, impact_for_payload},
    };
    use nodex_core_contracts::{
        CoreModuleEventPayload,
        automation::{AutomationEvent, AutomationEventKind},
    };
    if ids.is_empty() {
        return Ok(());
    }
    let connection = scope.connection();
    let leases=connection.prepare("SELECT lease_id FROM automation_execution_leases WHERE automation_id IN (SELECT value FROM json_each(?1)) AND settled_at_ms>=CAST(unixepoch(?2,'subsec')*1000 AS INTEGER) ORDER BY lease_id")?.query_map(params![serde_json::to_string(&ids).expect("identities encode"),scope.committed_at()],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let event = CoreModuleEventPayload::Automation(AutomationEvent {
        kind: AutomationEventKind::AutomationChanged,
        automation_ids: ids.to_vec(),
        lease_ids: leases.clone(),
        run_ids: vec![],
        reminder_lease_ids: vec![],
        snooze_ids: vec![],
        page_ids: vec![],
        document_ids: vec![],
        database_ids: vec![],
    });
    let impact = expand_database_coordinates(connection, impact_for_payload(&event)?)?;
    crate::database::record_local_projection_delta(
        connection,
        scope.evidence(),
        &context.library_id.0,
        &impact,
    )?;
    let payload = serde_json::json!({"module":"automation","operationKind":"inbox_scheduled_firing","kind":"automation_changed","automationIds":ids,"leaseIds":leases,"runIds":[],"reminderLeaseIds":[],"snoozeIds":[],"pageIds":[],"documentIds":[],"databaseIds":[]});
    append_change_log(
        connection,
        NewChangeLogEntry {
            project_id: context.project_id.as_ref().map(|id| id.0.as_str()),
            store_epoch: scope.store_epoch(),
            kind: "automation.changed",
            operation_id: Some(operation),
            block_ids: &[],
            document_ids: &[],
            database_block_ids: &[],
            payload_json: &payload.to_string(),
            projection_impact: &impact,
            committed_at: scope.committed_at(),
        },
        scope.evidence(),
    )?;
    Ok(())
}
