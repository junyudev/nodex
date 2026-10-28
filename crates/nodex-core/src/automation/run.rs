use std::collections::BTreeSet;

use nodex_core_contracts::automation::{
    AutomationInboxItem, AutomationIntent, AutomationRun, AutomationRunBulkResult,
    AutomationRunStatus, AutomationRunUnreadCounts,
};
use nodex_core_contracts::collection::{
    CollectionWindow, CollectionWindowAuthority, CollectionWindowRequest,
};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::infrastructure::collection_window::{WindowCandidate, assemble, normalize_request};
use crate::infrastructure::cursor::{
    self, CollectionCursorSubject, CursorDirection, KeysetCoordinate, KeysetValue,
};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const MAX_ID_LENGTH: usize = 512;
const MAX_BULK_RUNS: usize = 1_000;
const MAX_TITLE_BYTES: usize = 16 * 1024;
const MAX_INBOX_SUMMARY_BYTES: usize = 64 * 1024;
const MAX_ARCHIVE_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_ARCHIVE_REASON_BYTES: usize = 512;

pub(super) struct RunMutationEffects {
    pub operation_kind: &'static str,
    pub automation_ids: Vec<String>,
    pub runs: Vec<AutomationRun>,
    pub deleted_run_ids: Vec<String>,
    pub run_ids: Vec<String>,
    pub bulk: Option<AutomationRunBulkResult>,
    pub committed_at: String,
}

pub(super) fn read_run(
    connection: &Connection,
    run_id: &str,
) -> Result<Option<AutomationRun>, StoreError> {
    validate_id("run_id", run_id)?;
    let run = connection
        .query_row(
            "SELECT run_id, automation_id, run_revision, status, read_at, session_title, \
                    source_cwd, inbox_title, inbox_summary, archived_user_message, \
                    archived_assistant_message, archived_reason, created_at, updated_at, session_id, dispatch_id \
             FROM core_automation_runs WHERE run_id = ?1",
            [run_id],
            run_from_row,
        )
        .optional()
        .map_err(|_| corrupt("Automation run column types are invalid"))?;
    run.map(|run| validate_run(connection, run)).transpose()
}

pub(super) fn read_runs_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    automation_id: Option<&str>,
    include_archived: bool,
    request: &CollectionWindowRequest,
) -> Result<CollectionWindow<AutomationRun>, StoreError> {
    if let Some(automation_id) = automation_id {
        validate_id("automation_id", automation_id)?;
    }
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&(
        "automation_runs_session_v2",
        automation_id,
        include_archived,
    ))?;
    let subject = CollectionCursorSubject {
        kind: "automation_runs",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 1 {
                return Err(invalid("Automation run cursor is incompatible"));
            }
            let [
                KeysetValue::Integer {
                    value: created_at_ms,
                },
            ] = coordinate.values.as_slice()
            else {
                return Err(invalid("Automation run cursor coordinate is invalid"));
            };
            Ok((*created_at_ms, coordinate.stable_id))
        })
        .transpose()?;
    let mut statement = connection.prepare(
        "SELECT run_id, automation_id, run_revision, status, read_at, session_title, \
                source_cwd, inbox_title, inbox_summary, archived_user_message, \
                archived_assistant_message, archived_reason, created_at, updated_at, session_id, dispatch_id \
         FROM core_automation_runs \
         WHERE (?1 IS NULL OR automation_id = ?1) AND (?2 OR status <> 'ARCHIVED') \
           AND (?3 IS NULL OR created_at < ?3 OR (created_at = ?3 AND run_id > ?4)) \
         ORDER BY created_at DESC, run_id LIMIT ?5",
    )?;
    let rows = statement
        .query_map(
            params![
                automation_id,
                include_archived,
                after.as_ref().map(|value| value.0),
                after.as_ref().map(|value| value.1.as_str()),
                i64::try_from(normalized.first + 1)
                    .map_err(|_| invalid("Automation run window size is invalid"))?,
            ],
            run_from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("Automation run column types are invalid"))?
        .into_iter()
        .map(|run| validate_run(connection, run))
        .collect::<Result<Vec<_>, _>>()?;
    let candidates = rows.into_iter().map(|item| WindowCandidate {
        coordinate: KeysetCoordinate {
            values: vec![KeysetValue::Integer {
                value: item.created_at_ms,
            }],
            stable_id: item.run_id.clone(),
        },
        item,
    });
    assemble(
        candidates,
        normalized.first,
        CollectionWindowAuthority {
            projection_revision: commit_head,
        },
        |coordinate| {
            cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )
        },
    )
}

pub(super) fn read_inbox_window(
    connection: &Connection,
    library_id: &str,
    commit_head: i64,
    request: &CollectionWindowRequest,
) -> Result<
    (
        CollectionWindow<AutomationInboxItem>,
        AutomationRunUnreadCounts,
    ),
    StoreError,
