//! Heartbeat definitions follow their Core Session lifecycle in the owning
//! Workspace mutation. This participant borrows its commit rather than creating
//! another durable receipt or deferring the transition to the Desktop Host.

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::automation::{AutomationEvent, AutomationEventKind};
use nodex_core_contracts::events::CoreModuleEventPayload;
use rusqlite::params;
use serde_json::json;

use crate::infrastructure::durable_mutation::DurableMutationScope;
use crate::infrastructure::event_log::{NewChangeLogEntry, append_change_log};
use crate::infrastructure::projection_impact::{expand_database_coordinates, impact_for_payload};
use crate::infrastructure::sqlite::StoreError;

#[derive(Clone, Copy, Debug)]
pub(crate) enum TargetSessionLifecycle {
    Archived,
    Deleted,
}

pub(crate) fn on_target_session_lifecycle(
    scope: &DurableMutationScope<'_>,
    context: &BoundModuleContext,
    operation_id: &str,
    session_ids: &[String],
    lifecycle: TargetSessionLifecycle,
) -> Result<(), StoreError> {
    let connection = scope.connection();
    let now_ms: i64 = connection.query_row(
        "SELECT CAST(unixepoch(?1, 'subsec') * 1000 AS INTEGER)",
        [scope.committed_at()],
        |row| row.get(0),
    )?;
    let (target_status, reason, operation_kind) = match lifecycle {
        TargetSessionLifecycle::Archived => (
            "PAUSED",
            "target_session_archived",
            "archive_target_session",
        ),
        TargetSessionLifecycle::Deleted => {
            ("DELETED", "target_session_deleted", "delete_target_session")
        }
    };
    let mut automation_ids = Vec::new();
    let mut lease_ids = Vec::new();
    for session_id in session_ids {
        let definitions = connection
            .prepare(
                "SELECT automation_id, status FROM codex_scheduled_automations \
             WHERE kind = 'heartbeat' AND target_session_id = ?1 AND status != 'DELETED' \
             ORDER BY automation_id",
            )?
            .query_map([session_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (automation_id, status) in definitions {
            let changed = if status == target_status {
                0
            } else {
                connection.execute(
                    "UPDATE codex_scheduled_automations SET status = ?1, next_run_at = NULL, \
                       updated_at = ?2, definition_revision = definition_revision + 1 \
                     WHERE automation_id = ?3 AND status = ?4",
                    params![target_status, now_ms, automation_id, status],
                )?
            };
            if matches!(lifecycle, TargetSessionLifecycle::Deleted) {
                super::firing::withdraw_definition(connection, &automation_id, now_ms)?;
            }
            let cancelled =
                super::mutation::cancel_claimed_leases(connection, &automation_id, now_ms, reason)?;
            if changed != 0 || !cancelled.is_empty() {
                automation_ids.push(automation_id);
            }
            lease_ids.extend(cancelled);
        }
    }
    if automation_ids.is_empty() && lease_ids.is_empty() {
        return Ok(());
    }
    automation_ids.sort();
    automation_ids.dedup();
    lease_ids.sort();
    lease_ids.dedup();
    let payload = json!({
        "module": "automation", "operationKind": operation_kind, "kind": "automation_changed",
        "automationIds": automation_ids, "leaseIds": lease_ids, "runIds": [],
        "reminderLeaseIds": [], "snoozeIds": [], "pageIds": [], "documentIds": [], "databaseIds": [],
    });
    let event = CoreModuleEventPayload::Automation(AutomationEvent {
        kind: AutomationEventKind::AutomationChanged,
        automation_ids,
        lease_ids,
        run_ids: Vec::new(),
        reminder_lease_ids: Vec::new(),
        snooze_ids: Vec::new(),
        page_ids: Vec::new(),
        document_ids: Vec::new(),
        database_ids: Vec::new(),
    });
    let impact = expand_database_coordinates(connection, impact_for_payload(&event)?)?;
    crate::database::record_local_projection_delta(
        connection,
        scope.evidence(),
        &context.library_id.0,
        &impact,
    )?;
    append_change_log(
        connection,
        NewChangeLogEntry {
            project_id: context.project_id.as_ref().map(|id| id.0.as_str()),
            store_epoch: scope.store_epoch(),
            kind: "automation.changed",
            operation_id: Some(operation_id),
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
