//! First open of a detached Profile retires copied background work before Core
//! is reachable. Doing this after Store preparation also covers older backups.

use std::fs;
use std::path::Path;

use nodex_platform::private_fs::{self, OpenOptions};
use rusqlite::Connection;

use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, with_immediate_transaction};

const PENDING_FILE: &str = "profile-clone-activity.pending";

pub(super) fn stage(profile_home: &Path) -> Result<(), StoreError> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(profile_home.join(PENDING_FILE))
        .and_then(|file| file.sync_all())
        .map_err(io_error)
}

pub(crate) fn settle_on_open(
    profile_home: &Path,
    connection: &mut Connection,
) -> Result<(), StoreError> {
    let pending = profile_home.join(PENDING_FILE);
    let metadata = match fs::symlink_metadata(&pending) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error(error)),
        Ok(metadata) => metadata,
    };
    if !metadata.is_file() || private_fs::is_reparse_point(&metadata) {
        return Err(StoreError::new(
            StoreErrorCode::InvalidProfile,
            "Profile clone activity marker must be a regular file",
            false,
        ));
    }

    // Flush the transition before removing its marker. A crash can repeat the
    // idempotent transaction, but cannot expose an unsettled clone to the Host.
    connection.pragma_update(None, "synchronous", "FULL")?;
    with_immediate_transaction(connection, |transaction| settle(transaction))?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    fs::remove_file(pending).map_err(io_error)?;
    private_fs::sync_directory(profile_home).map_err(io_error)
}