> {
    let normalized = normalize_request(request)?;
    let fingerprint = cursor::query_fingerprint(&"automation_inbox_session_v2")?;
    let subject = CollectionCursorSubject {
        kind: "automation_inbox",
        library_id,
        query_fingerprint: &fingerprint,
    };
    let after = normalized
        .after
        .map(|encoded| cursor::decode(connection, encoded, subject))
        .transpose()?
        .map(|(direction, coordinate)| {
            if direction != CursorDirection::Forward || coordinate.values.len() != 2 {
                return Err(invalid("Automation inbox cursor is incompatible"));
            }
            let [
                KeysetValue::Integer {
                    value: status_bucket,
                },
                KeysetValue::Integer {
                    value: created_at_ms,
                },
            ] = coordinate.values.as_slice()
            else {
                return Err(invalid("Automation inbox cursor coordinate is invalid"));
            };
            Ok((*status_bucket, *created_at_ms, coordinate.stable_id))
        })
        .transpose()?;
    let mut statement = connection.prepare(
        "SELECT runs.automation_id, automations.name, \
                COALESCE(automations.name, NULLIF(runs.inbox_title, ''), runs.session_title), \
                COALESCE(NULLIF(runs.inbox_summary, ''), runs.archived_assistant_message, \
                         runs.archived_user_message, automations.prompt), \
                runs.archived_assistant_message, runs.archived_user_message, \
                runs.archived_reason, runs.source_cwd, runs.run_id, runs.read_at, \
                runs.created_at, runs.status, \
                CASE runs.status WHEN 'IN_PROGRESS' THEN 0 \
                  WHEN 'PENDING_REVIEW' THEN 1 ELSE 2 END AS status_bucket, runs.session_id \
         FROM core_automation_runs runs \
         JOIN codex_scheduled_automations automations \
           ON automations.automation_id = runs.automation_id \
         WHERE (?1 IS NULL OR status_bucket > ?1 \
           OR (status_bucket = ?1 AND runs.created_at < ?2) \
           OR (status_bucket = ?1 AND runs.created_at = ?2 AND runs.run_id > ?3)) \
         ORDER BY status_bucket, runs.created_at DESC, runs.run_id LIMIT ?4",
    )?;
    let rows = statement
        .query_map(
            params![
                after.as_ref().map(|value| value.0),
                after.as_ref().map(|value| value.1),
                after.as_ref().map(|value| value.2.as_str()),
                i64::try_from(normalized.first + 1)
                    .map_err(|_| invalid("Automation inbox window size is invalid"))?,
            ],
            |row| Ok((inbox_from_row(row)?, row.get::<_, i64>(12)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| corrupt("Automation inbox column types are invalid"))?
        .into_iter()
        .map(|(item, status_bucket)| Ok((validate_inbox_item(item)?, status_bucket)))
        .collect::<Result<Vec<_>, StoreError>>()?;
    let candidates = rows
        .into_iter()
        .map(|(item, status_bucket)| WindowCandidate {
            coordinate: KeysetCoordinate {
                values: vec![
                    KeysetValue::Integer {
                        value: status_bucket,
                    },
                    KeysetValue::Integer {
                        value: item.created_at_ms,
                    },
                ],
                stable_id: item.run_id.clone(),
            },
            item,
        });
    let window = assemble(
        candidates,
        normalized.first,
        CollectionWindowAuthority {
            projection_revision: commit_head,
        },
        |coordinate| {
            cursor::mint(
                connection,
                subject,
                CursorDirection::Forward,
                coordinate.clone(),
            )
        },
    )?;
    Ok((window, unread_counts(connection)?))
}

pub(super) fn apply(
    connection: &Connection,
    intent: &AutomationIntent,
) -> Result<RunMutationEffects, StoreError> {
    match intent {
        AutomationIntent::BeginRun {
            run_id,
            automation_id,
            dispatch_id,
            session_id,
            session_title,
            source_cwd,
        } => begin_run(
            connection,
            run_id,
            automation_id,
            dispatch_id.as_deref(),
            session_id.as_deref(),
            session_title.as_deref(),
            source_cwd.as_deref(),
        ),
        AutomationIntent::BindRunSession {
            run_id,
            session_id,
            expected_revision,
        } => bind_run_session(connection, run_id, session_id, *expected_revision),
        AutomationIntent::SetRunSessionTitle {
            run_id,
            expected_revision,
            session_title,
        } => set_session_title(
            connection,
            run_id,
            *expected_revision,
            session_title.as_deref(),
        ),
        AutomationIntent::CompleteRunForReview {
            run_id,
            expected_revision,
            inbox_title,
            inbox_summary,
        } => complete_for_review(
            connection,
            run_id,
            *expected_revision,
            inbox_title.as_deref(),
            inbox_summary.as_deref(),
        ),
        AutomationIntent::SetRunInboxItem {
            run_id,
            expected_revision,
            inbox_title,
            inbox_summary,
        } => set_inbox_item(
            connection,
            run_id,
            *expected_revision,
            inbox_title.as_deref(),
            inbox_summary.as_deref(),
        ),
        AutomationIntent::AcceptRun {
            run_id,
            expected_revision,
        } => accept_run(connection, run_id, *expected_revision),
        AutomationIntent::SetRunReadState {
            run_id,
            expected_revision,
            read,
        } => set_read_state(connection, run_id, *expected_revision, *read),
        AutomationIntent::MarkAllRunsRead => mark_all_read(connection),
        AutomationIntent::ArchiveRun {
            run_id,
            expected_revision,
            archived_user_message,
            archived_assistant_message,
            archived_reason,
        } => archive_run(
            connection,
            run_id,
            *expected_revision,
            archived_user_message.as_deref(),
            archived_assistant_message.as_deref(),
            archived_reason.as_deref(),
        ),
        AutomationIntent::UnarchiveRun {
            run_id,
            expected_revision,
        } => unarchive_run(connection, run_id, *expected_revision),
        AutomationIntent::DeleteRun {
            run_id,
            expected_revision,
        } => delete_run(connection, run_id, *expected_revision),
        AutomationIntent::SettleInterruptedRuns => settle_interrupted(connection),
        _ => Err(internal("Automation intent is not a run mutation")),
    }
}

pub(super) fn delete_for_automation(
    connection: &Connection,
    automation_id: &str,
) -> Result<Vec<String>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT run_id FROM core_automation_runs \
         WHERE automation_id = ?1 ORDER BY run_id",
    )?;
    let ids = statement
        .query_map([automation_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    connection.execute(
        "DELETE FROM core_automation_runs WHERE automation_id = ?1",
        [automation_id],
    )?;
    Ok(ids)
}

fn begin_run(
    connection: &Connection,
    run_id: &str,
    automation_id: &str,
    dispatch_id: Option<&str>,
    session_id: Option<&str>,
    session_title: Option<&str>,
    source_cwd: Option<&str>,
) -> Result<RunMutationEffects, StoreError> {
    validate_id("run_id", run_id)?;
    validate_id("automation_id", automation_id)?;
    require_definition(connection, automation_id)?;
    if let Some(dispatch) = dispatch_id {
        validate_id("dispatch_id", dispatch)?;
        super::firing::require_admitted(connection, dispatch)?;
        let mismatched: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM core_automation_firings WHERE dispatch_id=?1 AND automation_id<>?2)",params![dispatch,automation_id],|row|row.get(0))?;
        if mismatched {
            return Err(conflict(
                "The Run does not match this scheduled task's firing",
            ));
        }
    }
    let session_title = normalize_text(session_title, MAX_TITLE_BYTES, "run Session title")?;
    let source_cwd = source_cwd
        .map(|value| super::mutation::normalize_absolute_path(value, "run source cwd"))
        .transpose()?;
    let payload = serde_json::to_vec(&(
        run_id,
        automation_id,
        dispatch_id,
        session_id,
        &session_title,
        &source_cwd,
    ))
    .map_err(|_| internal("Automation run admission cannot be fingerprinted"))?;
    let request_hash = hex::encode(Sha256::digest(payload));
    let (now_ms, committed_at) = core_now(connection)?;
    let existing: Option<String> = connection
        .query_row(
            "SELECT admission_hash FROM core_automation_runs WHERE run_id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing) = existing {
        if existing != request_hash {
            return Err(StoreError::new(
                StoreErrorCode::IdempotencyKeyReused,
                "Automation run identity is bound to another admission",
                false,
            ));
        }
        let changed = connection.execute(
            "UPDATE core_automation_runs SET status = 'IN_PROGRESS', archived_reason = NULL, \
               archived_user_message = NULL, archived_assistant_message = NULL, read_at = NULL, \
               updated_at = ?1, run_revision = run_revision + 1 \
             WHERE run_id = ?2 AND session_id IS NULL AND status = 'ARCHIVED' AND archived_reason = 'auto'",
            params![now_ms, run_id],
        )?;
        let kind = if changed == 1 {
            "resume_run_admission"
        } else {
            "run_admission_unchanged"
        };
        return single_run_effects(connection, kind, run_id, committed_at);
    }
    if let Some(session_id) = session_id {
        require_session(connection, automation_id, session_id)?;
    }
    connection.execute(
        "INSERT INTO core_automation_runs(\
           run_id, automation_id, session_id, status, session_title, source_cwd, created_at, updated_at, \
           run_revision, admission_hash, dispatch_id\
         ) VALUES (?1, ?2, ?3, 'IN_PROGRESS', ?4, ?5, ?6, ?6, 1, ?7, ?8)",
        params![run_id, automation_id, session_id, session_title, source_cwd, now_ms, request_hash, dispatch_id],
    )?;
    if let Some(session) = session_id {
        link_run_pages(
            connection,
            automation_id,
            dispatch_id,
            session,
            &committed_at,
        )?;
    }
    single_run_effects(connection, "begin_run", run_id, committed_at)
}

fn bind_run_session(
    connection: &Connection,
    run_id: &str,
    session_id: &str,
    expected_revision: i64,
) -> Result<RunMutationEffects, StoreError> {
    validate_id("run_id", run_id)?;
    validate_expected_revision(expected_revision)?;
    let current =
        read_run(connection, run_id)?.ok_or_else(|| not_found("Automation run is unavailable"))?;
    let (now_ms, committed_at) = core_now(connection)?;
    if let Some(bound) = current.session_id.as_deref() {
        if bound != session_id {
            return Err(StoreError::new(
                StoreErrorCode::Conflict,
                "Automation run Session binding is immutable",
                false,
            ));
        }
        if expected_revision > current.run_revision {
            return Err(conflict("Automation run revision changed"));
        }
        return single_run_effects(connection, "run_binding_unchanged", run_id, committed_at);
    }
    if current.run_revision != expected_revision
        || current.status != AutomationRunStatus::InProgress
    {
        return Err(conflict("Pending Automation run changed concurrently"));
    }
    if let Some(dispatch) = &current.dispatch_id {
        super::firing::require_admitted(connection, dispatch)?;
    }
    require_session(connection, &current.automation_id, session_id)?;
    update_one(
        connection,
        "UPDATE core_automation_runs SET session_id = ?1, updated_at = ?2, run_revision = run_revision + 1 \
         WHERE run_id = ?3 AND run_revision = ?4 AND status = 'IN_PROGRESS' AND session_id IS NULL",
        params![session_id, now_ms, run_id, expected_revision],
        "Pending Automation run changed concurrently",
    )?;
    link_run_pages(
        connection,
        &current.automation_id,
        current.dispatch_id.as_deref(),
        session_id,
        &committed_at,
    )?;
    single_run_effects(connection, "bind_run_session", run_id, committed_at)
}

fn set_session_title(
    connection: &Connection,
    run_id: &str,
    expected_revision: i64,
    session_title: Option<&str>,
) -> Result<RunMutationEffects, StoreError> {
    require_run_revision(connection, run_id, expected_revision)?;
    let title = normalize_text(session_title, MAX_TITLE_BYTES, "run Session title")?;
    let (now_ms, committed_at) = core_now(connection)?;
    update_one(
        connection,
        "UPDATE core_automation_runs SET session_title = ?1, updated_at = ?2, \
           run_revision = run_revision + 1 WHERE run_id = ?3 AND run_revision = ?4",
        params![title, now_ms, run_id, expected_revision],
        "Automation run changed concurrently",
    )?;
    single_run_effects(connection, "set_run_session_title", run_id, committed_at)
}

fn complete_for_review(
    connection: &Connection,
    run_id: &str,
    expected_revision: i64,
    inbox_title: Option<&str>,
    inbox_summary: Option<&str>,
) -> Result<RunMutationEffects, StoreError> {
    let current = require_run_revision(connection, run_id, expected_revision)?;
    if current.status != AutomationRunStatus::InProgress {
        return Err(conflict(
            "Only an in-progress Automation run can complete for review",
        ));
    }
    let title = normalize_text(inbox_title, MAX_TITLE_BYTES, "run inbox title")?;
    let summary = normalize_text(inbox_summary, MAX_INBOX_SUMMARY_BYTES, "run inbox summary")?;
    let (now_ms, committed_at) = core_now(connection)?;
    update_one(
        connection,
        "UPDATE core_automation_runs SET status = 'PENDING_REVIEW', inbox_title = ?1, \
           inbox_summary = ?2, updated_at = ?3, run_revision = run_revision + 1 \
         WHERE run_id = ?4 AND run_revision = ?5 AND status = 'IN_PROGRESS'",
        params![title, summary, now_ms, run_id, expected_revision],
        "Automation run changed before review completion",
    )?;
    single_run_effects(connection, "complete_run_for_review", run_id, committed_at)
}

fn set_inbox_item(
    connection: &Connection,
    run_id: &str,
    expected_revision: i64,
    inbox_title: Option<&str>,
    inbox_summary: Option<&str>,
) -> Result<RunMutationEffects, StoreError> {
    let current = require_run_revision(connection, run_id, expected_revision)?;
    if current.status == AutomationRunStatus::Archived {
        return Err(conflict(
            "Archived Automation run inbox content is immutable",
        ));
    }
    let title = normalize_text(inbox_title, MAX_TITLE_BYTES, "run inbox title")?;
    let summary = normalize_text(inbox_summary, MAX_INBOX_SUMMARY_BYTES, "run inbox summary")?;
    let (now_ms, committed_at) = core_now(connection)?;
    update_one(
        connection,
        "UPDATE core_automation_runs SET inbox_title = ?1, inbox_summary = ?2, \
           status = CASE WHEN status = 'IN_PROGRESS' THEN 'PENDING_REVIEW' ELSE status END, \
           updated_at = ?3, run_revision = run_revision + 1 \
         WHERE run_id = ?4 AND run_revision = ?5 AND status <> 'ARCHIVED'",
        params![title, summary, now_ms, run_id, expected_revision],
        "Automation run changed before inbox update",
    )?;
    single_run_effects(connection, "set_run_inbox_item", run_id, committed_at)
}

fn accept_run(
    connection: &Connection,
    run_id: &str,
    expected_revision: i64,
) -> Result<RunMutationEffects, StoreError> {
    let current = require_run_revision(connection, run_id, expected_revision)?;
    if current.status == AutomationRunStatus::Archived {
        return Err(conflict("Archived Automation run cannot be accepted"));
    }
    let (now_ms, committed_at) = core_now(connection)?;
    update_one(
        connection,
        "UPDATE core_automation_runs SET status = 'ACCEPTED', updated_at = ?1, \
           run_revision = run_revision + 1 \
         WHERE run_id = ?2 AND run_revision = ?3 AND status <> 'ARCHIVED'",
        params![now_ms, run_id, expected_revision],
        "Automation run changed before acceptance",
    )?;
    single_run_effects(connection, "accept_run", run_id, committed_at)
}

fn set_read_state(
    connection: &Connection,
    run_id: &str,
    expected_revision: i64,
    read: bool,
) -> Result<RunMutationEffects, StoreError> {
    require_run_revision(connection, run_id, expected_revision)?;
    let (now_ms, committed_at) = core_now(connection)?;
    let read_at = read.then_some(now_ms);
    update_one(
        connection,
        "UPDATE core_automation_runs SET read_at = ?1, run_revision = run_revision + 1 \
         WHERE run_id = ?2 AND run_revision = ?3",
        params![read_at, run_id, expected_revision],
        "Automation run changed before read-state update",
    )?;
    single_run_effects(connection, "set_run_read_state", run_id, committed_at)
}

fn mark_all_read(connection: &Connection) -> Result<RunMutationEffects, StoreError> {
    let (now_ms, committed_at) = core_now(connection)?;
    let selected = select_run_ids(
        connection,
        "SELECT run_id FROM core_automation_runs \
         WHERE read_at IS NULL AND status IN ('PENDING_REVIEW', 'ACCEPTED', 'ARCHIVED') \
           AND updated_at <= ?1 \
         ORDER BY updated_at, run_id LIMIT ?2",
        params![
            now_ms,
            i64::try_from(MAX_BULK_RUNS).expect("bound fits i64")
        ],
    )?;
    for run_id in &selected {
        connection.execute(
            "UPDATE core_automation_runs SET read_at = ?1, run_revision = run_revision + 1 \
             WHERE run_id = ?2 AND read_at IS NULL",
            params![now_ms, run_id],
        )?;
    }
    let runs = read_selected_runs(connection, &selected)?;
    let has_more = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM core_automation_runs \
         WHERE read_at IS NULL AND status IN ('PENDING_REVIEW', 'ACCEPTED', 'ARCHIVED') \
           AND updated_at <= ?1)",
        [now_ms],
        |row| row.get::<_, bool>(0),
    )?;
    bulk_effects(
        "mark_all_runs_read",
        runs,
        AutomationRunBulkResult {
            changed_count: u32::try_from(selected.len()).expect("bounded selection fits u32"),
            archived_pending_count: 0,
            pending_review_count: 0,
            has_more,
        },
        committed_at,
    )
}

fn archive_run(
    connection: &Connection,
    run_id: &str,
    expected_revision: i64,
    archived_user_message: Option<&str>,
    archived_assistant_message: Option<&str>,
    archived_reason: Option<&str>,
) -> Result<RunMutationEffects, StoreError> {
    require_run_revision(connection, run_id, expected_revision)?;
    let user_message = normalize_text(
        archived_user_message,
        MAX_ARCHIVE_MESSAGE_BYTES,
        "archived user message",
    )?;
    let assistant_message = normalize_text(
        archived_assistant_message,
        MAX_ARCHIVE_MESSAGE_BYTES,
        "archived assistant message",
    )?;
    let reason = normalize_text(archived_reason, MAX_ARCHIVE_REASON_BYTES, "archive reason")?;
    let (now_ms, committed_at) = core_now(connection)?;
    update_one(
        connection,
        "UPDATE core_automation_runs SET status = 'ARCHIVED', archived_user_message = ?1, \
           archived_assistant_message = ?2, archived_reason = COALESCE(archived_reason, ?3), \
           updated_at = ?4, run_revision = run_revision + 1 \
         WHERE run_id = ?5 AND run_revision = ?6",
        params![
            user_message,
            assistant_message,
            reason,
            now_ms,
            run_id,
            expected_revision
        ],
        "Automation run changed before archive",
    )?;
    single_run_effects(connection, "archive_run", run_id, committed_at)
}