fn settle(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch(
        r"
        -- Pausing stops recurrence. Already admitted decisions can execute
        -- independently of the definition's paused status.
        UPDATE automations
        SET status='PAUSED', next_run_at=NULL, automation_revision=automation_revision+1,
            schedule_revision=schedule_revision+1
        WHERE status='ACTIVE';
        UPDATE automation_decisions
        SET status='withdrawn', waiting_in_inbox=0, due_at_ms=NULL,
            failure_message='Cancelled when this Profile was cloned'
        WHERE status IN ('held','admitted') OR waiting_in_inbox=1;
        UPDATE automation_execution_leases
        SET status='cancelled', retry_at_ms=NULL, reason_code='profile_clone',
            settled_at_ms=MAX(claimed_at_ms,CAST(unixepoch('subsec')*1000 AS INTEGER))
        WHERE status='claimed';
        UPDATE automation_execution_leases SET retry_at_ms=NULL WHERE retry_at_ms IS NOT NULL;
        UPDATE automation_execution_runs SET status='PENDING_REVIEW', run_revision=run_revision+1
        WHERE status='IN_PROGRESS';

        -- Desktop-native follow-ups are stored separately from Runtime replies.
        -- Retain the captured messages while fencing any old native acceptance.
        UPDATE codex_queued_message_state
        SET state_json=(SELECT json_group_object(thread.key, json(
            (SELECT json_group_array(json_set(json_remove(message.value,'$.submission'),
                    '$.pausedReason','Paused when this Profile was cloned') ORDER BY message.key)
             FROM json_each(thread.value) message)))
            FROM json_each(state_json) thread);
        DELETE FROM codex_background_processes;

        -- Source polling, Automation assessment and both directions of delivery
        -- have separate recovery queues.
        UPDATE sources SET enabled=0, enabled_at_ms=NULL, revision=revision+1 WHERE enabled=1;
        UPDATE source_positions SET lease_token=NULL, lease_expires_at_ms=NULL
        WHERE lease_token IS NOT NULL;
        UPDATE automation_assessment_requests
        SET state='failed', failure='Cancelled when this Profile was cloned'
        WHERE state='pending';
        DELETE FROM automation_assessment_triggers WHERE request_id IS NULL;
        UPDATE thread_delivery_batches
        SET state='rejected', last_failure='Cancelled when this Profile was cloned',
            settled_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER)
        WHERE state='pending';
        UPDATE thread_deliveries
        SET state='suppressed', reason='Cancelled when this Profile was cloned'
        WHERE state IN ('pending','unresolved','batched');
        UPDATE channel_outbox
        SET state='dropped', lease_token=NULL, lease_expires_at_ms=NULL,
            terminal_reason='Cancelled when this Profile was cloned'
        WHERE state IN ('pending','sending','failed');

        -- Retain editable Inbox entries and frozen handoffs for review.
        UPDATE inbox_proposals
        SET state='failed', failure_kind='rejected', revision=revision+1,
            failure_message='Cancelled when this Profile was cloned. Review before sending again.'
        WHERE state='dispatching';
        UPDATE inbox_proposals SET auto_confirm_pending=0, revision=revision+1
        WHERE auto_confirm_pending=1;
        UPDATE member_inbox_preferences SET start_my_requests=0 WHERE start_my_requests=1;
        UPDATE inbox_start_requests SET consent_basis=NULL WHERE consent_basis IS NOT NULL;
        UPDATE inbox_suggestion_requests SET state='superseded' WHERE state='pending';
        UPDATE inbox_entries
        SET suggestion_state='none', suggestion_request_id=NULL, suggestion_error=NULL,
            revision=revision+1
        WHERE suggestion_state IN ('waiting','pending');
        DELETE FROM inbox_decision_undo;

        -- Even manually started Pages can need attention from
        -- readiness or managed-chat observations. Pause copied Page work and
        -- require explicit enrollment for further managed chat observations.
        INSERT INTO execution_holds(scope_kind,scope_id,actor,revision,paused_at)
        SELECT 'page',page.block_id,member.member_id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM pages page
        JOIN blocks block ON block.id=page.block_id
        JOIN local_profile_members member ON member.library_id=page.library_id
        WHERE (block.lifecycle='active' AND EXISTS (
            SELECT 1 FROM block_properties work WHERE work.block_id=page.block_id
            AND work.property_key='work' AND json_extract(work.value_json,'$.assignee.kind')='agent'))
           OR EXISTS (SELECT 1 FROM page_workspaces workspace WHERE workspace.page_id=page.block_id
                      AND workspace.lifecycle='ready')
        ON CONFLICT DO NOTHING;
        INSERT OR IGNORE INTO page_turn_dirty
        SELECT scope_id FROM execution_holds WHERE scope_kind='page';
        UPDATE block_properties
        SET value_json=json_set(value_json,'$.auto_start',json('false')), revision=revision+1
        WHERE property_key='work' AND json_extract(value_json,'$.auto_start')=1;
        UPDATE page_work_launches SET rejection='Cancelled when this Profile was cloned'
        WHERE accepted_at IS NULL AND rejection IS NULL;
        DELETE FROM managed_chats;

        -- Worktree repair and cleanup must not act on the source Profile's checkouts.
        UPDATE page_workspaces
        SET lifecycle='failed', revision=revision+1, failure='Cancelled when this Profile was cloned'
        WHERE lifecycle IN ('preparing','cleanup_requested');
        -- Keep calendar recurrence, but clear copied delivery schedules and Push
        -- credentials. A notification or retry can outlive its original timer.
        UPDATE block_properties SET value_json='[]', revision=revision+1
        WHERE property_key='reminders.config' AND json_array_length(value_json)>0;
        UPDATE scheduled_page_index SET reminders_json='[]' WHERE json_array_length(reminders_json)>0;
        UPDATE recurrence_exceptions SET override_reminders_json='[]' WHERE override_reminders_json IS NOT NULL;
        UPDATE reminder_snoozes SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE consumed_at IS NULL;
        UPDATE core_reminder_leases
        SET status='cancelled', retry_at_ms=NULL, reason_code='profile_clone',
            settled_at_ms=MAX(claimed_at_ms,CAST(unixepoch('subsec')*1000 AS INTEGER))
        WHERE status='claimed';
        UPDATE core_reminder_leases SET retry_at_ms=NULL WHERE retry_at_ms IS NOT NULL;
        DELETE FROM member_session_snoozes;
        DELETE FROM member_session_wakes;
        DELETE FROM member_session_snooze_deliveries;
        DELETE FROM inbox_deferrals;
        DELETE FROM member_device_push_registrations;
        ",
    )?;
    let now: String =
        connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
            row.get(0)
        })?;
    crate::workspace::page_turn::initialize(connection, &format!("profile-clone:{now}"), &now)?;
    connection.execute(
        "UPDATE page_turn_notification_intents SET claimed_at=?1 WHERE claimed_at IS NULL",
        [&now],
    )?;
    Ok(())
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::Internal,
        format!("Could not settle copied Profile activity: {error}"),
        false,
    )
}