fn unarchive_run(
    connection: &Connection,
    run_id: &str,
    expected_revision: i64,
) -> Result<RunMutationEffects, StoreError> {
    let current = require_run_revision(connection, run_id, expected_revision)?;
    if current.status != AutomationRunStatus::Archived {
        return Err(conflict("Only an archived Automation run can be restored"));
    }
    let (now_ms, committed_at) = core_now(connection)?;
    update_one(
        connection,
        "UPDATE core_automation_runs SET status = 'ACCEPTED', read_at = COALESCE(read_at, ?1), \
           archived_reason = NULL, updated_at = ?1, run_revision = run_revision + 1 \
         WHERE run_id = ?2 AND run_revision = ?3 AND status = 'ARCHIVED'",
        params![now_ms, run_id, expected_revision],
        "Automation run changed before restore",
    )?;
    single_run_effects(connection, "unarchive_run", run_id, committed_at)
}

fn delete_run(
    connection: &Connection,
    run_id: &str,
    expected_revision: i64,
) -> Result<RunMutationEffects, StoreError> {
    let current = require_run_revision(connection, run_id, expected_revision)?;
    let (_, committed_at) = core_now(connection)?;
    let changed = connection.execute(
        "DELETE FROM core_automation_runs WHERE run_id = ?1 AND run_revision = ?2",
        params![run_id, expected_revision],
    )?;
    if changed != 1 {
        return Err(conflict("Automation run changed before deletion"));
    }
    Ok(RunMutationEffects {
        operation_kind: "delete_run",
        automation_ids: vec![current.automation_id],
        runs: Vec::new(),
        deleted_run_ids: vec![run_id.to_owned()],
        run_ids: vec![run_id.to_owned()],
        bulk: None,
        committed_at,
    })
}

fn settle_interrupted(connection: &Connection) -> Result<RunMutationEffects, StoreError> {
    let (now_ms, committed_at) = core_now(connection)?;
    let selected = select_run_ids(
        connection,
        "SELECT run_id FROM core_automation_runs WHERE status = 'IN_PROGRESS' \
         ORDER BY created_at, run_id LIMIT ?1",
        [i64::try_from(MAX_BULK_RUNS).expect("bound fits i64")],
    )?;
    let mut archived_pending_count = 0_u32;
    let mut pending_review_count = 0_u32;
    for run_id in &selected {
        let pending = connection.query_row(
            "SELECT session_id IS NULL FROM core_automation_runs WHERE run_id = ?1",
            [run_id],
            |row| row.get::<_, bool>(0),
        )?;
        if pending {
            connection.execute(
                "UPDATE core_automation_runs SET status = 'ARCHIVED', \
                   archived_reason = COALESCE(archived_reason, 'auto'), updated_at = ?1, \
                   run_revision = run_revision + 1 \
                 WHERE run_id = ?2 AND status = 'IN_PROGRESS'",
                params![now_ms, run_id],
            )?;
            archived_pending_count += 1;
        } else {
            connection.execute(
                "UPDATE core_automation_runs SET status = 'PENDING_REVIEW', updated_at = ?1, \
                   run_revision = run_revision + 1 \
                 WHERE run_id = ?2 AND status = 'IN_PROGRESS'",
                params![now_ms, run_id],
            )?;
            pending_review_count += 1;
        }
    }
    let runs = read_selected_runs(connection, &selected)?;
    let has_more = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM core_automation_runs WHERE status = 'IN_PROGRESS')",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    bulk_effects(
        "settle_interrupted_runs",
        runs,
        AutomationRunBulkResult {
            changed_count: u32::try_from(selected.len()).expect("bounded selection fits u32"),
            archived_pending_count,
            pending_review_count,
            has_more,
        },
        committed_at,
    )
}

fn single_run_effects(
    connection: &Connection,
    operation_kind: &'static str,
    run_id: &str,
    committed_at: String,
) -> Result<RunMutationEffects, StoreError> {
    let run = read_run(connection, run_id)?
        .ok_or_else(|| corrupt("Committed Automation run is unavailable"))?;
    Ok(RunMutationEffects {
        operation_kind,
        automation_ids: vec![run.automation_id.clone()],
        runs: vec![run],
        deleted_run_ids: Vec::new(),
        run_ids: vec![run_id.to_owned()],
        bulk: None,
        committed_at,
    })
}

fn bulk_effects(
    operation_kind: &'static str,
    runs: Vec<AutomationRun>,
    bulk: AutomationRunBulkResult,
    committed_at: String,
) -> Result<RunMutationEffects, StoreError> {
    let automation_ids = runs
        .iter()
        .map(|run| run.automation_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let run_ids = runs.iter().map(|run| run.run_id.clone()).collect();
    Ok(RunMutationEffects {
        operation_kind,
        automation_ids,
        runs,
        deleted_run_ids: Vec::new(),
        run_ids,
        bulk: Some(bulk),
        committed_at,
    })
}

fn require_run_revision(
    connection: &Connection,
    run_id: &str,
    expected_revision: i64,
) -> Result<AutomationRun, StoreError> {
    validate_id("run_id", run_id)?;
    validate_expected_revision(expected_revision)?;
    let run =
        read_run(connection, run_id)?.ok_or_else(|| not_found("Automation run is unavailable"))?;
    if run.run_revision != expected_revision {
        return Err(conflict("Automation run revision changed"));
    }
    Ok(run)
}

fn require_definition(connection: &Connection, automation_id: &str) -> Result<(), StoreError> {
    let status = connection
        .query_row(
            "SELECT status FROM codex_scheduled_automations WHERE automation_id = ?1",
            [automation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    match status.as_deref() {
        Some("ACTIVE" | "PAUSED") => Ok(()),
        Some("DELETED") => Err(conflict("Deleted Automation cannot start a run")),
        Some(_) => Err(corrupt("Scheduled Automation status is invalid")),
        None => Err(not_found("Scheduled Automation is unavailable")),
    }
}

fn require_session(
    connection: &Connection,
    automation_id: &str,
    session_id: &str,
) -> Result<(), StoreError> {
    validate_id("session_id", session_id)?;
    let session = connection
        .query_row(
            "SELECT project_id, archived, is_default_draft FROM project_sessions WHERE id = ?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("Automation run target Session is unavailable"))?;
    if session.1 || session.2 {
        return Err(conflict(
            "Automation run target Session is archived or a draft",
        ));
    }
    let definition = super::read::read_definition(connection, automation_id)?
        .ok_or_else(|| not_found("Automation definition is unavailable"))?;
    if definition.kind == nodex_core_contracts::automation::AutomationDefinitionKind::Heartbeat {
        if definition.target_session_id.as_deref() != Some(session_id) {
            return Err(conflict(
                "Automation run Session does not match its Heartbeat target",
            ));
        }
    } else if definition.project_id != session.0 {
        return Err(StoreError::new(
            StoreErrorCode::Unauthorized,
            "Automation run Session does not belong to its Definition Project",
            false,
        ));
    }
    if let Some(project_id) = session.0 {
        let active = connection.query_row(
            "SELECT lifecycle = 'active' FROM projects WHERE id = ?1",
            [project_id],
            |row| row.get::<_, bool>(0),
        )?;
        if !active {
            return Err(conflict("Automation run Project is unavailable"));
        }
    }
    Ok(())
}

fn read_selected_runs(
    connection: &Connection,
    run_ids: &[String],
) -> Result<Vec<AutomationRun>, StoreError> {
    run_ids
        .iter()
        .map(|run_id| {
            read_run(connection, run_id)?
                .ok_or_else(|| corrupt("Selected Automation run disappeared"))
        })
        .collect()
}

fn select_run_ids<P: rusqlite::Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<String>, StoreError> {
    let mut statement = connection.prepare(sql)?;
    statement
        .query_map(params, |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn unread_counts(connection: &Connection) -> Result<AutomationRunUnreadCounts, StoreError> {
    let total = connection.query_row(
        "SELECT count(*) \
         FROM core_automation_runs runs \
         JOIN codex_scheduled_automations automations \
           ON automations.automation_id = runs.automation_id \
         WHERE runs.read_at IS NULL AND runs.status IN ('PENDING_REVIEW', 'ACCEPTED')",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    let total =
        u32::try_from(total).map_err(|_| corrupt("Automation unread count exceeds its bound"))?;
    Ok(AutomationRunUnreadCounts { total })
}

fn run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationRun> {
    Ok(AutomationRun {
        run_id: row.get(0)?,
        session_id: row.get(14)?,
        automation_id: row.get(1)?,
        dispatch_id: row.get(15)?,
        run_revision: row.get(2)?,
        status: parse_status(&row.get::<_, String>(3)?).map_err(conversion)?,
        read_at_ms: row.get(4)?,
        session_title: row.get(5)?,
        source_cwd: row.get(6)?,
        inbox_title: row.get(7)?,
        inbox_summary: row.get(8)?,
        archived_user_message: row.get(9)?,
        archived_assistant_message: row.get(10)?,
        archived_reason: row.get(11)?,
        created_at_ms: row.get(12)?,
        updated_at_ms: row.get(13)?,
    })
}

fn inbox_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationInboxItem> {
    Ok(AutomationInboxItem {
        automation_id: row.get(0)?,
        automation_name: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        archived_assistant_message: row.get(4)?,
        archived_user_message: row.get(5)?,
        archived_reason: row.get(6)?,
        source_cwd: row.get(7)?,
        run_id: row.get(8)?,
        session_id: row.get(13)?,
        read_at_ms: row.get(9)?,
        created_at_ms: row.get(10)?,
        status: parse_status(&row.get::<_, String>(11)?).map_err(conversion)?,
    })
}

fn validate_run(connection: &Connection, run: AutomationRun) -> Result<AutomationRun, StoreError> {
    if run.run_revision < 1
        || run.created_at_ms < 0
        || run.updated_at_ms < run.created_at_ms
        || run.read_at_ms.is_some_and(|value| value < 0)
    {
        return Err(corrupt("Stored Automation run is invalid"));
    }
    validate_id("stored Automation run id", &run.run_id)
        .map_err(|_| corrupt("Stored Automation run id is invalid"))?;
    validate_id("stored Automation id", &run.automation_id)
        .map_err(|_| corrupt("Stored Automation run definition id is invalid"))?;
    let definition_exists = connection
        .query_row(
            "SELECT 1 FROM codex_scheduled_automations WHERE automation_id = ?1",
            [&run.automation_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !definition_exists {
        return Err(corrupt("Automation run definition is unavailable"));
    }
    Ok(run)
}

fn validate_inbox_item(item: AutomationInboxItem) -> Result<AutomationInboxItem, StoreError> {
    validate_id("stored Automation inbox Run", &item.run_id)
        .map_err(|_| corrupt("Stored Automation inbox Run is invalid"))?;
    validate_id("stored Automation inbox definition", &item.automation_id)
        .map_err(|_| corrupt("Stored Automation inbox definition is invalid"))?;
    if item.created_at_ms < 0 || item.read_at_ms.is_some_and(|value| value < 0) {
        return Err(corrupt("Stored Automation inbox item is invalid"));
    }
    Ok(item)
}

fn parse_status(value: &str) -> Result<AutomationRunStatus, String> {
    match value {
        "IN_PROGRESS" => Ok(AutomationRunStatus::InProgress),
        "PENDING_REVIEW" => Ok(AutomationRunStatus::PendingReview),
        "ACCEPTED" => Ok(AutomationRunStatus::Accepted),
        "ARCHIVED" => Ok(AutomationRunStatus::Archived),
        _ => Err("Automation run status is invalid".to_owned()),
    }
}

fn normalize_text(
    value: Option<&str>,
    max_bytes: usize,
    label: &str,
) -> Result<Option<String>, StoreError> {
    let value = value.unwrap_or_default().trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > max_bytes {
        return Err(invalid(&format!("Automation {label} exceeds its bound")));
    }
    Ok(Some(value.to_owned()))
}

fn validate_expected_revision(value: i64) -> Result<(), StoreError> {
    if value >= 1 {
        return Ok(());
    }
    Err(invalid("expected_revision must be positive"))
}

fn validate_id(label: &str, value: &str) -> Result<(), StoreError> {
    if !value.trim().is_empty()
        && value.trim() == value
        && value.len() <= MAX_ID_LENGTH
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
    {
        return Ok(());
    }
    Err(invalid(&format!("{label} is invalid")))
}

fn update_one<P: rusqlite::Params>(
    connection: &Connection,
    sql: &str,
    params: P,
    conflict_message: &str,
) -> Result<(), StoreError> {
    if connection.execute(sql, params)? == 1 {
        return Ok(());
    }
    Err(conflict(conflict_message))
}

fn core_now(connection: &Connection) -> Result<(i64, String), StoreError> {
    connection
        .query_row(
            "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER), \
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(Into::into)
}

fn conversion(message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn not_found(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn conflict(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, true)
}

fn corrupt(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

fn link_run_pages(
    connection: &Connection,
    automation: &str,
    dispatch: Option<&str>,
    session: &str,
    now: &str,
) -> Result<(), StoreError> {
    let mut pages = Vec::new();
    if let Some(page) = connection
        .query_row(
            "SELECT page_id FROM core_automation_firings WHERE dispatch_id=?1",
            [dispatch],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        pages.push(page);
    }
    let runbook: Option<String> = connection.query_row(
        "SELECT runbook_page_id FROM codex_scheduled_automations WHERE automation_id=?1",
        [automation],
        |r| r.get(0),
    )?;
    if let Some(page) = runbook {
        pages.push(page);
    }
    pages.sort();
    pages.dedup();
    crate::workspace::link_pages(connection, session, &pages, now)
}
